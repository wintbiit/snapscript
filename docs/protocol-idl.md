# Protocol IDL Direction

Last reviewed: 2026-06-20

## Purpose

SnapScript uses `.snap` files as the declaration-first protocol workflow:

```txt
schema.snap
  -> snapscript check
  -> snapscript generate
  -> generated TypeScript protocol, RPC bindings, manifest, and user logic stubs
```

The generated TypeScript calls the runtime definition APIs, but the public protocol model is
IDL-first. The current RPC model is a breaking redesign around endpoint-scoped declarations and does
not preserve the previous service-scoped RPC API.

## Goals

- Make protocol definitions a single source of truth.
- Reduce repetitive handwritten protocol and RPC binding code.
- Generate portable TypeScript that can run in Node.js, browsers, Puerts, and other JavaScript runtimes.
- Keep server/client world construction unchanged: `createServerWorld()` and `createClientWorld()`.
- Keep transports outside the protocol IDL.
- Generate deterministic component, entity, RPC, and field ids from declaration order.
- Fail early during check/generate when schema definitions are inconsistent.
- Keep replicated component snapshots on SnapScript's codec.

## Non-Goals

- No Room/Game/App abstraction.
- No runtime schema migration or protocol compatibility negotiation in this phase.
- No replacement of the snapshot wire format with protobuf, FlatBuffers, or another generic codec.
- No mandatory code generation for users who prefer the handwritten runtime API.
- No transport generation.
- No dependency on decorators, reflection metadata, `eval`, dynamic import, or runtime parser features.

## Deterministic IDs

Protocol versioning and compatibility policy are intentionally small for now. The first requirement
is deterministic ids that are obvious from the `.snap` file.

Rules:

- Component declaration order is the generated component id source.
- Gameplay entity declaration order is the generated gameplay entity id source.
- `world {}` and `peer {}` have reserved runtime entity semantics.
- Commands, events, and streams share one RPC id namespace, assigned by endpoint declaration order
  and then RPC declaration order inside `world {}`, `peer {}`, and `entity {}` blocks.
- Field order inside a component, command, event, or stream is the field id source.
- New fields should be appended.
- Reordering fields or declarations is a breaking protocol change.
- Deleting fields is a breaking protocol change.
- The generated project should not maintain a separate `snapscript.lock.json`.

Server/client protocol mismatches should be discovered before gameplay runs, preferably by generated
manifest checks in build, CI, or startup bootstrap.

## Parser Strategy

SnapScript owns a `.snap` DSL instead of using `.proto` or `.fbs` as the primary format.

Reasons:

- SnapScript has first-class concepts that generic message IDLs do not: `component`, `entity`,
  `command`, `event`, `stream`, quantized fields, dirty field masks, and RPC direction.
- Protobuf field numbers are useful, but protobuf messages do not naturally express replicated ECS
  snapshot semantics.
- FlatBuffers is optimized for a different object/table model and would add a heavier external toolchain.
- A custom DSL can generate current SnapScript runtime calls without implying that the wire format is
  protobuf or FlatBuffers.

The current implementation uses Peggy for the v1 single-file grammar. Chevrotain remains a later
option if the language needs richer diagnostics, editor tooling, or multi-file import recovery.

The parser/compiler is a development tool dependency. Generated protocol files do not depend on
Peggy; they import only the SnapScript runtime API.

## Language Surface

The current syntax is represented by `examples/protocol/game.snap`:

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

struct MoveInput {
  dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)
  dy: qf32(min: -1, max: 1, precision: 0.01, default: 0)
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
  stream MoveStream(input: MoveInput)
  event MoveDisabled(disabled: bool) reliable
}
```

RPC is declared inside endpoints:

- `world {}` maps to the reserved `WorldEntity`.
- `peer {}` maps to replicated framework-created `PeerEntity` instances. Generated protocols include
  a `Peer` prefab with the built-in replicated `PeerState` component plus components declared in
  `peer {}`.
- `entity Name {}` maps to gameplay entities.

Endpoint blocks contain component references, commands, events, and streams. They do not declare
inline fields or implicitly generate endpoint components.

Every `component` declared in `.snap` is replicated network state. The IDL does not support a
`replicated` option, field argument, or metadata switch. Server-only and client-only ECS state is
defined in TypeScript with `defineComponent(..., { replicated: false })` and registered through
`createServerWorld({ localComponents })` or `createClientWorld({ localComponents })`.

World commands target `WorldEntity`. Peer commands target the sending PeerEntity. Entity commands
target a specific gameplay entity ref.

The old external `service {}` block is removed. Runtime RPC names use the endpoint prefix, for
example `Player.Move`, `Peer.Ready`, and `World.GameStarted`.

The generated project output includes `protocol.ts`, `manifest.json`, facade files, registries, and
create-only user stubs.

## Generated Facade

The generated facade is the primary project API:

```ts
import { commands } from "./generated/commands";
import { entities } from "./generated/entities";
import { events } from "./generated/events";
import { streams } from "./generated/streams";

