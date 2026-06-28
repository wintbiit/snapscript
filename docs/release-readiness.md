# Release Readiness

Last reviewed: 2026-06-28

This document tracks the current npm release gate for SnapScript.

## Target Release

- Version: `0.3.0`
- Packages:
  - `snapscript`
  - `snapscript-cli`
  - `create-snapscript`
- Runtime target: Node.js `>=20`
- Publish access: public

## Release Gate

`pnpm release:check` is the required local gate before publishing. It runs:

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:examples`
- package tarball dry-run checks
- real tarball install smoke in a temporary consumer project
- `snapscript` import smoke
- `snapscript check`
- `snapscript generate`
- `create-snapscript` scaffold smoke
- generated project `pnpm install && pnpm build`

## Current Publish Shape

- Package versions are aligned at `0.3.0`.
- Published manifests use normal semver ranges instead of `workspace:*`.
- Local workspace installs use `.npmrc` with `link-workspace-packages=true`.
- Package metadata includes `repository`, `homepage`, `bugs`, `keywords`, and `engines`.
- Package tarballs include package-level `README.md`, `LICENSE`, `dist/**`, and `package.json`.
- `create-snapscript` emits generated core packages that depend on `snapscript` and
  `snapscript-cli` `^0.3.0`.
- `create-snapscript` scaffold tests use generated entity refs and avoid raw numeric entity ids.

## Manual Publish Steps

Run these from the repository root:

```sh
npm view snapscript version dist-tags --json
npm view snapscript-cli version dist-tags --json
npm view create-snapscript version dist-tags --json
pnpm release:check
```

If the release gate passes:

```sh
npm publish packages/snapscript --access public
npm publish packages/snapscript-cli --access public
npm publish packages/create-snapscript --access public
git tag v0.3.0
git push origin master
git push origin v0.3.0
```

Then verify the published path from a clean directory:

```sh
node -e "import('snapscript').then(m => console.log(typeof m.createServerWorld))"
npx snapscript check path/to/game.snap
npm create snapscript@latest my-game-core
cd my-game-core
pnpm install
pnpm build
```

## Release Notes

- `0.3.0` requires public world APIs to receive entity refs instead of numeric entity ids.
- Ownership APIs use PeerEntity refs for peer ownership assignment.
- Manual protocol construction remains available through `defineProtocol()` for non-IDL examples.
