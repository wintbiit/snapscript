# SnapScript Project Style

Last reviewed: 2026-05-25

This document defines the project style that `create-snapscript` initializes and `snapscript-cli`
maintains. The target project is a platform-neutral game core package: `.snap` owns protocol shape,
generated code owns mechanical wiring, and user code owns gameplay logic. Browser, Node, puerts,
Unity/Unreal bindings, deployment, persistence, accounts, matchmaking, rendering, and real network
adapters live in platform projects that depend on the generated core package.

## User Goals

SnapScript users should be able to:

- create a complete game core package with `npm create snapscript@latest`
- define replicated protocol once in a root `.snap` file
- regenerate protocol and RPC bindings with `snapscript generate`
- write gameplay logic in stable files that are never overwritten
- keep server/client world creation explicit and easy to inspect
- run the same ECS logic style in Node, browser, puerts, or another JS host
- avoid framework concepts above `ServerWorld` and `ClientWorld`
- know exactly which files are generated and which files are theirs

Users should not need to:

- hand-write repetitive RPC binding code
- manually assign stable field ids
- maintain a separate generated lock file
- manually maintain system registration index files
- learn internal packet/snapshot details
- wrap their project in a SnapScript `Game`, `App`, `Room`, or server SDK abstraction
- accept generated architecture that hides world ownership or transport ownership

## Package Boundary

The repo has three packages:

- `snapscript`: portable runtime library
- `snapscript-cli`: protocol check/generate tooling for existing projects
- `create-snapscript`: npm create package for project initialization

The runtime package stays small and platform-neutral. One-time project templates belong in
`create-snapscript`. `.snap` parsing, generated protocol/RPC files, system scanning, generated
registries, formatting, and stale-file reporting belong in `snapscript-cli`.

Both tooling packages can use Eta for template rendering. Eta is intentionally only a rendering tool
here; the tooling still owns file policy such as overwrite, create-only, and stale reporting.

## Core Package Shape

`npm create snapscript@latest my-game-core` should generate a complete TypeScript package, not a
deployable server app and not a browser app:

```txt
my-game-core/
  game.snap
  package.json
  tsconfig.json
  src/
    create-server.ts
    create-client.ts
    generated/
      snapscript/
        protocol.ts
        manifest.json
        rpc.ts
    rpc/
      server/
        move.command.ts
      client/
        move-disabled.event.ts
    systems/
      server/
        10-movement.system.ts
      client/
        10-view.system.ts
      generated/
        server.ts
        client.ts
    transport/
      memory.ts
      README.md
  test/
    roundtrip.test.ts
```

This layout uses SnapScript vocabulary rather than Go-style `internal/handler/logic/svc`. The user
sees protocol, RPC logic, systems, generated files, world composition, and test transport directly.

`package.json` should provide scripts that reference the root `.snap` file:

