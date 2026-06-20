# SnapScript

SnapScript is a platform-agnostic TypeScript framework for networked ECS state.

It gives a server process one authoritative world and gives clients replicated read-only worlds. Rendering, physics, input, assets, matchmaking, persistence, and real transport reliability stay in your engine or platform layer.

## Install

```sh
pnpm add snapscript
```

For a new `.snap`-driven core package, use the npm create package:

```sh
npm create snapscript@latest my-game-core
```

For local development in this repository, use the workspace scripts:

```sh
pnpm install
pnpm build
pnpm test
```

## Get Started

Start with a generated game core package. The core owns replicated protocol, endpoint RPC wiring,
systems, and tests. Your browser, Node, Puerts, Unity, Unreal, or custom server project owns the
transport adapter, tick loop, input, rendering, persistence, and deployment.

```sh
npm create snapscript@latest my-game-core
cd my-game-core
pnpm install
pnpm build
```

The generated package has this shape:

```txt
my-game-core/
  game.snap
  src/
    generated/              # generated protocol, manifest, facade files, registries
    logic/server/           # command handlers
    logic/client/           # event handlers
    systems/                # server/client systems
    create-server.ts        # assembled server world factory
    create-client.ts        # assembled client world factory
```

The source of truth is `game.snap`. RPC is declared inside endpoint blocks. The endpoint tells
SnapScript which entity the RPC is addressed to or emitted from:

```snap
struct MoveInput {
  dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)
  dy: qf32(min: -1, max: 1, precision: 0.01, default: 0)
}

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

entity Player {
  position: Position
  health: Health

  command Move(input: MoveInput) unreliable
  stream MoveStream(input: MoveInput)
  event MoveDisabled(disabled: bool) reliable
}
```

Endpoint blocks have fixed runtime meaning:

- `world {}` maps to the reserved `WorldEntity`.
- `peer {}` maps to replicated framework-created PeerEntity instances.
- `entity Player {}` maps to gameplay entities that have the declared component set.

RPC declarations are directional:

- `command` travels client to server. Its `source` is the sending PeerEntity and its `target` is the
  declared endpoint entity.
- `event` travels server to client. Its `source` is `WorldEntity`, a PeerEntity, or a gameplay
  entity, and its `target` is the receiving PeerEntity.
- `stream` travels client to server as an unreliable sample stream. It is flushed during
  `ClientWorld.tick()` after the `network` phase.

The generated runtime names are endpoint-scoped, for example `World.StartGame`, `Peer.Ready`, and
`Player.Move`.

Run generation after changing the schema:

```sh
pnpm generate
```

Generation overwrites only mechanical files under `src/generated/`. User logic stubs are
create-only, so edits under `src/logic/` and `src/systems/` are kept.

Use the generated `commands`, `events`, `streams`, and `entities` facades:

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

events.Player.MoveDisabled.sendTo(serverWorld, peerEntity, playerEntity, {
  disabled: true,
});

streams.Player.MoveStream(clientWorld, playerEntity, {
  dx: 1,
  dy: 0,
}, clientTick, dtMs);
```

`entities.Player.first()` and `entities.Player.firstMine()` read entity refs from replicated client
state, so application code does not need to construct `{ id }` objects. `events.*.sendTo()` accepts
PeerEntity refs, not raw peer ids. Stream calls enqueue samples; dirty streams are batched and sent
during `ClientWorld.tick()`.

Generated handlers receive a world plus a typed context:

```ts
import type { CommandCtx, ServerWorld } from "snapscript";
import { Position, type PlayerMovePayload } from "../../generated/protocol";

export function Move(world: ServerWorld, ctx: CommandCtx<PlayerMovePayload>): void {
  if (!world.isOwner(ctx.source, ctx.target)) {
    return;
  }

  const position = world.get(ctx.target, Position);
  if (position === undefined) {
    return;
  }

  position.x.value += ctx.payload.dx;
  position.y.value += ctx.payload.dy;
}
```

`ctx.source` and `ctx.target` are entity refs. For a client command, `ctx.source` is the sending
PeerEntity. There is no generated `ctx.sender`; use `world.peerId(ctx.source)` when project logic
needs the numeric connection id. Peer connection state is replicated on the built-in `PeerState`
component and exposed through `world.peerStatus(peerEntity)`.

Endpoint type checks happen before user handlers run. If a packet targets the wrong endpoint type,
for example `Player.Move` with a non-`Player` target, SnapScript logs `logger.warn` and drops it.
Ownership, cooldowns, possession, and gameplay permissions remain user logic.

To initialize from an existing schema without copying it:

```sh
npm create snapscript@latest my-game-core -- --schema ../game.snap
```

## Platform Integration

Create worlds explicitly in your platform code or generated core helpers:

```ts
const serverWorld = createServerWorld({
  protocol,
  transport: serverTransport,
  clock,
});

