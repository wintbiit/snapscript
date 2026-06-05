# Protocol IDL Direction

Last reviewed: 2026-06-05

## Purpose

SnapScript should grow a declaration-first protocol workflow, similar in spirit to framework IDL
tooling such as go-zero, while keeping the current runtime small and portable.

The intended workflow is:

```txt
schema.snap
  -> snapscript check
  -> snapscript generate
  -> generated TypeScript protocol, RPC bindings, manifest, and optional stubs
```

The generated TypeScript should call the runtime definition APIs, but the public protocol model is
IDL-first. The vNext RPC design is a breaking redesign around endpoint-scoped declarations; it does
not preserve the previous service-scoped RPC API.

## Goals

- Make protocol definitions a single source of truth.
- Reduce repetitive handwritten protocol/RPC binding code.
- Generate portable TypeScript that can run in puerts, Node.js, browsers, and other JS runtimes.
- Keep server/client world construction unchanged: `createServerWorld()` and `createClientWorld()`.
- Keep transports outside the protocol IDL. The server/engine layer still owns reliability and connection
  lifecycle.
- Generate deterministic component, RPC, and field ids from declaration order.
- Fail early during check/generate when schema definitions are inconsistent.
- Keep replicated component snapshots on SnapScript's codec because it owns quantization, field
  masks, dirty tracking, and batched update semantics.

## Non-Goals

- No Room/Game/App abstraction.
- No runtime schema migration or protocol compatibility negotiation in this phase.
- No replacement of the snapshot wire format with protobuf, FlatBuffers, or another generic codec.
- No mandatory code generation for users who prefer the handwritten API.
- No transport generation.
- No direct dependency on decorators, reflection metadata, `eval`, dynamic import, or runtime parser
  features that make puerts portability harder.

## Deterministic IDs

Protocol versioning and compatibility policy are intentionally deferred. The first requirement is
deterministic ids that are obvious from the `.snap` file.

Rules:

- Component and entity declaration order is the generated id source.
- Commands and events share one RPC id namespace, assigned by endpoint declaration order and then
  RPC declaration order inside `world {}`, `peer {}`, and `entity {}` blocks.
- Field order inside a component, command, or event is the field id source.
- New fields should be appended.
- Reordering fields or declarations is a breaking protocol change.
- Deleting fields is a breaking protocol change.
- The generated project should not maintain a separate `snapscript.lock.json`.

Server/client protocol mismatches should be discovered before gameplay runs, preferably by generated
manifest checks in build, CI, or startup bootstrap. The runtime protocol layer should not grow a
large compatibility system before the IDL workflow exists.

## Parser Strategy

We should own a `.snap` DSL instead of making `.proto` or `.fbs` the primary format.

Reasons:

- SnapScript has first-class concepts that generic message IDLs do not: `component`, `entity`,
  `command`, `event`, quantized fields, dirty field masks, and server/client RPC direction.
- Protobuf field numbers are useful, but protobuf messages do not naturally express replicated ECS
  snapshot semantics.
- FlatBuffers is optimized for a different object/table model and would add a heavier external
  toolchain.
- A custom DSL can generate current SnapScript runtime calls without implying that the wire format is
  protobuf or FlatBuffers.

We avoid a handwritten parser. The current implementation uses Peggy for the v1 single-file grammar.
Chevrotain remains a later option if the language grows editor tooling, imports, or richer recovery.

### Peggy

Peggy is a PEG parser generator. It is a good fit if the first `.snap` grammar stays compact.

Pros:

- Small grammar files are easy to read.
- Fast to prototype.
- Good enough for single-file IDL in phase one.
- Generated parser can produce a clean AST without much infrastructure.

Risks:

- Error recovery and rich diagnostics require extra work.
- Large grammars can become harder to maintain.
- IDE-like features are not the default shape.

### Chevrotain

Chevrotain is a parser toolkit written for JavaScript/TypeScript. It is a better fit if `.snap`
quickly needs rich diagnostics, editor tooling, or multi-file imports.

