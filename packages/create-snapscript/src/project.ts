import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Eta } from "eta";
import { generateProject, type ReportItem } from "snapscript-cli/project";

export interface CreateProjectOptions {
  readonly cwd: string;
  readonly targetDir: string;
  readonly schemaPath?: string;
}

interface TemplateData {
  readonly packageName: string;
  readonly schemaScriptPath: string;
}

const eta = new Eta({ autoTrim: false });

const defaultSchema = `syntax = "v1"

struct Vector2 {
  x: qf32(min: -128, max: 128, precision: 0.01, default: 0)
  y: qf32(min: -128, max: 128, precision: 0.01, default: 0)
}

component Position {
  Vector2
  hidden: bool(default: false)
}

component Health {
  hp: u16(100)
}

component MatchState {
  phase: u8(0)
  timeLeftMs: u32(0)
}

world {
  state: MatchState

  command StartGame() reliable
  event GameStarted() reliable
}

component ConnectionInfo {
  region: u8(0)
}

peer {
  connectionInfo: ConnectionInfo

  command Ready() reliable
  event Alert(reason: u8(0)) reliable
}

struct MoveInput {
  dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)
  dy: qf32(min: -1, max: 1, precision: 0.01, default: 0)
}

entity Player {
  position: Position
  health: Health

  command Move(input: MoveInput) unreliable
  stream MoveStream(input: MoveInput)
  event MoveDisabled(disabled: bool) reliable
}
`;

export function createProject(options: CreateProjectOptions): readonly ReportItem[] {
  const targetDir = resolve(options.cwd, options.targetDir);
  assertNewTarget(targetDir);
  mkdirSync(targetDir, { recursive: true });

  const externalSchema = options.schemaPath !== undefined;
  const schemaPath = externalSchema ? resolve(options.cwd, options.schemaPath) : join(targetDir, "game.snap");
  const schemaScriptPath = toPosix(relative(targetDir, schemaPath));
  const report: ReportItem[] = [];

  if (!externalSchema) {
    writeCreated(join(targetDir, "game.snap"), defaultSchema, report, options.cwd);
  } else {
    readFileSync(schemaPath, "utf8");
  }

  const data = {
    packageName: packageNameFor(targetDir),
    schemaScriptPath,
  };
  for (const file of renderBaseProject(data, externalSchema ? "generic" : "example")) {
    writeCreated(join(targetDir, file.path), file.content, report, options.cwd);
  }

  const generatedReport = generateProject({
    cwd: targetDir,
    schemaPath,
    outDir: "src/generated",
  });
  const targetPrefix = toPosix(relative(options.cwd, targetDir));
  report.push(...generatedReport.map((item) => ({ ...item, path: `${targetPrefix}/${item.path}` })));
  return report;
}

function renderBaseProject(
  data: TemplateData,
  kind: "example" | "generic",
): readonly { readonly path: string; readonly content: string }[] {
  return [
    { path: "README.md", content: render(rootReadmeTemplate, data) },
    { path: "package.json", content: render(packageJsonTemplate, data) },
    { path: "tsconfig.json", content: render(tsconfigTemplate, data) },
    { path: "src/index.ts", content: render(indexTemplate, data) },
    { path: "src/create-server.ts", content: render(kind === "example" ? exampleCreateServerTemplate : genericCreateServerTemplate, data) },
    { path: "src/create-client.ts", content: render(createClientTemplate, data) },
    { path: "src/systems/server/10-health.system.ts", content: render(kind === "example" ? exampleServerSystemTemplate : genericServerSystemTemplate, data) },
    { path: "src/systems/client/10-view.system.ts", content: render(kind === "example" ? exampleClientSystemTemplate : genericClientSystemTemplate, data) },
    { path: "test/roundtrip.test.ts", content: render(kind === "example" ? exampleRoundtripTestTemplate : genericRoundtripTestTemplate, data) },
  ];
}

function writeCreated(path: string, content: string, report: ReportItem[], cwd: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  report.push({ status: "created", path: toPosix(relative(cwd, path)) });
}

function assertNewTarget(targetDir: string): void {
  if (!existsSync(targetDir)) return;
  if (!statSync(targetDir).isDirectory()) {
    throw new Error(`create-snapscript target exists and is not a directory: ${targetDir}`);
  }
  if (readdirSync(targetDir).length > 0) {
    throw new Error(`create-snapscript target directory must be empty: ${targetDir}`);
  }
}

function render(template: string, data: object): string {
  return eta.renderString(template, data);
}

