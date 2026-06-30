# SnapScript

SnapScript is a platform-agnostic TypeScript framework for authoritative networked ECS state.

It gives a server process one authoritative world and gives clients replicated read-only worlds.
Rendering, physics, input, matchmaking, persistence, deployment, and real transport reliability stay
in your engine or platform layer.

## Packages

- `snapscript` — runtime ECS, schema helpers, protocol definitions, worlds, transports, and RPC types.
- `snapscript-cli` — `.snap` protocol check/generate CLI.
- `create-snapscript` — scaffold for a platform-neutral generated game core package.

## Install

```sh
pnpm add snapscript
```

For a new `.snap`-driven core package:

```sh
npm create snapscript@latest my-game-core
cd my-game-core
pnpm install
pnpm build
```

For local development in this repository:

```sh
pnpm install
pnpm build
pnpm test
```

## Get Started

Start with a generated game core package. The core owns replicated protocol, endpoint RPC wiring,
systems, and tests. Your browser, Node, Puerts, Unity, Unreal, or custom server project owns the
transport adapter, tick loop, input, rendering, persistence, and deployment.

```txt
my-game-core/
  game.snap
  src/
    generated/              # generated protocol, facades, manifest, registries
    logic/server/           # command and command-stream handlers
    logic/client/           # event handlers
    systems/                # server/client systems
    create-server.ts        # assembled server world factory
    create-client.ts        # assembled client world factory
```

`game.snap` is the protocol source of truth:

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

struct MoveInput {
  dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)
  dy: qf32(min: -1, max: 1, precision: 0.01, default: 0)
}

