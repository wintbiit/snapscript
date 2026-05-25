# Protocol Core Example

This package is the platform-neutral game core for `examples/protocol`.

- `../game.snap` is the schema source.
- `src/generated/snapscript/` is generated and should not be edited.
- `src/rpc/server` and `src/rpc/client` contain user-owned RPC logic.
- `src/systems/server` and `src/systems/client` contain user-owned systems.
- `src/transport/memory.ts` is only for tests.

Run `pnpm generate` after editing `../game.snap`.