Pros:

- Stronger control over lexer/parser structure.
- Better path toward custom diagnostics and tooling.
- Easier to evolve into language-server-style features.

Risks:

- More boilerplate than Peggy.
- Slower to get the first compact grammar working.
- The parser implementation can feel heavier than the DSL itself in phase one.

The parser/compiler is a development tool dependency. Generated protocol files do not depend on
Peggy; they import only the SnapScript runtime API.

## vNext Language Surface

The vNext syntax is represented by `examples/protocol/game.snap`:

```snap
syntax = "v1"

component MatchState {
  phase: u8(0)
  timeLeftMs: u32(0)
}

world {
  state: MatchState

  command StartGame() reliable
  event GameStarted() reliable
}

component ConnectionInfo {
  region: u8(0)
}

peer {
  connectionInfo: ConnectionInfo

  command Ready() reliable
  event Alert(reason: u8(0)) reliable
}

struct Vector2 {
  x: qf32(min: -128, max: 128, precision: 0.01, default: 0)
  y: qf32(min: -128, max: 128, precision: 0.01, default: 0)
}

component Position {
  Vector2
  hidden: bool(default: false)
}

component Health {
  hp: u16(100)
}

entity Player {
  position: Position
  health: Health

  command Move(input: MoveInput) unreliable
  event MoveDisabled(disabled: bool) reliable
}
```

RPC is declared inside endpoints:

- `world {}` maps to the reserved `WorldEntity`.
- `peer {}` maps to replicated framework-created `PeerEntity` instances. Generated protocols include
  a `Peer` prefab with the built-in replicated `PeerState` component plus any components declared in
  `peer {}`.
- `entity Name {}` maps to gameplay entities.

Endpoint blocks contain component references, commands, and events. They do not declare inline
fields or implicitly generate endpoint components.

World commands are valid and target `WorldEntity`. Peer commands target the sending PeerEntity.

The old external `service {}` block is removed. Runtime RPC names use the endpoint prefix, for
example `Player.Move`, `Peer.Ready`, and `World.GameStarted`.

The first generated output should include:

- `protocol.ts`
- typed component/entity exports
- a generated `Peer` prefab when RPC/peer endpoint support needs PeerEntity routing
- endpoint-scoped RPC binding helpers
- payload/context types for generated handlers
- `manifest.json`

## RPC Bindings

The IDL should reduce repeated command/event wiring while keeping execution world-authoritative.
Handlers receive either `CommandCtx<TPayload>` or `EventCtx<TPayload>`. Payload fields are not
expanded into handler arguments; decoded data stays on `ctx.payload`.

The generated project exposes short command/event helpers:

```ts
commands.Player.Move(clientWorld, playerEntity, {
  dx: 1,
  dy: 0,
});

events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, { disabled: true });
events.Player.MoveDisabled.sendTo(serverWorld, [peerEntity], playerEntity, {
  disabled: true,
});
```

Event helpers must provide both `broadcast()` and `sendTo()`. `sendTo()` accepts one PeerEntity or an
array of PeerEntity refs. `broadcast()` means all connected peers.

The generated facade should not export standalone raw RPC definitions such as `PlayerMove`; command
and event usage goes through the endpoint facade.

Entity type validation failures are logged through `logger.warn` and dropped before user handlers
run. Validation uses the endpoint entity declaration's component set, for example
`world.has(target, Player)`. Missing source/target entities are also logged and dropped. Gameplay
authorization is not implicit; user handlers validate ownership, possession, cooldowns, target
visibility, and other project rules.

See [docs/rpc-entity-model.md](rpc-entity-model.md) for the full decision record.

## Open Questions

- Whether explicit ids should ever be supported as an advanced source-level escape hatch.
- Whether entities should support aliases only, or direct component shorthand too.
- Whether `.proto` import should be supported later for RPC payloads only.
