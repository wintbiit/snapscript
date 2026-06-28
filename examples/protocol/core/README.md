# Protocol Core Example

This package is the platform-neutral game core for `examples/protocol`.

- `../game.snap` is the schema source.
- `src/generated/` is code-generated and should not be edited.
- `src/logic/server/*.ts` contains command and command-stream handlers.
- `src/logic/client/*.ts` contains event handlers.
- `src/systems/server` and `src/systems/client` contain user-owned systems.
- `src/create-server.ts` and `src/create-client.ts` provide assembled world factories.

Run generation after editing `../game.snap`:

```sh
pnpm generate
```

## Generated Facades

RPC calls use generated short facades:

```ts
const playerEntity = entities.Player.first(clientWorld);
if (playerEntity === undefined) throw new Error("Player is not replicated yet");

commands.Player.Move(clientWorld, playerEntity, { dx: 1, dy: 0 });
streams.Player.MoveStream(clientWorld, playerEntity, { dx: 1, dy: 0 }, clientTick, dtMs);

events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, { disabled: true });
events.Player.MoveDisabled.sendTo(serverWorld, peerEntity, playerEntity, { disabled: true });
```

`entities.*` reads entity refs from replicated client state. Generated project code should not
construct raw `{ id }` refs or pass numeric entity ids into world APIs.

## Handler Shape

Generated handlers receive `(world, ctx)`:

```ts
export function Move(world: ServerWorld, ctx: CommandCtx<PlayerMovePayload>): void {
  if (!world.isOwner(ctx.source, ctx.target)) {
    return;
  }
}
```

`ctx.source` and `ctx.target` are entity refs. For client commands and streams, `ctx.source` is the
sending PeerEntity. Use `world.peerId(ctx.source)` only when numeric peer ids are needed.

Command stream handlers receive `CommandStreamCtx<TPayload>` and iterate `ctx.samples`.
