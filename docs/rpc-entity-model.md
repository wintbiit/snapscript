# Endpoint-Scoped RPC Model

Last reviewed: 2026-06-20

This document records the current endpoint-scoped RPC design for SnapScript. The model replaced the
older service-scoped RPC shape; compatibility with that previous shape is not a goal.

## Decision

SnapScript RPC is declared on protocol endpoints:

- `world {}` declares global endpoint components and global RPC endpoints.
- `peer {}` declares per-peer endpoint components and peer RPC endpoints.
- `entity Name {}` declares gameplay entity components and gameplay RPC endpoints.

Commands, events, and streams are still directional:

- `command` is client-originated and server-received.
- `event` is server-originated and client-received.
- `stream` is client-originated, server-received, unreliable, and sample-batched.

Execution remains world-authoritative. RPC declarations are scoped to endpoints, but user logic is
still plain functions called by generated world registries. SnapScript does not introduce service
classes, entity methods, rooms, apps, or request/response RPC.

## IDL Shape

The schema keeps a small vocabulary:

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

component Position {
  x: qf32(min: -128, max: 128, precision: 0.01, default: 0)
  y: qf32(min: -128, max: 128, precision: 0.01, default: 0)
}

component Health {
  hp: u16(100)
}

entity Player {
  position: Position
  health: Health

  command Move(dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)) unreliable
  stream MoveStream(dx: qf32(min: -1, max: 1, precision: 0.01, default: 0))
  event MoveDisabled(disabled: bool(default: false)) reliable
}
```

RPC is not declared in an external `service {}` block. Endpoint blocks contain only component
references, commands, events, and streams. They do not implicitly generate endpoint components from
inline fields.

Do not add policy keywords such as `ownerOnly`, `anyClient`, `broadcast`, `toOwner`, `toSender`, or
`multicast` to the IDL. Authorization and fanout policy are expressed by generated helpers, world
APIs, and user gameplay logic.

## Endpoint Semantics

`world {}` maps to the reserved `WorldEntity`.

- It is a singleton endpoint.
- It represents global replicated gameplay state and global RPC endpoints.
- It is server-owned, always exists, and cannot be destroyed by user code.
- World commands are allowed. They represent client-originated global intent addressed to
  `WorldEntity`.

`peer {}` maps to framework-created `PeerEntity` instances.

- Each connected peer has one replicated `PeerEntity`.
- The `PeerEntity` is the peer/session anchor inside the ECS world.
- It is owned by that peer and visible to that peer.
- It always has the built-in replicated `PeerState` component, including `peerId` and `status`.
- On disconnect, `PeerState.status` is marked disconnected instead of destroying the entity immediately.
- The peer id is available through `world.peerId(peerEntity)`, not as a loose RPC context primitive.
- Transport connection metadata and reconnect/session details belong to the peer endpoint and
  internal peer APIs.

`entity Name {}` maps to ordinary replicated gameplay entities.

- Commands are addressed to an instance of that entity type.
- Events are emitted by or about an instance of that entity type.
- Runtime dispatch validates that the target/source entity matches the declared endpoint type.

## Context Types

Commands and events use separate context types:

```ts
interface CommandCtx<TPayload> {
  readonly payload: TPayload;
  readonly source: ReadonlyEntityRef;
  readonly target: EntityRef;
  readonly tick: number;
  readonly rpc: RpcDefinition;
  readonly channel: ChannelName;
}

interface EventCtx<TPayload> {
  readonly payload: TPayload;
  readonly source: ReadonlyEntityRef;
  readonly target: ReadonlyEntityRef;
  readonly tick: number;
  readonly rpc: RpcDefinition;
  readonly channel: ChannelName;
}
```

`source` and `target` are always present:

- A peer command to world has `source = sending PeerEntity` and `target = WorldEntity`.
- A peer command to peer has `source = sending PeerEntity` and `target = that same PeerEntity`.
- A peer command to a gameplay entity has `source = sending PeerEntity` and `target = gameplay entity`.
- A world event to a peer has `source = WorldEntity` and `target = receiving PeerEntity`.
- A peer event has `source = receiving PeerEntity` and `target = receiving PeerEntity`.
- A gameplay event has `source = gameplay entity` and `target = receiving PeerEntity`.

There is no `ctx.sender`. The numeric peer id is not a general RPC context field. If a project needs
it, it should call `world.peerId(peerEntity)`.

## Handler Shape

Generated handlers are plain functions:

```ts
export function moveCommand(
  world: ServerWorld,
  ctx: CommandCtx<PlayerMovePayload>,
): void {
  const { dx, dy } = ctx.payload;
  if (!world.isOwner(ctx.source, ctx.target)) {
    return;
  }
  void dx;
  void dy;
}

export function moveDisabledEvent(
  world: ClientWorld,
  ctx: EventCtx<PlayerMoveDisabledPayload>,
): void {
  const { disabled } = ctx.payload;
  void world;
  void disabled;
}
```

Payload fields are not expanded into trailing handler parameters. The payload object remains the
single source of decoded RPC data through `ctx.payload`.

## Generated Helpers

The generated facade should group callable RPC by endpoint:

```ts
commands.World.StartGame(clientWorld, payload);
events.World.GameStarted.broadcast(serverWorld, payload);