const playerEntity = entities.Player.first(clientWorld);
if (playerEntity === undefined) throw new Error("Player is not replicated yet");

commands.Player.Move(clientWorld, playerEntity, {
  dx: 1,
  dy: 0,
});

events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, { disabled: true });
events.Player.MoveDisabled.sendTo(serverWorld, [peerEntity], playerEntity, {
  disabled: true,
});

streams.Player.MoveStream(clientWorld, playerEntity, {
  dx: 1,
  dy: 0,
}, clientTick, dtMs);
```

The generated `internal` object is a mechanical bridge used by facade files and registries. User
application code should use `commands`, `events`, `streams`, and `entities` instead of `internal`.

### Entity Helpers

Entity helpers expose `all()`, `mine()`, `first()`, `firstMine()`, `has()`, and `get()` for each
component-backed endpoint entity. Use these helpers to obtain entity refs from replicated client
state instead of constructing raw `{ id }` objects by hand.

### Command Helpers

Command helpers send client-to-server intent:

- `commands.World.*(clientWorld, payload)` targets `WorldEntity`.
- `commands.Peer.*(clientWorld, payload)` targets the sending PeerEntity.
- `commands.<Entity>.*(clientWorld, entity, payload)` targets a specific gameplay entity.

Generated server handlers receive `CommandCtx<TPayload>`. The command `source` is the sending
PeerEntity and the `target` is the endpoint target.

### Event Helpers

Event helpers send server-to-client notifications:

- `events.World.*.broadcast(serverWorld, payload)` sends to all connected peers.
- `events.World.*.sendTo(serverWorld, peerEntityOrArray, payload)` sends explicitly to PeerEntity refs.
- `events.Peer.*.broadcast(serverWorld, payload)` sends one event per visible/interested PeerEntity,
  using each receiving PeerEntity as source and target.
- `events.Peer.*.sendTo(serverWorld, peerEntityOrArray, payload)` sends explicitly to PeerEntity refs.
- `events.<Entity>.*.broadcast(serverWorld, sourceEntity, payload)` sends only to peers that can
  currently see the source entity.
- `events.<Entity>.*.sendTo(serverWorld, peerEntityOrArray, sourceEntity, payload)` sends explicitly
  and bypasses visibility filtering.

Generated client handlers receive `EventCtx<TPayload>`. Event `target` is always the receiving
PeerEntity.

### Stream Helpers

Command streams are client-to-server only and use the unreliable channel internally:

```ts
streams.Player.MoveStream(clientWorld, playerEntity, payload, clientTick, dtMs);
```

The facade call queues a sample. `ClientWorld.tick(deltaTime)` runs the `network` phase and then
flushes dirty stream queues, so multiple samples pushed in one frame can be batched into one
command-stream packet. `deltaTime` is measured in milliseconds.

Generated server handlers receive `CommandStreamCtx<TPayload>` with ordered samples. Streams use
`MessageType.CommandStream`, minimal ack packets, per-stream sequence tracking, and client
pending-sample limits.

## Validation

The runtime/generator validates mechanical invariants before calling user handlers:

- command source is resolved from the transport connection and canonical PeerEntity.
- command target exists.
- event source exists.
- stream target exists.
- source/target entity type matches the endpoint that declared the RPC.
- payload decodes successfully.
- RPC direction matches command/event/stream usage.

Entity type validation failures are logged through `logger.warn` and dropped before user handlers run.
Gameplay authorization is not implicit; user handlers validate ownership, possession, cooldowns,
target visibility, and other project rules.

## Current Constraints

- The generated facade does not expose an explicit id escape hatch; public calls use entity refs and
  payload objects.
- Local components are not part of `.snap`, manifests, generated registries, or protocol hashes.
- A `.snap` type expression that uses `replicated: ...` is rejected during check/generate with an
  error that points users to TypeScript `localComponents`.
- Handwritten TypeScript protocols can use public world RPC methods directly, but packet codecs and
  low-level sync runtimes remain internal.
- Public world APIs do not accept numeric entity ids as entity inputs; use refs from `WorldEntity`,
  handler contexts, queries, or generated `entities.*` helpers.
- Rust and C# code generation do not exist in the current repo.
- Stream correction/replay/prediction is not implemented; current streams provide batching, sequence
  filtering, pending limits, and minimal acknowledgements.
