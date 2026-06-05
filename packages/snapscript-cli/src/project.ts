import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Eta } from "eta";
import ts from "typescript";
import { analyzeSnapFile, generateSnapFile, type GeneratedFile, type SnapModel, type SnapRpcModel } from "./idl/index";

export type ReportStatus = "generated" | "created" | "kept" | "missing" | "stale";

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
  readonly serverModules: readonly EndpointModuleData[];
  readonly clientModules: readonly EndpointModuleData[];
}

interface RpcTemplateData {
  readonly endpointName: string;
  readonly rpcName: string;
  readonly exportName: string;
  readonly payloadTypeName: string;
  readonly generatedImportPath: string;
  readonly facadePath: string;
  readonly handlerPath: string;
  readonly moduleName: string;
  readonly side: "server" | "client";
  readonly targetArg: string;
  readonly targetParam: string;
  readonly eventSourceArg: string;
  readonly eventSourceParam: string;
}

interface EndpointModuleData {
  readonly endpointName: string;
  readonly side: "server" | "client";
  readonly filePath: string;
  readonly importPath: string;
  readonly alias: string;
  readonly rpcs: readonly RpcTemplateData[];
}

interface SystemModule {
  readonly alias: string;
  readonly importPath: string;
}

const eta = new Eta({ autoTrim: false });

export function generateProject(options: GenerateProjectOptions): readonly ReportItem[] {
  const cwd = resolve(options.cwd);
  const schemaPath = isAbsolute(options.schemaPath) ? options.schemaPath : resolve(cwd, options.schemaPath);
  const outDir = options.outDir ?? "src/generated";
  const outPath = isAbsolute(outDir) ? outDir : resolve(cwd, outDir);
  const model = analyzeSnapFile(schemaPath);
  const report: ReportItem[] = [];

  for (const file of generateSnapFile({ inputPath: schemaPath, outDir: outPath })) {
    writeGenerated(file, report, cwd);
  }

  const data = templateData(model, packageNameFor(cwd), toPosix(relative(cwd, schemaPath)));
  writeGenerated({ path: join(outPath, "commands.ts"), content: render(commandsTemplate, data) }, report, cwd);
  writeGenerated({ path: join(outPath, "events.ts"), content: render(eventsTemplate, data) }, report, cwd);
  writeGenerated({ path: join(outPath, "register.ts"), content: render(registerTemplate, data) }, report, cwd);

  writeSystemRegistry(cwd, outPath, "server", report);
  writeSystemRegistry(cwd, outPath, "client", report);

  writeEndpointStubs(cwd, data.serverModules, report);
  writeEndpointStubs(cwd, data.clientModules, report);
  report.push(...scanEndpointExports(cwd, data.serverModules));
  report.push(...scanEndpointExports(cwd, data.clientModules));
  report.push(...staleLegacyRpcFiles(cwd));

  return report;
}

export function formatReport(report: readonly ReportItem[]): string {
  return report.map((item) => `${item.status.padEnd(9)} ${item.path}`).join("\n");
}

function templateData(model: SnapModel, packageName: string, schemaScriptPath: string): TemplateData {
  const commands = model.commands.map((rpc) => rpcData(rpc, "server"));
  const events = model.events.map((rpc) => rpcData(rpc, "client"));
  return {
    packageName,
    schemaScriptPath,
    commands,
    events,
    serverModules: endpointModules(commands, "server"),
    clientModules: endpointModules(events, "client"),
  };
}

function rpcData(rpc: SnapRpcModel, side: "server" | "client"): RpcTemplateData {
  const handlerPath = rpc.handlerPath.join("/");
  const endpointName = rpc.endpointName;
  return {
    endpointName,
    rpcName: rpc.rpcName,
    exportName: rpc.exportName,
    payloadTypeName: rpc.payloadTypeName,
    generatedImportPath: relativeImport(dirname(handlerPath), "generated/protocol"),
    facadePath: `.${endpointName}.${rpc.kind === "command" ? "commands" : "events"}.${rpc.rpcName}`,
    handlerPath,
    moduleName: moduleNameFor(endpointName, side),
    side,
    targetParam: endpointName === "World" || endpointName === "Peer" ? "" : "target: ReadonlyEntityRef, ",
    targetArg: endpointName === "World" || endpointName === "Peer" ? "" : "target, ",
    eventSourceParam: endpointName === "World" || endpointName === "Peer" ? "" : "source: ReadonlyEntityRef, ",
    eventSourceArg: endpointName === "World" || endpointName === "Peer" ? "" : "source, ",
  };
}