const clientWorld = createClientWorld({
  protocol,
  transport: clientTransport,
  clock,
});
```

The transport adapter only moves `Uint8Array` packets and channel labels. SnapScript does not own
WebSocket/WebRTC/UDP reliability, input collection, rendering, prediction, matchmaking, accounts, or
deployment.

Client component refs are read-only. Clients send commands, receive events, run client-only systems,
and can sample applied snapshots:

```ts
clientWorld.onSnapshot((world, snapshot) => {
  for (const [entity, position] of world.query(Position)) {
    interpolationBuffer.push({
      id: entity.id,
      tick: snapshot.tick,
      x: position.x.value,
      y: position.y.value,
    });
  }
});
```

## Direct Runtime API

Most projects should use `.snap` generation. The lower-level runtime API remains available for
direct integrations, tests, and examples that do not want generated protocol files.

Define replicated state with field helpers and component/entity schemas:

```ts
import {
  createClientWorld,
  createServerWorld,
  WorldEntity,
  defineCommand,
  defineComponent,
  defineEntity,
  defineProtocol,
  qf32,
  u16,
  type ClientTransport,
  type Clock,
  type ServerTransport,
} from "snapscript";

const Position = defineComponent("Position", {
  x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }),
  y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }),
});

const Health = defineComponent("Health", {
  hp: u16(100),
});

const Player = defineEntity("Player", {
  position: Position,
  health: Health,
});

const Move = defineCommand("Move", {
  dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
  dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
});

const protocol = defineProtocol({
  components: { Position, Health },
  prefabs: { Player },
  commands: { Move },
});
```

Create one world on the server and one world per client connection or client runtime:

```ts
declare const serverTransport: ServerTransport;
declare const clientTransport: ClientTransport;
declare const clock: Clock;

const serverWorld = createServerWorld({
  protocol,
  transport: serverTransport,
  clock,
});

const clientWorld = createClientWorld({
  protocol,
  transport: clientTransport,
  clock,
});
```

Run gameplay logic against the world:

```ts
const player = serverWorld.spawn(Player, {
  position: { x: 0, y: 0 },
  health: { hp: 100 },
});

serverWorld.onCommand(Move, (ctx) => {
  const position = serverWorld.get(player, Position);
  if (position === undefined) {
    return;
  }
  position.x.value += ctx.payload.dx;
  position.y.value += ctx.payload.dy;
});

serverWorld.system("movement", "update", (world) => {
  world.each([Position] as const, (_entity, position) => {
    position.x.value += 0.01;
  });
});

clientWorld.sendCommand(WorldEntity, Move, { dx: 1, dy: 0 });

