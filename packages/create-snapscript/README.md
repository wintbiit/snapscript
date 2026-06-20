# create-snapscript

Scaffold a platform-neutral SnapScript game core package.

## Use

```sh
npm create snapscript@latest my-game-core
```

Use an existing schema without copying it:

```sh
npm create snapscript@latest my-game-core -- --schema ../game.snap
```

The generated package owns protocol definitions, generated facades, server/client world factories,
systems, tests, and RPC handlers. Platform projects provide transport, clocks, input, rendering, and
deployment.

## Docs

- Repository: https://github.com/wintbiit/snapscript
- Main README: https://github.com/wintbiit/snapscript#readme

## License

Apache-2.0