function endpointModules(rpcs: readonly RpcTemplateData[], side: "server" | "client"): readonly EndpointModuleData[] {
  const byPath = new Map<string, RpcTemplateData[]>();
  for (const rpc of rpcs) {
    byPath.set(rpc.handlerPath, [...(byPath.get(rpc.handlerPath) ?? []), rpc]);
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, moduleRpcs]) => {
      const endpointName = moduleRpcs[0]?.endpointName ?? "Unknown";
      return {
        endpointName,
        side,
        filePath,
        importPath: `../${filePath.replace(/\.ts$/, "")}`,
        alias: moduleNameFor(endpointName, side),
        rpcs: moduleRpcs,
      };
    });
}

function writeEndpointStubs(cwd: string, modules: readonly EndpointModuleData[], report: ReportItem[]): void {
  for (const module of modules) {
    const path = join(cwd, "src", module.filePath);
    const template = module.side === "server" ? commandEndpointStubTemplate : eventEndpointStubTemplate;
    writeCreateOnly(path, render(template, { module }), report, cwd);
  }
}

function writeSystemRegistry(cwd: string, outPath: string, side: "server" | "client", report: ReportItem[]): void {
  const modules = scanSystemModules(cwd, side, outPath);
  const typeName = side === "server" ? "ServerWorld" : "ClientWorld";
  const fnName = side === "server" ? "registerServerSystems" : "registerClientSystems";
  const content = render(systemRegistryTemplate, { modules, typeName, fnName });
  writeGenerated({ path: join(outPath, `systems.${side}.ts`), content }, report, cwd);
}

function scanSystemModules(cwd: string, side: "server" | "client", outPath: string): readonly SystemModule[] {
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
      importPath: relativeImport(relative(cwd, outPath), `src/systems/${side}/${file.replace(/\.ts$/, "")}`),
    };
  });
}

function scanEndpointExports(cwd: string, modules: readonly EndpointModuleData[]): readonly ReportItem[] {
  const report: ReportItem[] = [];
  for (const module of modules) {
    const fullPath = join(cwd, "src", module.filePath);
    if (!existsSync(fullPath)) continue;
    const sourceFile = ts.createSourceFile(fullPath, readFileSync(fullPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const exports = exportedNames(sourceFile);
    const expected = new Set(module.rpcs.map((rpc) => rpc.rpcName));
    for (const name of expected) {
      if (!exports.has(name)) {
        report.push({ status: "missing", path: `${toPosix(relative(cwd, fullPath))}#${name}` });
      }
    }
    for (const item of exports) {
      if (!expected.has(item) && looksLikeHandlerExport(item)) {
        report.push({ status: "stale", path: `${toPosix(relative(cwd, fullPath))}#${item}` });
      }
    }
  }
  return report;
}

function exportedNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (hasExportModifier(statement)) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name !== undefined) {
        names.add(statement.name.text);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add(element.propertyName?.text ?? element.name.text);
      }
    }
  }
  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function looksLikeHandlerExport(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(name);
}

function staleLegacyRpcFiles(cwd: string): readonly ReportItem[] {
  const stale: ReportItem[] = [];
  for (const dirName of ["entities", "peer", "world"] as const) {
    const dir = join(cwd, "src", dirName);
    if (!existsSync(dir)) continue;
    stale.push(...legacyRpcFilesInDir(dir, cwd));
  }
  return stale;
}

function legacyRpcFilesInDir(dir: string, cwd: string): readonly ReportItem[] {
  const stale: ReportItem[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      stale.push(...legacyRpcFilesInDir(fullPath, cwd));
      continue;
    }
    if (entry.name.endsWith(".command.ts") || entry.name.endsWith(".event.ts")) {
      stale.push({ status: "stale", path: toPosix(relative(cwd, fullPath)) });
    }
  }
  return stale;
}

