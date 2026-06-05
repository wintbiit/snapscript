# SnapScript Protocol Project Example

This example shows the current generated project shape:

- `game.snap` is the root protocol source.
- `core/` is the platform-neutral game core package.
- `app/` is a browser/Vite platform package that depends on the core package.
- `node/` is a Node/WebSocket platform package used by tests.

```sh
pnpm --dir examples/protocol generate
pnpm --dir examples/protocol build
pnpm --dir examples/protocol dev
```

The core package contains:

- generated protocol, command, event, and registry files under `src/generated/`
- user endpoint handlers under `src/logic/server/` and `src/logic/client/`
- user systems under `src/systems/server/` and `src/systems/client/`
- assembled world factories in `src/create-server.ts` and `src/create-client.ts`

`game.snap` declares `world {}`, `peer {}`, and `entity Player {}` endpoints. Client code sends
commands through `commands.Player.Move(...)`; server code sends events through
`events.Player.MoveDisabled.sendTo(...)` or `.broadcast(...)`. Handler contexts use `ctx.source` and
`ctx.target` entity refs, with peer/session state represented by replicated PeerEntity instances.

The app and node packages supply platform concerns: WebSocket transport, clocks, tick loops, input,
and rendering. They do not own protocol definitions or gameplay RPC logic.
