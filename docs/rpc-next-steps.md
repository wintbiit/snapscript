# RPC Next Steps

Last reviewed: 2026-06-05

This document tracks near-term RPC design work that is not part of the current generated facade.

## Raw Runtime API

The generated `.snap` facade is the primary project API:

```ts
commands.Player.Move(clientWorld, playerEntity, payload);
events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, payload);
events.Player.MoveDisabled.sendTo(serverWorld, peerEntity, playerEntity, payload);
```

The lower-level runtime API remains for direct integrations that do not use `.snap` generation, such
as tests, host-player scenarios, and minimal examples. It should stay small and strict:

- Contexts expose `source`, `target`, and `payload`; they do not expose `sender`.
- Client command sends throw before peer assignment.
- Docs should avoid teaching raw endpoint helpers as the normal project path.
- Future raw API naming should favor explicit endpoint words over overloaded verbs when possible.

Open tightening candidates:

- Require explicit payload objects at the raw world layer too.
- Rename raw endpoint send helpers to make source/target semantics clearer.
- Keep `defineCommand()` / `defineEvent()` documented only as direct-integration primitives.

## Command Stream

Command stream is still future work. It should be treated as a specialized input/move transport
mechanism, not as a synonym for ordinary unreliable command.

Relevant Unreal Engine takeaways:

- Unreal documents unreliable RPCs for high-frequency calls such as per-tick movement, while warning
  that reliable input-bound RPCs can overflow queues:
  <https://dev.epicgames.com/documentation/unreal-engine/networking-overview-for-unreal-engine>
- Unreal's movement model is more than "unreliable RPC": it batches/saves moves, tracks client time
  or sequence, receives server acknowledgement/correction, and replays unacknowledged local input for
  prediction.
- The Network Prediction plugin generalizes prediction-friendly gameplay systems, which supports
  treating command streams as a simulation input layer rather than an arbitrary RPC layer:
  <https://dev.epicgames.com/documentation/unreal-engine/API/PluginIndex/NetworkPrediction>

SnapScript direction:

- A normal `command ... unreliable` remains one command packet: send once, may drop, no built-in
  ack/replay semantics.
- A command stream is a new IDL declaration and a new runtime mechanism, not an opt-in mode on
  `command`.
- A command stream should share field codecs, endpoint routing, and endpoint validation with RPC, but
  it should use a separate packet type and dispatch path.
- Stream handlers should receive an ordered batch of samples or a stream context, not individual
  ad-hoc RPC invocations.

### IDL Shape

Use a dedicated `stream` keyword without a channel suffix:

```snap
entity Player {
  stream MoveStream(input: MoveInput)
}
```

Do not write:

```snap
entity Player {
  stream MoveStream(input: MoveInput) unreliable
}
```

Reason:

- Adding `unreliable` implies a future `reliable stream` option.
- The first stream model is inherently loss-tolerant and sequence-based.
- Stream reliability is defined by stream semantics: batching, sequence, duplicate/drop-old
  filtering, and optional future acknowledgement. It is not a normal RPC channel selector.

Generated facade:

```ts
streams.Player.MoveStream.push(clientWorld, playerEntity, {
  dx: 1,
  dy: 0,
});
```

Server handler:

```ts
export function MoveStream(
  world: ServerWorld,
  ctx: CommandStreamCtx<PlayerMoveStreamPayload>,
): void {
  for (const sample of ctx.samples) {
    sample.payload.dx;
    sample.sequence;
    sample.clientTick;
    sample.dtMs;
  }
}
```

`stream` is allowed under every endpoint declaration because every endpoint is represented by an
entity in the world model:

```snap
world {
  stream MatchInput(input: MatchInput)
}

peer {
  stream PeerInput(input: PeerInput)
}

entity Player {
  stream MoveStream(input: MoveInput)
}
```

There is no IDL-level distinction that makes one endpoint eligible and another ineligible. Project
authority rules remain handler/runtime policy.

### Runtime Packet

Use a new message type:

```ts
MessageType.CommandStream
```