commands.Peer.Ready(clientWorld, payload);
events.Peer.Alert.sendTo(serverWorld, targets, payload);

commands.Player.Move(clientWorld, playerEntity, payload);
events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, payload);
events.Player.MoveDisabled.sendTo(serverWorld, targets, playerEntity, payload);
```

Event helpers must support:

- `broadcast(serverWorld, ...)`
- `sendTo(serverWorld, targetOrTargets, ...)`, where the target may be one `PeerEntity` or an array
  of `PeerEntity` refs.

`broadcast()` means the framework chooses the connected peers that should receive the event:

- `events.World.*.broadcast()` sends to all connected peers. `WorldEntity` is always visible.
- `events.Peer.*.broadcast()` sends one packet per currently visible/interested PeerEntity, using
  each receiver's PeerEntity as both source and target.
- `events.<Entity>.*.broadcast()` sends only to peers for which the source entity is currently
  visible/interested.
- `sendTo(peerEntity)` is explicit point-to-point delivery and does not apply visibility filtering.

Visibility/interest is a runtime fanout policy, not an IDL keyword.

The generated user-facing API should not export standalone raw RPC definitions such as `PlayerMove`.
Generated payload/context types may be exported for handler typing, but command/event/stream usage
should go through the endpoint facade.

## Runtime Validation

The runtime/generator should validate mechanical invariants before calling user handlers:

- command source is resolved from the transport connection and canonical `PeerEntity`
- command target exists
- event source exists
- source/target entity type matches the endpoint that declared the RPC
- payload decodes successfully
- RPC direction matches command/event/stream usage

Entity type validation failures are logged with `logger.warn` and the packet is dropped. They should
not throw into user handler code.

Endpoint type validation uses the entity declaration's component set. In runtime terms,
`Player.Move` is valid for a target only when `world.has(target, Player)` is true. Missing source or
target entities are also logged with `logger.warn` and dropped before user handlers run.

Gameplay authorization is still user logic. SnapScript does not implicitly enforce owner-only
commands. Generated stubs may show `world.isOwner(ctx.source, ctx.target)` as a common pattern, but
some commands intentionally target `world {}`, `peer {}`, non-owned entities, or project-specific
control relationships.

Ownership APIs must accept PeerEntity refs, not numeric peer ids:

```ts
world.setOwner(entity, peerEntity);
world.isOwner(peerEntity, entity);
world.ownedBy(peerEntity);
world.peerId(peerEntity);
world.peerStatus(peerEntity);
```

Numeric peer-id overloads should be removed from the public API to avoid two parallel ownership
models.

## PeerEntity Lifecycle

PeerEntity is replicated and durable across disconnect handling:

1. Server accepts a peer and creates/assigns a `PeerEntity`.
2. The `PeerEntity` is synchronized to the owning client with the built-in replicated `PeerState`
   component.
3. User code may attach peer/session components declared by `peer {}`.
4. On disconnect, the framework marks `PeerState.status` disconnected.
5. Project code decides whether later systems remove, archive, or reuse the disconnected peer state.

This keeps peer/session data in the ECS world instead of splitting it into ad hoc server maps.

## Deterministic IDs

Generated ids remain declaration-order based:

- Component ids follow component declaration order.
- Gameplay entity ids follow entity declaration order, with reserved world/peer endpoint ids defined
  by the runtime.
- RPC ids share one namespace and follow endpoint declaration order, then RPC declaration order
  inside each endpoint.
- Field ids follow payload field order.

Reordering declarations or fields is a breaking protocol change.

## Migration Stance

This model intentionally breaks the previous service-scoped RPC design:

```snap
service Movement {
  command Move(input: MoveInput) unreliable
}
```

The replacement is endpoint-scoped:

```snap
entity Player {
  command Move(input: MoveInput) unreliable
}
```

There is no compatibility layer, no legacy facade, and no standalone raw definition export such as
`PlayerMove` in the user-facing generated API. The public API should be redesigned around `world {}`,
`peer {}`, entity-scoped RPC, `CommandCtx<TPayload>`, `EventCtx<TPayload>`, `source`/`target`, and
PeerEntity refs.

Low-level raw send/on primitives may remain inside the runtime for generated facades and direct
integrations that do not use `.snap`, but they are not the primary public docs model. Any exposed raw
surface should be strict, small, and built on the same endpoint-addressed envelope.

## Related Work

Command stream is a separate client-to-server mechanism for high-frequency input. It uses `stream`
declarations, the generated `streams.*` facade, `CommandStreamCtx<TPayload>`, and
`MessageType.CommandStream`. The first version provides unreliable sample batching, sequence
filtering, pending-sample limits, and minimal acknowledgements. It does not implement prediction,
correction, or replay.

Visibility/interest-aware event fanout is part of endpoint event broadcast: `events.World.*.broadcast()`
sends to all connected peers, `events.<Entity>.*.broadcast()` sends only to peers that can see the
source entity, and `sendTo(peerEntity)` remains explicit point-to-point delivery.
