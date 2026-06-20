# SnapScript API Reference

Last reviewed: 2026-06-20

This document defines the intended user-facing API layers. The generated facade is the normal
project path. Lower-level world methods remain available for direct integrations, tests, and
examples.

## Generated Facade

Use generated facade files from `.snap` projects:

```ts
import { commands } from "./generated/commands";
import { entities } from "./generated/entities";
import { events } from "./generated/events";
import { streams } from "./generated/streams";
```

### Commands

Commands are client-to-server:

```ts
commands.World.StartGame(clientWorld, payload);
commands.Peer.Ready(clientWorld, payload);
commands.Player.Move(clientWorld, playerEntity, payload);
```

World commands target `WorldEntity`. Peer commands target the sending PeerEntity. Entity commands
target the provided entity ref.

### Events

Events are server-to-client:

```ts
events.World.GameStarted.broadcast(serverWorld, payload);
events.World.GameStarted.sendTo(serverWorld, peerEntities, payload);

events.Peer.Alert.broadcast(serverWorld, payload);
events.Peer.Alert.sendTo(serverWorld, peerEntities, payload);

events.Player.MoveDisabled.broadcast(serverWorld, sourceEntity, payload);
events.Player.MoveDisabled.sendTo(serverWorld, peerEntities, sourceEntity, payload);
```

`broadcast()` uses endpoint semantics: world events go to all connected peers, peer events use each
visible/interested PeerEntity as source and target, and gameplay entity events fan out only to peers
that can see the source entity. `sendTo()` is explicit point-to-point delivery to PeerEntity refs and
bypasses visibility filtering.

### Streams

Command streams are client-to-server input streams:

```ts
streams.Player.MoveStream(clientWorld, playerEntity, payload, clientTick, dtMs);
```

Stream calls enqueue samples. `ClientWorld.tick()` flushes dirty stream queues during the `network`
phase. Streams use the unreliable channel internally and have their own packet/ack path.

### Entities

Entity helpers find replicated entity refs without raw `{ id }` construction:

```ts
const allPlayers = entities.Player.all(clientWorld);
const myPlayers = entities.Player.mine(clientWorld);
const firstPlayer = entities.Player.first(clientWorld);
const firstMyPlayer = entities.Player.firstMine(clientWorld);
const isPlayer = entities.Player.has(clientWorld, entity);
const playerState = entities.Player.get(clientWorld, entity);
```

## World API

Projects create worlds directly or through generated core helpers:

```ts
const serverWorld = createServerWorld({ protocol, transport, clock });
const clientWorld = createClientWorld({ protocol, transport, clock });
```

The stable public world layer includes ECS and lifecycle operations:

- entity/component operations: `spawn`, `add`, `remove`, `destroy`, `get`, `getComponent`,
  `getPrefab`, `has`
- queries and systems: `query`, `each`, `system`, `tick`
- snapshot hooks: `onSnapshot`, `requestFullSnapshot`, `sendFullSnapshot`
- ownership and peer state: `setOwner`, `clearOwner`, `ownerOf`, `isOwner`, `ownedBy`, `myPeerId`,
  `myPeerEntity`, `peerId`, `peerStatus`, `isMine`
- visibility: `setVisible`, `clearVisible`

Endpoint RPC facade files call lower-level world methods such as `sendCommand`, `onCommand`,
`broadcastEvent`, `sendEventTo`, `broadcastPeerEvent`, `sendPeerEventTo`, `onEvent`,
`pushCommandStream`, and `onCommandStream`. These methods remain available for direct integrations,
but generated projects should prefer the facade.

The older direct helpers `send`, `on`, `broadcast`, and `sendTo` are not part of the public
`ServerWorld`/`ClientWorld` type surface. Handwritten protocols should use the endpoint-addressed
methods above with explicit `WorldEntity`, PeerEntity, or gameplay entity refs.

## Schema API

Handwritten protocols use schema and RPC definition helpers:

```ts
import {
  angle16,
  angle12,
  angle8,
  arrayOf,
  bool,
  bytesOf,
  defineCommand,
  defineComponent,
  defineEntity,
  defineEvent,
  defineProtocol,
  defineStream,
  enumOf,
  f32,
  flags,
  i16,
  i32,
  i8,
  qf32,
  stringOf,
  u16,
  u32,
  u8,
  varu32,
  vec2q,
  vec3q,
} from "snapscript";
```

## Transport API

Transports move packet bytes and channel labels. SnapScript does not implement WebSocket, WebRTC,
UDP, or engine-specific reliability:

```ts
import {
  createMemoryTransportPair,
  ServerPeerId,
  type ChannelName,
  type ClientTransport,
  type Clock,
  type Logger,
  type PeerId,
  type PeerRef,
  type ServerTransport,
} from "snapscript";
```

## Peer API

Peer connection state is represented by replicated PeerEntity instances with `PeerState`:

```ts
import { PeerState, PeerStatus, type PeerStatusValue } from "snapscript";
```

Use `world.peerId(peerEntity)` when gameplay code needs the numeric connection id.
