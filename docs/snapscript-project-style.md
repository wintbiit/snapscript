# SnapScript Project Style

Last reviewed: 2026-05-25

This document defines the project style that `snapscript-cli` should generate. It is the working
best-practice target for SnapScript projects: `.snap` owns protocol shape, generated code owns
mechanical wiring, and user code owns gameplay logic, transports, rendering, persistence, and app
lifecycle.

## User Goals

SnapScript users should be able to:

- create a complete project with `snapscript new`
- define replicated protocol once in `.snap`
- regenerate stable protocol and RPC bindings with `snapscript generate`
- write gameplay logic in stable files that are never overwritten
- keep server/client world creation explicit and easy to inspect
- run the same ECS logic style in Node, browser, puerts, or another JS host
- avoid framework concepts above `ServerWorld` and `ClientWorld`
- know exactly which files are generated and which files are theirs

Users should not need to:

- hand-write repetitive RPC binding code
- manually assign stable field ids
- manually maintain system registration index files
- learn internal packet/snapshot details
- wrap their project in a SnapScript `Game`, `App`, `Room`, or server SDK abstraction
- accept generated architecture that hides world ownership or transport ownership

## Package Boundary

The repo has two packages:

- `snapscript`: portable runtime library
- `snapscript-cli`: project/protocol generation tooling

The runtime package stays small and platform-neutral. Project templates, `.snap` parsing, project
initialization, system scanning, generated registries, formatting, and stale-file reporting belong
in `snapscript-cli`.

## CLI Shape

`snapscript new my-game` should generate a complete runnable TypeScript project:

- `package.json`
- `tsconfig.json`
- protocol source and lock file
- generated protocol/RPC files
- server/client world bootstrap files
- server/client system folders and generated system registries
- user-owned RPC logic stubs
- a minimal test or local smoke fixture
- transport guidance, but no production networking implementation

`snapscript generate` should update only generated files and create missing user stubs. It should
not overwrite user logic.

## Generated Project Shape

Recommended first generated shape:

```txt
my-project/
  package.json
  tsconfig.json
  protocol/
    main.snap
    snapscript.lock.json
  src/
    protocol/
      generated/
        protocol.ts
        manifest.json
        rpc.ts
      logic/
        movement/
          move.command.ts
          move-disabled.event.ts
    systems/
      server/
        movement.system.ts
      client/
        view.system.ts
      generated/
        server.ts
        client.ts
    world/
      server.ts
      client.ts
    transport/
      README.md
```

This layout uses SnapScript vocabulary rather than Go-style `internal/handler/logic/svc`. The user
sees protocol, logic, systems, world, and transport directly.

## Ownership Rules

Generated and overwritten on every `snapscript generate`:

- `src/protocol/generated/protocol.ts`
- `src/protocol/generated/manifest.json`
- `src/protocol/generated/rpc.ts`
- `src/systems/generated/server.ts`
- `src/systems/generated/client.ts`
- `protocol/snapscript.lock.json`

Generated only if missing:

- `src/protocol/logic/**/*.ts`
- `src/systems/server/*.system.ts`
- `src/systems/client/*.system.ts`
- `src/world/server.ts`
- `src/world/client.ts`
- `src/transport/README.md`

Never generated after project creation unless explicitly requested:

- real transport adapters
- app entrypoints
- renderer/input/physics integration
- persistence, matchmaking, deployment, accounts

When a command/event is removed from `.snap`, the CLI should not delete user logic files. It should
report stale logic files so the user can delete or migrate them intentionally.

## Protocol Files

The `.snap` file is the source of truth for:

- structs
- components
- entities
- commands
- events
- RPC channel policy
- stable generated ids through the lock file

It does not define:

- systems
- world creation
- transport implementation
- ownership policy
- app lifecycle
- prediction/interpolation strategy

Systems are code because systems express behavior, ordering, and dependencies. Putting systems in
IDL would make the protocol file responsible for runtime composition and would blur the framework
boundary.

## RPC Logic

RPC should be generated as typed wiring plus user-owned logic stubs.