function packageNameFor(path: string): string {
  return kebabCase(basename(path)) || "snapscript-game-core";
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

const packageJsonTemplate = `<%~ JSON.stringify({
  name: it.packageName,
  version: "0.0.0",
  private: true,
  type: "module",
  packageManager: "pnpm@10.32.1",
  scripts: {
    "snap:check": \`snapscript check \${it.schemaScriptPath}\`,
    "snap:generate": \`snapscript generate \${it.schemaScriptPath} --out src/generated\`,
    check: "pnpm snap:check",
    generate: "pnpm snap:generate",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    build: "pnpm snap:generate && pnpm typecheck && pnpm test",
  },
  dependencies: {
    snapscript: "^0.2.0",
  },
  devDependencies: {
    "snapscript-cli": "^0.2.0",
    typescript: "^5.9.3",
    vitest: "^4.1.9",
  },
  exports: {
    ".": "./src/index.ts",
    "./generated/protocol": "./src/generated/protocol.ts",
  },
}, null, 2) %>
`;

const rootReadmeTemplate = `# <%= it.packageName %>

This package is a platform-neutral SnapScript game core. It owns protocol definitions, generated
RPC/system wiring, authoritative server/client world creation, gameplay systems, and RPC handlers.
It does not own browser, Node, Puerts, engine renderer, persistence, login, matchmaking, or
production networking.

## Get Started

\`\`\`sh
pnpm install
pnpm build
\`\`\`

\`<%= it.schemaScriptPath %>\` is the source of truth. Edit it when replicated components,
entities, commands, or events change, then run:

\`\`\`sh
pnpm generate
\`\`\`

The schema uses endpoint-scoped RPC:

- \`world {}\` is the reserved replicated \`WorldEntity\` for global gameplay state.
- \`peer {}\` is the framework-created replicated PeerEntity for each connected peer.
- \`entity Player {}\` is a gameplay entity type with its declared component set.

Commands are received by the endpoint that declares them. Events are emitted by the endpoint that
declares them. Generated handlers receive \`(world, ctx)\`; \`ctx.payload\` has decoded data,
\`ctx.source\` is the source endpoint entity, and \`ctx.target\` is the target endpoint entity.
There is no generated \`ctx.sender\`; call \`world.peerId(peerEntity)\` when logic needs the numeric
connection id.

## Commands

- \`pnpm generate\` refreshes files generated from \`<%= it.schemaScriptPath %>\`.
- \`pnpm typecheck\` checks the core package.
- \`pnpm test\` runs the package tests.
- \`pnpm build\` regenerates protocol code, typechecks, and runs tests.

## Ownership

Generated files are written under \`src/generated/\`.
Do not edit them directly; change \`<%= it.schemaScriptPath %>\` or system files, then run
\`pnpm generate\`.

User-owned logic lives in:

- \`src/logic/server/*.ts\` for command handlers.
- \`src/logic/client/*.ts\` for event handlers.
- \`src/systems/server/*.system.ts\` for authoritative server systems.
- \`src/systems/client/*.system.ts\` for client-side read/presentation systems.

System files are registered in filename order. Each system file exports
\`register(world)\`.

Use generated \`entities\` and \`commands\` on the client, and \`events\` on the server:

\`\`\`ts
const playerEntity = entities.Player.first(clientWorld);
if (playerEntity === undefined) throw new Error("Player is not replicated yet");

commands.Player.Move(clientWorld, playerEntity, { dx: 1, dy: 0 });
events.Player.MoveDisabled.sendTo(serverWorld, peerEntity, playerEntity, {
  disabled: true,
});
\`\`\`

Endpoint type validation happens before user handlers run. If a packet targets the wrong endpoint
type, SnapScript logs a warning and drops it. Gameplay authorization is still user logic; validate
ownership, cooldowns, possession, and project-specific rules in handlers.

## Platform Boundary

A real platform layer should adapt its transport into SnapScript packets, provide a clock/tick loop,
forward input into client commands, and render/read snapshots from this core package. Tests and
host-mode wiring can use \`createMemoryTransportPair()\` from \`snapscript\`.
`;

const tsconfigTemplate = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "useDefineForClassFields": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "types": ["vitest/globals"]
  },
  "include": ["src", "test"]
}
`;

const indexTemplate = `export { createClient } from "./create-client";
export { createServer } from "./create-server";
export { commands } from "./generated/commands";
export { entities } from "./generated/entities";
export { events } from "./generated/events";
export { streams } from "./generated/streams";
export * from "./generated/protocol";
`;

const exampleCreateServerTemplate = `import {
  createServerWorld,
  type Clock,
  type Logger,
  type ServerTransport,
  type ServerWorld,
} from "snapscript";
import { Player, protocol } from "./generated/protocol";
import { registerServerRpc } from "./generated/register";
import { registerServerSystems } from "./generated/systems.server";

