# SnapScript Docs

Last reviewed: 2026-06-20

This directory contains stable project documentation. Development-status notes are intentionally not
kept here; release-facing docs should describe the current API and design, not temporary refactor
state.

## Start Here

- [README](../README.md) — installation, generated-project workflow, platform boundary, and examples.
- [API reference](API.md) — public API layers and exported runtime surface.
- [Protocol IDL](protocol-idl.md) — `.snap` syntax, deterministic IDs, generated facade, and validation.
- [RPC design record](rpc-entity-model.md) — endpoint-scoped RPC rationale and semantics.
- [Release readiness](release-readiness.md) — first public npm release gap checklist.

## Current Protocol Model

- `world {}` maps to the reserved `WorldEntity`.
- `peer {}` maps to one replicated PeerEntity per connected peer.
- `entity Name {}` maps to replicated gameplay entities with the declared component set.
- `command` travels client to server.
- `event` travels server to client.
- `stream` travels client to server as an unreliable command stream.

Generated `.snap` projects should use:

- `commands.*` for client-to-server commands.
- `events.*` for server-to-client events.
- `streams.*` for client-to-server input streams.
- `entities.*` for replicated entity lookup.

## Examples

- [Protocol project](../examples/protocol/README.md)
- [Protocol core package](../examples/protocol/core/README.md)

## Documentation Policy

- Keep `README.md` short enough to evaluate the project quickly.
- Keep generated-project examples facade-first.
- Keep handwritten protocol examples explicit and separate from generated-project examples.
- Do not document internal packet codecs, storage classes, or low-level sync runtimes as public API.
