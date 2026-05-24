# SnapScript Protocol IDL Example

This example shows the declaration-first workflow:

```sh
pnpm --dir examples/protocol generate
pnpm --dir examples/protocol build
```

`example.snap` is the source of truth. The generator writes:

- `generated/protocol.ts` - runtime definitions and typed RPC helpers
- `generated/manifest.json` - stable ids for diagnostics
- `snapscript.lock.json` - stable component/entity/RPC/field ids

`src/demo.ts` imports only the generated TypeScript and the public SnapScript world API. It creates a server world and a client world, spawns a generated `Player`, sends a generated `Movement.Move` command, and handles a generated `Movement.MoveDisabled` event through the generated `rpc` helpers.