export interface CreateServerOptions {
  readonly transport: ServerTransport;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export function createServer(options: CreateServerOptions): ServerWorld {
  const world = createServerWorld({
    protocol,
    transport: options.transport,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const player = world.spawn(Player, {
    position: { x: 0, y: 0 },
    health: { hp: 100 },
  });

  registerServerRpc(world);
  registerServerSystems(world);

  return world;
}
`;

const genericCreateServerTemplate = `import {
  createServerWorld,
  type Clock,
  type Logger,
  type ServerTransport,
  type ServerWorld,
} from "snapscript";
import { protocol } from "./generated/protocol";
import { registerServerRpc } from "./generated/register";
import { registerServerSystems } from "./generated/systems.server";

export interface CreateServerOptions {
  readonly transport: ServerTransport;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export function createServer(options: CreateServerOptions): ServerWorld {
  const world = createServerWorld({
    protocol,
    transport: options.transport,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  registerServerRpc(world);
  registerServerSystems(world);

  return world;
}
`;

const createClientTemplate = `import {
  createClientWorld,
  type ClientTransport,
  type ClientWorld,
  type Clock,
  type Logger,
} from "snapscript";
import { protocol } from "./generated/protocol";
import { registerClientRpc } from "./generated/register";
import { registerClientSystems } from "./generated/systems.client";

export interface CreateClientOptions {
  readonly transport: ClientTransport;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export function createClient(options: CreateClientOptions): ClientWorld {
  const world = createClientWorld({
    protocol,
    transport: options.transport,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  registerClientRpc(world);
  registerClientSystems(world);

  return world;
}
`;

const exampleServerSystemTemplate = `import type { ServerWorld } from "snapscript";
import { Health } from "../../generated/protocol";

export function register(world: ServerWorld): void {
  // Server systems are authoritative gameplay. Phase is fixed by the second argument;
  // files in src/systems/server are registered in filename order.
  world.system("health.clamp", "postUpdate", (world) => {
    world.each([Health] as const, (_entity, health) => {
      health.hp.value = Math.max(0, Math.min(100, health.hp.value));
    });
  });
}
`;

const genericServerSystemTemplate = `import type { ServerWorld } from "snapscript";

export function register(world: ServerWorld): void {
  // Server systems are authoritative gameplay. Phase is fixed by the second argument;
  // files in src/systems/server are registered in filename order.
  world.system("server.update", "update", () => {
    // Add authoritative gameplay systems here.
  });
}
`;

const exampleClientSystemTemplate = `import type { ClientWorld } from "snapscript";
import { Position } from "../../generated/protocol";

export function register(world: ClientWorld): void {
  // Client systems should read replicated state and prepare presentation-facing data.
  // Files in src/systems/client are registered in filename order.
  world.system("view.collect", "postUpdate", (world) => {
    world.each([Position] as const, (_entity, position) => {
      void position;
    });
  });
}
`;

const genericClientSystemTemplate = `import type { ClientWorld } from "snapscript";

export function register(world: ClientWorld): void {
  // Client systems should read replicated state and prepare presentation-facing data.
  // Files in src/systems/client are registered in filename order.
  world.system("client.update", "postUpdate", () => {
    // Add client-side read or presentation systems here.
  });
}
`;

const exampleRoundtripTestTemplate = `import { describe, expect, it } from "vitest";
import { createClient, createServer, Position, commands, entities } from "../src/index";
import { createMemoryTransportPair, type Clock } from "snapscript";

function clock(): Clock {
  let tick = 0;
  return {
    nowMs: () => tick * 16,
    tick: () => {
      tick += 1;
      return tick;
    },
  };
}

describe("protocol core", () => {
  it("round-trips a generated command through memory transport", () => {
    const transport = createMemoryTransportPair();
    const server = createServer({ transport: transport.server, clock: clock() });
    const client = createClient({ transport: transport.client, clock: clock() });

    client.tick();
    server.tick();
    client.tick();

    const playerEntity = entities.Player.first(client);
    if (playerEntity === undefined) throw new Error("expected a replicated Player");
    commands.Player.Move(client, playerEntity, { dx: 1, dy: 0 });
    server.tick();
    client.tick();

    const position = client.get(playerEntity, Position);
    expect(client.myPeerId()).toBe(1);
    expect(client.isMine(playerEntity)).toBe(false);
    expect(position?.x.value).toBe(0);
    expect(position?.y.value).toBe(0);
  });
});
`;

const genericRoundtripTestTemplate = `import { describe, expect, it } from "vitest";
import { createClient, createServer } from "../src/index";
import { createMemoryTransportPair, type Clock } from "snapscript";

function clock(): Clock {
  let tick = 0;
  return {
    nowMs: () => tick * 16,
    tick: () => {
      tick += 1;
      return tick;
    },
  };
}

describe("protocol core", () => {
  it("creates server and client worlds through memory transport", () => {
    const transport = createMemoryTransportPair();
    const server = createServer({ transport: transport.server, clock: clock() });
    const client = createClient({ transport: transport.client, clock: clock() });

    client.tick();
    server.tick();
    client.tick();

    expect(client.myPeerId()).toBe(1);
  });
});
`;
