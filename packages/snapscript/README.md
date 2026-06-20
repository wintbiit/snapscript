# snapscript

Platform-agnostic TypeScript runtime for authoritative networked ECS state.

## Install

```sh
pnpm add snapscript
```

## Use

```ts
import {
  createClientWorld,
  createServerWorld,
  defineComponent,
  defineProtocol,
  u8,
} from "snapscript";
```

Most projects should use `.snap` generation through `snapscript-cli` or `create-snapscript`; direct
runtime APIs remain available for handwritten protocols and tests.

## Docs

- Repository: https://github.com/wintbiit/snapscript
- Main README: https://github.com/wintbiit/snapscript#readme

## License

Apache-2.0
