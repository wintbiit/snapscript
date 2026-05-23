# Examples Validation

The examples are part of the architecture contract. They should prove that a developer can use SnapScript as a single-world networking framework without reaching into internals.

## Current Smoke Coverage

Run:

```sh
pnpm test:examples
```

The smoke test imports the example modules and runs host/client flows with in-memory transports:

- `examples/simple`
  - host creates one authoritative player
  - client receives the full snapshot
  - client sends `DamageCommand`
  - host mutates authoritative `NetRef.value`
  - client receives `DamageEvent` and updated replicated health

- `examples/ecs`
  - host creates player and NPC prefabs
  - host uses explicit all-visible interest policy
  - client receives replicated query rows
  - client sends movement and damage commands
  - host system and command handlers update components
  - client receives event state and can benchmark the same pair-`each()` render path used by UI snapshots

## API Friction Found

Before this pass, both examples constructed `WebSocketTransport` internally. That made them easy to run in a browser but hard to validate or adapt to another host engine.

The examples now accept injectable transport and clock objects while preserving the browser defaults:

```ts
const host = new HostDemo(customTransport, customClock);
const client = new ClientDemo(customTransport, customClock);
```

This matches the framework boundary:

- the host application creates and owns worlds
- transport reliability and connection lifetime stay outside SnapScript
- examples can run with WebSocket, in-memory tests, or engine adapters

## Use-Case Guardrails

Keep examples aligned with these user paths:

- first-time developer can copy the protocol/world setup into their own app
- host logic mutates only through world APIs and `NetRef.value`
- client logic cannot mutate replicated state
- transport adapters pass bytes and channel names without wrapping SnapScript packets in another framework protocol
- all-visible examples should use `visibility: "all"` instead of dummy peer-specific overrides
- examples exercise command/event/snapshot behavior, not only render UI
- batched snapshots stay opt-in until the example-derived benchmark shows a CPU win, not only a byte-size win
- repeated render/read loops should use `each()` rather than `query().map()` when they do not need to keep query tuples
- `query().map()` and `query().forEach()` are acceptable for ordinary readable code, but hot render/system paths should still graduate to `each()`
- repeated systems/render paths should reuse named query tuples so type inference and component-id caching both apply
- render loops should include all required components in the same `each()` query instead of doing per-row `get()` lookups
- helpers that only read replicated state should accept `ReplicatedStateReader`, so host/client rendering paths share one implementation without local casts
- example setup helpers should return concrete values instead of optional objects that require non-null assertions in copied user code

## Benchmark Mapping

Performance experiments should be tied back to those same user paths:

- `test/benchmark-examples.test.ts` is the example-derived gate. It imports the real
  `examples/ecs` protocol, components, and prefab definitions, then measures host movement,
  host-to-client snapshot sync, and client render queries through public world APIs.
- The benchmark has two modes when run on the current branch: `default-compatible`, which can be
  copied into a main-branch worktree for apples-to-apples comparison, and `batched-opt-in`, which
  tracks the negotiated batched snapshot path without making it the ECS example default.
- End-to-end rows are also split into `host tick send`, `client tick apply`, and client render rows.
  The split uses Tinybench hooks so packet generation for client-apply measurements is outside the
  timed section.
- `examples/ecs` host movement maps to `each+mutate`, `slot-backed world each+mutate`, and the SOA movement prototypes.
- `examples/ecs` UI rendering maps to `client readonly render views`, `client readonly each render views`, `client readonly pair query.forEach render views`, and `client readonly pair each render views`.
- the `batched-opt-in` benchmark mode maps to homogeneous `encode dirty batched`, host dirty fanout, and slot-backed host dirty fanout benchmarks.
- bitECS-inspired SOA prototypes are upper-bound comparisons only: they mutate entity-id indexed columns directly, while the public example must keep `world.each()`, readonly clients, dirty snapshots, and schema codecs.

Cross-branch example comparison:

```sh
BENCH_TIME_MS=100 BENCH_WARMUP_TIME_MS=20 pnpm bench:branch:compare -- --main D:\src\snapscript-main-bench --test-file test/benchmark-examples.test.ts
```

The compare script sets `SNAPSCRIPT_BRANCH_COMPARE=1`, so current-branch-only benchmark modes are
skipped while comparing against main.

When public APIs change, update the examples first, then run `pnpm test:examples`, `pnpm example:simple:build`, and `pnpm example:ecs:build`.
