# SnapScript Protocol Project Example

This example shows the confirmed project shape:

- `game.snap` is the root protocol source.
- `core/` is the platform-neutral game core package.
- `app/` is a browser/Vite platform package that depends on the core package.

```sh
pnpm --dir examples/protocol generate
pnpm --dir examples/protocol build
pnpm --dir examples/protocol dev
```

The core package contains:

- `src/generated/snapscript/protocol.ts` and `manifest.json`
- user RPC handlers under `src/rpc/server/` and `src/rpc/client/`
- generated registries under `src/generated/snapscript/rpc.ts` and `src/systems/generated/`
- `src/create-server.ts` and `src/create-client.ts`
- a test-only in-memory transport under `src/transport/memory.ts`

The app package supplies the platform layer: WebSocket transport, browser clock, tick loop, input
buttons, and rendering. It intentionally does not own protocol definitions or gameplay RPC logic.
