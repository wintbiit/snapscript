# Development Progress

Last reviewed: 2026-06-20

This document tracks the current implementation state and the next refactor direction. It is a
working project-status document, not a stable user guide.

## Current State

The current repo direction is TypeScript-first `.snap` protocol generation with endpoint-scoped RPC:

- `world {}` maps to `WorldEntity`.
- `peer {}` maps to replicated framework-created PeerEntity instances.
- `entity Name {}` maps to component-backed gameplay entities.
- `command` travels client to server.
- `event` travels server to client.
- `stream` travels client to server as an unreliable, sample-batched command stream.

There is no Rust or C# emitter in the current repo, and there is no implemented `facade_bindings`
feature. The implemented abstraction is the generated TypeScript facade:

- `commands.*`
- `events.*`
- `streams.*`
- `entities.*`

## Landed Work

### IDL And Generation

- The parser accepts `stream Name(args)` inside `world`, `peer`, and `entity` endpoint blocks.
- Manifest output includes `streams`.
- Protocol generation emits `defineStream()` definitions.
- Project generation emits `streams.ts` and `entities.ts`.
- Server registration includes command stream handlers.
- Create-only server logic stubs use `CommandStreamCtx<TPayload>` for stream handlers.
- Generated entity helpers expose `all()`, `mine()`, `first()`, `firstMine()`, `has()`, and `get()`.

### Runtime

- PeerEntity is the source for client-originated commands and streams.
- Client command sends throw before peer assignment.
- `ClientWorld.tick()` runs the `network` phase and flushes dirty command stream queues.
- Command stream packets use their own message type and ack message type.
- Command stream receive tracks sequence per `(peerEntity, target, stream)`.
- Duplicate/old stream samples are dropped.
- Stream handlers receive ordered sample batches.
- Minimal stream acknowledgements let clients discard acknowledged pending samples.
- Stream limits exist for `maxSamplesPerPacket`, `maxPendingSamples`, and `maxStreamsPerPeer`.
- Stream tests cover batching, ack, client stream overflow, server stream overflow logging,
  pending-sample trimming, max-samples-per-packet truncation, ack pruning across packets,
  duplicate/old sample filtering, and independent `(peerEntity, target, stream)` tracking.

### Event Semantics

- World event `broadcast()` sends to connected peers.
- Peer event `broadcast()` uses each receiving PeerEntity as source and target.
- Gameplay entity event `broadcast()` fans out through source visibility/interest.
- `sendTo()` remains explicit point-to-point delivery to PeerEntity refs and bypasses visibility.

### Documentation

- `protocol-idl.md` is the main IDL and generated-facade guide.
- `rpc-entity-model.md` remains the design decision record for endpoint-scoped RPC.
- `API.md` describes API layers and keeps generated facade as the recommended project path.
- `rpc-next-steps.md` was removed because it was a development-tracking note, not stable user docs.

## Known Gaps

### Raw World Surface

The package root does not export low-level sync runtimes. `ServerWorld` and `ClientWorld` now expose
only endpoint-addressed RPC helpers at the public type layer:

- endpoint methods: `sendCommand`, `onCommand`, `broadcastEvent`, `sendEventTo`,
  `broadcastPeerEvent`, `sendPeerEventTo`, `onEvent`, `pushCommandStream`, `onCommandStream`

The older direct helpers `send`, `on`, `broadcast`, and `sendTo` remain as implementation methods for
now but are no longer part of the public world interfaces. Generated projects should stay on facade
helpers, while handwritten protocols should use explicit source/target world methods.

### Stream Tests

The core stream runtime has coverage for batching, limits, ack pruning, old packet drops,
duplicate sample drops, and independent sequence keys. Remaining useful tests are now closer
to integration behavior:

- generated facade stream helpers in example projects
- client resend behavior when ack packets are lost
- command stream behavior under a lossy transport simulation

### Documentation Consistency

README still includes direct runtime sections for handwritten protocols. That is intentional, but the
facade path should remain visibly primary for `.snap` projects.

Docs should avoid teaching raw `{ id }` construction in generated-project examples.

### Public API Tightening

The first public API tightening pass removed older direct helpers from the public world interfaces.
The next decision is whether to delete the implementation methods too or keep them as internal
compatibility for tests and direct runtime experiments.

## Recommended Next Direction

### 1. Add Stream Facade Integration Tests

The core runtime behavior is now covered. The next stream tests should verify the generated
facade path:

- generated `streams.*.push()` and `streams.*.on()` helpers
- tick-phase flush through `ClientWorld.tick()`
- resend behavior when stream ack packets are dropped

This reduces risk before touching public world methods.

### 2. Finish Facade-Oriented API Separation

Keep the generated facade as the documented path for `.snap` projects:

- commands through `commands.*`
- events through `events.*`
- streams through `streams.*`
- entity lookup through `entities.*`

Direct runtime methods should stay explicit in docs and types:

- treat `sendCommand`, `onCommand`, `broadcastEvent`, `sendEventTo`, `broadcastPeerEvent`,
  `sendPeerEventTo`, `pushCommandStream`, and `onCommandStream` as endpoint-addressed low-level helpers
- keep generated project docs off the raw methods except in implementation notes

### 3. Decide The Breaking API Cleanup

Once tests are stronger, decide what to do with legacy implementation helpers:

- option A: delete `send/on/broadcast/sendTo` implementation methods
- option B: keep them private to tests/internal runtime experiments
- option C: reintroduce explicit direct-runtime names if handwritten protocols need a smaller API

Option B is lowest risk. Option A is cleanest but requires updating internal tests that intentionally
exercise generic sync runtime behavior.

### 4. Stream Semantics Beyond Transport

Do not add prediction/correction yet. The next stream work should stay mechanical:

- diagnostics for dropped pending samples
- diagnostics for stream overflow
- clearer ack behavior under packet loss
- possible generated stream config metadata later

Prediction, correction, replay, and rollback should remain above command streams until the core
transport behavior is boring and well tested.