serverWorld.tick();
clientWorld.tick();
```

Client component refs are read-only. The client reads replicated state, sends commands, handles events, runs client-only systems, and can sample applied snapshots:

```ts
clientWorld.onSnapshot((world, snapshot) => {
  for (const [entity, position] of world.query(Position)) {
    interpolationBuffer.push({
      id: entity.id,
      tick: snapshot.tick,
      x: position.x.value,
      y: position.y.value,
    });
  }
});
```

## Run The Examples

```sh
pnpm example:protocol:build
pnpm --dir examples/protocol/node build
pnpm example:simple:dev
pnpm example:ecs:dev
```

Open `/server` and `/client` in separate browser tabs. The examples show the intended layering:

- `examples/protocol` shows `.snap` check/generate, order-derived ids, generated protocol exports, and typed RPC helpers
- `examples/protocol/node` shows a Node WebSocket platform adapter around the generated core package
- server/client worlds are created directly by the server app
- transports only deliver `Uint8Array` packets and channel labels
- commands express client intent
- server command handlers mutate authoritative `NetRef.value`
- clients observe read-only replicated component state

The examples are also performance fixtures. Changes to query loops, dirty encoding, fanout, or
snapshot apply should be checked against `test/benchmark-examples.test.ts`, not only isolated
microbenchmarks.

## Design Boundary

SnapScript owns:

- replicated ECS-style state
- schema-defined components and prefabs
- replicated PeerEntity state
- binary field encoding
- dirty tracking
- snapshot encode/apply
- command/event/stream packet encoding
- world-local peer ids and entity ownership metadata
- server/client world runtime
- optional visibility filtering
- `.snap` protocol generation tooling
- generated protocol hash checks during early handshake
- benchmark and protocol diagnostics

SnapScript does not own:

- rendering
- physics
- input devices
- audio
- asset loading
- scenes or game object hierarchies
- matchmaking, accounts, lobbies, persistence, or deployment
- reliable network protocol implementation
- transform interpolation, prediction, rollback, or lag compensation policy

There is no top-level `Game` or `App` object. The public runtime entrypoints are `createServerWorld()` and `createClientWorld()`. There is no public local-only `createWorld()` because this project is a networking framework.

## World Roles

The world role is fixed at construction time:

- `createServerWorld()` returns a `ServerWorld`
- `createClientWorld()` returns a `ClientWorld`

The role is not a later mode switch. Internally, server and client worlds use separate classes over a shared core so hot paths do not branch on role for every operation.

`ServerWorld` can:

- `spawn`, `add`, `remove`, and `destroy` replicated entities/components
- mutate component fields through `NetRef.value`
- run systems
- receive endpoint-addressed commands through `onCommand()`
- broadcast endpoint-addressed events through `broadcastEvent()`
- send generated endpoint events to PeerEntity refs through `sendEventTo()` / `sendPeerEventTo()`
- set and query ownership through `setOwner()`, `clearOwner()`, `ownerOf()`, `isOwner()`, and `ownedBy()`
- map PeerEntity refs with `peerId()` and `peerStatus()`
- control visibility
- send full snapshots

`ClientWorld` can:

- read replicated components and prefabs
- query and iterate read-only rows
- run client systems
- send endpoint-addressed commands through `sendCommand()`
- receive endpoint-addressed events through `onEvent()`
- read `myPeerId()`, `myPeerEntity()`, `peerId(peerEntity)`, `peerStatus(peerEntity)`, `ownerOf(entity)`, and `isMine(entity)`
- request a full snapshot
- observe applied snapshots through `onSnapshot()`

World handles are frozen runtime objects. Keep non-replicated server application state in your own objects.

## WorldEntity

`WorldEntity` is the reserved replicated world-level entity. It is SnapScript's GameState-like
place for global gameplay facts that every client should observe:

```ts
import { WorldEntity } from "snapscript";

const MatchState = defineComponent("MatchState", {
  phase: u8(0),
  timeLeftMs: u32(0),
});

serverWorld.add(WorldEntity, MatchState, {
  phase: 1,
  timeLeftMs: 300000,
});

const state = clientWorld.get(WorldEntity, MatchState);
const sameState = clientWorld.getComponent(MatchState);
```

It has `id === 0`, is created automatically by the framework inside every server/client world, is
always server-owned, and is always visible. User code never spawns or constructs the world entity.
Use it for replicated global gameplay state such as match phase, round timer, team score, world
clock, or global match config. Server-only rules and orchestration live in systems, RPC handlers, or
the platform layer, similar to an engine GameMode. Do not use `WorldEntity` for
logger/cache/db/transport/engine bridge objects; those belong to the platform layer.

`WorldEntity` uses the same component, dirty tracking, snapshot, query, and `each()` paths as normal
entities. `destroy(WorldEntity)` is forbidden, while server-side `remove(WorldEntity, Component)` is
allowed to clear a world-level component.

Use `world.getComponent(Component)` as sugar for `world.get(WorldEntity, Component)` when reading
world-level components. Server worlds return mutable refs; client worlds and shared readers return
read-only refs.

## ECS API

The public ECS surface is intentionally small:

- `spawn(schemaOrPrefab?, initial?)`
- `add(entity, componentOrPrefab, initial?)`
- `getComponent(component)`
- `get(entity, componentOrSimpleEntity)`
- `getPrefab(entity, prefab)`
- `has(entity, componentOrPrefab)`
- `remove(entity, componentOrPrefab)`
- `destroy(entity)`
- `query(...components)`
- `each(components, fn)`
- `system(name, phase, fn)`
- `tick()`

Use `spawn()` to create entities. `add()` requires an existing entity; it does not create arbitrary raw ids or resurrect destroyed refs.

Use `query()` when you want a lazy iterable result with `.length`, `.map()`, `.forEach()`, and `.toArray()`. Use `each()` in hot systems because it avoids materializing public query tuples.

Reusable query tuples should preserve tuple inference:

```ts
import type { ComponentQuery } from "snapscript";

