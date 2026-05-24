import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import peggy from "peggy";

type Channel = "reliable" | "unreliable";
type Decl = StructDecl | ComponentDecl | EntityDecl | ServiceDecl;

interface SnapAst {
  readonly syntax: "v1";
  readonly declarations: readonly Decl[];
}

interface StructDecl {
  readonly kind: "struct";
  readonly name: string;
  readonly body: readonly ComponentItem[];
}

interface ComponentDecl {
  readonly kind: "component";
  readonly name: string;
  readonly body: readonly ComponentItem[];
}

interface EntityDecl {
  readonly kind: "entity";
  readonly name: string;
  readonly components: readonly EntityItem[];
}

interface ServiceDecl {
  readonly kind: "service";
  readonly name: string;
  readonly rpcs: readonly RpcItem[];
}

type ComponentItem = FieldItem | StructSpread;

interface FieldItem {
  readonly kind: "field";
  readonly name: string;
  readonly type: TypeExpr;
}

interface StructSpread {
  readonly kind: "spread";
  readonly name: string;
}

interface EntityItem {
  readonly name: string;
  readonly component: string;
}

interface RpcItem {
  readonly kind: "command" | "event";
  readonly name: string;
  readonly args: readonly FieldItem[];
  readonly channel: Channel;
}

interface TypeExpr {
  readonly name: string;
  readonly args: readonly Arg[];
}

interface Arg {
  readonly name?: string;
  readonly value: string | number | boolean;
}

interface Manifest {
  readonly components?: Record<string, LockedDef>;
  readonly entities?: Record<string, LockedDef>;
  readonly commands?: Record<string, LockedDef>;
  readonly events?: Record<string, LockedDef>;
}

interface LockedDef {
  readonly id: number;
  readonly fields?: Record<string, number>;
}

interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

interface GenerateOptions {
  readonly inputPath: string;
  readonly outDir?: string;
  readonly write?: boolean;
}

