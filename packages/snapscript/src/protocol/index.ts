import { createRegistry } from "../registry/index";
import type { CommandDefinition, EventDefinition, StreamDefinition } from "../rpc/index";
import type { RpcDefinition } from "../rpc/types";
import type { ComponentSchema, PrefabDefinition } from "../schema/index";
import { isPlainObjectMap } from "../utils/object";

type ComponentMap = Record<string, ComponentSchema>;
type PrefabMap = Record<string, PrefabDefinition<any>>;
type CommandMap = Record<string, CommandDefinition>;
type EventMap = Record<string, EventDefinition>;
type StreamMap = Record<string, StreamDefinition>;

const protocolBrand: unique symbol = Symbol("SnapScriptProtocol");
const protocolRegistries = new WeakMap<ProtocolDefinition, ProtocolRegistry>();

interface ProtocolRegistry {
  getSchema(schemaId: number): ComponentSchema | undefined;
  getRpc(rpcId: number): RpcDefinition | undefined;
}

/** Frozen protocol bundle used to construct server and client worlds. */
export interface ProtocolDefinition<
  TCommands extends CommandMap = CommandMap,
  TEvents extends EventMap = EventMap,
  TStreams extends StreamMap = StreamMap,
  TComponents extends ComponentMap = ComponentMap,
  TPrefabs extends PrefabMap = PrefabMap,
> {
  readonly components: TComponents;
  readonly prefabs: TPrefabs;
  readonly commands: TCommands;
  readonly events: TEvents;
  readonly streams: TStreams;
  readonly hash?: string;
  readonly [protocolBrand]: true;
  manifest(): ProtocolManifest;
}

/** Serializable summary of ids registered in a protocol. Useful for tooling and diagnostics. */
export interface ProtocolManifest {
  readonly components: readonly ProtocolManifestEntry[];
  readonly prefabs: readonly ProtocolManifestEntry[];
  readonly commands: readonly ProtocolManifestEntry[];
  readonly events: readonly ProtocolManifestEntry[];
  readonly streams: readonly ProtocolManifestEntry[];
}

/** Name/id pair emitted by `ProtocolDefinition.manifest()`. */
export interface ProtocolManifestEntry {
  readonly name: string;
  readonly id: number;
}

/** Input maps accepted by `defineProtocol()`. Every value must come from SnapScript definition helpers. */
export interface DefineProtocolInput<
  TCommands extends CommandMap = Record<never, never>,
  TEvents extends EventMap = Record<never, never>,
  TStreams extends StreamMap = Record<never, never>,
  TComponents extends ComponentMap = Record<never, never>,
  TPrefabs extends PrefabMap = Record<never, never>,
> {
  readonly components?: TComponents;
  readonly prefabs?: TPrefabs;
  readonly commands?: TCommands;
  readonly events?: TEvents;
  readonly streams?: TStreams;
  readonly hash?: string;
}

/** Creates the protocol registry that binds schemas and RPC definitions to a world. */
export function defineProtocol<
  TCommands extends CommandMap = Record<never, never>,
  TEvents extends EventMap = Record<never, never>,
  TStreams extends StreamMap = Record<never, never>,
  TComponents extends ComponentMap = Record<never, never>,
  TPrefabs extends PrefabMap = Record<never, never>,
>(
  input: DefineProtocolInput<TCommands, TEvents, TStreams, TComponents, TPrefabs>,
): ProtocolDefinition<TCommands, TEvents, TStreams, TComponents, TPrefabs> {
  const source = assertProtocolInput(input);
  const components = cloneProtocolMap<TComponents>(source.components, "components");
  const prefabs = cloneProtocolMap<TPrefabs>(source.prefabs, "prefabs");
  const commands = cloneProtocolMap<TCommands>(source.commands, "commands");
  const events = cloneProtocolMap<TEvents>(source.events, "events");
  const streams = cloneProtocolMap<TStreams>(source.streams, "streams");
  const hash = assertProtocolHash(source.hash);
  const registry = createRegistry();
  const registeredComponents = new Map<number, ComponentSchema>();

  for (const [key, component] of Object.entries(components)) {
    assertComponentSchema(component, `components.${key}`);
    registry.registerComponent(component);
    registeredComponents.set(component.schemaId, component);
  }

  for (const [key, prefab] of Object.entries(prefabs)) {
    assertPrefabDefinition(prefab, `prefabs.${key}`);
    for (const component of prefab.componentList) {
      registry.registerComponent(component);
      registeredComponents.set(component.schemaId, component);
    }
  }

  for (const [key, command] of Object.entries(commands)) {
    assertRpcDefinition(command, `commands.${key}`);
    if (command.kind !== "command") {
      throw new Error(`RPC "${command.name}" is not a command`);
    }
    registry.registerRpc(command);
  }

  for (const [key, event] of Object.entries(events)) {
    assertRpcDefinition(event, `events.${key}`);
    if (event.kind !== "event") {
      throw new Error(`RPC "${event.name}" is not an event`);
    }
    registry.registerRpc(event);
  }

  for (const [key, stream] of Object.entries(streams)) {
    assertRpcDefinition(stream, `streams.${key}`);
    if (stream.kind !== "stream") {
      throw new Error(`RPC "${stream.name}" is not a stream`);
    }
    registry.registerRpc(stream);
  }

  const protocol = Object.freeze({
    components,
    prefabs,
    commands,
    events,
    streams,
    ...(hash === undefined ? {} : { hash }),
    [protocolBrand]: true as const,
    manifest() {
      return Object.freeze({
        components: manifestEntries([...registeredComponents.values()], (component) => ({
          name: component.name,
          id: component.schemaId,
        })),
        prefabs: manifestEntries(Object.values(prefabs), (prefab) => ({
          name: prefab.name,
          id: prefab.prefabId,
        })),
        commands: manifestEntries(Object.values(commands), (rpc) => ({
          name: rpc.name,
          id: rpc.rpcId,
        })),
        events: manifestEntries(Object.values(events), (rpc) => ({
          name: rpc.name,
          id: rpc.rpcId,
        })),
        streams: manifestEntries(Object.values(streams), (rpc) => ({
          name: rpc.name,
          id: rpc.rpcId,
        })),
      });
    },
  });
  protocolRegistries.set(protocol, registry);
  return protocol;
}

function assertProtocolHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("defineProtocol() hash must be a non-empty string");
  }
  return value;
}

function assertProtocolInput(value: unknown): Record<string, unknown> {
  if (!isPlainObjectMap(value)) {
    throw new Error("defineProtocol() requires an options object");
  }
  return value;
}

function cloneProtocolMap<TMap extends Record<string, unknown>>(
  value: unknown,
  label: string,
): TMap {
  if (value === undefined) {
    return Object.freeze({}) as TMap;
  }
  if (!isPlainObjectMap(value)) {
    throw new Error(`defineProtocol() ${label} must be an object`);
  }
  return Object.freeze({ ...value }) as TMap;
}

function assertComponentSchema(value: unknown, label: string): asserts value is ComponentSchema {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly kind?: unknown }).kind !== "component" ||
    typeof (value as { readonly name?: unknown }).name !== "string" ||
    !Number.isSafeInteger((value as { readonly schemaId?: unknown }).schemaId) ||
    (value as { readonly fields?: unknown }).fields === null ||
    typeof (value as { readonly fields?: unknown }).fields !== "object" ||
    !Array.isArray((value as { readonly fieldList?: unknown }).fieldList)
  ) {
    throw new Error(`defineProtocol() ${label} must be a component from defineComponent()`);
  }
}

function assertPrefabDefinition(value: unknown, label: string): asserts value is PrefabDefinition<any> {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly kind?: unknown }).kind !== "prefab" ||
    typeof (value as { readonly name?: unknown }).name !== "string" ||
    !Number.isSafeInteger((value as { readonly prefabId?: unknown }).prefabId) ||
    (value as { readonly components?: unknown }).components === null ||
    typeof (value as { readonly components?: unknown }).components !== "object" ||
    !Array.isArray((value as { readonly componentList?: unknown }).componentList)
  ) {
    throw new Error(`defineProtocol() ${label} must be a prefab from defineEntity()`);
  }
}

function assertRpcDefinition(value: unknown, label: string): asserts value is RpcDefinition {
  if (
    value === null ||
    typeof value !== "object" ||
    ((value as { readonly kind?: unknown }).kind !== "command" &&
      (value as { readonly kind?: unknown }).kind !== "event" &&
      (value as { readonly kind?: unknown }).kind !== "stream") ||
    typeof (value as { readonly name?: unknown }).name !== "string" ||
    !Number.isSafeInteger((value as { readonly rpcId?: unknown }).rpcId) ||
    ((value as { readonly channel?: unknown }).channel !== "reliable" &&
      (value as { readonly channel?: unknown }).channel !== "unreliable") ||
    (value as { readonly fields?: unknown }).fields === null ||
    typeof (value as { readonly fields?: unknown }).fields !== "object" ||
    !Array.isArray((value as { readonly fieldList?: unknown }).fieldList)
  ) {
    throw new Error(`defineProtocol() ${label} must be an RPC from defineCommand(), defineEvent(), or defineStream()`);
  }
}

export function isProtocolDefinition(value: unknown): value is ProtocolDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly [protocolBrand]?: unknown })[protocolBrand] === true &&
    protocolRegistries.has(value as ProtocolDefinition)
  );
}

export function registryForProtocol(protocol: ProtocolDefinition): ProtocolRegistry {
  const registry = protocolRegistries.get(protocol);
  if (registry === undefined) {
    throw new Error("Protocol registry is missing; use defineProtocol()");
  }
  return registry;
}

function manifestEntries<T>(
  values: readonly T[],
  createEntry: (value: T) => ProtocolManifestEntry,
): readonly ProtocolManifestEntry[] {
  const entries = values
    .map((value) => Object.freeze(createEntry(value)))
    .sort(compareManifestEntry);
  return Object.freeze(entries);
}

function compareManifestEntry(a: ProtocolManifestEntry, b: ProtocolManifestEntry): number {
  return a.name.localeCompare(b.name);
}
