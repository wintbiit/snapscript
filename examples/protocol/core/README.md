# Protocol Core Example

This package is the platform-neutral game core for `examples/protocol`.

- `../game.snap` is the schema source.
- `src/generated/` is code-generated and should not be edited.
- `src/logic/server/*.ts` contains command handlers.
- `src/logic/client/*.ts` contains event handlers.
- `src/systems/server` and `src/systems/client` contain user-owned systems.
- `src/create-server.ts` and `src/create-client.ts` provide assembled world factories.

Run `pnpm generate` after editing `../game.snap`.

RPC calls use generated short facades:

```ts
commands.Player.Move(clientWorld, playerEntity, { dx: 1, dy: 0 });
events.Player.MoveDisabled.sendTo(serverWorld, peerEntity, playerEntity, { disabled: true });
```

Generated handlers receive `(world, ctx)`. `ctx.source` and `ctx.target` are entity refs; for client
commands, `ctx.source` is the sending PeerEntity. Use `world.peerId(ctx.source)` only when numeric
peer ids are needed.