`ctx` in RPC logic means the per-message RPC context. It is not a service context, dependency
container, or project runtime object. It contains only data that belongs to the current RPC packet:

- `ctx.payload`: decoded command/event payload
- `ctx.sender`: SnapScript peer id of the sender
- `ctx.tick`: sender tick encoded on the packet
- `ctx.rpc`: the RPC definition
- `ctx.channel`: logical channel used by the packet

The `world` argument is the stable object that gives logic access to replicated state and world APIs.
The `ctx` argument is ephemeral and should not be stored.

Example generated file:

```ts
// src/protocol/generated/rpc.ts
// Code-generated by snapscript-cli. Do not edit.

export function registerServerRpc(world: ServerWorld): void {
  rpc.commands.MovementMove.on(world, (ctx) => moveCommand(world, ctx));
}

export function registerClientRpc(world: ClientWorld): void {
  rpc.events.MovementMoveDisabled.on(world, (ctx) => moveDisabledEvent(world, ctx));
}
```

Example user file:

```ts
// src/protocol/logic/movement/move.command.ts

export function moveCommand(world: ServerWorld, ctx: RpcCtx<MovePayload>): void {
  const player = findControlledPlayer(world, ctx.sender);
  if (player === undefined) {
    return;
  }
  const position = world.get(player, Position);
  if (position !== undefined) {
    position.x.value += ctx.payload.dx;
    position.y.value += ctx.payload.dy;
  }
}
```

Function stubs are the default recommendation over classes. They are smaller, easier to read, and
match the current world-first API.

## Service Context

Do not generate a service context by default.

Reasons:

- SnapScript is not a server SDK and should not create an app/service abstraction.
- The server already owns `ServerWorld`, transport, clock, config, logger, and external systems.
- A default context object can become a dumping ground and hide dependencies.
- Most RPC logic can accept `world` and `ctx` directly.

Recommended default:

```ts
export function moveCommand(world: ServerWorld, ctx: RpcCtx<MovePayload>): void;
```

Projects that need dependency injection can create their own explicit object and pass it from their
own bootstrap code. That is a project decision, not a generated default.

## Systems

Systems are user code, not `.snap` definitions. Server and client systems are intentionally split
because they run with different authority and different world APIs.

Recommended shape:

```txt
src/
  systems/
    server/
      movement.system.ts
      combat.system.ts
    client/
      view.system.ts
      prediction.system.ts
    generated/
      server.ts
      client.ts
```

Every user system module exports a fixed `register(world)` function. The CLI scans
`src/systems/server/*.system.ts` and `src/systems/client/*.system.ts`, then generates platform-neutral
registry files. This gives users the ergonomics of automatic collection without requiring Vite
`import.meta.glob` or a specific bundler.

Server system example:

```ts
// src/systems/server/movement.system.ts

import type { ServerWorld } from "snapscript";
import { Position, Velocity } from "../../protocol/generated/protocol";

export function register(world: ServerWorld): void {
  world.system("movement.integrate", "update", (world, frame) => {
    const dt = frame.dtMs / 1000;
    world.each([Position, Velocity] as const, (_entity, position, velocity) => {
      position.x.value += velocity.x.value * dt;
      position.y.value += velocity.y.value * dt;
    });
  });
}
```

Client system example:

```ts
// src/systems/client/view.system.ts

import type { ClientWorld } from "snapscript";
import { Position } from "../../protocol/generated/protocol";

export function register(world: ClientWorld): void {
  world.system("view.collect", "postUpdate", (world) => {
    world.each([Position] as const, (_entity, position) => {
      sampleRenderPosition(position.x.value, position.y.value);
    });
  });
}
```

Generated server registry:

```ts
// src/systems/generated/server.ts
// Code-generated by snapscript-cli. Do not edit.

import type { ServerWorld } from "snapscript";
import * as combat from "../server/combat.system";
import * as movement from "../server/movement.system";

export function registerServerSystems(world: ServerWorld): void {
  combat.register(world);
  movement.register(world);
}
```

Generated client registry:

