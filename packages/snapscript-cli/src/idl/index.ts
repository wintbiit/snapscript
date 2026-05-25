import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import peggy from "peggy";

export type Channel = "reliable" | "unreliable";
export type Decl = ImportDecl | EnumDecl | StructDecl | ComponentDecl | EntityDecl | ServiceDecl;

export interface SnapAst {
  readonly syntax: "v1";
  readonly declarations: readonly Decl[];
}

export interface ImportDecl {
  readonly kind: "import";
  readonly path: string;
}

export interface EnumDecl {
  readonly kind: "enum";
  readonly name: string;
  readonly values: readonly string[];
}

export interface StructDecl {
  readonly kind: "struct";
  readonly name: string;
  readonly body: readonly ComponentItem[];
}

export interface ComponentDecl {
  readonly kind: "component";
  readonly name: string;
  readonly body: readonly ComponentItem[];
}

export interface EntityDecl {
  readonly kind: "entity";
  readonly name: string;
  readonly components: readonly EntityItem[];
}

export interface ServiceDecl {
  readonly kind: "service";
  readonly name: string;
  readonly rpcs: readonly RpcItem[];
}

export type ComponentItem = FieldItem | StructSpread;

export interface FieldItem {
  readonly kind: "field";
  readonly name: string;
  readonly type: TypeExpr;
}

export interface StructSpread {
  readonly kind: "spread";
  readonly name: string;
}

export interface EntityItem {
  readonly name: string;
  readonly component: string;
}

export interface RpcItem {
  readonly kind: "command" | "event";
  readonly name: string;
  readonly args: readonly FieldItem[];
  readonly channel: Channel;
}

export interface TypeExpr {
  readonly name: string;
  readonly args: readonly Arg[];
}

export interface Arg {
  readonly name?: string;
  readonly value: string | number | boolean | TypeExpr;
}

export interface Manifest {
  readonly enums?: Record<string, { readonly values: readonly string[] }>;
  readonly components?: Record<string, LockedDef>;
  readonly entities?: Record<string, LockedDef>;
  readonly commands?: Record<string, LockedDef>;
  readonly events?: Record<string, LockedDef>;
}

export interface LockedDef {
  readonly id: number;
  readonly fields?: Record<string, number>;
  readonly types?: Record<string, unknown>;
}

export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

export interface GenerateOptions {
  readonly inputPath: string;
  readonly outDir?: string;
  readonly write?: boolean;
}

export interface SnapRpcModel {
  readonly kind: "command" | "event";
  readonly serviceName: string;
  readonly rpcName: string;
  readonly runtimeName: string;
  readonly exportName: string;
  readonly payloadTypeName: string;
}

export interface SnapModel {
  readonly ast: SnapAst;
  readonly manifest: Required<Manifest>;
  readonly commands: readonly SnapRpcModel[];
  readonly events: readonly SnapRpcModel[];
}

const grammar = String.raw`
{
  function node(kind, props) { return { kind, ...props }; }
}

Start = _ syntax:Syntax _ declarations:Declaration* _ { return { syntax, declarations }; }
Syntax = "syntax" __ "=" __ q:StringLiteral _ { if (q !== "v1") throw new Error("Only syntax \"v1\" is supported"); return q; }
Declaration = Import / Enum / Struct / Component / Entity / Service
Import = "import" __ path:StringLiteral _ { return node("import", { path }); }
Enum = "enum" __ name:Ident _ "{" _ values:EnumValue* "}" _ { return node("enum", { name, values }); }
EnumValue = value:Ident _ { return value; }
Struct = "struct" __ name:Ident _ "{" _ body:ComponentItem* "}" _ { return node("struct", { name, body }); }
Component = "component" __ name:Ident _ "{" _ body:ComponentItem* "}" _ { return node("component", { name, body }); }
Entity = "entity" __ name:Ident _ "{" _ components:EntityItem* "}" _ { return node("entity", { name, components }); }
Service = "service" __ name:Ident _ "{" _ rpcs:RpcItem* "}" _ { return node("service", { name, rpcs }); }
ComponentItem = FieldItem / SpreadItem
SpreadItem = name:Ident _ { return node("spread", { name }); }
FieldItem = name:Ident _ ":" _ type:TypeExpr _ { return node("field", { name, type }); }
EntityItem = name:Ident _ ":" _ component:Ident _ { return { name, component }; }
RpcItem = kind:("command" / "event") __ name:Ident _ "(" _ args:ArgList? _ ")" _ channel:("reliable" / "unreliable") _ {
  return { kind, name, args: args ?? [], channel };
}
ArgList = head:FieldItem tail:(_ "," _ FieldItem)* { return [head, ...tail.map((item) => item[3])]; }
TypeExpr = name:Ident _ "(" _ args:CallArgs? _ ")" { return { name, args: args ?? [] }; } / name:Ident { return { name, args: [] }; }
CallArgs = head:CallArg tail:(_ "," _ CallArg)* { return [head, ...tail.map((item) => item[3])]; }
CallArg = name:Ident _ ":" _ value:(Value / TypeExpr) { return { name, value }; } / value:(Value / TypeExpr) { return { value }; }
Value = StringLiteral / NumberLiteral / BooleanLiteral
StringLiteral = "\"" chars:([^"\\] / "\\" .)* "\"" { return chars.map((c) => Array.isArray(c) ? c[1] : c).join(""); }
NumberLiteral = n:$("-"? [0-9]+ ("." [0-9]+)?) { return Number(n); }
BooleanLiteral = "true" { return true; } / "false" { return false; }
Ident = $([A-Za-z_] [A-Za-z0-9_]*)
__ = [ \t\r\n]+
_ = ([ \t\r\n] / Comment)*
Comment = "//" [^\n\r]*
`;

