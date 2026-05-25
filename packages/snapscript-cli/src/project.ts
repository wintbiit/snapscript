import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Eta } from "eta";
import { analyzeSnapFile, generateSnapFile, type GeneratedFile, type SnapModel, type SnapRpcModel } from "./idl/index";

export type ReportStatus = "generated" | "created" | "kept" | "stale";

export interface ReportItem {
  readonly status: ReportStatus;
  readonly path: string;
}

export interface GenerateProjectOptions {
  readonly cwd: string;
  readonly schemaPath: string;
  readonly outDir?: string;
}

interface TemplateData {
  readonly packageName: string;
  readonly schemaScriptPath: string;
  readonly commands: readonly RpcTemplateData[];
  readonly events: readonly RpcTemplateData[];
}

interface RpcTemplateData {
  readonly exportName: string;
  readonly payloadTypeName: string;
  readonly handlerName: string;
  readonly importPath: string;
  readonly filePath: string;
}

interface SystemModule {
  readonly alias: string;
  readonly importPath: string;
}

const eta = new Eta({ autoTrim: false });

export function generateProject(options: GenerateProjectOptions): readonly ReportItem[] {
  const cwd = resolve(options.cwd);
  const schemaPath = isAbsolute(options.schemaPath) ? options.schemaPath : resolve(cwd, options.schemaPath);
  const outDir = options.outDir ?? "src/generated/snapscript";
  const outPath = isAbsolute(outDir) ? outDir : resolve(cwd, outDir);
  const model = analyzeSnapFile(schemaPath);
  const report: ReportItem[] = [];

  assertRpcFileNames(model);

  for (const file of generateSnapFile({ inputPath: schemaPath, outDir: outPath })) {
    writeGenerated(file, report, cwd);
  }

  const data = templateData(model, packageNameFor(cwd), toPosix(relative(cwd, schemaPath)));
  writeGenerated({ path: join(outPath, "rpc.ts"), content: render(rpcRegistryTemplate, data) }, report, cwd);

  writeSystemRegistry(cwd, "server", report);
  writeSystemRegistry(cwd, "client", report);

  writeRpcStubs(cwd, data.commands, "server", "command", report);
  writeRpcStubs(cwd, data.events, "client", "event", report);
  report.push(...staleRpcFiles(cwd, data));

  return report;
}

export function formatReport(report: readonly ReportItem[]): string {
  return report.map((item) => `${item.status.padEnd(9)} ${item.path}`).join("\n");
}

function writeRpcStubs(
  cwd: string,
  rpcs: readonly RpcTemplateData[],
  side: "server" | "client",
  kind: "command" | "event",
  report: ReportItem[],
): void {
  const template = kind === "command" ? commandStubTemplate : eventStubTemplate;
  for (const rpc of rpcs) {
    const path = join(cwd, "src", "rpc", side, rpc.filePath);
    writeCreateOnly(path, render(template, { rpc }), report, cwd);
  }
}

function writeSystemRegistry(cwd: string, side: "server" | "client", report: ReportItem[]): void {
  const modules = scanSystemModules(cwd, side);
  const typeName = side === "server" ? "ServerWorld" : "ClientWorld";
  const fnName = side === "server" ? "registerServerSystems" : "registerClientSystems";
  const content = render(systemRegistryTemplate, { modules, typeName, fnName });
  writeGenerated({ path: join(cwd, "src", "systems", "generated", `${side}.ts`), content }, report, cwd);
}

function scanSystemModules(cwd: string, side: "server" | "client"): readonly SystemModule[] {
  const dir = join(cwd, "src", "systems", side);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".system.ts"))
    .sort((a, b) => a.localeCompare(b));
  return files.map((file, index) => {
    const fullPath = join(dir, file);
    const source = readFileSync(fullPath, "utf8");
    if (!/\bexport\s+(async\s+)?function\s+register\b|\bexport\s+const\s+register\b/.test(source)) {
      throw new Error(`${toPosix(relative(cwd, fullPath))} must export register(world)`);
    }
    return {
      alias: `system${index}`,
      importPath: `../${side}/${file.replace(/\.ts$/, "")}`,
    };
  });
}

function staleRpcFiles(cwd: string, data: TemplateData): readonly ReportItem[] {
  const expected = new Set([
    ...data.commands.map((rpc) => toPosix(join("src", "rpc", "server", rpc.filePath))),
    ...data.events.map((rpc) => toPosix(join("src", "rpc", "client", rpc.filePath))),
  ]);
  const stale: ReportItem[] = [];
  for (const [side, suffix] of [
    ["server", ".command.ts"],
    ["client", ".event.ts"],
  ] as const) {
    const dir = join(cwd, "src", "rpc", side);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(suffix)).sort((a, b) => a.localeCompare(b))) {
      const path = toPosix(join("src", "rpc", side, file));
      if (!expected.has(path)) stale.push({ status: "stale", path });
    }
  }
  return stale;
}