```json
{
  "scripts": {
    "snap:check": "snapscript check game.snap",
    "snap:generate": "snapscript generate game.snap --out src/generated/snapscript",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

`npm create snapscript@latest <name>` is equivalent to:

- create the directory
- write the root `game.snap`
- write package and TypeScript config files
- generate protocol files from `game.snap`
- create initial RPC logic stubs
- create initial system files
- create generated RPC and system registries
- create in-memory test transport
- create a minimal round-trip test

`npm create snapscript@latest <name> -- --schema ../game.snap` uses the external schema in generated
scripts and does not copy it into the target directory.

It does not install dependencies, start a server, generate a browser app, or choose a production
network stack.

## Ownership Rules

Generated and overwritten on every `snapscript generate <schema.snap> --out src/generated/snapscript`:

- `src/generated/snapscript/protocol.ts`
- `src/generated/snapscript/manifest.json`
- `src/generated/snapscript/rpc.ts`
- `src/systems/generated/server.ts`
- `src/systems/generated/client.ts`

Generated only if missing:

- `src/rpc/server/**/*.ts`
- `src/rpc/client/**/*.ts`
- `src/systems/server/*.system.ts`
- `src/systems/client/*.system.ts`
- `src/create-server.ts`
- `src/create-client.ts`
- `src/transport/memory.ts`
- `src/transport/README.md`

Never generated after project creation unless explicitly requested:

- real transport adapters
- app entrypoints
- renderer/input/physics integration
- persistence, matchmaking, deployment, accounts

When a command/event is removed from `.snap`, the CLI should not delete user logic files. It should
report stale logic files so the user can delete or migrate them intentionally.

`snapscript generate` is the command that keeps generated wiring current after schema edits. It
should:

- parse and validate the `.snap` file
- overwrite protocol files under `src/generated/snapscript/`
- overwrite generated RPC registry files
- overwrite generated system registry files
- create missing RPC logic stubs
- never overwrite existing RPC logic stubs
- never overwrite user system files
- report stale RPC logic files
- report invalid system modules that do not export `register(world)`

`generate` resolves the project root from the current working directory. Run it from the generated
core package root.

## Protocol Files

The `.snap` file is the source of truth for:

- structs
- components
- entities
- commands
- events
- RPC channel policy
- generated ids by declaration and field order

It does not define:

- systems
- world creation
- transport implementation
- ownership policy
- app lifecycle
- prediction/interpolation strategy

Stable ids are deliberately simple:

- component and entity declaration order is the generated id source
- commands and events share one RPC id namespace, assigned by service/RPC declaration order
- field order inside a component, command, or event is the field id source
- new fields should be appended
- reordering fields or declarations is a breaking protocol change
- deleting fields is a breaking protocol change
- client/server protocol mismatch should be blocked before gameplay or during early handshake

Generated projects do not use `snapscript.lock.json`. If a project needs schema evolution later,
that should be an explicit future feature, not default hidden state.

Systems are code because systems express behavior, ordering, and dependencies. Putting systems in
IDL would make the protocol file responsible for runtime composition and would blur the framework
boundary.

## World-Level Gameplay State

Use `WorldEntity` for replicated world-level gameplay state. It is a reserved entity with
`WorldEntity.id === 0`, is created automatically by the framework inside every server/client world,
is server-owned, and is always visible. User code never spawns or constructs it.

Example protocol:

```snap
component MatchState {
  phase: u8(0)
  timeLeftMs: u32(0)
}
```

Server logic:

```ts
import { WorldEntity } from "snapscript";
import { MatchState } from "../generated/snapscript/protocol";

serverWorld.add(WorldEntity, MatchState, {
  phase: 1,
  timeLeftMs: 300000,
});
```

Client logic:

```ts
import { WorldEntity } from "snapscript";
import { MatchState } from "../generated/snapscript/protocol";

const state = clientWorld.get(WorldEntity, MatchState);
```

This is the SnapScript equivalent of replicated global gameplay state. It should be used for match
phase, timers, team scores, world clock, and global match config. It should not be used for
logger/cache/db/engine bridge objects; those belong to the platform/app layer. Do not introduce a
public `Resource` concept in v1.

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

Generated RPC registry example:

```ts
// src/generated/snapscript/rpc.ts
// Code-generated by snapscript-cli. Do not edit.

export function registerServerRpc(world: ServerWorld): void {
  rpc.commands.MovementMove.on(world, (ctx) => moveCommand(world, ctx));
}

export function registerClientRpc(world: ClientWorld): void {
  rpc.events.MovementMoveDisabled.on(world, (ctx) => moveDisabledEvent(world, ctx));
}
```

The generated registry imports user logic files directly. Do not generate a user-maintained barrel
file for RPC handlers by default:

```ts
import { moveCommand } from "../../rpc/server/move.command";
import { moveDisabledEvent } from "../../rpc/client/move-disabled.event";
```

Direct imports keep the dependency graph obvious and remove another mechanical file from user
ownership. File paths are derived from the `.snap` service/RPC names:

- `service Movement { command Move(...) }` -> `src/rpc/server/move.command.ts`
- `service Movement { event MoveDisabled(...) }` -> `src/rpc/client/move-disabled.event.ts`

If two service RPCs would map to the same file name, generation should fail with a clear collision
error. A future version may include service prefixes in paths if this becomes common, but the default
v1 template optimizes for small game-core packages.

User command logic:

```ts
// src/rpc/server/move.command.ts

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

User event logic:

```ts
// src/rpc/client/move-disabled.event.ts

export function moveDisabledEvent(world: ClientWorld, ctx: RpcCtx<MoveDisabledPayload>): void {
  showMoveDisabledFx(ctx.payload.disabled);
}
```

Function stubs are the default recommendation over classes. They are smaller, easier to read, and
match the current world-first API.

Generated stubs are create-only. If the user has already edited `src/rpc/server/move.command.ts`,
later `snapscript generate` runs must leave it unchanged and only update generated wiring and types.

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

Logger stays in world options; generated user logic should not receive a broad `svc` object by
default. The framework exposes `ILogger`/`Logger`, and when no logger is passed the runtime uses a
console-backed default logger for isolated handler/runtime errors.

## Systems

Systems are user code, not `.snap` definitions. Server and client systems are intentionally split
because they run with different authority and different world APIs.

Recommended shape:

```txt
src/
  systems/
    server/
      10-movement.system.ts
      20-combat.system.ts
    client/
      10-view.system.ts
      20-prediction.system.ts
    generated/
      server.ts
      client.ts
```

Every user system module exports a fixed `register(world)` function. The CLI scans
`src/systems/server/*.system.ts` and `src/systems/client/*.system.ts`, sorts by file name, then
generates platform-neutral registry files. This gives users automatic collection without requiring
Vite `import.meta.glob` or a specific bundler.

Server system example:

```ts
// src/systems/server/10-movement.system.ts

import type { ServerWorld } from "snapscript";
import { Position, Velocity } from "../../generated/snapscript/protocol";

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
// src/systems/client/10-view.system.ts

import type { ClientWorld } from "snapscript";
import { Position } from "../../generated/snapscript/protocol";

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
import * as combat from "../server/20-combat.system";
import * as movement from "../server/10-movement.system";

export function registerServerSystems(world: ServerWorld): void {
  movement.register(world);
  combat.register(world);
}
```

The generated registry imports system modules directly, sorted by file name. There is no user-owned
`src/systems/index.ts`; index files are exactly the mechanical registration code we want the CLI to
own.

System module validation:

- each `*.system.ts` file must export `register(world)`
- server system files receive `ServerWorld`
- client system files receive `ClientWorld`
- duplicate runtime system names are still rejected by `world.system()`
- file-name order is registration order, so prefixes such as `10-`, `20-`, `30-` are recommended

System naming convention:

- use dot-separated feature/action names
- prefer pipeline names: `movement.integrate`, `combat.resolve`, `view.collect`
- keep names stable because they appear in diagnostics and logs

Recommended phase usage:

- `preUpdate`: consume queued inputs or prepare temporary frame state
- `update`: mutate authoritative server state or run core simulation
- `postUpdate`: derive read models, emit side effects, cleanup
- `network`: advanced server-side hook before runtime sends snapshots; avoid by default

## Server And Client Composition

World creation remains explicit and user-owned. Generated projects are platform-neutral core
packages, so `src/create-server.ts` and `src/create-client.ts` are composition files, not process or
browser entrypoints.

These files are generated only when missing. They are intentionally user-owned after project
creation, because real projects often add initial world state, feature flags, protocol guards, or
project-specific setup. Regeneration should update imported generated registries, not rewrite these
composition files.

Generated once:

```ts
// src/create-server.ts

export function createServer(options: {
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
// src/create-client.ts

export function createClient(options: {
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

The generated package should export:

```ts
export { createServer } from "./create-server";
export { createClient } from "./create-client";
export * from "./generated/snapscript/protocol";
```

The public runtime vocabulary is server/client. `createServerWorld()` and `createClientWorld()` are
the only world factories.

## Platform Integration

Platform projects depend on the generated core package:

```txt
node dedicated server
browser client
puerts client
test harness
        -> depends on my-game-core
        -> depends on snapscript runtime
```

The core package owns:

- protocol
- generated bindings
- RPC handlers
- systems
- server/client world composition
- in-memory test transport

The platform layer owns:

- real network transport
- clock source
- tick loop
- input bridge
- renderer/engine entity bridge
- process/app lifecycle
- physics, persistence, accounts, matchmaking, deployment

Node server platform:

```ts
import { createServer } from "@my-game/core";
import { createNodeClock } from "./node-clock";
import { createWsServerTransport } from "./ws-server-transport";

const server = createServer({
  transport: createWsServerTransport({ port: 3000 }),
  clock: createNodeClock(),
});

setInterval(() => {
  server.tick();
}, 1000 / 30);
```

Browser client platform:

```ts
import { Move, createClient } from "@my-game/core";
import { createBrowserClock } from "./browser-clock";
import { createWebSocketTransport } from "./websocket-transport";
import { renderWorld } from "./renderer";

const client = createClient({
  transport: createWebSocketTransport("ws://localhost:3000"),
  clock: createBrowserClock(),
});

function frame() {
  const input = readInput();
  if (input.moveX !== 0 || input.moveY !== 0) {
    client.send(Move, { dx: input.moveX, dy: input.moveY });
  }
  client.tick();
  renderWorld(client);
  requestAnimationFrame(frame);
}
```

The concrete browser reference is `examples/protocol/app`: it owns the WebSocket relay transport,
browser clock, animation/tick loop, input bridge, and simple render/HUD bridge while depending on
the platform-neutral protocol core package.

Puerts/engine client platform:

```ts
import { Move, createClient } from "@my-game/core";
import { createEngineTransport } from "./engine-transport";
import { createPuertsClock } from "./puerts-clock";
import { syncWorldToEngine } from "./engine-entities";

const client = createClient({
  transport: createEngineTransport(),
  clock: createPuertsClock(),
});

export function update(): void {
  const input = readEngineInput();
  if (input.hasMove) {
    client.send(Move, { dx: input.dx, dy: input.dy });
  }
  client.tick();
  syncWorldToEngine(client);
}
```

Engine entity bridge:

```ts
import { Health, Position } from "@my-game/core";
import type { ClientWorld } from "snapscript";

export function syncWorldToEngine(world: ClientWorld): void {
  world.each([Position, Health] as const, (entity, position, health) => {
    const actor = getOrCreateActor(entity.id);
    actor.setPosition(position.x.value, position.y.value);
    actor.setHealth(health.hp.value);
  });
}
```

Client transport adapter:

```ts
export function createEngineTransport(): ClientTransport {
  let onPacket: ((channel: ChannelName, bytes: Uint8Array) => void) | undefined;

  EngineNetwork.onMessage((message) => {
    onPacket?.(message.reliable ? "reliable" : "unreliable", message.bytes);
  });

  return {
    send(channel, bytes) {
      EngineNetwork.send({
        reliable: channel === "reliable",
        bytes,
      });
    },
    onPacket(cb) {
      onPacket = cb;
    },
  };
}
```

## Transport Boundary

The generated project should not include a fake production networking framework.

`create-snapscript` includes an in-memory test transport and `src/transport/README.md`, but the
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

## CLI Reporting

`snapscript generate` should print a small, stable report:

```txt
generated src/generated/snapscript/protocol.ts
generated src/generated/snapscript/manifest.json
generated src/generated/snapscript/rpc.ts
generated src/systems/generated/server.ts
generated src/systems/generated/client.ts
created   src/rpc/server/move.command.ts
stale     src/rpc/server/old-command.command.ts
```

Meaning:

- `generated`: overwritten generated file
- `created`: user-owned stub created because it did not exist
- `kept`: user-owned file already existed and was not touched
- `stale`: user-owned RPC logic file no longer referenced by current `.snap`

Stale files are warnings, not errors. They should make schema drift visible without deleting user
code.

## Formatting

Generated files should be deterministic and readable without requiring Prettier in the target
project. User-owned files are not reformatted by `snapscript generate`.

## Core Test Fixture

Generated core packages should include one minimal test using the in-memory transport:

- create server and client worlds
- tick through hello/full snapshot
- send one command from client to server
- verify client receives replicated state
- verify `client.myPeerId()`
- verify ownership with `client.isMine(entity)`
- verify at least one `WorldEntity` global state component if the default schema includes one

The test is not a gameplay test suite. It is a smoke test that proves the generated project wiring,
transport boundary, RPC binding, snapshot sync, and ownership defaults work together.

## Listen-Server Scenario

Do not introduce a third public world type for listen-server or local-host play.

Future work can provide a helper that composes one `ServerWorld` and one `ClientWorld` for the same
process, for example returning `{ serverWorld, clientWorld }`. That would be convenience orchestration
around the existing server/client model, not a `createHostWorld()` API and not a new runtime role.

## Best-Practice Defaults

Confirmed defaults:

- runtime package: `snapscript`
- CLI package: `snapscript-cli`
- project init package: `create-snapscript`
- CLI binary: `snapscript`
- project init: `npm create snapscript@latest <name>` generates a platform-neutral game core package
- source schema: root `game.snap`
- no generated lock file
- declaration order and field order are generated id sources
- world-level replicated gameplay state uses `WorldEntity`
- no public `Resource` in v1
- generated runtime code: `src/generated/snapscript/`
- user RPC logic: `src/rpc/server/` and `src/rpc/client/`
- user systems: `src/systems/server/` and `src/systems/client/`
- system order: file-name sort
- generated system registries: `src/systems/generated/server.ts` and `src/systems/generated/client.ts`
- world composition: `src/create-server.ts` and `src/create-client.ts`
- default in-memory test transport, no production transport binding
- no generated service context by default
- no systems in `.snap`
- generated files are overwritten
- user logic files are create-only
- system files export `register(world)`
- generated RPC registry imports user logic directly
- no user-maintained RPC or system barrel files by default
- `snapscript generate` reports stale RPC logic and never deletes it
- generated projects include a minimal in-memory round-trip test

Items still needing implementation detail:

- exact platform integration examples for puerts and Node packages
