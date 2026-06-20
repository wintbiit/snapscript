# snapscript-cli

CLI for checking and generating SnapScript `.snap` protocol projects.

## Install

```sh
pnpm add -D snapscript-cli
```

## Use

```sh
snapscript check game.snap
snapscript generate game.snap --out src/generated
```

By default, `generate` writes the full project-style output: generated protocol files, facades,
registries, system registries, and create-only handler stubs.

## Docs

- Repository: https://github.com/wintbiit/snapscript
- Protocol IDL: https://github.com/wintbiit/snapscript/blob/master/docs/protocol-idl.md

## License

Apache-2.0