function relativeImport(fromDir: string, toPath: string): string {
  const relativePath = toPosix(relative(fromDir, toPath)).replace(/\.ts$/, "");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function moduleNameFor(endpointName: string, side: "server" | "client"): string {
  return `${side}${endpointName}`;
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

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

const registerTemplate = `// Code-generated by snapscript-cli. Do not edit.
import type { ClientWorld, ServerWorld } from "snapscript";
import { internal } from "./protocol";
<% it.serverModules.forEach((module) => { %>import * as <%= module.alias %> from "<%= module.importPath %>";
<% }) %><% it.clientModules.forEach((module) => { %>import * as <%= module.alias %> from "<%= module.importPath %>";
<% }) %>
export function registerServerRpc(world: ServerWorld): void {
<% if (it.commands.length === 0) { %>  void world;
<% } else { %><% it.commands.forEach((rpc) => { %>  internal<%= rpc.facadePath %>.on(world, (ctx) => <%= rpc.moduleName %>.<%= rpc.rpcName %>(world, ctx));
<% }) %><% } %>}

export function registerClientRpc(world: ClientWorld): void {
<% if (it.events.length === 0) { %>  void world;
<% } else { %><% it.events.forEach((rpc) => { %>  internal<%= rpc.facadePath %>.on(world, (ctx) => <%= rpc.moduleName %>.<%= rpc.rpcName %>(world, ctx));
<% }) %><% } %>}
`;

const commandsTemplate = `// Code-generated by snapscript-cli. Do not edit.
import type { ClientWorld, ReadonlyEntityRef } from "snapscript";
import { internal } from "./protocol";
import type {
<% it.commands.forEach((rpc) => { %>  <%= rpc.payloadTypeName %>,
<% }) %>} from "./protocol";

export const commands = {
<% [...new Set(it.commands.map((rpc) => rpc.endpointName))].forEach((endpointName) => { %>  <%= endpointName %>: {
<% it.commands.filter((rpc) => rpc.endpointName === endpointName).forEach((rpc) => { %>    <%= rpc.rpcName %>(world: ClientWorld, <%= rpc.targetParam %>payload: <%= rpc.payloadTypeName %>): void {
      internal<%= rpc.facadePath %>.send(world, <%= rpc.targetArg %>payload);
    },
<% }) %>  },
<% }) %>} as const;
`;

const eventsTemplate = `// Code-generated by snapscript-cli. Do not edit.
import type { ReadonlyEntityRef, ServerWorld } from "snapscript";
import { internal } from "./protocol";
import type {
<% it.events.forEach((rpc) => { %>  <%= rpc.payloadTypeName %>,
<% }) %>} from "./protocol";

type PeerTarget = ReadonlyEntityRef | readonly ReadonlyEntityRef[];

export const events = {
<% [...new Set(it.events.map((rpc) => rpc.endpointName))].forEach((endpointName) => { %>  <%= endpointName %>: {
<% it.events.filter((rpc) => rpc.endpointName === endpointName).forEach((rpc) => { %>    <%= rpc.rpcName %>: {
      broadcast(world: ServerWorld, <%= rpc.eventSourceParam %>payload: <%= rpc.payloadTypeName %>): void {
        internal<%= rpc.facadePath %>.broadcast(world, <%= rpc.eventSourceArg %>payload);
      },
      sendTo(world: ServerWorld, targets: PeerTarget, <%= rpc.eventSourceParam %>payload: <%= rpc.payloadTypeName %>): void {
        internal<%= rpc.facadePath %>.sendTo(world, targets, <%= rpc.eventSourceArg %>payload);
      },
    },
<% }) %>  },
<% }) %>} as const;
`;

const commandEndpointStubTemplate = `<% it.module.rpcs.forEach((rpc, index) => { %><% if (index === 0) { %>import type { CommandCtx, ServerWorld } from "snapscript";
import type {
<% } %>  <%= rpc.payloadTypeName %>,
<% }) %>} from "../../generated/protocol";

<% it.module.rpcs.forEach((rpc) => { %>export function <%= rpc.rpcName %>(world: ServerWorld, ctx: CommandCtx<<%= rpc.payloadTypeName %>>): void {
  void world;
  void ctx;
}

<% }) %>`;

const eventEndpointStubTemplate = `<% it.module.rpcs.forEach((rpc, index) => { %><% if (index === 0) { %>import type { ClientWorld, EventCtx } from "snapscript";
import type {
<% } %>  <%= rpc.payloadTypeName %>,
<% }) %>} from "../../generated/protocol";

<% it.module.rpcs.forEach((rpc) => { %>export function <%= rpc.rpcName %>(world: ClientWorld, ctx: EventCtx<<%= rpc.payloadTypeName %>>): void {
  void world;
  void ctx;
}

<% }) %>`;

const systemRegistryTemplate = `// Code-generated by snapscript-cli. Do not edit.
import type { <%= it.typeName %> } from "snapscript";
<% it.modules.forEach((module) => { %>import * as <%= module.alias %> from "<%= module.importPath %>";
<% }) %>
export function <%= it.fnName %>(world: <%= it.typeName %>): void {
<% if (it.modules.length === 0) { %>  void world;
<% } else { %><% it.modules.forEach((module) => { %>  <%= module.alias %>.register(world);
<% }) %><% } %>}
`;