component Position {
  x: qf32(min: -128, max: 128, precision: 0.01, default: 0)
  y: qf32(min: -128, max: 128, precision: 0.01, default: 0)
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

Endpoint blocks define routing:

- `world {}` maps to the reserved `WorldEntity`.
- `peer {}` maps to one replicated PeerEntity per connected peer.
- `entity Player {}` maps to replicated gameplay entities with the declared component set.

Every `component` declared in `.snap` is replicated network state and is readable on clients after it
is synchronized. The IDL does not support `replicated` or local-only metadata. Keep server-only or
client-only ECS state in TypeScript with `defineComponent(..., { replicated: false })` and register
it through `localComponents` when creating a world.

RPC direction is fixed by keyword:

- `command` travels client to server.
- `event` travels server to client.
- `stream` travels client to server as an unreliable, sample-batched command stream.

Run generation after changing the schema:

```sh
pnpm generate
```

Generation overwrites only mechanical files under `src/generated/`. User logic stubs are create-only,
so edits under `src/logic/` and `src/systems/` are kept.

## Generated Facade

Application code should use the generated facade:

```ts
import { commands } from "./generated/commands";
import { entities } from "./generated/entities";
import { events } from "./generated/events";
import { streams } from "./generated/streams";

const playerEntity = entities.Player.first(clientWorld);
if (playerEntity === undefined) throw new Error("Player is not replicated yet");

commands.Player.Move(clientWorld, playerEntity, { dx: 1, dy: 0 });
streams.Player.MoveStream(clientWorld, playerEntity, { dx: 1, dy: 0 }, clientTick, dtMs);

events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, { disabled: true });
events.Player.MoveDisabled.sendTo(serverWorld, peerEntity, playerEntity, { disabled: true });
events.World.GameStarted.broadcast(serverWorld, {});
```

`entities.*` reads entity refs from replicated client state. Generated project code should not need
to construct raw `{ id }` refs. `events.*.sendTo()` accepts PeerEntity refs, not numeric peer ids.

Stream calls enqueue samples. `ClientWorld.tick(deltaTime)` flushes dirty stream queues during the
`network` phase, so multiple samples pushed in one frame can be batched into one command-stream
packet. `deltaTime` is measured in milliseconds.

## Handler Shape

Generated handlers receive `(world, ctx)`:

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

`ctx.source` and `ctx.target` are entity refs:

- client-originated commands and streams use the sending PeerEntity as `source`;
- world commands target `WorldEntity`;
- peer commands target the sending PeerEntity;
- entity commands target the gameplay entity passed to the facade;
- client events target the receiving PeerEntity.

There is no generated `ctx.sender`. Use `world.peerId(peerEntity)` only when gameplay code needs the
numeric connection id.

## Event Fanout

`broadcast()` uses endpoint semantics:

- `events.World.*.broadcast()` sends to all connected peers.
- `events.Peer.*.broadcast()` sends one event per visible/interested PeerEntity, using each receiver's
  PeerEntity as both source and target.
- `events.<Entity>.*.broadcast()` sends only to peers that can currently see the source entity.
- `sendTo()` is explicit point-to-point delivery to PeerEntity refs and bypasses visibility filtering.

Endpoint type checks happen before user handlers run. If a packet targets the wrong endpoint type,
SnapScript logs `logger.warn` and drops it. Ownership, cooldowns, possession, and gameplay
permissions remain user logic.

## Platform Integration

Create worlds explicitly in platform code or generated core helpers:

```ts
const serverWorld = createServerWorld({
  protocol,
  transport: serverTransport,
});

const clientWorld = createClientWorld({
  protocol,
  transport: clientTransport,
});
```

Local components use the same ECS API as replicated components, but they never enter the protocol
manifest or snapshot stream:

```ts
const ServerAiState = defineComponent(
  "ServerAiState",
  { targetId: u32(0) },
  { replicated: false },
);

const serverWorld = createServerWorld({
  protocol,
  localComponents: [ServerAiState],
  transport: serverTransport,
});

const ai = serverWorld.spawn();
serverWorld.add(ai, ServerAiState, { targetId: 0 });
```

`replicated` defaults to `true` for `defineComponent()`. `defineProtocol()` rejects non-replicated
components and prefabs; pass them through `localComponents` instead. Pure local entities are omitted
from snapshots until a replicated component is added. When the last replicated component is removed,
the remote network entity is destroyed.

Transports move packet bytes and channel labels:

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

- control packets and structural snapshots use `reliable`;
- update-only dirty snapshots use `unreliable`;
- commands and events use the channel declared in the protocol;
- command streams use `unreliable` internally.

SnapScript does not implement WebSocket, WebRTC, UDP, Steam networking, prediction, rollback,
matchmaking, accounts, or deployment.

## Manual Protocol API

Most projects should use `.snap` generation. Small integrations and focused examples can also write
the protocol in TypeScript with `defineProtocol()` and the same public world API:

```ts
import {
  WorldEntity,
  createClientWorld,
  createServerWorld,
  defineCommand,
  defineComponent,
  defineProtocol,
  u8,
} from "snapscript";

const MatchState = defineComponent("MatchState", {
  phase: u8(0),
});

const StartGame = defineCommand("World.StartGame", {}, { channel: "reliable" });

const protocol = defineProtocol({
  components: { MatchState },
  commands: { StartGame },
});

const serverWorld = createServerWorld({ protocol, transport: serverTransport });
const clientWorld = createClientWorld({ protocol, transport: clientTransport });

serverWorld.add(WorldEntity, MatchState);

serverWorld.onCommand(StartGame, (ctx) => {
  const state = serverWorld.get(ctx.target, MatchState);
  if (state === undefined) return;
  state.phase.value = 1;
});

// Send after the client has completed the SnapScript hello/full-snapshot handshake.
clientWorld.sendCommand(WorldEntity, StartGame, {});
```

Handwritten protocols may still use local components:

```ts
const DebugTag = defineComponent("DebugTag", { color: u8(0) }, { replicated: false });

const clientWorld = createClientWorld({
  protocol,
  localComponents: [DebugTag],
  transport: clientTransport,
});
```

Do not put `DebugTag` in `defineProtocol({ components })`; non-replicated components are private to
the world instance that registers them.

Generated projects should prefer `commands.*`, `events.*`, `streams.*`, and `entities.*`. The package
root intentionally does not export packet codecs, binary readers/writers, storage classes, low-level
sync runtimes, or public world constructors.

Public world methods accept entity refs such as `WorldEntity`, `ctx.source`, `ctx.target`, query
results, or generated `entities.*` results. They do not accept numeric entity ids as entity inputs.
Numeric ids may still appear inside your own payload fields when your protocol explicitly declares
them, but those ids should be resolved to entity refs before calling world APIs.

## Documentation

- [Docs index](docs/README.md)
- [API reference](docs/API.md)
- [Protocol IDL](docs/protocol-idl.md)
- [RPC design record](docs/rpc-entity-model.md)
- [Protocol project example](examples/protocol/README.md)

## Examples

```sh
pnpm --dir examples/protocol generate
pnpm --dir examples/protocol build
```

Repository checks:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:examples
```

## License

SnapScript is licensed under the Apache License 2.0. See [LICENSE](./LICENSE) for the full license
text.