const parser = peggy.generate(grammar) as { parse(source: string): SnapAst };

export function parseSnap(source: string): SnapAst {
  return parser.parse(source);
}

export function checkSnap(source: string): SnapAst {
  const ast = parseSnap(source);
  validateAst(ast);
  return ast;
}

export function analyzeSnap(source: string): SnapModel {
  const ast = checkSnap(source);
  const manifest = buildManifest(ast);
  const context = buildContext(ast);
  return modelFromContext(ast, manifest, context);
}

function modelFromContext(
  ast: SnapAst,
  manifest: Required<Manifest>,
  context: ReturnType<typeof buildContext>,
): SnapModel {
  const commands: SnapRpcModel[] = [];
  const events: SnapRpcModel[] = [];
  for (const service of context.services.values()) {
    for (const rpc of service.rpcs) {
      const model = {
        kind: rpc.kind,
        serviceName: service.name,
        rpcName: rpc.name,
        runtimeName: `${service.name}.${rpc.name}`,
        exportName: `${service.name}${rpc.name}`,
        payloadTypeName: `${service.name}${rpc.name}Payload`,
      } as const;
      if (rpc.kind === "command") commands.push(model);
      else events.push(model);
    }
  }
  return { ast, manifest, commands, events };
}

export function generateSnap(source: string, options: GenerateOptions): readonly GeneratedFile[] {
  const ast = checkSnap(source);
  return generateFromAst(ast, options);
}