function templateData(model: SnapModel, packageName: string, schemaScriptPath: string): TemplateData {
  return {
    packageName,
    schemaScriptPath,
    commands: model.commands.map((rpc) => rpcData(rpc, "command")),
    events: model.events.map((rpc) => rpcData(rpc, "event")),
  };
}

function rpcData(rpc: SnapRpcModel, kind: "command" | "event"): RpcTemplateData {
  const stem = kebabCase(rpc.rpcName);
  const filePath = `${stem}.${kind}.ts`;
  const handlerName = `${camelCase(rpc.rpcName)}${kind === "command" ? "Command" : "Event"}`;
  return {
    exportName: rpc.exportName,
    payloadTypeName: rpc.payloadTypeName,
    handlerName,
    importPath: kind === "command" ? `../../rpc/server/${stem}.command` : `../../rpc/client/${stem}.event`,
    filePath,
  };
}

function assertRpcFileNames(model: SnapModel): void {
  for (const [kind, rpcs] of [
    ["command", model.commands],
    ["event", model.events],
  ] as const) {
    const seen = new Map<string, SnapRpcModel>();
    for (const rpc of rpcs) {
      const file = `${kebabCase(rpc.rpcName)}.${kind}.ts`;
      const existing = seen.get(file);
      if (existing !== undefined) {
        throw new Error(
          `RPC file name collision: ${existing.runtimeName} and ${rpc.runtimeName} both map to ${file}; rename one RPC`,
        );
      }
      seen.set(file, rpc);
    }
  }
}

function writeGenerated(file: GeneratedFile, report: ReportItem[], cwd: string): void {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.content);
  report.push({ status: "generated", path: toPosix(relative(cwd, file.path)) });
}

function writeCreateOnly(path: string, content: string, report: ReportItem[], cwd: string): void {
  const reportPath = toPosix(relative(cwd, path));
  if (existsSync(path)) {
    report.push({ status: "kept", path: reportPath });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  report.push({ status: "created", path: reportPath });
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

function camelCase(value: string): string {
  const parts = kebabCase(value).split("-").filter(Boolean);
  const [first = "", ...rest] = parts;
  return `${first}${rest.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("")}`;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

const rpcRegistryTemplate = `// Code-generated by snapscript-cli. Do not edit.
import type { ClientWorld, ServerWorld } from "snapscript";
import { rpc } from "./protocol";
<% it.commands.forEach((rpc) => { %>import { <%= rpc.handlerName %> } from "<%= rpc.importPath %>";
<% }) %><% it.events.forEach((rpc) => { %>import { <%= rpc.handlerName %> } from "<%= rpc.importPath %>";
<% }) %>
export function registerServerRpc(world: ServerWorld): void {
<% if (it.commands.length === 0) { %>  void world;
<% } else { %><% it.commands.forEach((rpc) => { %>  rpc.commands.<%= rpc.exportName %>.on(world, (ctx) => <%= rpc.handlerName %>(world, ctx));
<% }) %><% } %>}

export function registerClientRpc(world: ClientWorld): void {
<% if (it.events.length === 0) { %>  void world;
<% } else { %><% it.events.forEach((rpc) => { %>  rpc.events.<%= rpc.exportName %>.on(world, (ctx) => <%= rpc.handlerName %>(world, ctx));
<% }) %><% } %>}
`;

const commandStubTemplate = `import type { RpcCtx, ServerWorld } from "snapscript";
import type { <%= it.rpc.payloadTypeName %> } from "../../generated/snapscript/protocol";

/**
 * Handles a client-to-server command.
 *
 * \`ctx.sender\` is the sending peer id. Validate authority, ownership, and payload limits before
 * mutating authoritative state.
 */
export function <%= it.rpc.handlerName %>(world: ServerWorld, ctx: RpcCtx<<%= it.rpc.payloadTypeName %>>): void {
  void world;
  void ctx;
}
`;

const eventStubTemplate = `import type { ClientWorld, RpcCtx } from "snapscript";
import type { <%= it.rpc.payloadTypeName %> } from "../../generated/snapscript/protocol";

/**
 * Handles a server-to-client event.
 *
 * \`ctx.sender\` is the server peer id. Keep presentation feedback here; authoritative gameplay
 * state should still come from replicated world data.
 */
export function <%= it.rpc.handlerName %>(world: ClientWorld, ctx: RpcCtx<<%= it.rpc.payloadTypeName %>>): void {
  void world;
  void ctx;
}
`;

const systemRegistryTemplate = `// Code-generated by snapscript-cli. Do not edit.
import type { <%= it.typeName %> } from "snapscript";
<% it.modules.forEach((module) => { %>import * as <%= module.alias %> from "<%= module.importPath %>";
<% }) %>
export function <%= it.fnName %>(world: <%= it.typeName %>): void {
<% if (it.modules.length === 0) { %>  void world;
<% } else { %><% it.modules.forEach((module) => { %>  <%= module.alias %>.register(world);
<% }) %><% } %>}
`;