const MovementQuery = [Position, Velocity] as const satisfies ComponentQuery;

serverWorld.each(MovementQuery, (_entity, position, velocity) => {
  position.x.value += velocity.x.value;
});
```

For shared render or inspection code, accept `ReplicatedStateReader` instead of `ServerWorld` or
`ClientWorld`. That keeps helper functions read-only and usable on both sides:

```ts
import type { ReplicatedStateReader } from "snapscript";

function readViews(world: ReplicatedStateReader) {
  const views: { id: number; x: number; y: number }[] = [];
  world.each([Position] as const, (entity, position) => {
    views.push({ id: entity.id, x: position.x.value, y: position.y.value });
  });
  return views;
}
```

Object-valued fields such as `vec2q()` and `vec3q()` use immutable value snapshots. Replace the whole object:

```ts
position.xy.value = {
  x: position.xy.value.x + 1,
  y: position.xy.value.y,
};
```

## Protocols And Definitions

`defineProtocol()` creates the registry bundle used by worlds. Worlds only accept protocol objects returned by `defineProtocol()`. Copied or hand-written lookalikes are rejected.

Definitions are frozen and fail fast:

- names must be non-empty strings
- field/component maps must be plain objects
- fields must come from SnapScript field helpers
- manual ids must be integers in `[0, 4294967295]`
- unknown initial value and RPC payload keys throw

`protocol.manifest()` returns a frozen summary of component, prefab, command, event, and stream ids.
Use it for diagnostics, protocol validation, or tooling.

## `.snap` IDL

Handwritten definitions are still the runtime foundation. For larger projects, `.snap` files provide a declaration-first workflow that generates the same runtime calls plus typed RPC helpers:

```sh
npm create snapscript@latest my-game-core
snapscript check examples/protocol/game.snap
pnpm --dir examples/protocol/core generate
```

Endpoint-scoped RPC is declared inside `world {}`, `peer {}`, and `entity Name {}` blocks.
Endpoint blocks contain component references, commands, events, and streams:

```snap
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

entity Player {
  position: Position
  health: Health

  command Move(input: MoveInput) unreliable
  stream MoveStream(input: MoveInput)
  event MoveDisabled(disabled: bool) reliable
}
```

`create-snapscript` initializes a platform-neutral game core package. `snapscript generate` then
writes generated TypeScript protocol/RPC bindings, system registries, create-only endpoint RPC stubs,
and a manifest from the core package root. The project-style target uses `.snap` declaration order and
field order as the generated id source; reordering is a breaking protocol change. See
[docs/protocol-idl.md](docs/protocol-idl.md), [docs/rpc-entity-model.md](docs/rpc-entity-model.md),
and [examples/protocol/game.snap](examples/protocol/game.snap).

## RPC

In `.snap` projects, commands, events, and streams are declared on the endpoint that can receive or
emit them:

```snap
world {
  command StartGame() reliable
  event GameStarted() reliable
}

peer {
  command Ready() reliable
  event Alert(reason: u8) reliable
}

entity Player {
  command Move(input: MoveInput) unreliable
  stream MoveStream(input: MoveInput)
  event MoveDisabled(disabled: bool) reliable
}
```

The generator creates a typed facade and endpoint handler stubs. Commands and streams travel client
to server; events travel server to clients:

```ts
const playerEntity = entities.Player.first(clientWorld);
if (playerEntity === undefined) throw new Error("Player is not replicated yet");

commands.Player.Move(clientWorld, playerEntity, { dx: 1, dy: 0 });
streams.Player.MoveStream(clientWorld, playerEntity, { dx: 1, dy: 0 }, clientTick, dtMs);