Do not encode command streams as normal `MessageType.Rpc` packets.

The packet should include at least:

```ts
{
  streamId,
  sourceId,      // sending PeerEntity
  targetId,      // endpoint target entity
  baseSequence,
  samples: [
    { sequenceDelta, clientTickDelta, dtMs, payload },
  ],
}
```

The runtime can reuse:

- stream field codec generation
- source PeerEntity and target endpoint validation
- packet framing primitives
- logger/drop behavior

The runtime should not reuse:

- normal RPC packet type
- `CommandCtx<T>`
- `commands.*` facade
- normal RPC dispatch table

### Scope

First version:

- client-to-server only
- no correction
- no replay
- no server-to-client stream
- no reliable stream option
- no automatic conversion from unreliable command to stream
- fixed transport channel: `"unreliable"`
- no visibility/interest filtering on stream receive

Server receives batches, drops already processed sample sequences, and dispatches a stream context
once per decoded packet.

### Server Dispatch

Server handlers are called once per decoded packet with a batch:

```ts
export interface CommandStreamCtx<TPayload> {
  readonly source: ReadonlyEntityRef;
  readonly target: EntityRef;
  readonly samples: readonly CommandStreamSample<TPayload>[];
}

export interface CommandStreamSample<TPayload> {
  readonly sequence: number;
  readonly clientTick: number;
  readonly dtMs: number;
  readonly payload: Readonly<TPayload>;
}
```

Sequence is tracked per `(peer, target, streamId)`. This keeps independent streams from interfering
with each other and lets one peer stream to multiple controlled entities.

Default server behavior:

1. Decode packet.
2. Validate source PeerEntity and target endpoint type.
3. Drop samples whose `sequence <= lastProcessedSequence`.
4. Sort/keep remaining samples in sequence order.
5. Dispatch one batch to the handler.
6. Update `lastProcessedSequence`.
7. Send a minimal acknowledgement.

Visibility/interest is not part of command stream receive. It is a server-to-client fanout policy for
events and snapshots; streams are client-to-server input and should be validated by endpoint type,
ownership, possession, cooldowns, and gameplay authority instead.

### Client Buffering

First-version defaults:

- `maxSamplesPerPacket = 16`
- `maxPendingSamples = 64`
- `maxStreamsPerPeer = 32`

Rationale:

- `16` samples per packet covers short packet loss bursts without creating huge decode work.
- `64` pending samples gives roughly one second of 60 Hz input headroom before local dropping.
- `32` active streams per peer is enough for normal controlled entities/tools while bounding maps and
  memory.

The client sends `CommandStream` packets on the fixed `"unreliable"` channel. There is no generated
`flush()`, `clear()`, or `status()` API in the first version; the public facade only exposes
`push(...)`.

### Acknowledgement

First version includes a minimal ack, but still no correction/replay.

Ack purpose:

- let the client discard acknowledged pending samples precisely
- bound pending buffer growth without relying only on age/length
- give later prediction work a compatible foundation

Ack should report at least:

```ts
{
  streamId,
  targetId,
  lastProcessedSequence,
}
```

Ack is not a gameplay event and is not delivered through generated `events.*`.

### Directionality

SnapScript command streams should be one-way: client to server.

This keeps the model aligned with the rest of the framework:

- client to server: `command` and `stream`
- server to client: replicated state and `event`

Unreal has general RPC directions (`Server`, `Client`, and multicast RPCs) and movement/prediction
systems can send acknowledgements or corrective state back to the client. That does not mean its
movement input stream is symmetrical. In Character Movement, client moves are saved/batched and sent
to the server; server responses are acknowledgements or correction data, not the same bidirectional
stream abstraction. The newer Mover/Network Prediction model also treats prediction/correction as a
simulation timeline concern rather than a generic two-way RPC stream.

Remaining future options:

- Add stream declaration metadata later, such as custom sample limits or coalescing policy.
- Add a prediction/correction module above stream ack.
- Add diagnostics for dropped pending samples or stream-limit violations.
