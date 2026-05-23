# SnapScript

SnapScript is a platform-agnostic TypeScript framework for networked ECS state.

It gives a host process one authoritative world and gives clients replicated read-only worlds. Rendering, physics, input, assets, matchmaking, persistence, and real transport reliability stay in your engine or platform layer.

## Install

```sh
pnpm add snapscript
```

The package is currently private in this repository. For local development, use the workspace scripts:

```sh
pnpm install
pnpm build
pnpm test
```

## Get Started

Define replicated state with field helpers and component/entity schemas:

```ts
import {
  createClientWorld,
  createHostWorld,
  defineCommand,
  defineComponent,
  defineEntity,
  defineProtocol,
  qf32,
  u16,
  type ClientTransport,
  type Clock,
  type HostTransport,
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

Create one world at the host and one world per client connection or client runtime:

```ts
declare const hostTransport: HostTransport;
declare const clientTransport: ClientTransport;
declare const clock: Clock;

const hostWorld = createHostWorld({
  protocol,
  transport: hostTransport,
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
const player = hostWorld.spawn(Player, {
  position: { x: 0, y: 0 },
  health: { hp: 100 },
});

hostWorld.on(Move, (payload) => {
  const position = hostWorld.get(player, Position);
  if (position === undefined) {
    return;
  }
  position.x.value += payload.dx;
  position.y.value += payload.dy;
});

hostWorld.system("movement", "update", (world) => {
  world.each([Position] as const, (_entity, position) => {
    position.x.value += 0.01;
  });
});

clientWorld.send(Move, { dx: 1, dy: 0 });

hostWorld.tick();
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
pnpm example:simple:dev
pnpm example:ecs:dev
```

Open `/host` and `/client` in separate browser tabs. The examples show the intended layering:

- host/client worlds are created directly by the host app
- transports only deliver `Uint8Array` packets and channel labels
- commands express client intent
- host command handlers mutate authoritative `NetRef.value`
- clients observe read-only replicated component state

## Design Boundary

SnapScript owns:

- replicated ECS-style state
- schema-defined components and prefabs
- binary field encoding
- dirty tracking
- snapshot encode/apply
- command/event packet encoding
- host/client world runtime
- optional visibility filtering
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

There is no top-level `Game` or `App` object. The public runtime entrypoints are `createHostWorld()` and `createClientWorld()`. There is no public local-only `createWorld()` because this project is a networking framework.

## World Roles

The world role is fixed at construction time:

- `createHostWorld()` returns a `HostWorld`
- `createClientWorld()` returns a `ClientWorld`

The role is not a later mode switch. Internally, host and client worlds use separate classes over a shared core so hot paths do not branch on role for every operation.

`HostWorld` can:

- `spawn`, `add`, `remove`, and `destroy` replicated entities/components
- mutate component fields through `NetRef.value`
- run systems
- receive commands through `on()`
- broadcast events through `broadcast()`
- control visibility
- send full snapshots

`ClientWorld` can:

- read replicated components and prefabs
- query and iterate read-only rows
- run client systems
- send commands through `send()`
- receive events through `on()`
- request a full snapshot
- observe applied snapshots through `onSnapshot()`

World handles are frozen runtime objects. Keep non-replicated host application state in your own objects.

## ECS API

The public ECS surface is intentionally small:

- `spawn(schemaOrPrefab?, initial?)`
- `add(entity, componentOrPrefab, initial?)`
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

hostWorld.each(MovementQuery, (_entity, position, velocity) => {
  position.x.value += velocity.x.value;
});
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

`protocol.manifest()` returns a frozen summary of component, prefab, command, and event ids. Use it for diagnostics, protocol validation, or tooling.

## RPC

Commands travel client to host:

```ts
const Jump = defineCommand("Jump", {
  strength: qf32({ min: 0, max: 1, precision: 0.01, default: 0.5 }),
});

clientWorld.send(Jump, { strength: 0.75 });
hostWorld.on(Jump, (payload, context) => {
  console.log(payload.strength, context.peer);
});
```

Events travel host to client:

```ts
const TookDamage = defineEvent("TookDamage", {
  amount: u16(0),
});

hostWorld.broadcast(TookDamage, { amount: 10 });
clientWorld.on(TookDamage, (payload) => {
  playDamageFx(payload.amount);
});
```

RPC payloads and handler contexts are frozen. Handler errors are isolated and logged through `logger.error`. Handlers run from a stable dispatch snapshot, so handlers registered during one dispatch start on a later packet.

## Transport Boundary

SnapScript does not implement a reliable transport protocol. The adapter must provide the behavior it claims for these logical channels:

```ts
type ChannelName = "reliable" | "unreliable";

interface ClientTransport {
  send(channel: ChannelName, bytes: Uint8Array): void;
  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
}

interface HostTransport {
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

There is no generic public `Transport` type and no world-level default channel option. If you need WebSocket, WebRTC, UDP, Steam networking, or an engine networking layer, implement the adapter at the host layer.

Inbound packet bytes are copied when they enter the world queue, so adapters may reuse their receive buffers after invoking `onPacket`. Outbound bytes should be treated as immutable.

## Visibility And Interest

Default visibility is all-visible:

```ts
const hostWorld = createHostWorld({
  protocol,
  transport,
  clock,
  visibility: "all",
});
```

Deny by default with `visibility: "none"`:

```ts
const hostWorld = createHostWorld({
  protocol,
  transport,
  clock,
  visibility: "none",
});
```

Use an interest hook for host-defined policy:

```ts
const hostWorld = createHostWorld({
  protocol,
  transport,
  clock,
  interest(peer, entity, world) {
    return world.has(entity, Position);
  },
});
```

Interest hooks receive read-only entity/world inputs and must return a boolean. Manual overrides are available with `setVisible(peer, entity, visible)` and `clearVisible(peer, entity?)`.

Visibility applies to full snapshots and incremental sync. When visibility is peer-specific, the host encodes peer-specific snapshots and reconciles stale peer state with removals/destroys.

## Prediction, Interpolation, And Rollback

SnapScript provides foundation hooks, not game-specific algorithms.

Framework responsibilities:

- tick/time context
- local vs remote apply paths
- command/event encoding
- post-apply snapshot hooks
- future state capture/restore and reconciliation hooks

Host responsibilities:

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

Timing benchmarks use `tinybench` with `process.hrtime.bigint()` and a minimum of 9 measured
iterations per scenario. Cross-branch comparisons can run the same compatible benchmark against a
main-branch worktree:

```sh
pnpm bench:branch:compare -- --main D:\src\snapscript-main-bench
```

The current benchmark covers:

- query and `each()` loops
- dirty snapshot encode
- remote snapshot apply
- spawn/destroy churn
- component add/remove churn
- fanout across peers
- map storage vs sparse-set vs sparse-set plus archetype index
- example-derived ECS host movement, host sync, and client render paths

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

Example-derived benchmarks use `examples/ecs` protocol, prefab definitions, host movement logic,
full snapshot handshakes, dirty sync, and client render queries. They are the preferred regression
gate for user-visible performance because they measure the same world API shape developers copy from
the examples. Microbenchmarks are still useful for isolating storage and codec costs, but they should
not be treated as proof of end-to-end framework speed by themselves.

## Internal Architecture Notes

The current default storage is sparse-set component storage with an archetype query index:

- each component has dense entity and record arrays
- sparse entity-to-row maps provide O(1) membership lookup
- entity-to-component sets support destroy/remove enumeration
- single-component queries scan dense tables
- two-component queries use smallest sparse table lookup
- wider queries choose between archetype buckets and smallest sparse table

Snapshot writing uses pooled bit writers. Default all-visible dirty fanout can encode one update packet and reuse it across peers. Per-peer visibility paths reuse encoded packets when peer op sets are identical.

The package root intentionally does not export binary readers/writers, raw registry factories, packet codecs, low-level sync runtimes, storage classes, or public `World` constructors.

## Development Checks

```sh
pnpm typecheck
pnpm test
pnpm bench
pnpm build
pnpm example:simple:build
pnpm example:ecs:build
```

After `pnpm build`, audit the generated public declaration surface if you touch exports:

```sh
rg -n "createWorld|declare class World|BinaryReader|BinaryWriter|ComponentStorage|SparseSetComponentStorage|createSyncHost|createSyncClient" dist/index.d.mts
```

The command should not find those internal names.

## License

SnapScript is licensed under the GNU General Public License version 3. See [LICENSE](./LICENSE).