events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, { disabled: true });
events.Peer.Alert.sendTo(serverWorld, [peerEntity], { reason: 1 });
events.World.GameStarted.broadcast(serverWorld, {});
```

Generated endpoint handlers receive one frozen `CommandCtx<TPayload>`, `EventCtx<TPayload>`, or
`CommandStreamCtx<TPayload>`.
`ctx.source` and `ctx.target` are entity refs; there is no generated `ctx.sender`. Peer ids are
exposed from PeerEntity refs through `world.peerId(peerEntity)`. Peer connection state is replicated
through the built-in `PeerState` component and can be read with `world.peerStatus(peerEntity)`.

The lower-level `defineCommand()` / `defineEvent()` / `defineStream()` runtime API remains available
for direct integrations that do not use `.snap` generation, such as the simple runtime examples.

Handler errors are isolated and logged through `logger.error`. Handlers run from a stable dispatch snapshot, so handlers registered during one dispatch start on a later packet.

## Peer Ids And Ownership

`PeerId` is a world-local connection id. `ServerPeerId` is always `0`; client peer ids start at `1` and are assigned by the server during the hello/full-snapshot handshake.

Ownership is internal network metadata, not a component that users add, remove, or query. The vNext
generated endpoint model uses PeerEntity refs; direct runtime integrations may still use peer ids:

```ts
serverWorld.setOwner(player, peerId);
serverWorld.isOwner(peerId, player);
serverWorld.ownedBy(peerId);

clientWorld.myPeerId();
clientWorld.isMine(player.id);
clientWorld.ownerOf(player.id);
```

Entities default to owner `0`. `clearOwner(entity)` sets ownership back to the server. Ownership is synchronized in snapshots and dirty structural updates, so client-side `isMine(entity)` follows server authority.

## Transport Boundary

SnapScript does not implement a reliable transport protocol. The adapter must provide the behavior it claims for these logical channels:

```ts
type ChannelName = "reliable" | "unreliable";

interface ClientTransport {
  send(channel: ChannelName, bytes: Uint8Array): void;
  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
}

