# SnapScript API Reference

Last reviewed: 2026-06-28

This document defines the intended user-facing API layers. The generated facade is the normal
project path. Handwritten protocols may use the public world RPC methods directly. Packet codecs,
storage internals, and low-level sync runtimes are not part of the public package entrypoint.

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

Public world methods accept entity refs such as `WorldEntity`, `ctx.source`, `ctx.target`, query
rows, and generated `entities.*` results. They do not accept numeric entity ids as entity inputs.
If a protocol payload carries an entity id, resolve it to an entity ref before calling world APIs.

## World API

Projects create worlds directly or through generated core helpers:

```ts
const serverWorld = createServerWorld({ protocol, transport, clock });
const clientWorld = createClientWorld({ protocol, transport, clock });
```

Both world factories also accept `localComponents` for non-replicated ECS state:

```ts
const ServerOnly = defineComponent("ServerOnly", { value: u32(0) }, { replicated: false });

const serverWorld = createServerWorld({
  protocol,
  localComponents: [ServerOnly],
  transport,
  clock,
});
```

`localComponents` accepts only `replicated: false` schemas. It rejects duplicate component ids and
ids that collide with protocol components. Local components do not affect protocol hashes,
manifests, wire registries, or generated code.

The stable public world layer includes ECS and lifecycle operations:

- entity/component operations: `spawn`, `add`, `remove`, `destroy`, `get`, `getComponent`,
  `getPrefab`, `has`
- queries and systems: `query`, `each`, `system`, `tick`
- snapshot hooks: `onSnapshot`, `requestFullSnapshot`, `sendFullSnapshot`
- ownership and peer state: `setOwner`, `clearOwner`, `ownerOf`, `isOwner`, `ownedBy`, `myPeerId`,
  `myPeerEntity`, `peerId`, `peerStatus`, `isMine`
- visibility: `setVisible`, `clearVisible`

Ownership APIs that name a peer use PeerEntity refs, not numeric peer ids. Use `world.peerId(peerEntity)`
only when gameplay code needs to display or persist the numeric connection id.

Endpoint RPC facade files call public world methods such as `sendCommand`, `onCommand`,
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

`defineComponent()` accepts an optional `replicated` flag:

```ts
const Health = defineComponent("Health", { hp: u16(100) });
const ServerAi = defineComponent("ServerAi", { targetId: u32(0) }, { replicated: false });
```

`replicated` defaults to `true`. Replicated components may be used in `.snap` output or
`defineProtocol({ components, prefabs })`. Non-replicated components are never protocol members and
must be registered through `localComponents`.

`.snap component` declarations are always replicated network state. The IDL intentionally rejects a
`replicated` argument or metadata switch; use TypeScript for server-only or client-only components.

Server worlds can create and mutate replicated and local components through the same `spawn`, `add`,
`remove`, `destroy`, `get`, `has`, `query`, and `each` methods. Client worlds can create and mutate
only local components and pure local entities; replicated state remains read-only and attempts to
mutate replicated entities throw at runtime.

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
