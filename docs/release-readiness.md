# Release Readiness

Last reviewed: 2026-06-21

This document tracks the first public npm release plan for SnapScript.

## Target Release

- Version: `0.1.0`
- Packages:
  - `snapscript`
  - `snapscript-cli`
  - `create-snapscript`
- Runtime target: Node.js `>=20`
- Publish access: public

Registry checks on 2026-06-21 returned `E404` for all three package names, so the names appeared
unclaimed at review time. Recheck immediately before publishing.

## Completed Release Prep

- Package versions are aligned at `0.1.0`.
- Published manifests use normal semver ranges instead of `workspace:*`.
- Local workspace installs use `.npmrc` with `link-workspace-packages=true`.
- Package metadata includes `repository`, `homepage`, `bugs`, `keywords`, and `engines`.
- Package tarballs include package-level `README.md` and `LICENSE`.
- `create-snapscript` emits generated core packages that depend on `snapscript` and
  `snapscript-cli` `^0.1.0`.
- `create-snapscript` scaffold tests avoid raw entity ids and do not assume unimplemented handler
  side effects.
- Root scripts include:
  - `pnpm pack:dry-run`
  - `pnpm release:check`

## Release Gate

`pnpm release:check` is the local gate before publishing. It runs:

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

Latest result on 2026-06-21: passed.

## Current Publish Shape

Latest `npm pack --dry-run --json` output:

- `snapscript@0.1.0`: 7 entries, about 127 kB packed, about 652 kB unpacked.
- `snapscript-cli@0.1.0`: 11 entries, about 32 kB packed, about 141 kB unpacked.
- `create-snapscript@0.1.0`: 11 entries, about 10 kB packed, about 41 kB unpacked.

All three tarballs include `README.md`, `LICENSE`, `dist/**`, and `package.json`.

## Manual Publish Steps

Run these from the repository root:

```sh
npm view snapscript name version --json
npm view snapscript-cli name version --json
npm view create-snapscript name version --json
pnpm release:check
```

If the three `npm view` commands still return `E404` and the release gate passes:

```sh
npm publish packages/snapscript --access public
npm publish packages/snapscript-cli --access public
npm publish packages/create-snapscript --access public
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

## Remaining Human Decisions

- Confirm `0.1.0` is the intended first public version.
- Confirm package ownership/account for npm publish.
- Decide whether to create a Git tag such as `v0.1.0`.
- Decide whether to publish GitHub release notes or a `CHANGELOG.md`.