interface ServerTransport {
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  broadcast(channel: ChannelName, bytes: Uint8Array): void;
  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void;
  peers?(): Iterable<PeerRef>;
}
```

SnapScript uses channels as policy:

- control packets and structural snapshots use `reliable`
- update-only dirty snapshots use `unreliable`
- commands/events use the channel declared on the RPC definition
- streams use the unreliable channel internally

There is no generic public `Transport` type and no world-level default channel option. If you need WebSocket, WebRTC, UDP, Steam networking, or an engine networking layer, implement the adapter on the server layer.

Inbound packet bytes are copied when they enter the world queue, so adapters may reuse their receive buffers after invoking `onPacket`. Outbound bytes should be treated as immutable.

Servers can opt into batched dirty update snapshots:

```ts
const serverWorld = createServerWorld({
  protocol,
  transport,
  clock,
  snapshotEncoding: "batched",
});
```

The default is `snapshotEncoding: "default"`. Batched snapshots reduce repeated per-entity update headers for homogeneous dirty updates. When enabled, the server still sends batched update packets only to peers that advertise batched snapshot support in SnapScript control messages; older peers automatically receive the default update format.

Keep this option data-driven. It can reduce bandwidth for homogeneous dirty frames, but the default
path stays the CPU-stable baseline until the example-derived benchmark proves a broad win.

## Visibility And Interest

Default visibility is all-visible:

```ts
const serverWorld = createServerWorld({
  protocol,
  transport,
  clock,
  visibility: "all",
});
```

Deny by default with `visibility: "none"`:

```ts
const serverWorld = createServerWorld({
  protocol,
  transport,
  clock,
  visibility: "none",
});
```

Use an interest hook for server-defined policy:

```ts
const serverWorld = createServerWorld({
  protocol,
  transport,
  clock,
  interest(peerId, entity, world) {
    return world.has(entity, Position);
  },
});
```

Interest hooks receive a SnapScript `PeerId`, read-only entity/world inputs, and must return a boolean. Manual overrides are available with `setVisible(peerId, entity, visible)` and `clearVisible(peerId, entity?)`.

Visibility applies to full snapshots and incremental sync. When visibility is peer-specific, the server encodes peer-specific snapshots and reconciles stale peer state with removals/destroys.

## Prediction, Interpolation, And Rollback

SnapScript provides foundation hooks, not game-specific algorithms.

Framework responsibilities:

- tick/time context
- local vs remote apply paths
- command/event/stream encoding
- post-apply snapshot hooks
- future state capture/restore and reconciliation hooks

Server responsibilities:

- input sampling
- character controller prediction
- physics rollback
- transform interpolation
- lag compensation policy

## Performance

Run benchmarks with:

```sh
pnpm bench
```

The benchmark reports median/min/max wall-clock time across repeated samples. The current benchmark covers:

- query and `each()` loops
- dirty snapshot encode
- remote snapshot apply
- spawn/destroy churn
- component add/remove churn
- fanout across peers
- map storage vs sparse-set vs sparse-set plus archetype index
- real example-derived server send, movement, render read, and client apply loops

Use this rule for architecture work: example-derived benchmark results are the merge gate. Synthetic
microbenchmarks are useful for finding mechanisms, but they are not enough to justify a storage or
wire-format change by themselves.

Hot-path guidance for users:

- keep reusable query tuples as `const ... satisfies ComponentQuery`
- use `world.each(QueryTuple, fn)` for systems, render sampling, and other high-frequency loops
- use `query()` when you need a lazy result object, length checks, mapping, or easy debugging
- pass `ReplicatedStateReader` to shared read-only helpers
- leave `snapshotEncoding` at `"default"` unless your measured workload benefits from `"batched"`
- prefer `visibility: "all"` when all entities are visible; peer-specific interest disables the
  simplest all-peer fanout reuse path

Representative local run on 2026-05-23:

| Scenario | Map Storage | Sparse + Archetype | Result |
| --- | ---: | ---: | --- |
| 10k single-component query | 0.713 ms | 0.156 ms | 4.6x faster |
| 50k single-component query | 2.419 ms | 0.725 ms | 3.3x faster |
| 10k sparse pair query | 0.344 ms | 0.024 ms | 14.3x faster |
| 50k sparse pair query | 2.244 ms | 0.111 ms | 20.2x faster |
| 10k sparse four-component query | 0.751 ms | 0.039 ms | 19.3x faster |
| 50k sparse four-component query | 2.947 ms | 0.140 ms | 21.1x faster |

The tradeoff is structural churn. Component add/remove churn is currently about 2.6x to 3.0x slower than the map baseline in the microbenchmark because the archetype index maintains signatures and buckets. This is acceptable for query-heavy worlds, but high-churn worlds are the first tuning target.

SoA storage is not part of the current default. It remains a future internal storage option because it would change `NetRef` from a value holder into a slot handle and affect query, dirty tracking, snapshot encoding, and codec paths.

## Internal Architecture Notes

The current default storage is sparse-set component storage with an archetype query index:

- each component has dense entity and record arrays
- sparse entity-to-row maps provide O(1) membership lookup
- entity-to-component sets support destroy/remove enumeration
- single-component queries scan dense tables
- two-component queries use smallest sparse table lookup
- wider queries choose between archetype buckets and smallest sparse table

Snapshot writing uses pooled bit writers. Default all-visible dirty fanout can encode one update packet and reuse it across peers. Per-peer visibility paths reuse encoded packets when peer op sets are identical. Servers may opt into batched dirty snapshots with `snapshotEncoding: "batched"`; the runtime only sends batched packets to peers that advertised support and falls back per peer otherwise.

The package root intentionally does not export binary readers/writers, raw registry factories, packet codecs, low-level sync runtimes, storage classes, or public `World` constructors.

## Development Checks

```sh
pnpm typecheck
pnpm test
pnpm bench
pnpm build
pnpm test:examples
```

After `pnpm build`, audit the generated public declaration surface if you touch exports:

```sh
rg -n "createWorld|declare class World|BinaryReader|BinaryWriter|ComponentStorage|SparseSetComponentStorage|createSyncServer|createSyncClient" packages/snapscript/dist/index.d.mts
```

The command should not find those internal names.

## License

SnapScript is licensed under the Apache License 2.0. See [LICENSE](./LICENSE) for the full license text.