```ts
// src/systems/generated/client.ts
// Code-generated by snapscript-cli. Do not edit.

import type { ClientWorld } from "snapscript";
import * as view from "../client/view.system";

export function registerClientSystems(world: ClientWorld): void {
  view.register(world);
}
```

System ordering is file-name sorted by default. If a project needs stronger ordering later, the CLI
can introduce explicit order metadata without changing runtime concepts.

System naming convention:

- use dot-separated feature/action names
- prefer pipeline names: `movement.integrate`, `combat.resolve`, `view.collect`
- keep names stable because they appear in diagnostics and logs

Recommended phase usage:

- `preUpdate`: consume queued inputs or prepare temporary frame state
- `update`: mutate authoritative server state or run core simulation
- `postUpdate`: derive read models, emit side effects, cleanup
- `network`: advanced server-side hook before runtime sends snapshots; avoid by default

## Server And Client Bootstrap

World creation remains explicit and user-owned.

Generated once:

```ts
// src/world/server.ts

export function createProjectServerWorld(options: {
  readonly transport: ServerTransport;
  readonly clock: Clock;
  readonly logger?: Logger;
}): ServerWorld {
  const world = createServerWorld({
    protocol,
    transport: options.transport,
    clock: options.clock,
    logger: options.logger,
  });
  registerServerRpc(world);
  registerServerSystems(world);
  return world;
}
```

Generated once:

```ts
// src/world/client.ts

export function createProjectClientWorld(options: {
  readonly transport: ClientTransport;
  readonly clock: Clock;
  readonly logger?: Logger;
}): ClientWorld {
  const world = createClientWorld({
    protocol,
    transport: options.transport,
    clock: options.clock,
    logger: options.logger,
  });
  registerClientRpc(world);
  registerClientSystems(world);
  return world;
}
```

The public runtime vocabulary is server/client. `createServerWorld()` and `createClientWorld()` are
the only world factories.

## Transport Boundary

The generated project should not include a fake networking framework.

`snapscript new` may include `src/transport/README.md` or a tiny in-memory test transport, but the
default architecture should say clearly:

- production reliability belongs to the engine/platform layer
- SnapScript adapters only move `Uint8Array` packets with channel labels
- WebSocket/WebRTC/UDP/engine transports are project-specific

## Commands And Events

Naming convention:

- command logic file: `move.command.ts`
- event logic file: `move-disabled.event.ts`
- generated export: `MovementMove`
- runtime RPC name: `Movement.Move`

Command handlers run on the server:

```ts
export function moveCommand(world: ServerWorld, ctx: RpcCtx<MovePayload>): void;
```

Event handlers run on the client:

```ts
export function moveDisabledEvent(world: ClientWorld, ctx: RpcCtx<MoveDisabledPayload>): void;
```

The CLI should avoid generating both class and function variants in the same project. One default
style keeps examples and docs consistent.

## Listen-Server Scenario

Do not introduce a third public world type for listen-server or local-host play.

Future work can provide a helper that composes one `ServerWorld` and one `ClientWorld` for the same
process, for example returning `{ serverWorld, clientWorld }`. That would be convenience orchestration
around the existing server/client model, not a `createHostWorld()` API and not a new runtime role.

## Best-Practice Defaults

Confirmed defaults:

- runtime package: `snapscript`
- CLI package: `snapscript-cli`
- CLI binary: `snapscript`
- project init: `snapscript new <name>` generates a complete project
- source schema: `protocol/main.snap`
- generated runtime code: `src/protocol/generated/`
- user RPC logic: `src/protocol/logic/`
- user systems: `src/systems/server/` and `src/systems/client/`
- generated system registries: `src/systems/generated/server.ts` and `src/systems/generated/client.ts`
- world bootstrap: `src/world/server.ts` and `src/world/client.ts`
- no generated service context by default
- no systems in `.snap`
- generated files are overwritten
- user logic files are create-only
- system files export `register(world)`

Items still needing implementation detail:

- exact `snapscript new` template files
- whether generated RPC registration imports user logic directly or uses an index barrel
- how stale logic/system files are reported
- whether `generate` should format generated code
- whether to include a minimal test fixture in generated projects