const grammar = String.raw`
{
  function node(kind, props) { return { kind, ...props }; }
}

Start = _ syntax:Syntax _ declarations:Declaration* _ { return { syntax, declarations }; }
Syntax = "syntax" __ "=" __ q:StringLiteral _ { if (q !== "v1") throw new Error("Only syntax \"v1\" is supported"); return q; }
Declaration = Struct / Component / Entity / Service
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
CallArg = name:Ident _ ":" _ value:Value { return { name, value }; } / value:Value { return { value }; }
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

export function generateSnap(source: string, options: GenerateOptions): readonly GeneratedFile[] {
  const ast = checkSnap(source);
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
  return generateSnap(readFileSync(options.inputPath, "utf8"), options);
}

function validateAst(ast: SnapAst): void {
  const names = new Map<string, string>();
  for (const declaration of ast.declarations) {
    const previous = names.get(declaration.name);
    if (previous !== undefined) {
      throw new Error(`Duplicate definition "${declaration.name}" used by ${previous} and ${declaration.kind}`);
    }
    names.set(declaration.name, declaration.kind);
  }
  buildContext(ast);
}

function buildContext(ast: SnapAst) {
  const structs = new Map<string, StructDecl>();
  const components = new Map<string, ComponentDecl>();
  const entities = new Map<string, EntityDecl>();
  const services = new Map<string, ServiceDecl>();
  for (const declaration of ast.declarations) {
    if (declaration.kind === "struct") structs.set(declaration.name, declaration);
    if (declaration.kind === "component") components.set(declaration.name, declaration);
    if (declaration.kind === "entity") entities.set(declaration.name, declaration);
    if (declaration.kind === "service") services.set(declaration.name, declaration);
  }
  for (const component of components.values()) {
    expandComponentBody(component.body, structs, [component.name]);
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
          expandComponentBody([{ kind: "spread", name: arg.type.name }], structs, [service.name, rpc.name]);
        } else {
          assertFieldType(arg.type.name, `${service.name}.${rpc.name}.${arg.name}`);
        }
      }
    }
  }
  return { structs, components, entities, services };
}

function expandComponentBody(
  body: readonly ComponentItem[],
  structs: Map<string, StructDecl>,
  stack: readonly string[],
): FieldItem[] {
  const fields: FieldItem[] = [];
  const seen = new Set<string>();
  for (const item of body) {
    if (item.kind === "field") {
      assertFieldType(item.type.name, item.name);
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
    for (const field of expandComponentBody(struct.body, structs, [...stack, item.name])) {
      if (seen.has(field.name)) throw new Error(`Duplicate field "${field.name}"`);
      seen.add(field.name);
      fields.push(field);
    }
  }
  return fields;
}

function assertFieldType(name: string, label: string, structs?: Map<string, StructDecl>): void {
  if (structs?.has(name)) return;
  if (!fieldHelpers.has(name)) {
    throw new Error(`${label} uses unknown field type "${name}"`);
  }
}

const fieldHelpers = new Set([
  "angle12",
  "angle16",
  "angle8",
  "bool",
  "f32",
  "flags",
  "i16",
  "i32",
  "i8",
  "qf32",
  "u16",
  "u32",
  "u8",
  "varu32",
  "vec2q",
  "vec3q",
]);

function buildManifest(ast: SnapAst): Required<Manifest> {
  const manifest: Required<Manifest> = {
    components: {},
    entities: {},
    commands: {},
    events: {},
  };
  const context = buildContext(ast);
  let componentId = 1;
  for (const component of context.components.values()) {
    manifest.components[component.name] = {
      id: componentId,
      fields: fieldIdsFor(expandComponentBody(component.body, context.structs, [component.name])),
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
        fields: fieldIdsFor(expandRpcFields(rpc, context.structs)),
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

function emitProtocol(context: ReturnType<typeof buildContext>, manifest: Required<Manifest>): string {
  const helpers = new Set<string>(["defineComponent", "defineEntity", "defineCommand", "defineEvent", "defineProtocol"]);
  for (const struct of context.structs.values()) {
    for (const field of expandComponentBody(struct.body, context.structs, [struct.name])) helpers.add(field.type.name);
  }
  for (const component of context.components.values()) {
    for (const field of expandComponentBody(component.body, context.structs, [component.name])) helpers.add(field.type.name);
  }
  for (const service of context.services.values()) {
    for (const rpc of service.rpcs) {
      for (const field of expandRpcFields(rpc, context.structs)) helpers.add(field.type.name);
    }
  }

  const lines: string[] = [
    `import { ${[...helpers].sort().join(", ")} } from "snapscript";`,
    `import type { ClientWorld, CommandDefinition, EventDefinition, FieldDefinitions, FieldValues, ServerWorld, PeerId, RpcHandler } from "snapscript";`,
    "",
    `type RpcFields<T> = T extends CommandDefinition<infer TFields> ? TFields : T extends EventDefinition<infer TFields> ? TFields : never;`,
    `type RpcPayload<T> = FieldValues<RpcFields<T> & FieldDefinitions>;`,
    "",
  ];
  for (const struct of context.structs.values()) {
    lines.push(`export const ${struct.name}Fields = ${emitFields(expandComponentBody(struct.body, context.structs, [struct.name]))} as const;`);
    lines.push("");
  }
  for (const component of context.components.values()) {
    const fields = expandComponentBody(component.body, context.structs, [component.name]);
    lines.push(`export const ${component.name} = defineComponent(${JSON.stringify(component.name)}, ${emitFields(fields)}, { id: ${manifest.components[component.name]!.id}, fieldIds: ${JSON.stringify(manifest.components[component.name]!.fields)} });`);
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
      lines.push(`export const ${exportName} = ${factory}(${JSON.stringify(runtimeName)}, ${emitFields(expandRpcFields(rpc, context.structs))}, { id: ${manifestMap[runtimeName]!.id}, fieldIds: ${JSON.stringify(manifestMap[runtimeName]!.fields)}, channel: ${JSON.stringify(rpc.channel)} });`);
    }
  }
  if (commandNames.length + eventNames.length > 0) lines.push("");
  lines.push(`export const protocol = defineProtocol({`);
  lines.push(`  components: { ${[...context.components.keys()].join(", ")} },`);
  lines.push(`  prefabs: { ${[...context.entities.keys()].join(", ")} },`);
  lines.push(`  commands: { ${commandNames.join(", ")} },`);
  lines.push(`  events: { ${eventNames.join(", ")} },`);
  lines.push(`});`);
  lines.push("");
  lines.push(emitRpcBindings(commandNames, eventNames));
  return `${lines.join("\n")}\n`;
}

function expandRpcFields(rpc: RpcItem, structs: Map<string, StructDecl>): FieldItem[] {
  if (rpc.args.length === 1 && structs.has(rpc.args[0]!.type.name)) {
    return expandComponentBody([{ kind: "spread", name: rpc.args[0]!.type.name }], structs, [rpc.name]);
  }
  return [...rpc.args];
}

function emitFields(fields: readonly FieldItem[]): string {
  return `{ ${fields.map((field) => `${field.name}: ${emitType(field.type)}`).join(", ")} }`;
}

function emitType(type: TypeExpr): string {
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

const objectOptionFieldHelpers = new Set(["qf32", "vec2q", "vec3q"]);

function emitRpcBindings(commands: readonly string[], events: readonly string[]): string {
  return `export const rpc = {\n  commands: {\n${commands.map((name) => `    ${name}: {\n      send(world: ClientWorld, payload?: Partial<RpcPayload<typeof ${name}>>) { world.send(${name}, payload); },\n      on(world: ServerWorld, handler: RpcHandler<RpcFields<typeof ${name}> & FieldDefinitions>) { return world.on(${name}, handler); },\n    },`).join("\n")}\n  },\n  events: {\n${events.map((name) => `    ${name}: {\n      broadcast(world: ServerWorld, payload?: Partial<RpcPayload<typeof ${name}>>) { world.broadcast(${name}, payload); },\n      sendTo(world: ServerWorld, peerId: PeerId, payload?: Partial<RpcPayload<typeof ${name}>>) { world.sendTo(peerId, ${name}, payload); },\n      on(world: ClientWorld, handler: RpcHandler<RpcFields<typeof ${name}> & FieldDefinitions>) { return world.on(${name}, handler); },\n    },`).join("\n")}\n  },\n} as const;`;
}
