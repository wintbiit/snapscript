# Framework Audit

Last reviewed: 2026-05-24

## Current Status

SnapScript is now shaped as a single-world-entry networking framework:

- public entrypoints are `createHostWorld()` and `createClientWorld()`
- there is no public `createWorld()`, `World` constructor, game object, or app wrapper
- host/client roles are fixed at construction time
- transports pass raw `Uint8Array` packets plus channel labels; reliability belongs to the host layer
- default visibility is all-visible, with host-owned overrides and interest hooks when needed
- clients read replicated state through read-only refs
- high-frequency reads can share `ReplicatedStateReader`

The current default ECS storage is sparse-set component storage with an archetype query index. SoA,
slot-backed refs, and bitECS replacement are paused; they remain future experiments only if
example-derived benchmarks prove a broad win.

## Evidence

Verification commands used for this review:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:examples
pnpm bench
rg -n "createWorld|declare class World|BinaryReader|BinaryWriter|ComponentStorage|SparseSetComponentStorage|createSyncHost|createSyncClient" dist/index.d.mts
```

The declaration audit should return no matches.

Important coverage:

- `test/public-api.test.ts` protects the root export surface and package exports.
- `test/types.test.ts` protects host/client directionality and type-only ergonomics.
- `test/game-world.test.ts` covers construction errors, frozen worlds, read-only clients, visibility,
  packet boundaries, snapshot hooks, and world-driven sync.
- `test/ecs.test.ts` covers sparse-set storage, archetype consistency, query helpers, `each()`,
  systems, prefab sugar, and snapshot round trips.
- `test/runtime.test.ts` covers RPC, dirty sync, visibility reconciliation, channel splitting, and
  batched snapshot negotiation/fallback.
- `test/benchmark-examples.test.ts` is the merge gate for real example-derived performance paths.

## Completed Goals

- Framework boundary is explicit in README and tests.
- Host/client world construction is the only runtime entry model.
- Transport does not rewrap or implement reliability protocol.
- Interest management defaults to visible-all and remains host-defined.
- Prediction/interpolation/rollback are documented as host policy with framework hooks only.
- Public API remains small: `spawn/add/get/remove/destroy/query/each/system/tick` plus RPC/snapshot
  hooks.
- User-facing docs now include install, get started, examples, boundary, roles, ECS API, transport,
  visibility, performance, development checks, and license.
- GPLv3 full license text is present.
- Experimental SOA/bitECS branches and cross-workspace benchmark scripts have been removed from the
  active worktree.

## Remaining Risks

- Batched dirty snapshots reduce bytes and can improve client apply, but host send CPU is not a
  broad win in the ECS example. It should stay opt-in.
- Archetype indexing improves sparse/wide queries but adds structural churn cost. This is acceptable
  for query-heavy worlds, but high-churn games may need an internal tuning switch later.
- Benchmark output is still console-oriented. Long-term regression tracking would benefit from a
  committed JSON summary or CI artifact comparison.
- Prediction/interpolation/rollback foundation is mostly boundary documentation and hooks. Real
  game-facing helper utilities are not implemented yet.

## Recommended Next Work

1. Add a benchmark summary artifact or threshold reporter for `test/benchmark-examples.test.ts`.
2. Keep optimizing only real hot paths proven by the ECS example: `each()`, read-only render views,
   dirty encode, fanout reuse, and client apply.
3. Add small host-policy helpers only when examples show repeated friction.
4. Keep SoA, slot refs, and bitECS as separate spikes unless they beat the current mainline in
   example-derived benchmarks without making the public API harder.
