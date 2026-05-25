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

entity Player {
  position: Position
  health: Health
}

struct MoveInput {
  dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)
  dy: qf32(min: -1, max: 1, precision: 0.01, default: 0)
}

service Movement {
  command Move(input: MoveInput) unreliable
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
    outDir: "src/generated/snapscript",
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
    { path: "package.json", content: render(packageJsonTemplate, data) },
    { path: "tsconfig.json", content: render(tsconfigTemplate, data) },
    { path: "src/index.ts", content: render(indexTemplate, data) },
    { path: "src/create-server.ts", content: render(kind === "example" ? exampleCreateServerTemplate : genericCreateServerTemplate, data) },
    { path: "src/create-client.ts", content: render(createClientTemplate, data) },
    { path: "src/state.ts", content: render(kind === "example" ? exampleStateTemplate : genericStateTemplate, data) },
    { path: "src/transport/memory.ts", content: render(memoryTransportTemplate, data) },
    { path: "src/transport/README.md", content: render(memoryTransportReadmeTemplate, data) },
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
  scripts: {
    "snap:check": \`snapscript check \${it.schemaScriptPath}\`,
    "snap:generate": \`snapscript generate \${it.schemaScriptPath} --out src/generated/snapscript\`,
    check: "pnpm snap:check",
    generate: "pnpm snap:generate",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    build: "pnpm snap:generate && pnpm typecheck && pnpm test",
  },
  dependencies: {
    snapscript: "^0.0.0",
  },
  devDependencies: {
    "snapscript-cli": "^0.0.0",
    typescript: "^5.9.3",
    vitest: "^4.0.8",
  },
  exports: {
    ".": "./src/index.ts",
    "./generated/snapscript/protocol": "./src/generated/snapscript/protocol.ts",
  },
}, null, 2) %>
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
export { createMemoryTransportPair } from "./transport/memory";
export { readClientSnapshot, readServerSnapshot } from "./state";
export type { ClientSnapshot, ServerSnapshot } from "./state";
export * from "./generated/snapscript/protocol";
`;

const exampleCreateServerTemplate = `import {
  createServerWorld,
  type Clock,
  type Logger,
  type ServerTransport,
  type ServerWorld,
} from "snapscript";
import { Player, protocol } from "./generated/snapscript/protocol";
import { registerServerRpc } from "./generated/snapscript/rpc";
import { registerServerSystems } from "./systems/generated/server";

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
  world.setOwner(player, 0);

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
import { protocol } from "./generated/snapscript/protocol";
import { registerServerRpc } from "./generated/snapscript/rpc";
import { registerServerSystems } from "./systems/generated/server";

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
import { protocol } from "./generated/snapscript/protocol";
import { registerClientRpc } from "./generated/snapscript/rpc";
import { registerClientSystems } from "./systems/generated/client";

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

const exampleStateTemplate = `import type { ClientWorld, ReplicatedStateReader, ServerWorld } from "snapscript";
import { Health, Position } from "./generated/snapscript/protocol";

export interface PlayerView {
  readonly id: number;
  readonly hp: number;
  readonly x: number;
  readonly y: number;
  readonly hidden: boolean;
  readonly mine: boolean;
}

export interface ServerSnapshot {
  readonly players: readonly PlayerView[];
}

export interface ClientSnapshot {
  readonly myPeerId: number;
  readonly players: readonly PlayerView[];
}

export function readServerSnapshot(world: ServerWorld): ServerSnapshot {
  return {
    players: readPlayers(world, () => false),
  };
}

export function readClientSnapshot(world: ClientWorld): ClientSnapshot {
  return {
    myPeerId: world.myPeerId(),
    players: readPlayers(world, (id) => world.isMine(id)),
  };
}

function readPlayers(
  world: ReplicatedStateReader,
  isMine: (entityId: number) => boolean,
): PlayerView[] {
  const players: PlayerView[] = [];
  world.each([Position, Health] as const, (entity, position, health) => {
    players.push({
      id: entity.id,
      hp: health.hp.value,
      x: position.x.value,
      y: position.y.value,
      hidden: position.hidden.value,
      mine: isMine(entity.id),
    });
  });
  return players;
}
`;

const genericStateTemplate = `import type { ClientWorld, ServerWorld } from "snapscript";

export interface ServerSnapshot {
  readonly tick: number;
}

export interface ClientSnapshot {
  readonly myPeerId: number;
}

export function readServerSnapshot(_world: ServerWorld): ServerSnapshot {
  return { tick: 0 };
}

export function readClientSnapshot(world: ClientWorld): ClientSnapshot {
  return { myPeerId: world.myPeerId() };
}
`;

const exampleServerSystemTemplate = `import type { ServerWorld } from "snapscript";
import { Health } from "../../generated/snapscript/protocol";

export function register(world: ServerWorld): void {
  world.system("health.clamp", "postUpdate", (world) => {
    world.each([Health] as const, (_entity, health) => {
      health.hp.value = Math.max(0, Math.min(100, health.hp.value));
    });
  });
}
`;

const genericServerSystemTemplate = `import type { ServerWorld } from "snapscript";

export function register(world: ServerWorld): void {
  world.system("server.update", "update", () => {
    // Add authoritative gameplay systems here.
  });
}
`;

const exampleClientSystemTemplate = `import type { ClientWorld } from "snapscript";
import { Position } from "../../generated/snapscript/protocol";

export function register(world: ClientWorld): void {
  world.system("view.collect", "postUpdate", (world) => {
    world.each([Position] as const, (_entity, position) => {
      void position;
    });
  });
}
`;

const genericClientSystemTemplate = `import type { ClientWorld } from "snapscript";

export function register(world: ClientWorld): void {
  world.system("client.update", "postUpdate", () => {
    // Add client-side read or presentation systems here.
  });
}
`;

const memoryTransportTemplate = `import type {
  ChannelName,
  ClientTransport,
  PeerRef,
  ServerTransport,
} from "snapscript";

export interface MemoryTransportPair {
  readonly server: ServerTransport;
  readonly client: ClientTransport;
}

export function createMemoryTransportPair(): MemoryTransportPair {
  const peer: PeerRef = "memory-client";
  let serverHandler: ((peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void) | undefined;
  let clientHandler: ((channel: ChannelName, bytes: Uint8Array) => void) | undefined;

  return {
    server: {
      send(_peer, channel, bytes) {
        clientHandler?.(channel, bytes);
      },
      broadcast(channel, bytes) {
        clientHandler?.(channel, bytes);
      },
      onPacket(cb) {
        serverHandler = cb;
      },
      peers() {
        return [peer];
      },
    },
    client: {
      send(channel, bytes) {
        serverHandler?.(peer, channel, bytes);
      },
      onPacket(cb) {
        clientHandler = cb;
      },
    },
  };
}
`;

const memoryTransportReadmeTemplate = `# Test Transport

This in-memory transport is only for generated project tests and local wiring checks.
Production transports belong to the platform layer and should adapt engine, WebSocket, WebRTC, or
UDP messages into SnapScript \`Uint8Array\` packets with channel labels.
`;

const exampleRoundtripTestTemplate = `import { describe, expect, it } from "vitest";
import { createClient, createMemoryTransportPair, createServer, MovementMove, Position } from "../src/index";
import type { Clock } from "snapscript";

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

    client.send(MovementMove, { dx: 1, dy: 0 });
    server.tick();
    client.tick();

    const position = client.get(1, Position);
    expect(client.myPeerId()).toBe(1);
    expect(client.isMine(1)).toBe(true);
    expect(position?.x.value).toBe(1);
    expect(position?.y.value).toBe(0);
  });
});
`;

const genericRoundtripTestTemplate = `import { describe, expect, it } from "vitest";
import { createClient, createMemoryTransportPair, createServer } from "../src/index";
import type { Clock } from "snapscript";

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