function generateFromAst(ast: SnapAst, options: GenerateOptions): readonly GeneratedFile[] {
  const outDir = options.outDir ?? join(dirname(options.inputPath), "generated");
  const manifest = buildManifest(ast);
  const context = buildContext(ast);
  const protocol = emitProtocol(context, manifest);
  const files = [
    { path: join(outDir, "protocol.ts"), content: protocol },
    { path: join(outDir, "manifest.json"), content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  if (options.write === true) {
    for (const file of files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
  }
  return files;
}

export function generateSnapFile(options: GenerateOptions): readonly GeneratedFile[] {
  const ast = loadSnapFile(options.inputPath);
  return generateFromAst(ast, options);
}

export function checkSnapFile(inputPath: string): SnapAst {
  const ast = loadSnapFile(inputPath);
  validateAst(ast);
  return ast;
}

export function analyzeSnapFile(inputPath: string): SnapModel {
  const ast = loadSnapFile(inputPath);
  validateAst(ast);
  const manifest = buildManifest(ast);
  const context = buildContext(ast);
  return modelFromContext(ast, manifest, context);
}

function loadSnapFile(inputPath: string): SnapAst {
  const root = realpathSync(inputPath);
  const active: string[] = [];
  const imported = new Set<string>();

  function visit(path: string): SnapAst {
    const real = realpathSync(path);
    if (active.includes(real)) {
      throw new Error(`Circular .snap import: ${[...active, real].map((item) => item === root ? inputPath : item).join(" -> ")}`);
    }
    active.push(real);
    const ast = parseSnap(readFileSync(real, "utf8"));
    const declarations: Decl[] = [];
    for (const declaration of ast.declarations) {
      if (declaration.kind !== "import") {
        declarations.push(declaration);
        continue;
      }
      const resolved = realpathSync(resolve(dirname(real), declaration.path));
      if (imported.has(resolved)) {
        throw new Error(`Duplicate .snap import "${declaration.path}"`);
      }
      imported.add(resolved);
      declarations.unshift(...visit(resolved).declarations);
    }
    active.pop();
    return { syntax: ast.syntax, declarations };
  }

  const ast = visit(root);
  validateAst(ast);
  return ast;
}


function validateAst(ast: SnapAst): void {
  const names = new Map<string, string>();
  for (const declaration of ast.declarations) {
    if (declaration.kind === "import") continue;
    const previous = names.get(declaration.name);
    if (previous !== undefined) {
      throw new Error(`Duplicate definition "${declaration.name}" used by ${previous} and ${declaration.kind}`);
    }
    names.set(declaration.name, declaration.kind);
  }
  buildContext(ast);
}

function buildContext(ast: SnapAst) {
  const enums = new Map<string, EnumDecl>();
  const structs = new Map<string, StructDecl>();
  const components = new Map<string, ComponentDecl>();
  const entities = new Map<string, EntityDecl>();
  const services = new Map<string, ServiceDecl>();
  for (const declaration of ast.declarations) {
    if (declaration.kind === "enum") enums.set(declaration.name, declaration);
    if (declaration.kind === "struct") structs.set(declaration.name, declaration);
    if (declaration.kind === "component") components.set(declaration.name, declaration);
    if (declaration.kind === "entity") entities.set(declaration.name, declaration);
    if (declaration.kind === "service") services.set(declaration.name, declaration);
  }
  for (const component of components.values()) {
    expandComponentBody(component.body, structs, enums, [component.name]);
  }
  for (const entity of entities.values()) {
    for (const item of entity.components) {
      if (!components.has(item.component)) {
        throw new Error(`Entity "${entity.name}" references unknown component "${item.component}"`);
      }
    }
  }
  for (const service of services.values()) {
    for (const rpc of service.rpcs) {
      for (const arg of rpc.args) {
        if (structs.has(arg.type.name)) {
          expandComponentBody([{ kind: "spread", name: arg.type.name }], structs, enums, [service.name, rpc.name]);
        } else {
          assertFieldType(arg.type.name, `${service.name}.${rpc.name}.${arg.name}`, enums);
        }
      }
    }
  }
  for (const item of enums.values()) {
    if (new Set(item.values).size !== item.values.length || item.values.length === 0) {
      throw new Error(`Enum "${item.name}" must contain unique values`);
    }
  }
  return { enums, structs, components, entities, services };
}

function expandComponentBody(
  body: readonly ComponentItem[],
  structs: Map<string, StructDecl>,
  enums: Map<string, EnumDecl>,
  stack: readonly string[],
): FieldItem[] {
  const fields: FieldItem[] = [];
  const seen = new Set<string>();
  for (const item of body) {
    if (item.kind === "field") {
      assertFieldType(item.type.name, item.name, enums);
      if (seen.has(item.name)) throw new Error(`Duplicate field "${item.name}"`);
      seen.add(item.name);
      fields.push(item);
      continue;
    }
    const struct = structs.get(item.name);
    if (struct === undefined) {
      throw new Error(`Unknown struct "${item.name}"`);
    }
    if (stack.includes(item.name)) {
      throw new Error(`Recursive struct use: ${[...stack, item.name].join(" -> ")}`);
    }
    for (const field of expandComponentBody(struct.body, structs, enums, [...stack, item.name])) {
      if (seen.has(field.name)) throw new Error(`Duplicate field "${field.name}"`);
      seen.add(field.name);
      fields.push(field);
    }
  }
  return fields;
}

function assertFieldType(name: string, label: string, enums?: Map<string, EnumDecl>): void {
  if (!fieldHelpers.has(name) && enums?.has(name) !== true) {
    throw new Error(`${label} uses unknown field type "${name}"`);
  }
}

const fieldHelpers = new Set([
  "angle12",
  "angle16",
  "angle8",
  "bool",
  "bytes",
  "f32",
  "flags",
  "i16",
  "i32",
  "i8",
  "qf32",
  "array",
  "string",
  "u16",
  "u32",
  "u8",
  "varu32",
  "vec2q",
  "vec3q",
]);

function buildManifest(ast: SnapAst): Required<Manifest> {
  const manifest: Required<Manifest> = {
    enums: {},
    components: {},
    entities: {},
    commands: {},
    events: {},
  };
  const context = buildContext(ast);
  for (const item of context.enums.values()) {
    manifest.enums[item.name] = { values: item.values };
  }
  let componentId = 1;
  for (const component of context.components.values()) {
    manifest.components[component.name] = {
      id: componentId,
      fields: fieldIdsFor(expandComponentBody(component.body, context.structs, context.enums, [component.name])),
      types: fieldTypesFor(expandComponentBody(component.body, context.structs, context.enums, [component.name])),
    };
    componentId += 1;
  }
  let entityId = 1;
  for (const entity of context.entities.values()) {
    manifest.entities[entity.name] = { id: entityId };
    entityId += 1;
  }
  let rpcId = 1;
  for (const service of context.services.values()) {
    for (const rpc of service.rpcs) {
      const name = `${service.name}.${rpc.name}`;
      const target = rpc.kind === "command" ? manifest.commands : manifest.events;
      target[name] = {
        id: rpcId,
        fields: fieldIdsFor(expandRpcFields(rpc, context.structs, context.enums)),
        types: fieldTypesFor(expandRpcFields(rpc, context.structs, context.enums)),
      };
      rpcId += 1;
    }
  }
  return manifest;
}

function fieldIdsFor(fields: readonly FieldItem[]): Record<string, number> {
  const fieldIds: Record<string, number> = {};
  fields.forEach((field, index) => {
    if (index > 31) throw new Error("SnapScript v1 supports at most 32 fields per definition");
    fieldIds[field.name] = index;
  });
  return fieldIds;
}

function fieldTypesFor(fields: readonly FieldItem[]): Record<string, unknown> {
  const types: Record<string, unknown> = {};
  for (const field of fields) {
    types[field.name] = normalizeType(field.type);
  }
  return types;
}

function normalizeType(type: TypeExpr): unknown {
  return {
    name: type.name,
    args: type.args.map((arg) => ({
      ...(arg.name === undefined ? {} : { name: arg.name }),
      value: typeof arg.value === "object" ? normalizeType(arg.value) : arg.value,
    })),
  };
}

function emitProtocol(context: ReturnType<typeof buildContext>, manifest: Required<Manifest>): string {
  const helpers = new Set<string>(["defineComponent", "defineEntity", "defineCommand", "defineEvent", "defineProtocol"]);
  for (const struct of context.structs.values()) {
    for (const field of expandComponentBody(struct.body, context.structs, context.enums, [struct.name])) {
      collectHelpers(helpers, field.type, context.enums);
    }
  }
  for (const component of context.components.values()) {
    for (const field of expandComponentBody(component.body, context.structs, context.enums, [component.name])) {
      collectHelpers(helpers, field.type, context.enums);
    }
  }
  for (const service of context.services.values()) {
    for (const rpc of service.rpcs) {
      for (const field of expandRpcFields(rpc, context.structs, context.enums)) {
        collectHelpers(helpers, field.type, context.enums);
      }
    }
  }
  const protocolHash = hashManifest(manifest);

  const lines: string[] = [
    `import { ${[...helpers].sort().join(", ")} } from "snapscript";`,
    `import type { ClientWorld, CommandDefinition, EventDefinition, FieldDefinitions, FieldValues, ServerWorld, PeerId, RpcHandler } from "snapscript";`,
    "",
    `type RpcFields<T> = T extends CommandDefinition<infer TFields> ? TFields : T extends EventDefinition<infer TFields> ? TFields : never;`,
    `type RpcPayload<T> = FieldValues<RpcFields<T> & FieldDefinitions>;`,
    "",
  ];
  for (const item of context.enums.values()) {
    lines.push(`export const ${item.name}Values = ${JSON.stringify(item.values)} as const;`);
    lines.push(`export type ${item.name} = typeof ${item.name}Values[number];`);
    lines.push("");
  }
  for (const struct of context.structs.values()) {
    lines.push(`export const ${struct.name}Fields = ${emitFields(expandComponentBody(struct.body, context.structs, context.enums, [struct.name]), context.enums)} as const;`);
    lines.push("");
  }
  for (const component of context.components.values()) {
    const fields = expandComponentBody(component.body, context.structs, context.enums, [component.name]);
    lines.push(`export const ${component.name} = defineComponent(${JSON.stringify(component.name)}, ${emitFields(fields, context.enums)}, { id: ${manifest.components[component.name]!.id}, fieldIds: ${JSON.stringify(manifest.components[component.name]!.fields)} });`);
  }
  if (context.components.size > 0) lines.push("");
  for (const entity of context.entities.values()) {
    lines.push(`export const ${entity.name} = defineEntity(${JSON.stringify(entity.name)}, { ${entity.components.map((item) => `${item.name}: ${item.component}`).join(", ")} }, { id: ${manifest.entities[entity.name]!.id} });`);
  }
  if (context.entities.size > 0) lines.push("");
  const commandNames: string[] = [];
  const eventNames: string[] = [];
  for (const service of context.services.values()) {
    for (const rpc of service.rpcs) {
      const runtimeName = `${service.name}.${rpc.name}`;
      const exportName = `${service.name}${rpc.name}`;
      const manifestMap = rpc.kind === "command" ? manifest.commands : manifest.events;
      const factory = rpc.kind === "command" ? "defineCommand" : "defineEvent";
      const collection = rpc.kind === "command" ? commandNames : eventNames;
      collection.push(exportName);
      lines.push(`export const ${exportName} = ${factory}(${JSON.stringify(runtimeName)}, ${emitFields(expandRpcFields(rpc, context.structs, context.enums), context.enums)}, { id: ${manifestMap[runtimeName]!.id}, fieldIds: ${JSON.stringify(manifestMap[runtimeName]!.fields)}, channel: ${JSON.stringify(rpc.channel)} });`);
      lines.push(`export type ${exportName}Payload = RpcPayload<typeof ${exportName}>;`);
    }
  }
  if (commandNames.length + eventNames.length > 0) lines.push("");
  lines.push(`export const protocolHash = ${JSON.stringify(protocolHash)};`);
  lines.push("");
  lines.push(`export const protocol = defineProtocol({`);
  lines.push(`  components: { ${[...context.components.keys()].join(", ")} },`);
  lines.push(`  prefabs: { ${[...context.entities.keys()].join(", ")} },`);
  lines.push(`  commands: { ${commandNames.join(", ")} },`);
  lines.push(`  events: { ${eventNames.join(", ")} },`);
  lines.push(`  hash: protocolHash,`);
  lines.push(`});`);
  lines.push("");
  lines.push(emitRpcBindings(commandNames, eventNames));
  return `${lines.join("\n")}\n`;
}

function expandRpcFields(
  rpc: RpcItem,
  structs: Map<string, StructDecl>,
  enums: Map<string, EnumDecl>,
): FieldItem[] {
  if (rpc.args.length === 1 && structs.has(rpc.args[0]!.type.name)) {
    return expandComponentBody([{ kind: "spread", name: rpc.args[0]!.type.name }], structs, enums, [rpc.name]);
  }
  return [...rpc.args];
}

function emitFields(fields: readonly FieldItem[], enums: Map<string, EnumDecl>): string {
  return `{ ${fields.map((field) => `${field.name}: ${emitType(field.type, enums)}`).join(", ")} }`;
}

function emitType(type: TypeExpr, enums: Map<string, EnumDecl>): string {
  const enumDecl = enums.get(type.name);
  if (enumDecl !== undefined) {
    const defaultArg = type.args.find((arg) => arg.name === "default")?.value;
    const defaultValue = typeof defaultArg === "object" ? defaultArg.name : defaultArg;
    if (typeof defaultValue !== "string" || !enumDecl.values.includes(defaultValue)) {
      throw new Error(`Enum field "${type.name}" requires a valid default`);
    }
    return `enumOf(${type.name}Values, ${JSON.stringify(defaultValue)})`;
  }
  if (type.name === "string") {
    const defaultValue = typedArg(type, "default", "");
    const maxBytes = requiredNumberArg(type, "maxBytes");
    return `stringOf(${JSON.stringify(defaultValue)}, { maxBytes: ${maxBytes} })`;
  }
  if (type.name === "bytes") {
    const maxBytes = requiredNumberArg(type, "maxBytes");
    return `bytesOf(new Uint8Array(), { maxBytes: ${maxBytes} })`;
  }
  if (type.name === "array") {
    const item = type.args.find((arg) => arg.name === undefined)?.value;
    if (typeof item !== "object") {
      throw new Error("array() requires an item field expression");
    }
    const maxItems = requiredNumberArg(type, "maxItems");
    return `arrayOf(${emitType(item, enums)}, [], { maxItems: ${maxItems} })`;
  }
  if (type.args.length === 0) {
    if (type.name === "bool") return "bool(false)";
    return `${type.name}(0)`;
  }
  const named = type.args.every((arg) => arg.name !== undefined);
  if (named) {
    if (objectOptionFieldHelpers.has(type.name)) {
      return `${type.name}({ ${type.args.map((arg) => `${arg.name}: ${JSON.stringify(arg.value)}`).join(", ")} })`;
    }
    const defaultArg = type.args.find((arg) => arg.name === "default");
    if (defaultArg !== undefined) {
      const metadata = type.args.filter((arg) => arg.name !== "default");
      if (metadata.length === 0) {
        return `${type.name}(${JSON.stringify(defaultArg.value)})`;
      }
      return `${type.name}(${JSON.stringify(defaultArg.value)}, { ${metadata.map((arg) => `${arg.name}: ${JSON.stringify(arg.value)}`).join(", ")} })`;
    }
    return `${type.name}({ ${type.args.map((arg) => `${arg.name}: ${JSON.stringify(arg.value)}`).join(", ")} })`;
  }
  return `${type.name}(${type.args.map((arg) => JSON.stringify(arg.value)).join(", ")})`;
}

function typedArg<TDefault extends string | number | boolean>(
  type: TypeExpr,
  name: string,
  defaultValue: TDefault,
): TDefault | string | number | boolean {
  const value = type.args.find((arg) => arg.name === name)?.value;
  return typeof value === "object" || value === undefined ? defaultValue : value;
}

function requiredNumberArg(type: TypeExpr, name: string): number {
  const value = type.args.find((arg) => arg.name === name)?.value;
  if (typeof value !== "number") {
    throw new Error(`${type.name}() requires numeric ${name}`);
  }
  return value;
}

function collectHelpers(
  helpers: Set<string>,
  type: TypeExpr,
  enums: Map<string, EnumDecl>,
): void {
  if (enums.has(type.name)) {
    helpers.add("enumOf");
    return;
  }
  if (type.name === "string") helpers.add("stringOf");
  else if (type.name === "bytes") helpers.add("bytesOf");
  else if (type.name === "array") {
    helpers.add("arrayOf");
    const item = type.args.find((arg) => arg.name === undefined)?.value;
    if (typeof item === "object") collectHelpers(helpers, item, enums);
  } else {
    helpers.add(type.name);
  }
}

const objectOptionFieldHelpers = new Set(["qf32", "vec2q", "vec3q"]);

function hashManifest(manifest: Required<Manifest>): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function emitRpcBindings(commands: readonly string[], events: readonly string[]): string {
  return `export const rpc = {
  commands: {
${commands.map((name) => `    ${name}: {
      /** Sends the ${name} command from a client world to the server. */
      send(world: ClientWorld, payload?: Partial<RpcPayload<typeof ${name}>>) {
        world.send(${name}, payload);
      },
      /** Registers the server-side handler for the ${name} command. */
      on(world: ServerWorld, handler: RpcHandler<RpcFields<typeof ${name}> & FieldDefinitions>) {
        return world.on(${name}, handler);
      },
    },`).join("\n")}
  },
  events: {
${events.map((name) => `    ${name}: {
      /** Broadcasts the ${name} event from the server to all connected clients. */
      broadcast(world: ServerWorld, payload?: Partial<RpcPayload<typeof ${name}>>) {
        world.broadcast(${name}, payload);
      },
      /** Sends the ${name} event from the server to one peer id. */
      sendTo(world: ServerWorld, peerId: PeerId, payload?: Partial<RpcPayload<typeof ${name}>>) {
        world.sendTo(peerId, ${name}, payload);
      },
      /** Registers the client-side handler for the ${name} event. */
      on(world: ClientWorld, handler: RpcHandler<RpcFields<typeof ${name}> & FieldDefinitions>) {
        return world.on(${name}, handler);
      },
    },`).join("\n")}
  },
} as const;`;
}
