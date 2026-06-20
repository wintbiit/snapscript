import { ServerPeerId, defaultLogger, type PeerId } from "../platform/index";
import type {
  ChannelName,
  ClientTransport,
  Clock,
  ServerTransport,
  Logger,
  PeerRef,
} from "../platform/index";
import { PeerState, PeerStatus, type PeerStatusValue } from "../peer/index";
import { isProtocolDefinition, registryForProtocol, type ProtocolDefinition } from "../protocol/index";
import type {
  CommandDefinition,
  CommandHandler,
  CommandStreamHandler,
  CommandStreamValidator,
  CommandValidator,
  EventDefinition,
  EventHandler,
  EventValidator,
  RpcDefinition,
  RpcHandler,
  StreamDefinition,
} from "../rpc/index";
import {
  createSyncClient,
  createSyncServer,
  type CommandStreamLimits,
  type SyncClient,
  type SyncServer,
  type SyncServerOptions,
  type SyncRuntimeOptions,
} from "../runtime/index";
import { fieldsForSchema } from "../schema/index";
import { assertPlainObjectMap, isPlainObjectMap } from "../utils/object";
import type {
  ComponentSchema,
  EntitySchema,
  FieldDefinitions,
  FieldValue,
  FieldValues,
  InternalFieldMeta,
  InternalSchemaField,
  PrefabDefinition,
  SimpleEntityDefinition,
} from "../schema/index";
import { DirtyGraph } from "./dirty-graph";
import { registerWorldInternals, type WorldInternals } from "./internals";
import { NetRefImpl, type NetRef, type ReadonlyNetRef } from "./net-ref";
import type { ComponentRecord } from "./records";
import {
  SparseSetComponentStorage,
  type ComponentQueryRow,
} from "./storage";

/** Mutable component instance returned from server-world reads. Write replicated fields through `NetRef.value`. */
export type ComponentInstance<TFields extends FieldDefinitions> = {
  readonly entityId: number;
  readonly id: number;
  readonly schema: ComponentSchema<TFields>;
} & {
  readonly [K in keyof TFields]: NetRef<FieldValue<TFields[K]>>;
};

/** Read-only component instance returned from client worlds and interest hooks. */
export type ReadonlyComponentInstance<TFields extends FieldDefinitions> = {
  readonly entityId: number;
  readonly id: number;
  readonly schema: ComponentSchema<TFields>;
} & {
  readonly [K in keyof TFields]: ReadonlyNetRef<FieldValue<TFields[K]>>;
};

export type EntityInstance<TFields extends FieldDefinitions> = ComponentInstance<TFields>;

export type ComponentFieldsOf<TComponent extends ComponentSchema<any>> =
  TComponent extends ComponentSchema<infer TFields> ? TFields : never;

export type ComponentInstanceOf<TComponent extends ComponentSchema<any>> = ComponentInstance<
  ComponentFieldsOf<TComponent>
>;

export type ReadonlyComponentInstanceOf<TComponent extends ComponentSchema<any>> =
  ReadonlyComponentInstance<ComponentFieldsOf<TComponent>>;

type ComponentAccess = "mutable" | "readonly";
export type ComponentQuery = readonly [ComponentSchema, ...ComponentSchema[]];
export type ComponentOrPrefab = ComponentSchema | PrefabDefinition;

type QueryComponentInstance<
  TFields extends FieldDefinitions,
  TAccess extends ComponentAccess,
> = TAccess extends "readonly" ? ReadonlyComponentInstance<TFields> : ComponentInstance<TFields>;

export type PrefabInstance<TComponents extends Record<string, ComponentSchema>> = {
  readonly [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
    ? ComponentInstance<TFields>
    : never;
};

export type ReadonlyPrefabInstance<TComponents extends Record<string, ComponentSchema>> = {
  readonly [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
    ? ReadonlyComponentInstance<TFields>
    : never;
};

export type PrefabComponentsOf<TPrefab extends PrefabDefinition<any>> =
  TPrefab extends PrefabDefinition<infer TComponents> ? TComponents : never;

export type PrefabInstanceOf<TPrefab extends PrefabDefinition<any>> = PrefabInstance<
  PrefabComponentsOf<TPrefab>
>;

export type ReadonlyPrefabInstanceOf<TPrefab extends PrefabDefinition<any>> = ReadonlyPrefabInstance<
  PrefabComponentsOf<TPrefab>
>;

/** Read-only entity identity visible to client and interest-policy code. */
export interface ReadonlyEntityRef {
  readonly id: number;
}

declare const entityRefBrand: unique symbol;

/** Server-authored entity identity returned by `ServerWorld.spawn()`. */
export interface EntityRef extends ReadonlyEntityRef {
  readonly [entityRefBrand]: "server";
}

/** Reserved world-level entity used for replicated global gameplay state. */
export const WorldEntity = Object.freeze({ id: 0 }) as EntityRef;

/** Ordered system phase run by `world.tick()`. */
export type SystemPhase = "preUpdate" | "update" | "postUpdate" | "network";

const systemPhases = new Set<string>(["preUpdate", "update", "postUpdate", "network"]);

/** Frozen timing context passed to systems during one world tick. */
export interface SystemContext {
  readonly tick: number;
  readonly dtMs: number;
  readonly nowMs: number;
  readonly phase: SystemPhase;
}

/** Frozen context passed after a client applies a snapshot. */
export interface SnapshotContext {
  readonly tick: number;
  readonly channel: ChannelName;
}

/** System callback registered on a server or client world. */
export type SystemFn<TWorld extends ServerWorld | ClientWorld = ServerWorld | ClientWorld> = (
  world: TWorld,
  context: SystemContext,
) => void;

/** Client callback invoked after snapshot apply. Use it for sampling, interpolation buffers, or diagnostics. */
export type SnapshotHandler<TWorld extends ClientWorld = ClientWorld> = (
  world: TWorld,
  context: SnapshotContext,
) => void;

type FrameContext = Omit<SystemContext, "phase">;

export type QueryRow<
  TComponents extends readonly ComponentSchema[],
  TEntity extends ReadonlyEntityRef = EntityRef,
  TAccess extends ComponentAccess = "mutable",
> = [
  TEntity,
  ...{
    [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
      ? QueryComponentInstance<TFields, TAccess>
      : never;
  },
];

export type EachFn<
  TComponents extends readonly ComponentSchema[],
  TEntity extends ReadonlyEntityRef = EntityRef,
  TAccess extends ComponentAccess = "mutable",
> = (
  entity: TEntity,
  ...components: {
    [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
      ? QueryComponentInstance<TFields, TAccess>
      : never;
  }
) => void;

/** Lazy query result. Iteration streams rows; `toArray()` materializes them. */
export interface QueryResult<
  TComponents extends readonly ComponentSchema[],
  TEntity extends ReadonlyEntityRef = EntityRef,
  TAccess extends ComponentAccess = "mutable",
> extends Iterable<QueryRow<TComponents, TEntity, TAccess>> {
  readonly length: number;
  map<TResult>(
    fn: (row: QueryRow<TComponents, TEntity, TAccess>, index: number) => TResult,
  ): TResult[];
  forEach(fn: (row: QueryRow<TComponents, TEntity, TAccess>, index: number) => void): void;
  toArray(): QueryRow<TComponents, TEntity, TAccess>[];
}

interface QueryWorldAccess<
  TEntity extends ReadonlyEntityRef = EntityRef,
  TAccess extends ComponentAccess = "mutable",
> {
  _queryRows(components: readonly ComponentSchema[]): Iterable<{
    readonly entityId: number;
    readonly first?: ComponentRecord;
    readonly second?: ComponentRecord;
    readonly third?: ComponentRecord;
    readonly fourth?: ComponentRecord;
    readonly records?: readonly ComponentRecord[];
  }>;
  _forEachQueryRow(
    components: readonly ComponentSchema[],
    visitor: (row: ComponentQueryRow) => void,
  ): void;
  _queryCount(components: readonly ComponentSchema[]): number;
  _entityRef(entityId: number): TEntity;
  _component?(record: ComponentRecord): QueryComponentInstance<FieldDefinitions, TAccess>;
}

class QueryResultImpl<
  TComponents extends readonly ComponentSchema[],
  TEntity extends ReadonlyEntityRef = EntityRef,
  TAccess extends ComponentAccess = "mutable",
> implements QueryResult<TComponents, TEntity, TAccess>
{
  constructor(
    private readonly world: QueryWorldAccess<TEntity, TAccess>,
    private readonly components: TComponents,
  ) {}

  get length(): number {
    return this.world._queryCount(this.components);
  }

  #rowFromStorageRow(row: ComponentQueryRow): QueryRow<TComponents, TEntity, TAccess> {
    const components = this.components;
    const component = this.world._component;
    const entity = this.world._entityRef(row.entityId);
    if (components.length === 0) {
      return [entity] as unknown as QueryRow<TComponents, TEntity, TAccess>;
    }
    if (components.length === 1) {
      return [
        entity,
        component === undefined ? row.first!.instance : component(row.first!),
      ] as unknown as QueryRow<TComponents, TEntity, TAccess>;
    }
    if (components.length === 2) {
      return [
        entity,
        component === undefined ? row.first!.instance : component(row.first!),
        component === undefined ? row.second!.instance : component(row.second!),
      ] as unknown as QueryRow<TComponents, TEntity, TAccess>;
    }
    if (components.length === 3) {
      return [
        entity,
        component === undefined ? row.first!.instance : component(row.first!),
        component === undefined ? row.second!.instance : component(row.second!),
        component === undefined ? row.third!.instance : component(row.third!),
      ] as unknown as QueryRow<TComponents, TEntity, TAccess>;
    }
    if (components.length === 4) {
      return [
        entity,
        component === undefined ? row.first!.instance : component(row.first!),
        component === undefined ? row.second!.instance : component(row.second!),
        component === undefined ? row.third!.instance : component(row.third!),
        component === undefined ? row.fourth!.instance : component(row.fourth!),
      ] as unknown as QueryRow<TComponents, TEntity, TAccess>;
    }

    const result: unknown[] = [entity];
    const records = row.records ?? [];
    for (const record of records) {
      result.push(component === undefined ? record.instance : component(record));
    }
    return result as QueryRow<TComponents, TEntity, TAccess>;
  }

  [Symbol.iterator](): Iterator<QueryRow<TComponents, TEntity, TAccess>> {
    const components = this.components;
    const iterator = this.world._queryRows(components)[Symbol.iterator]();
    const toPublicRow = (row: ComponentQueryRow) => this.#rowFromStorageRow(row);

    return {
      next(): IteratorResult<QueryRow<TComponents, TEntity, TAccess>> {
        const next = iterator.next();
        if (next.done === true) {
          return { done: true, value: undefined };
        }

        return { done: false, value: toPublicRow(next.value) };
      },
    };
  }

  map<TResult>(
    fn: (row: QueryRow<TComponents, TEntity, TAccess>, index: number) => TResult,
  ): TResult[] {
    if (!isFunction(fn)) {
      throw new Error("QueryResult.map() requires a function");
    }
    const result: TResult[] = [];
    let index = 0;
    this.world._forEachQueryRow(this.components, (row) => {
      result.push(fn(this.#rowFromStorageRow(row), index));
      index += 1;
    });
    return result;
  }

  forEach(fn: (row: QueryRow<TComponents, TEntity, TAccess>, index: number) => void): void {
    if (!isFunction(fn)) {
      throw new Error("QueryResult.forEach() requires a function");
    }
    let index = 0;
    this.world._forEachQueryRow(this.components, (row) => {
      fn(this.#rowFromStorageRow(row), index);
      index += 1;
    });
  }

  toArray(): QueryRow<TComponents, TEntity, TAccess>[] {
    return [...this];
  }
}

/**
 * Options for constructing an authoritative server world.
 *
 * A server world owns simulation truth, mutable replicated state, command handlers, and outbound
 * snapshots. There is no local-only world mode; choose server or client when the world is created.
 */
export interface ServerWorldOptions {
  /** Protocol returned by `defineProtocol()`. Hand-written protocol-like objects are rejected. */
  readonly protocol: ProtocolDefinition;
  /** Server transport adapter. Reliability and ordering are provided by the server/engine layer. */
  readonly transport: ServerTransport;
  /** Monotonic frame clock used for system context and runtime tick ordering. */
  readonly clock: Clock;
  /** Optional structured logger used for isolated handler/runtime errors. */
  readonly logger?: Logger;
  /**
   * Dirty snapshot wire format.
   *
   * `"default"` is the CPU-stable baseline. `"batched"` is opt-in and negotiated per client; it
   * can reduce bytes for homogeneous dirty updates without changing the public ECS API.
   */
  readonly snapshotEncoding?: "default" | "batched";
  /** Default server visibility policy before manual overrides or `interest` are applied. */
  readonly visibility?: "all" | "none";
  /**
   * Optional server-owned interest hook.
   *
   * The hook receives a SnapScript peer id and read-only world inputs, and must return a boolean. Use `visibility: "all"`
   * when every entity should be visible to every peer.
   */
  readonly interest?: (peerId: PeerId, entity: ReadonlyEntityRef, world: InterestWorld) => boolean;
  /** Optional command-stream resource limits. */
  readonly streamLimits?: Partial<CommandStreamLimits>;
}

/**
 * Options for constructing a replicated client world.
 *
 * Client worlds are read-only views of replicated state. They run client systems, send commands,
 * receive events, and apply snapshots produced by a server world.
 */
export interface ClientWorldOptions {
  /** Protocol returned by `defineProtocol()`; it must match the server protocol. */
  readonly protocol: ProtocolDefinition;
  /** Client transport adapter. Snapshot and RPC bytes are delivered as raw `Uint8Array` packets. */
  readonly transport: ClientTransport;
  /** Monotonic frame clock used for system context and runtime tick ordering. */
  readonly clock: Clock;
  /** Optional structured logger used for isolated handler/runtime errors. */
  readonly logger?: Logger;
  /** Optional command-stream resource limits. */
  readonly streamLimits?: Partial<CommandStreamLimits>;
}

/**
 * Shared read-only replicated state view.
 *
 * Use this type for renderers, inspectors, interpolation samplers, and helper functions that should
 * work with either a server world or a client world without gaining mutation authority.
 */
export interface ReplicatedStateReader {
  /** Reads a world-level component from the reserved `WorldEntity`. */
  getComponent<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined;
  /** Reads a single component or a simple prefab primary component as read-only replicated state. */
  get<TFields extends FieldDefinitions>(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema<TFields> | SimpleEntityDefinition<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined;
  /** Reads every component in a composite prefab as read-only replicated state. */
  getPrefab<TComponents extends Record<string, ComponentSchema>>(
    entity: number | ReadonlyEntityRef,
    prefab: PrefabDefinition<TComponents>,
  ): ReadonlyPrefabInstance<TComponents> | undefined;
  /** Returns whether the entity currently has a component or every component in a prefab. */
  has(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentOrPrefab,
  ): boolean;
  /** Returns the synchronized owner peer id for an entity. Server-owned entities return `0`. */
  ownerOf(entity: number | ReadonlyEntityRef): PeerId;
  /** Creates a lazy read-only query with `.length`, `.map()`, `.forEach()`, and `.toArray()`. */
  query<TComponents extends ComponentQuery>(
    ...components: TComponents
  ): QueryResult<TComponents, ReadonlyEntityRef, "readonly">;
  /** Iterates matching rows without materializing public query tuples; prefer this in hot paths. */
  each<const TComponents extends ComponentQuery>(
    components: TComponents,
    fn: EachFn<TComponents, ReadonlyEntityRef, "readonly">,
  ): void;
}

/** Read-only world view passed to server interest hooks. */
export interface InterestWorld extends ReplicatedStateReader {}

function createWorldInternals(core: WorldCore): WorldInternals {
  return {
    getRecord: (entityId, componentId) => core._getRecord(entityId, componentId),
    getRecords: () => core._getRecords(),
    getEntityIds: () => core._getEntityIds(),
    getNetworkOwners: () => core._getNetworkOwners(),
    getOwner: (entityId) => core.ownerOf(entityId),
    getDirtySnapshot: () => core._getDirtySnapshot(),
    clearWrittenDirty: (ops) => core._clearWrittenDirty(ops),
    getDirtyMask: (entityId, componentId) => core._getDirtyMask(entityId, componentId),
    entityRef: (entityId) => core._entityRef(entityId),
    spawnRemote: (component, entityId) => core._spawnRemote(component, entityId),
    applyCreateEntityFromRemote: (entityId) => core._applyCreateEntityFromRemote(entityId),
    applyNetworkFromRemote: (entityId, owner) => core._applyNetworkFromRemote(entityId, owner),
    applyRemoveFromRemote: (entityId, componentId) =>
      core._applyRemoveFromRemote(entityId, componentId),
    applyDestroyFromRemote: (entityId, schemaId) =>
      core._applyDestroyFromRemote(entityId, schemaId),
  };
}

class WorldCore implements QueryWorldAccess {
  readonly dirty = new DirtyGraph();
  readonly #storage = new SparseSetComponentStorage();
  readonly #systems = new Map<SystemPhase, { name: string; fn: SystemFn }[]>();
  readonly #entityRefs = new Map<number, EntityRef>();
  readonly #readonlyEntityRefs = new Map<number, ReadonlyEntityRef>();
  readonly #owners = new Map<number, PeerId>();
  readonly #ownedEntities = new Map<PeerId, Set<number>>();
  readonly #peerEntities = new Map<PeerId, number>();
  readonly #peerIdsByEntity = new Map<number, PeerId>();
  readonly #peerStatuses = new Map<PeerId, PeerStatusValue>();
  readonly #readonlyComponents = new WeakMap<
    ComponentInstance<FieldDefinitions>,
    ReadonlyComponentInstance<FieldDefinitions>
  >();
  readonly #componentIdCache = new WeakMap<readonly ComponentSchema[], readonly number[]>();
  readonly #protocol: ProtocolDefinition;
  readonly #protocolPrefabs = new WeakSet<PrefabDefinition>();
  readonly #knownProtocolComponents = new WeakSet<ComponentSchema>();
  readonly #knownProtocolPrefabs = new WeakSet<PrefabDefinition>();
  #nextEntityId = 1;

  constructor(protocol: ProtocolDefinition) {
    this.#protocol = protocol;
    for (const prefab of Object.values(protocol.prefabs)) {
      this.#protocolPrefabs.add(prefab);
    }
    this.#storage.addEntity(WorldEntity.id);
    this.#entityRefs.set(WorldEntity.id, WorldEntity);
    this.#readonlyEntityRefs.set(WorldEntity.id, WorldEntity);
  }

  entity(): EntityRef {
    const entityId = this.#allocateEntityId();
    this.#storage.addEntity(entityId);
    this.dirty.markCreated(entityId);
    return this.#entityRef(entityId);
  }

  spawn(): EntityRef;
  spawn<TFields extends FieldDefinitions>(
    schema: EntitySchema<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): EntityInstance<TFields>;
  spawn<TFields extends FieldDefinitions>(
    prefab: SimpleEntityDefinition<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): EntityRef;
  spawn<TComponents extends Record<string, ComponentSchema>>(
    prefab: PrefabDefinition<TComponents>,
    initial?: Partial<{
      [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
        ? Partial<FieldValues<TFields>>
        : never;
    }>,
  ): EntityRef;
  spawn(
    schemaOrPrefab?: EntitySchema | PrefabDefinition,
    initial?: Record<string, unknown>,
  ): EntityInstance<FieldDefinitions> | EntityRef {
    if (schemaOrPrefab === undefined) {
      return this.entity();
    }

    if (hasComponentList(schemaOrPrefab)) {
      this.#assertPrefabInProtocol(schemaOrPrefab, "spawn");
      this.#assertPrefabInitial(schemaOrPrefab, initial);
      const entity = this.entity();
      for (const [alias, component] of Object.entries(schemaOrPrefab.components)) {
        const componentInitial =
          initial?.[alias] ??
          initial?.[component.name] ??
          (schemaOrPrefab.component === component ? initial : undefined);
        this.add(entity, component, componentInitial as Partial<FieldValues<FieldDefinitions>>);
      }
      return entity;
    }

    this.#assertComponentInProtocol(schemaOrPrefab, "spawn");
    this.#assertComponentInitial(schemaOrPrefab, initial, "spawn");
    const entity = this.entity();
    return this.add(entity, schemaOrPrefab, initial as Partial<FieldValues<FieldDefinitions>>);
  }

  spawnAny(
    schemaOrPrefab: EntitySchema | PrefabDefinition,
    initial?: Record<string, unknown>,
  ): EntityInstance<FieldDefinitions> | EntityRef {
    return this.spawn(
      schemaOrPrefab as EntitySchema<FieldDefinitions>,
      initial as Partial<FieldValues<FieldDefinitions>>,
    );
  }

  add<TFields extends FieldDefinitions>(
    entity: number | EntityRef,
    component: ComponentSchema<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentInstance<TFields>;
  add<TFields extends FieldDefinitions>(
    entity: number | EntityRef,
    prefab: SimpleEntityDefinition<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentInstance<TFields>;
  add<TComponents extends Record<string, ComponentSchema>>(
    entity: number | EntityRef,
    prefab: PrefabDefinition<TComponents>,
    initial?: Partial<{
      [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
        ? Partial<FieldValues<TFields>>
        : never;
    }>,
  ): PrefabInstance<TComponents>;
  add(
    entity: number | EntityRef,
    componentOrPrefab: ComponentSchema | PrefabDefinition,
    initial?: Record<string, unknown>,
  ): ComponentInstance<FieldDefinitions> | PrefabInstance<Record<string, ComponentSchema>> {
    if (hasComponentList(componentOrPrefab)) {
      this.#assertPrefabInProtocol(componentOrPrefab, "add");
      this.#assertPrefabInitial(componentOrPrefab, initial);
      const entityId = entityIdFrom(entity, "world.add()");
      this.#assertEntityExists(entityId, "world.add()");
      for (const [alias, component] of Object.entries(componentOrPrefab.components)) {
        const componentInitial =
          initial?.[alias] ??
          initial?.[component.name] ??
          (componentOrPrefab.component === component ? initial : undefined);
        this.#addComponent(entityId, component, componentInitial as Partial<FieldValues<FieldDefinitions>>);
      }
      if (componentOrPrefab.component !== undefined && componentOrPrefab.componentList.length === 1) {
        return this.get(entityId, componentOrPrefab.component)!;
      }
      return this.getPrefab(entityId, componentOrPrefab)!;
    }

    return this.#addComponent(entity, componentOrPrefab, initial as Partial<FieldValues<FieldDefinitions>>);
  }

  #addComponent<TFields extends FieldDefinitions>(
    entity: number | EntityRef,
    component: ComponentSchema<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentInstance<TFields> {
    this.#assertComponentInProtocol(component, "add");
    const entityId = entityIdFrom(entity, "world.add()");
    this.#assertEntityExists(entityId, "world.add()");

    const existing = this.get(entityId, component);
    if (existing !== undefined) {
      return existing;
    }

    const record = this.#createRecord(component, entityId, initial);
    this.#storage.set(entityId, component.schemaId, record as ComponentRecord);
    this.dirty.markAdded(entityId, component.schemaId);
    return record.instance;
  }

  get<TFields extends FieldDefinitions>(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema<TFields> | SimpleEntityDefinition<TFields>,
  ): ComponentInstance<TFields> | undefined;
  get(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema | SimpleEntityDefinition<FieldDefinitions>,
  ): ComponentInstance<FieldDefinitions> | undefined {
    const entityId = entityIdFrom(entity, "world.get()");
    if (hasComponentList(componentOrPrefab)) {
      this.#assertPrefabInProtocol(componentOrPrefab, "get");
      const component = componentOrPrefab.component;
      if (component === undefined) {
        throw new Error(
          `Prefab "${componentOrPrefab.name}" does not have a single primary component`,
        );
      }
      this.#assertComponentInProtocol(component, "get");
      const record = this.#storage.get(entityId, component.schemaId);
      return record?.instance;
    }
    this.#assertComponentInProtocol(componentOrPrefab, "get");
    const record = this.#storage.get(entityId, componentOrPrefab.schemaId);
    return record?.instance;
  }

  getAny(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema | SimpleEntityDefinition<FieldDefinitions>,
  ): ComponentInstance<FieldDefinitions> | undefined {
    return this.get(entity, componentOrPrefab as ComponentSchema<FieldDefinitions>);
  }

  getComponent<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
  ): ComponentInstance<TFields> | undefined {
    return this.get(WorldEntity, component);
  }

  getReadonly<TFields extends FieldDefinitions>(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema<TFields> | SimpleEntityDefinition<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined;
  getReadonly(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema | SimpleEntityDefinition<FieldDefinitions>,
  ): ReadonlyComponentInstance<FieldDefinitions> | undefined {
    const entityId = entityIdFrom(entity, "world.get()");
    if (hasComponentList(componentOrPrefab)) {
      this.#assertPrefabInProtocol(componentOrPrefab, "get");
      const component = componentOrPrefab.component;
      if (component === undefined) {
        throw new Error(
          `Prefab "${componentOrPrefab.name}" does not have a single primary component`,
        );
      }
      this.#assertComponentInProtocol(component, "get");
      const record = this.#storage.get(entityId, component.schemaId);
      return record === undefined ? undefined : this.#readonlyComponent(record.instance);
    }
    this.#assertComponentInProtocol(componentOrPrefab, "get");
    const record = this.#storage.get(entityId, componentOrPrefab.schemaId);
    return record === undefined ? undefined : this.#readonlyComponent(record.instance);
  }

  getComponentReadonly<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined {
    return this.getReadonly(WorldEntity, component);
  }

  getPrefab<TComponents extends Record<string, ComponentSchema>>(
    entity: number | ReadonlyEntityRef,
    prefab: PrefabDefinition<TComponents>,
  ): PrefabInstance<TComponents> | undefined {
    this.#assertPrefabInProtocol(prefab, "getPrefab");
    const entityId = entityIdFrom(entity, "world.getPrefab()");
    const result: Record<string, ComponentInstance<FieldDefinitions>> = {};
    for (const [alias, component] of Object.entries(prefab.components)) {
      const record = this.#storage.get(entityId, component.schemaId);
      if (record === undefined) {
        return undefined;
      }
      result[alias] = record.instance;
    }
    return Object.freeze(result) as PrefabInstance<TComponents>;
  }

  getPrefabReadonly<TComponents extends Record<string, ComponentSchema>>(
    entity: number | ReadonlyEntityRef,
    prefab: PrefabDefinition<TComponents>,
  ): ReadonlyPrefabInstance<TComponents> | undefined {
    this.#assertPrefabInProtocol(prefab, "getPrefab");
    const entityId = entityIdFrom(entity, "world.getPrefab()");
    const result: Record<string, ReadonlyComponentInstance<FieldDefinitions>> = {};
    for (const [alias, component] of Object.entries(prefab.components)) {
      const record = this.#storage.get(entityId, component.schemaId);
      if (record === undefined) {
        return undefined;
      }
      result[alias] = this.#readonlyComponent(record.instance);
    }
    return Object.freeze(result) as ReadonlyPrefabInstance<TComponents>;
  }

  has(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentOrPrefab,
  ): boolean {
    const entityId = entityIdFrom(entity, "world.has()");
    if (hasComponentList(componentOrPrefab)) {
      this.#assertPrefabInProtocol(componentOrPrefab, "has");
      return componentOrPrefab.componentList.every((component) =>
        this.#storage.get(entityId, component.schemaId) !== undefined,
      );
    }
    this.#assertComponentInProtocol(componentOrPrefab, "has");
    return this.#storage.get(entityId, componentOrPrefab.schemaId) !== undefined;
  }

  remove(entity: number | EntityRef, componentOrPrefab: ComponentOrPrefab): boolean {
    const entityId = entityIdFrom(entity, "world.remove()");
    if (hasComponentList(componentOrPrefab)) {
      this.#assertPrefabInProtocol(componentOrPrefab, "remove");
      let removed = false;
      for (const component of componentOrPrefab.componentList) {
        if (this.#storage.remove(entityId, component.schemaId)) {
          this.dirty.markRemoved(entityId, component.schemaId);
          removed = true;
        }
      }
      return removed;
    }

    this.#assertComponentInProtocol(componentOrPrefab, "remove");
    if (!this.#storage.remove(entityId, componentOrPrefab.schemaId)) {
      return false;
    }

    this.dirty.markRemoved(entityId, componentOrPrefab.schemaId);
    return true;
  }

  destroy(entity: number | EntityRef): boolean {
    const entityId = entityIdFrom(entity, "world.destroy()");
    if (entityId === WorldEntity.id) {
      throw new Error("world.destroy() cannot destroy WorldEntity");
    }
    if (!this.#storage.deleteEntity(entityId)) {
      return false;
    }

    this.#entityRefs.delete(entityId);
    this.#readonlyEntityRefs.delete(entityId);
    this.#clearOwnerInternal(entityId);
    this.dirty.markDestroyed(entityId);
    return true;
  }

  ownerOf(entity: number | ReadonlyEntityRef): PeerId {
    const entityId = entityIdFrom(entity, "world.ownerOf()");
    return this.#owners.get(entityId) ?? ServerPeerId;
  }

  setOwner(entity: number | EntityRef, peer: PeerId | ReadonlyEntityRef): void {
    const entityId = entityIdFrom(entity, "world.setOwner()");
    const peerId = this.#peerIdFromPeer(peer, "world.setOwner()");
    this.#assertEntityExists(entityId, "world.setOwner()");
    if (entityId === WorldEntity.id) {
      throw new Error("world.setOwner() cannot change WorldEntity ownership");
    }
    this.#setOwnerInternal(entityId, peerId);
    this.dirty.markNetworkChanged(entityId);
  }

  clearOwner(entity: number | EntityRef): void {
    const entityId = entityIdFrom(entity, "world.clearOwner()");
    if (entityId === WorldEntity.id) {
      return;
    }
    this.setOwner(entity, ServerPeerId);
  }

  isOwner(peer: PeerId | ReadonlyEntityRef, entity: number | ReadonlyEntityRef): boolean {
    const peerId = this.#peerIdFromPeer(peer, "world.isOwner()");
    return this.ownerOf(entity) === peerId;
  }

  ownedBy(peer: PeerId | ReadonlyEntityRef): readonly ReadonlyEntityRef[] {
    const peerId = this.#peerIdFromPeer(peer, "world.ownedBy()");
    const ids =
      peerId === ServerPeerId
        ? this.#storage.entityIds().filter((entityId) => this.ownerOf(entityId) === ServerPeerId)
        : [...(this.#ownedEntities.get(peerId) ?? [])].sort((a, b) => a - b);
    return ids.map((entityId) => this.#readonlyEntityRef(entityId));
  }

  peerId(peer: ReadonlyEntityRef): PeerId {
    const entityId = entityIdFrom(peer, "world.peerId()");
    const peerId = this.#peerIdsByEntity.get(entityId);
    if (peerId === undefined) {
      throw new Error("world.peerId() requires a PeerEntity ref");
    }
    return peerId;
  }

  peerStatus(peer: ReadonlyEntityRef): PeerStatusValue {
    return this.#peerStatuses.get(this.peerId(peer)) ?? PeerStatus.Disconnected;
  }

  peerEntity(peerId: PeerId): ReadonlyEntityRef | undefined {
    assertPeerId(peerId, "world.peerEntity()");
    const entityId = this.#peerEntities.get(peerId);
    return entityId === undefined ? undefined : this.#readonlyEntityRef(entityId);
  }

  ensurePeerEntity(peerId: PeerId): EntityRef {
    assertPeerId(peerId, "world peer");
    const existing = this.#peerEntities.get(peerId);
    if (existing !== undefined) {
      this.#setPeerStatus(peerId, PeerStatus.Connected);
      return this.#entityRef(existing);
    }

    const peerPrefab = this.#protocol.prefabs.Peer;
    const entity =
      peerPrefab === undefined
        ? this.entity()
        : this.spawn(peerPrefab, {
            peerState: {
              peerId,
              status: PeerStatus.Connected,
            },
          } as never);
    const entityId = entityIdFrom(entity, "world peer");
    this.#peerEntities.set(peerId, entityId);
    this.#peerIdsByEntity.set(entityId, peerId);
    this.#peerStatuses.set(peerId, PeerStatus.Connected);
    this.#setOwnerInternal(entityId, peerId);
    this.dirty.markNetworkChanged(entityId);
    return this.#entityRef(entityId);
  }

  registerPeerEntity(peerId: PeerId, peerEntityId: number): void {
    assertPeerId(peerId, "world peer");
    assertEntityId(peerEntityId, "world peer");
    this.#peerEntities.set(peerId, peerEntityId);
    this.#peerIdsByEntity.set(peerEntityId, peerId);
    this.#peerStatuses.set(peerId, PeerStatus.Connected);
  }

  markPeerDisconnected(peerId: PeerId): void {
    assertPeerId(peerId, "world peer");
    this.#setPeerStatus(peerId, PeerStatus.Disconnected);
  }

  query<TComponents extends ComponentQuery>(
    ...components: TComponents
  ): QueryResult<TComponents> {
    this.#assertComponentsInProtocol(components, "query");
    // QueryResult stays lazy; row materialization happens only when the caller iterates or maps it.
    return new QueryResultImpl(this, components);
  }

  queryReadonly<TComponents extends ComponentQuery>(
    ...components: TComponents
  ): QueryResult<TComponents, ReadonlyEntityRef, "readonly"> {
    this.#assertComponentsInProtocol(components, "query");
    return new QueryResultImpl(this.#readonlyQueryAccess(), components);
  }

  each<const TComponents extends ComponentQuery>(
    components: TComponents,
    fn: EachFn<TComponents>,
  ): void {
    this.#assertComponentsInProtocol(components, "each");
    assertEachCallback(fn);
    const call = fn as (
      entity: EntityRef,
      ...components: ComponentInstance<FieldDefinitions>[]
    ) => void;
    const componentIds = this.#componentIds(components);
    const arity = componentIds.length;
    if (arity === 1) {
      this.#storage.forEachRow(componentIds, (entityId, first) => {
        call(this.#entityRef(entityId), first!.instance);
      });
      return;
    }
    if (arity === 2) {
      this.#storage.forEachRow(componentIds, (entityId, first, second) => {
        call(this.#entityRef(entityId), first!.instance, second!.instance);
      });
      return;
    }
    if (arity === 3) {
      this.#storage.forEachRow(componentIds, (entityId, first, second, third) => {
        call(this.#entityRef(entityId), first!.instance, second!.instance, third!.instance);
      });
      return;
    }
    if (arity === 4) {
      this.#storage.forEachRow(componentIds, (entityId, first, second, third, fourth) => {
        call(
          this.#entityRef(entityId),
          first!.instance,
          second!.instance,
          third!.instance,
          fourth!.instance,
        );
      });
      return;
    }

    this.#storage.forEachRow(
      componentIds,
      (entityId, first, second, third, fourth, records) => {
        call(this.#entityRef(entityId), ...records!.map((record) => record.instance));
      },
    );
  }

  eachReadonly<const TComponents extends ComponentQuery>(
    components: TComponents,
    fn: EachFn<TComponents, ReadonlyEntityRef, "readonly">,
  ): void {
    this.#assertComponentsInProtocol(components, "each");
    assertEachCallback(fn);
    const call = fn as (
      entity: ReadonlyEntityRef,
      ...components: ReadonlyComponentInstance<FieldDefinitions>[]
    ) => void;
    const componentIds = this.#componentIds(components);
    const arity = componentIds.length;
    if (arity === 1) {
      this.#storage.forEachRow(componentIds, (entityId, first) => {
        call(this.#readonlyEntityRef(entityId), this.#readonlyComponent(first!.instance));
      });
      return;
    }
    if (arity === 2) {
      this.#storage.forEachRow(componentIds, (entityId, first, second) => {
        call(
          this.#readonlyEntityRef(entityId),
          this.#readonlyComponent(first!.instance),
          this.#readonlyComponent(second!.instance),
        );
      });
      return;
    }
    if (arity === 3) {
      this.#storage.forEachRow(componentIds, (entityId, first, second, third) => {
        call(
          this.#readonlyEntityRef(entityId),
          this.#readonlyComponent(first!.instance),
          this.#readonlyComponent(second!.instance),
          this.#readonlyComponent(third!.instance),
        );
      });
      return;
    }
    if (arity === 4) {
      this.#storage.forEachRow(componentIds, (entityId, first, second, third, fourth) => {
        call(
          this.#readonlyEntityRef(entityId),
          this.#readonlyComponent(first!.instance),
          this.#readonlyComponent(second!.instance),
          this.#readonlyComponent(third!.instance),
          this.#readonlyComponent(fourth!.instance),
        );
      });
      return;
    }

    this.#storage.forEachRow(
      componentIds,
      (entityId, first, second, third, fourth, records) => {
        call(
          this.#readonlyEntityRef(entityId),
          ...records!.map((record) => this.#readonlyComponent(record.instance)),
        );
      },
    );
  }

  system<TWorld extends ServerWorld | ClientWorld>(
    name: string,
    phase: SystemPhase,
    fn: SystemFn<TWorld>,
  ): () => void {
    assertSystemRegistration(name, phase, fn);
    const systems = this.#systems.get(phase) ?? [];
    if (systems.some((system) => system.name === name)) {
      throw new Error(`world.system() already has a system named "${name}" in phase "${phase}"`);
    }
    const entry = { name, fn: fn as SystemFn };
    systems.push(entry);
    this.#systems.set(phase, systems);
    return () => {
      const current = this.#systems.get(phase) ?? [];
      this.#systems.set(
        phase,
        current.filter((item) => item !== entry),
      );
    };
  }

  runSystems(owner: ServerWorld | ClientWorld, phase: SystemPhase, context?: SystemContext): void {
    const sourceContext = context ?? { phase, tick: 0, dtMs: 0, nowMs: 0 };
    const systemContext = Object.isFrozen(sourceContext) ? sourceContext : Object.freeze(sourceContext);
    // Systems use a registration snapshot so systems added mid-phase start on the next tick.
    for (const system of [...(this.#systems.get(phase) ?? [])]) {
      try {
        system.fn(owner, systemContext);
      } catch (cause) {
        throw new Error(`world.system() "${system.name}" failed in phase "${phase}"`, { cause });
      }
    }
  }

  tick(owner: ServerWorld | ClientWorld): void {
    this.runSystems(owner, "preUpdate");
    this.runSystems(owner, "update");
    this.runSystems(owner, "postUpdate");
    this.runSystems(owner, "network");
  }

  clearDirty(): void {
    this.dirty.clear();
  }

  _getRecord(entityId: number, componentId?: number): ComponentRecord | undefined {
    if (componentId !== undefined) {
      return this.#storage.get(entityId, componentId);
    }
    return this.#storage.first(entityId);
  }

  _getRecords(): readonly ComponentRecord[] {
    return this.#storage.records();
  }

  _getEntityIds(): readonly number[] {
    return this.#storage.entityIds();
  }

  _getNetworkOwners(): readonly { readonly entityId: number; readonly owner: PeerId }[] {
    return [...this.#owners.entries()]
      .map(([entityId, owner]) => ({ entityId, owner }))
      .sort((a, b) => a.entityId - b.entityId);
  }

  _queryRows(components: readonly ComponentSchema[]) {
    return this.#storage.queryRows(this.#componentIds(components));
  }

  _forEachQueryRow(
    components: readonly ComponentSchema[],
    visitor: (row: ComponentQueryRow) => void,
  ): void {
    this.#storage.forEachRow(
      this.#componentIds(components),
      (entityId, first, second, third, fourth, records) => {
        if (records !== undefined) {
          visitor({ entityId, records });
          return;
        }
        if (fourth !== undefined) {
          visitor({ entityId, first: first!, second: second!, third: third!, fourth });
          return;
        }
        if (third !== undefined) {
          visitor({ entityId, first: first!, second: second!, third });
          return;
        }
        if (second !== undefined) {
          visitor({ entityId, first: first!, second });
          return;
        }
        if (first !== undefined) {
          visitor({ entityId, first });
          return;
        }
        visitor({ entityId });
      },
    );
  }

  _queryCount(components: readonly ComponentSchema[]): number {
    return this.#storage.countRows(this.#componentIds(components));
  }

  _getDirtySnapshot() {
    return this.dirty.collectOps();
  }

  _clearWrittenDirty(ops: ReturnType<DirtyGraph["collectOps"]>): void {
    this.dirty.clearWritten(ops);
  }

  _getDirtyMask(entityId: number, componentId?: number): number {
    return this.dirty.maskOf(entityId, componentId);
  }

  _entityRef(entityId: number): EntityRef {
    return this.#entityRef(entityId);
  }

  _readonlyEntityRef(entityId: number): ReadonlyEntityRef {
    return this.#readonlyEntityRef(entityId);
  }

  _spawnRemote<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
    entityId: number,
  ): ComponentInstance<TFields> {
    this.#assertComponentInProtocol(component, "apply remote snapshot");
    assertEntityId(entityId, "remote snapshot");
    this.#ensureEntity(entityId, false);
    const existing = this.get(entityId, component);
    if (existing !== undefined) {
      return existing;
    }

    const record = this.#createRecord(component, entityId);
    this.#storage.set(entityId, component.schemaId, record as ComponentRecord);
    this.#nextEntityId = Math.max(this.#nextEntityId, entityId + 1);
    return record.instance;
  }

  _applyCreateEntityFromRemote(entityId: number): void {
    assertEntityId(entityId, "remote snapshot");
    this.#ensureEntity(entityId, false);
    this.#nextEntityId = Math.max(this.#nextEntityId, entityId + 1);
  }

  _applyNetworkFromRemote(entityId: number, owner: PeerId): void {
    assertEntityId(entityId, "remote snapshot");
    assertPeerId(owner, "remote snapshot");
    this.#ensureEntity(entityId, false);
    this.#setOwnerInternal(entityId, owner);
  }

  _applyRemoveFromRemote(entityId: number, componentId: number): void {
    assertEntityId(entityId, "remote snapshot");
    this.#storage.remove(entityId, componentId);
  }

  _applyDestroyFromRemote(entityId: number, _schemaId?: number): void {
    assertEntityId(entityId, "remote snapshot");
    if (entityId === WorldEntity.id) {
      throw new Error("remote snapshot cannot destroy WorldEntity");
    }
    this.#storage.deleteEntity(entityId);
    this.#entityRefs.delete(entityId);
    this.#readonlyEntityRefs.delete(entityId);
    this.#clearOwnerInternal(entityId);
  }

  #allocateEntityId(): number {
    const entityId = this.#nextEntityId;
    this.#nextEntityId += 1;
    return entityId;
  }

  #ensureEntity(entityId: number, markDirty = true): void {
    assertEntityId(entityId, "world entity");
    if (this.#storage.hasEntity(entityId)) {
      return;
    }
    this.#storage.addEntity(entityId);
    this.#nextEntityId = Math.max(this.#nextEntityId, entityId + 1);
    if (markDirty) {
      this.dirty.markCreated(entityId);
    }
  }

  #assertEntityExists(entityId: number, label: string): void {
    if (!this.#storage.hasEntity(entityId)) {
      throw new Error(`${label} requires an existing entity; create it with spawn() first`);
    }
  }

  #setOwnerInternal(entityId: number, peerId: PeerId): void {
    this.#clearOwnerInternal(entityId);
    if (peerId === ServerPeerId) {
      return;
    }
    this.#owners.set(entityId, peerId);
    const entities = this.#ownedEntities.get(peerId) ?? new Set<number>();
    entities.add(entityId);
    this.#ownedEntities.set(peerId, entities);
  }

  #setPeerStatus(peerId: PeerId, status: PeerStatusValue): void {
    this.#peerStatuses.set(peerId, status);
    const entityId = this.#peerEntities.get(peerId);
    if (entityId === undefined) {
      return;
    }
    const peerState = this.#storage.get(entityId, PeerState.schemaId)?.instance;
    if (peerState?.status !== undefined) {
      peerState.status.value = status;
    }
  }

  #clearOwnerInternal(entityId: number): void {
    const previous = this.#owners.get(entityId);
    if (previous === undefined) {
      return;
    }
    this.#owners.delete(entityId);
    const entities = this.#ownedEntities.get(previous);
    entities?.delete(entityId);
    if (entities?.size === 0) {
      this.#ownedEntities.delete(previous);
    }
  }

  #peerIdFromPeer(peer: PeerId | ReadonlyEntityRef, label: string): PeerId {
    if (typeof peer === "number") {
      return peerIdFrom(peer, label);
    }
    const entityId = entityIdFrom(peer, label);
    return this.#peerIdsByEntity.get(entityId) ?? entityId;
  }

  #entityRef(entityId: number): EntityRef {
    const existing = this.#entityRefs.get(entityId);
    if (existing !== undefined) {
      return existing;
    }

    const ref = Object.freeze({ id: entityId }) as EntityRef;
    this.#entityRefs.set(entityId, ref);
    return ref;
  }

  #readonlyEntityRef(entityId: number): ReadonlyEntityRef {
    const existing = this.#readonlyEntityRefs.get(entityId);
    if (existing !== undefined) {
      return existing;
    }

    const ref = Object.freeze({ id: entityId }) as ReadonlyEntityRef;
    this.#readonlyEntityRefs.set(entityId, ref);
    return ref;
  }

  #readonlyQueryAccess(): QueryWorldAccess<ReadonlyEntityRef, "readonly"> {
    return {
      _queryRows: (components) => this._queryRows(components),
      _forEachQueryRow: (components, visitor) => this._forEachQueryRow(components, visitor),
      _queryCount: (components) => this._queryCount(components),
      _entityRef: (entityId) => this.#readonlyEntityRef(entityId),
      _component: (record) => this.#readonlyComponent(record.instance),
    };
  }

  #componentIds(components: readonly ComponentSchema[]): readonly number[] {
    const cached = this.#componentIdCache.get(components);
    if (cached !== undefined) {
      return cached;
    }

    const componentIds = components.map((component) => component.schemaId);
    this.#componentIdCache.set(components, componentIds);
    return componentIds;
  }

  #readonlyComponent<TFields extends FieldDefinitions>(
    instance: ComponentInstance<TFields>,
  ): ReadonlyComponentInstance<TFields> {
    const existing = this.#readonlyComponents.get(instance as ComponentInstance<FieldDefinitions>);
    if (existing !== undefined) {
      return existing as ReadonlyComponentInstance<TFields>;
    }

    const readonlyInstance: Record<string, unknown> = {
      entityId: instance.entityId,
      id: instance.id,
      schema: instance.schema,
    };
    for (const field of fieldsForSchema(instance.schema)) {
      const fieldName = field.fieldName as keyof TFields & string;
      readonlyInstance[fieldName] = readonlyNetRef(
        instance[fieldName] as NetRef<FieldValue<TFields[keyof TFields]>>,
      );
    }

    const frozen = Object.freeze(readonlyInstance) as ReadonlyComponentInstance<TFields>;
    this.#readonlyComponents.set(
      instance as ComponentInstance<FieldDefinitions>,
      frozen as ReadonlyComponentInstance<FieldDefinitions>,
    );
    return frozen;
  }

  #createRecord<TFields extends FieldDefinitions>(
    schema: ComponentSchema<TFields>,
    entityId: number,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentRecord<TFields> {
    this.#assertComponentInitial(schema, initial, "initialize");
    const instance: Record<string, unknown> = {
      entityId,
      id: entityId,
      schema,
    };

    for (const field of fieldsForSchema(schema)) {
      const fieldName = field.fieldName as keyof TFields & string;
      const initialValue =
        initial !== undefined && fieldName in initial
          ? initial[fieldName as keyof FieldValues<TFields>]
          : field.defaultValue;
      const meta = this.#createFieldMeta(schema, entityId, field);
      instance[fieldName] = new NetRefImpl(meta, initialValue, (dirtyMeta) => {
        this.dirty.markUpdated(dirtyMeta.entityId, dirtyMeta.schemaId, dirtyMeta.fieldId);
      });
    }

    return {
      entityId,
      schema,
      instance: Object.freeze(instance) as ComponentInstance<TFields>,
    };
  }

  #assertPrefabInitial(prefab: PrefabDefinition, initial: Record<string, unknown> | undefined): void {
    if (initial === undefined) {
      return;
    }
    this.#assertInitialObject(`Prefab "${prefab.name}" initial`, initial);
    const aliases = new Set(Object.keys(prefab.components));
    const componentNames = new Set(prefab.componentList.map((component) => component.name));
    const primary = prefab.component;
    const primaryFields = primary === undefined
      ? new Set<string>()
      : new Set(fieldsForSchema(primary).map((field) => field.fieldName));
    const usesComponentContainer = Object.keys(initial).some(
      (key) => aliases.has(key) || componentNames.has(key),
    );

    for (const key of Object.keys(initial)) {
      if (aliases.has(key) || componentNames.has(key)) {
        const component = (prefab.components as Record<string, ComponentSchema>)[key] ??
          prefab.componentList.find((item) => item.name === key);
        this.#assertInitialObject(
          `Prefab "${prefab.name}" initial "${key}"`,
          initial[key],
        );
        if (component !== undefined) {
          this.#assertComponentInitial(
            component,
            initial[key] as Partial<FieldValues<FieldDefinitions>>,
            "initialize",
          );
        }
        continue;
      }
      if (primaryFields.has(key)) {
        if (usesComponentContainer) {
          throw new Error(
            `Prefab "${prefab.name}" initial cannot mix component aliases with primary component field "${key}"`,
          );
        }
        continue;
      }
      throw new Error(`Prefab "${prefab.name}" initial has unknown key "${key}"`);
    }
  }

  #assertComponentInitial(
    schema: ComponentSchema,
    initial: Partial<FieldValues<FieldDefinitions>> | undefined,
    operation: string,
  ): void {
    if (initial === undefined) {
      return;
    }
    this.#assertInitialObject(`Component "${schema.name}" initial`, initial);
    const fields = new Set(fieldsForSchema(schema).map((field) => field.fieldName));
    for (const key of Object.keys(initial)) {
      if (!fields.has(key)) {
        throw new Error(`Cannot ${operation} component "${schema.name}" with unknown field "${key}"`);
      }
    }
  }

  #assertInitialObject(label: string, value: unknown): asserts value is Record<string, unknown> {
    assertPlainObjectMap(label, value);
  }

  #createFieldMeta<T>(
    schema: ComponentSchema,
    entityId: number,
    field: InternalSchemaField<T>,
  ): InternalFieldMeta<T> {
    const meta = {
      entityId,
      schemaId: schema.schemaId,
      schemaName: schema.name,
      fieldId: field.fieldId,
      fieldName: field.fieldName,
      dirtyBit: field.dirtyBit,
      codec: field.codec,
      defaultValue: field.defaultValue,
    };

    return field.metadata === undefined ? meta : { ...meta, metadata: field.metadata };
  }

  #assertPrefabInProtocol(prefab: PrefabDefinition<any>, operation: string): void {
    assertPrefabDefinition(prefab, operation);
    if (this.#knownProtocolPrefabs.has(prefab)) {
      return;
    }

    if (!this.#protocolPrefabs.has(prefab)) {
      throw new Error(
        `Cannot ${operation} prefab "${prefab.name}" because it is not registered in this world protocol`,
      );
    }

    this.#knownProtocolPrefabs.add(prefab);
    for (const component of prefab.componentList) {
      this.#assertComponentInProtocol(component, operation);
    }
  }

  #assertComponentsInProtocol(components: readonly unknown[], operation: string): void {
    if (!Array.isArray(components)) {
      throw new Error(`world.${operation}() requires a component array`);
    }
    if (components.length === 0) {
      throw new Error(`world.${operation}() requires at least one component`);
    }
    const seenComponentIds = new Set<number>();
    for (const component of components) {
      this.#assertComponentInProtocol(component, operation);
      if (seenComponentIds.has(component.schemaId)) {
        throw new Error(`world.${operation}() cannot include duplicate component "${component.name}"`);
      }
      seenComponentIds.add(component.schemaId);
    }
  }

  #assertComponentInProtocol(component: unknown, operation: string): asserts component is ComponentSchema {
    assertComponentSchema(component, operation);
    if (this.#knownProtocolComponents.has(component)) {
      return;
    }

    if (registryForProtocol(this.#protocol).getSchema(component.schemaId) === component) {
      this.#knownProtocolComponents.add(component);
      return;
    }

    throw new Error(
      `Cannot ${operation} component "${component.name}" because it is not registered in this world protocol`,
    );
  }
}

function hasComponentList(value: unknown): value is PrefabDefinition {
  return value !== null && typeof value === "object" && "componentList" in value;
}

function assertPrefabDefinition(value: unknown, operation: string): asserts value is PrefabDefinition {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly kind?: unknown }).kind !== "prefab" ||
    typeof (value as { readonly name?: unknown }).name !== "string" ||
    !Array.isArray((value as { readonly componentList?: unknown }).componentList) ||
    typeof (value as { readonly components?: unknown }).components !== "object" ||
    (value as { readonly components?: unknown }).components === null
  ) {
    throw new Error(`Cannot ${operation}: expected a prefab from defineEntity()`);
  }
}

function assertComponentSchema(
  value: unknown,
  operation: string,
): asserts value is ComponentSchema {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly kind?: unknown }).kind !== "component" ||
    typeof (value as { readonly name?: unknown }).name !== "string" ||
    !Number.isSafeInteger((value as { readonly schemaId?: unknown }).schemaId) ||
    typeof (value as { readonly fields?: unknown }).fields !== "object" ||
    (value as { readonly fields?: unknown }).fields === null ||
    !Array.isArray((value as { readonly fieldList?: unknown }).fieldList)
  ) {
    throw new Error(`Cannot ${operation}: expected a component from defineComponent()`);
  }
}

function readonlyNetRef<T>(source: NetRef<T>): ReadonlyNetRef<T> {
  return Object.freeze(new ReadonlyNetRefImpl(source));
}

class ReadonlyNetRefImpl<T> implements ReadonlyNetRef<T> {
  readonly meta;

  constructor(private readonly source: NetRef<T>) {
    this.meta = source.meta;
  }

  get value(): T {
    return this.source.peek();
  }

  set value(_value: T) {
    throw new Error(
      `Cannot mutate read-only replicated field "${this.meta.schemaName}.${this.meta.fieldName}". Send a command to the server or mutate state from a ServerWorld.`,
    );
  }

  peek(): T {
    return this.source.peek();
  }
}

class QueuedClientTransport implements ClientTransport {
  readonly #queue: { channel: ChannelName; bytes: Uint8Array }[] = [];
  #handler?: (channel: ChannelName, bytes: Uint8Array) => void;

  constructor(private readonly inner: ClientTransport) {
    inner.onPacket((channel, bytes) => {
      assertChannelName(channel, "ClientTransport.onPacket()");
      assertPacketBytes(bytes, "ClientTransport.onPacket()");
      this.#queue.push({ channel, bytes: copyPacketBytes(bytes) });
    });
  }

  send(channel: ChannelName, bytes: Uint8Array): void {
    assertChannelName(channel, "ClientTransport.send()");
    assertPacketBytes(bytes, "ClientTransport.send()");
    this.inner.send(channel, bytes);
  }

  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void {
    this.#handler = cb;
  }

  drain(): void {
    const packets = this.#queue.splice(0);
    for (const packet of packets) {
      this.#handler?.(packet.channel, packet.bytes);
    }
  }
}

class QueuedServerTransport implements ServerTransport {
  readonly #queue: { peer: PeerRef; channel: ChannelName; bytes: Uint8Array }[] = [];
  #handler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  constructor(private readonly inner: ServerTransport) {
    inner.onPacket((peer, channel, bytes) => {
      assertPeerRef(peer, "ServerTransport.onPacket()");
      assertChannelName(channel, "ServerTransport.onPacket()");
      assertPacketBytes(bytes, "ServerTransport.onPacket()");
      this.#queue.push({ peer, channel, bytes: copyPacketBytes(bytes) });
    });
  }

  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    assertPeerRef(peer, "ServerTransport.send()");
    assertChannelName(channel, "ServerTransport.send()");
    assertPacketBytes(bytes, "ServerTransport.send()");
    this.inner.send(peer, channel, bytes);
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    assertChannelName(channel, "ServerTransport.broadcast()");
    assertPacketBytes(bytes, "ServerTransport.broadcast()");
    this.inner.broadcast(channel, bytes);
  }

  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void {
    this.#handler = cb;
  }

  peers(): Iterable<PeerRef> {
    const peers = this.inner.peers?.();
    if (peers === undefined) {
      return [];
    }
    if (peers === null || typeof peers !== "object" || !(Symbol.iterator in peers)) {
      throw new Error("ServerTransport.peers() must return an iterable of peer refs");
    }
    return Array.from(peers, (peer) => {
      assertPeerRef(peer, "ServerTransport.peers()");
      return peer;
    });
  }

  drain(): void {
    const packets = this.#queue.splice(0);
    for (const packet of packets) {
      this.#handler?.(packet.peer, packet.channel, packet.bytes);
    }
  }
}

/** Authoritative world handle. Servers create entities, mutate components, receive commands, and send snapshots. */
export interface ServerWorld {
  /** Creates an empty server-authored entity. */
  spawn(): EntityRef;
  /** Creates an entity with one component schema attached and returns that component instance. */
  spawn<TFields extends FieldDefinitions>(
    schema: EntitySchema<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): EntityInstance<TFields>;
  spawn<TFields extends FieldDefinitions>(
    prefab: SimpleEntityDefinition<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): EntityRef;
  spawn<TComponents extends Record<string, ComponentSchema>>(
    prefab: PrefabDefinition<TComponents>,
    initial?: Partial<{
      [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
        ? Partial<FieldValues<TFields>>
        : never;
    }>,
  ): EntityRef;
  /** Adds a component or prefab to an existing server entity. Re-adding an existing component returns it. */
  add<TFields extends FieldDefinitions>(
    entity: number | EntityRef,
    component: ComponentSchema<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentInstance<TFields>;
  add<TFields extends FieldDefinitions>(
    entity: number | EntityRef,
    prefab: SimpleEntityDefinition<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentInstance<TFields>;
  add<TComponents extends Record<string, ComponentSchema>>(
    entity: number | EntityRef,
    prefab: PrefabDefinition<TComponents>,
    initial?: Partial<{
      [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
        ? Partial<FieldValues<TFields>>
        : never;
    }>,
  ): PrefabInstance<TComponents>;
  /** Reads a world-level component from the reserved `WorldEntity`. */
  getComponent<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
  ): ComponentInstance<TFields> | undefined;
  /** Reads a component or simple prefab primary component from an entity. */
  get<TFields extends FieldDefinitions>(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema<TFields> | SimpleEntityDefinition<TFields>,
  ): ComponentInstance<TFields> | undefined;
  /** Reads every component in a composite prefab, or `undefined` if any component is missing. */
  getPrefab<TComponents extends Record<string, ComponentSchema>>(
    entity: number | ReadonlyEntityRef,
    prefab: PrefabDefinition<TComponents>,
  ): PrefabInstance<TComponents> | undefined;
  /** Returns whether an entity currently has a component or every component in a prefab. */
  has(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentOrPrefab,
  ): boolean;
  /** Returns the owner peer id for an entity. Server-owned entities return `0`. */
  ownerOf(entity: number | ReadonlyEntityRef): PeerId;
  /** Sets server-authoritative owner metadata for an entity. */
  setOwner(entity: number | EntityRef, peer: PeerId | ReadonlyEntityRef): void;
  /** Sets an entity back to server ownership. */
  clearOwner(entity: number | EntityRef): void;
  /** Returns whether a peer owns an entity. */
  isOwner(peer: PeerId | ReadonlyEntityRef, entity: number | ReadonlyEntityRef): boolean;
  /** Returns read-only refs for entities currently owned by a peer. */
  ownedBy(peer: PeerId | ReadonlyEntityRef): readonly ReadonlyEntityRef[];
  /** Returns the numeric peer id represented by a PeerEntity ref. */
  peerId(peer: ReadonlyEntityRef): PeerId;
  /** Returns the built-in connection status for a PeerEntity ref. */
  peerStatus(peer: ReadonlyEntityRef): PeerStatusValue;
  /** Removes a component or every component in a prefab from an entity. */
  remove(entity: number | EntityRef, componentOrPrefab: ComponentOrPrefab): boolean;
  /** Destroys an entity and all component rows attached to it. */
  destroy(entity: number | EntityRef): boolean;
  /** Creates a lazy query over one or more components. */
  query<TComponents extends ComponentQuery>(
    ...components: TComponents
  ): QueryResult<TComponents>;
  /** Iterates matching rows without materializing public query tuples. Prefer this in hot systems. */
  each<const TComponents extends ComponentQuery>(
    components: TComponents,
    fn: EachFn<TComponents>,
  ): void;
  /** Registers a named system in a phase. The returned function unregisters it. */
  system(name: string, phase: SystemPhase, fn: SystemFn<ServerWorld>): () => void;
  /** Advances transport input, systems, and server snapshot output once. */
  tick(): void;
  /** Handles an endpoint-addressed client-to-server command. */
  onCommand<TFields extends FieldDefinitions>(
    rpc: CommandDefinition<TFields>,
    handler: CommandHandler<TFields>,
    validator?: CommandValidator<TFields>,
  ): () => void;
  /** Handles an endpoint-addressed client-to-server command stream. */
  onCommandStream<TFields extends FieldDefinitions>(
    stream: StreamDefinition<TFields>,
    handler: CommandStreamHandler<TFields>,
    validator?: CommandStreamValidator<TFields>,
  ): () => void;
  /** Broadcasts an endpoint-addressed event to every connected peer. */
  broadcastEvent<TFields extends FieldDefinitions>(
    source: number | ReadonlyEntityRef,
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  /** Sends an endpoint-addressed event to one or more PeerEntity refs. */
  sendEventTo<TFields extends FieldDefinitions>(
    targets: number | ReadonlyEntityRef | readonly ReadonlyEntityRef[],
    source: number | ReadonlyEntityRef,
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  /** Sends a peer endpoint event whose source is each receiving PeerEntity. */
  sendPeerEventTo<TFields extends FieldDefinitions>(
    targets: number | ReadonlyEntityRef | readonly ReadonlyEntityRef[],
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  /** Broadcasts a peer endpoint event to every connected peer using each PeerEntity as source/target. */
  broadcastPeerEvent<TFields extends FieldDefinitions>(
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  /** Sends a full snapshot to one peer or all known peers. */
  sendFullSnapshot(peer?: PeerRef): void;
  /** Sets a manual per-peer visibility override for one entity. */
  setVisible(peerId: PeerId, entity: number | ReadonlyEntityRef, visible: boolean): void;
  /** Clears one visibility override, or all overrides for a peer when no entity is passed. */
  clearVisible(peerId: PeerId, entity?: number | ReadonlyEntityRef): void;
  /** Evaluates the current visibility policy for a peer/entity pair. */
  isVisible(peerId: PeerId, entity: number | ReadonlyEntityRef): boolean;
}

class ServerWorldImpl implements ServerWorld {
  readonly #core: WorldCore;
  readonly #transport: QueuedServerTransport;
  readonly #runtime: SyncServer;
  readonly #clock: Clock;
  readonly #protocol: ProtocolDefinition;
  readonly #knownProtocolRpcs = new WeakSet<RpcDefinition>();
  readonly #visibility = new Map<PeerId, Map<number, boolean>>();
  readonly #visibilityDefault: "all" | "none";
  readonly #interestWorld: InterestWorld;
  #interest?: (peerId: PeerId, entity: ReadonlyEntityRef, world: InterestWorld) => boolean;
  #started = false;
  #lastNowMs: number | undefined;
  #systemTick = 0;

  constructor(options: ServerWorldOptions) {
    assertServerWorldOptions(options);
    const clock = checkedClock("createServerWorld()", options.clock);
    this.#core = new WorldCore(options.protocol);
    registerWorldInternals(this, createWorldInternals(this.#core));
    this.#protocol = options.protocol;
    this.#clock = clock;
    this.#transport = new QueuedServerTransport(options.transport);
    this.#visibilityDefault = options.visibility ?? "all";
    this.#interestWorld = this.#createInterestWorld();
    if (options.interest !== undefined) {
      this.#interest = options.interest;
    }
    this.#runtime = createSyncServer(
      serverRuntimeOptions(this, this.#transport, options, clock, () => this.#canReusePeerSnapshots()),
    );
    Object.freeze(this);
  }

  spawn(): EntityRef;
  spawn<TFields extends FieldDefinitions>(
    schema: EntitySchema<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): EntityInstance<TFields>;
  spawn<TFields extends FieldDefinitions>(
    prefab: SimpleEntityDefinition<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): EntityRef;
  spawn<TComponents extends Record<string, ComponentSchema>>(
    prefab: PrefabDefinition<TComponents>,
    initial?: Partial<{
      [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
        ? Partial<FieldValues<TFields>>
        : never;
    }>,
  ): EntityRef;
  spawn(
    schemaOrPrefab?: EntitySchema | PrefabDefinition,
    initial?: Record<string, unknown>,
  ): EntityInstance<FieldDefinitions> | EntityRef {
    if (schemaOrPrefab === undefined) {
      return this.#core.entity();
    }
    return this.#core.spawnAny(schemaOrPrefab, initial);
  }

  add<TFields extends FieldDefinitions>(
    entity: number | EntityRef,
    component: ComponentSchema<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentInstance<TFields>;
  add<TFields extends FieldDefinitions>(
    entity: number | EntityRef,
    prefab: SimpleEntityDefinition<TFields>,
    initial?: Partial<FieldValues<TFields>>,
  ): ComponentInstance<TFields>;
  add<TComponents extends Record<string, ComponentSchema>>(
    entity: number | EntityRef,
    prefab: PrefabDefinition<TComponents>,
    initial?: Partial<{
      [K in keyof TComponents]: TComponents[K] extends ComponentSchema<infer TFields>
        ? Partial<FieldValues<TFields>>
        : never;
    }>,
  ): PrefabInstance<TComponents>;
  add(
    entity: number | EntityRef,
    componentOrPrefab: ComponentSchema | PrefabDefinition,
    initial?: Record<string, unknown>,
  ): ComponentInstance<FieldDefinitions> | PrefabInstance<Record<string, ComponentSchema>> {
    if (hasComponentList(componentOrPrefab)) {
      return this.#core.add(
        entity,
        componentOrPrefab,
        initial as Partial<Record<string, Partial<FieldValues<FieldDefinitions>>>> | undefined,
      );
    }
    return this.#core.add(entity, componentOrPrefab, initial as Partial<FieldValues<FieldDefinitions>>);
  }

  get<TFields extends FieldDefinitions>(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema<TFields> | SimpleEntityDefinition<TFields>,
  ): ComponentInstance<TFields> | undefined;
  get(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema | SimpleEntityDefinition<FieldDefinitions>,
  ): ComponentInstance<FieldDefinitions> | undefined {
    return this.#core.getAny(entity, componentOrPrefab);
  }

  getComponent<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
  ): ComponentInstance<TFields> | undefined {
    return this.#core.getComponent(component);
  }

  getPrefab<TComponents extends Record<string, ComponentSchema>>(
    entity: number | ReadonlyEntityRef,
    prefab: PrefabDefinition<TComponents>,
  ): PrefabInstance<TComponents> | undefined {
    return this.#core.getPrefab(entity, prefab);
  }

  has(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentOrPrefab,
  ): boolean {
    return this.#core.has(entity, componentOrPrefab);
  }

  ownerOf(entity: number | ReadonlyEntityRef): PeerId {
    return this.#core.ownerOf(entity);
  }

  setOwner(entity: number | EntityRef, peer: PeerId | ReadonlyEntityRef): void {
    this.#core.setOwner(entity, peer);
  }

  clearOwner(entity: number | EntityRef): void {
    this.#core.clearOwner(entity);
  }

  isOwner(peer: PeerId | ReadonlyEntityRef, entity: number | ReadonlyEntityRef): boolean {
    return this.#core.isOwner(peer, entity);
  }

  ownedBy(peer: PeerId | ReadonlyEntityRef): readonly ReadonlyEntityRef[] {
    return this.#core.ownedBy(peer);
  }

  peerId(peer: ReadonlyEntityRef): PeerId {
    return this.#core.peerId(peer);
  }

  peerStatus(peer: ReadonlyEntityRef): PeerStatusValue {
    return this.#core.peerStatus(peer);
  }

  _ensurePeerEntity(peerId: PeerId): EntityRef {
    return this.#core.ensurePeerEntity(peerId);
  }

  _markPeerDisconnected(peerId: PeerId): void {
    this.#core.markPeerDisconnected(peerId);
  }

  remove(entity: number | EntityRef, componentOrPrefab: ComponentOrPrefab): boolean {
    return this.#core.remove(entity, componentOrPrefab);
  }

  destroy(entity: number | EntityRef): boolean {
    return this.#core.destroy(entity);
  }

  query<TComponents extends ComponentQuery>(
    ...components: TComponents
  ): QueryResult<TComponents> {
    return this.#core.query(...components);
  }

  each<const TComponents extends ComponentQuery>(
    components: TComponents,
    fn: EachFn<TComponents>,
  ): void {
    this.#core.each(components, fn);
  }

  system(name: string, phase: SystemPhase, fn: SystemFn<ServerWorld>): () => void {
    return this.#core.system(name, phase, fn);
  }

  tick(): void {
    if (!this.#started) {
      this.#runtime.start();
      this.#started = true;
    }
    const frame = this.#frameContext();
    this.#transport.drain();
    this.#runTimedSystems("preUpdate", frame);
    this.#runTimedSystems("update", frame);
    this.#runTimedSystems("postUpdate", frame);
    this.#runTimedSystems("network", frame);
    this.#runtime.update();
  }

  on<TFields extends FieldDefinitions>(
    rpc: CommandDefinition<TFields>,
    handler: RpcHandler<TFields>,
  ): () => void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "command", "ServerWorld.on");
    return this.#runtime.on(rpc, handler);
  }

  onCommand<TFields extends FieldDefinitions>(
    rpc: CommandDefinition<TFields>,
    handler: CommandHandler<TFields>,
    validator?: CommandValidator<TFields>,
  ): () => void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "command", "ServerWorld.onCommand");
    return this.#runtime.onCommand(rpc, handler, validator);
  }

  onCommandStream<TFields extends FieldDefinitions>(
    stream: StreamDefinition<TFields>,
    handler: CommandStreamHandler<TFields>,
    validator?: CommandStreamValidator<TFields>,
  ): () => void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, stream, "stream", "ServerWorld.onCommandStream");
    return this.#runtime.onCommandStream(stream, handler, validator);
  }

  broadcast<TFields extends FieldDefinitions>(
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ServerWorld.broadcast");
    this.#runtime.broadcast(rpc, payload);
  }

  sendTo<TFields extends FieldDefinitions>(
    peerId: PeerId,
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    assertPeerId(peerId, "ServerWorld.sendTo()");
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ServerWorld.sendTo");
    this.#runtime.sendTo(peerId, rpc, payload);
  }

  broadcastEvent<TFields extends FieldDefinitions>(
    source: number | ReadonlyEntityRef,
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    const sourceId = entityIdFrom(source, "ServerWorld.broadcastEvent()");
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ServerWorld.broadcastEvent");
    this.#runtime.broadcastEvent(sourceId, rpc, payload);
  }

  sendEventTo<TFields extends FieldDefinitions>(
    targets: number | ReadonlyEntityRef | readonly ReadonlyEntityRef[],
    source: number | ReadonlyEntityRef,
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    const peerTargets = peerEventTargets(this.#core, targets, "ServerWorld.sendEventTo()");
    const sourceId = entityIdFrom(source, "ServerWorld.sendEventTo()");
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ServerWorld.sendEventTo");
    this.#runtime.sendEventTo(peerTargets, sourceId, rpc, payload);
  }

  sendPeerEventTo<TFields extends FieldDefinitions>(
    targets: number | ReadonlyEntityRef | readonly ReadonlyEntityRef[],
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    const peerTargets = peerEventTargets(this.#core, targets, "ServerWorld.sendPeerEventTo()");
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ServerWorld.sendPeerEventTo");
    this.#runtime.sendPeerEventTo(peerTargets, rpc, payload);
  }

  broadcastPeerEvent<TFields extends FieldDefinitions>(
    rpc: EventDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ServerWorld.broadcastPeerEvent");
    this.#runtime.broadcastPeerEvent(rpc, payload);
  }

  sendFullSnapshot(peer?: PeerRef): void {
    if (peer !== undefined) {
      assertPeerRef(peer, "ServerWorld.sendFullSnapshot()");
    }
    this.#runtime.sendFullSnapshot(peer);
  }

  setVisible(peerId: PeerId, entity: number | ReadonlyEntityRef, visible: boolean): void {
    assertPeerId(peerId, "ServerWorld.setVisible()");
    const entityId = entityIdFrom(entity, "ServerWorld.setVisible()");
    if (typeof visible !== "boolean") {
      throw new Error("ServerWorld.setVisible() visible must be a boolean");
    }
    if (entityId === WorldEntity.id) {
      if (!visible) {
        throw new Error("ServerWorld.setVisible() cannot hide WorldEntity");
      }
      return;
    }
    const map = this.#visibility.get(peerId) ?? new Map<number, boolean>();
    map.set(entityId, visible);
    this.#visibility.set(peerId, map);
  }

  clearVisible(peerId: PeerId, entity?: number | ReadonlyEntityRef): void {
    assertPeerId(peerId, "ServerWorld.clearVisible()");
    if (entity === undefined) {
      this.#visibility.delete(peerId);
      return;
    }

    const entityId = entityIdFrom(entity, "ServerWorld.clearVisible()");
    if (entityId === WorldEntity.id) {
      return;
    }
    const map = this.#visibility.get(peerId);
    if (map === undefined) {
      return;
    }
    map.delete(entityId);
    if (map.size === 0) {
      this.#visibility.delete(peerId);
    }
  }

  isVisible(peerId: PeerId, entity: number | ReadonlyEntityRef): boolean {
    assertPeerId(peerId, "ServerWorld.isVisible()");
    const entityId = entityIdFrom(entity, "ServerWorld.isVisible()");
    if (entityId === WorldEntity.id) {
      return true;
    }
    if (this.#core.ownerOf(entityId) === peerId) {
      return true;
    }
    const override = this.#visibility.get(peerId)?.get(entityId);
    if (override !== undefined) {
      return override;
    }
    if (this.#interest !== undefined) {
      const visible = this.#interest(peerId, this.#core._readonlyEntityRef(entityId), this.#interestWorld);
      if (typeof visible !== "boolean") {
        throw new Error("createServerWorld() interest must return a boolean");
      }
      return visible;
    }
    return this.#visibilityDefault === "all";
  }

  #canReusePeerSnapshots(): boolean {
    return (
      this.#visibilityDefault === "all" &&
      this.#interest === undefined &&
      this.#visibility.size === 0
    );
  }

  #runTimedSystems(phase: SystemPhase, frame: FrameContext): void {
    this.#core.runSystems(this, phase, { ...frame, phase });
  }

  #frameContext(): FrameContext {
    const nowMs = this.#clock.nowMs();
    assertMonotonicNowMs("createServerWorld()", this.#lastNowMs, nowMs);
    const dtMs = this.#lastNowMs === undefined ? 0 : nowMs - this.#lastNowMs;
    this.#lastNowMs = nowMs;
    this.#systemTick += 1;
    return { tick: this.#systemTick, dtMs, nowMs };
  }

  #createInterestWorld(): InterestWorld {
    return Object.freeze({
      getComponent: (component) => this.#core.getComponentReadonly(component),
      get: (entity, componentOrPrefab) => this.#core.getReadonly(entity, componentOrPrefab),
      getPrefab: (entity, prefab) => this.#core.getPrefabReadonly(entity, prefab),
      has: (entity, componentOrPrefab) => this.#core.has(entity, componentOrPrefab),
      ownerOf: (entity) => this.#core.ownerOf(entity),
      query: (...components) => this.#core.queryReadonly(...components),
      each: (components, fn) => this.#core.eachReadonly(components, fn),
    } satisfies InterestWorld);
  }
}

/** Replicated client world handle. Clients read state, run client systems, send commands, and receive events. */
export interface ClientWorld {
  /** Reads a world-level replicated component from the reserved `WorldEntity`. */
  getComponent<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined;
  /** Reads a replicated component or simple prefab primary component. */
  get<TFields extends FieldDefinitions>(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema<TFields> | SimpleEntityDefinition<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined;
  /** Reads every component in a composite prefab as read-only replicated state. */
  getPrefab<TComponents extends Record<string, ComponentSchema>>(
    entity: number | ReadonlyEntityRef,
    prefab: PrefabDefinition<TComponents>,
  ): ReadonlyPrefabInstance<TComponents> | undefined;
  /** Returns whether a replicated entity currently has a component or prefab. */
  has(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentOrPrefab,
  ): boolean;
  /** Returns the synchronized owner peer id for an entity. Server-owned entities return `0`. */
  ownerOf(entity: number | ReadonlyEntityRef): PeerId;
  /** Returns this client's assigned peer id, or `0` before assignment. */
  myPeerId(): PeerId;
  /** Returns this client's PeerEntity ref. */
  myPeerEntity(): ReadonlyEntityRef;
  /** Returns the numeric peer id represented by a PeerEntity ref. */
  peerId(peer: ReadonlyEntityRef): PeerId;
  /** Returns the built-in connection status for a PeerEntity ref. */
  peerStatus(peer: ReadonlyEntityRef): PeerStatusValue;
  /** Returns whether this client owns an entity. */
  isMine(entity: number | ReadonlyEntityRef): boolean;
  /** Creates a lazy read-only query over one or more components. */
  query<TComponents extends ComponentQuery>(
    ...components: TComponents
  ): QueryResult<TComponents, ReadonlyEntityRef, "readonly">;
  /** Iterates matching read-only rows without materializing public query tuples. */
  each<const TComponents extends ComponentQuery>(
    components: TComponents,
    fn: EachFn<TComponents, ReadonlyEntityRef, "readonly">,
  ): void;
  /** Registers a named client-side system. The returned function unregisters it. */
  system(name: string, phase: SystemPhase, fn: SystemFn<ClientWorld>): () => void;
  /** Advances transport input and client systems once. */
  tick(): void;
  /** Sends an endpoint-addressed client-to-server command. */
  sendCommand<TFields extends FieldDefinitions>(
    target: number | ReadonlyEntityRef,
    rpc: CommandDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  /** Pushes one sample into a client-to-server command stream. */
  pushCommandStream<TFields extends FieldDefinitions>(
    target: number | ReadonlyEntityRef,
    stream: StreamDefinition<TFields>,
    payload: Partial<FieldValues<TFields>>,
    clientTick: number,
    dtMs: number,
  ): void;
  /** Handles an endpoint-addressed server-to-client event. */
  onEvent<TFields extends FieldDefinitions>(
    rpc: EventDefinition<TFields>,
    handler: EventHandler<TFields>,
    validator?: EventValidator<TFields>,
  ): () => void;
  /** Registers a post-apply snapshot callback. The returned function unregisters it. */
  onSnapshot(handler: SnapshotHandler<ClientWorld>): () => void;
  /** Requests a reliable full snapshot from the server. */
  requestFullSnapshot(): void;
}

class ClientWorldImpl implements ClientWorld {
  readonly #core: WorldCore;
  readonly #transport: QueuedClientTransport;
  readonly #runtime: SyncClient;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #protocol: ProtocolDefinition;
  readonly #knownProtocolRpcs = new WeakSet<RpcDefinition>();
  readonly #snapshotHandlers = new Set<SnapshotHandler<ClientWorld>>();
  #started = false;
  #lastNowMs: number | undefined;
  #systemTick = 0;

  constructor(options: ClientWorldOptions) {
    assertClientWorldOptions(options);
    const clock = checkedClock("createClientWorld()", options.clock);
    this.#core = new WorldCore(options.protocol);
    registerWorldInternals(this, createWorldInternals(this.#core));
    this.#protocol = options.protocol;
    this.#clock = clock;
    this.#logger = options.logger ?? defaultLogger;
    this.#transport = new QueuedClientTransport(options.transport);
    this.#runtime = createSyncClient(
      clientRuntimeOptions(this, this.#transport, options, clock, (context) =>
        this.#notifySnapshot(context),
      ),
    );
    Object.freeze(this);
  }

  get<TFields extends FieldDefinitions>(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema<TFields> | SimpleEntityDefinition<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined;
  get(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentSchema | SimpleEntityDefinition<FieldDefinitions>,
  ): ReadonlyComponentInstance<FieldDefinitions> | undefined {
    return this.#core.getReadonly(
      entity,
      componentOrPrefab,
    );
  }

  getComponent<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
  ): ReadonlyComponentInstance<TFields> | undefined {
    return this.#core.getComponentReadonly(component);
  }

  getPrefab<TComponents extends Record<string, ComponentSchema>>(
    entity: number | ReadonlyEntityRef,
    prefab: PrefabDefinition<TComponents>,
  ): ReadonlyPrefabInstance<TComponents> | undefined {
    return this.#core.getPrefabReadonly(entity, prefab);
  }

  has(
    entity: number | ReadonlyEntityRef,
    componentOrPrefab: ComponentOrPrefab,
  ): boolean {
    return this.#core.has(entity, componentOrPrefab);
  }

  ownerOf(entity: number | ReadonlyEntityRef): PeerId {
    return this.#core.ownerOf(entity);
  }

  myPeerId(): PeerId {
    return this.#runtime.peerId();
  }

  myPeerEntity(): ReadonlyEntityRef {
    return this.#assignedPeerEntity("ClientWorld.myPeerEntity()");
  }

  peerId(peer: ReadonlyEntityRef): PeerId {
    return this.#core.peerId(peer);
  }

  peerStatus(peer: ReadonlyEntityRef): PeerStatusValue {
    return this.#core.peerStatus(peer);
  }

  _assignPeerEntity(peerId: PeerId, peerEntityId: number): void {
    this.#core.registerPeerEntity(peerId, peerEntityId);
  }

  isMine(entity: number | ReadonlyEntityRef): boolean {
    return this.ownerOf(entity) === this.myPeerId();
  }

  query<TComponents extends ComponentQuery>(
    ...components: TComponents
  ): QueryResult<TComponents, ReadonlyEntityRef, "readonly"> {
    return this.#core.queryReadonly(...components);
  }

  each<const TComponents extends ComponentQuery>(
    components: TComponents,
    fn: EachFn<TComponents, ReadonlyEntityRef, "readonly">,
  ): void {
    this.#core.eachReadonly(components, fn);
  }

  system(name: string, phase: SystemPhase, fn: SystemFn<ClientWorld>): () => void {
    return this.#core.system(name, phase, fn);
  }

  tick(): void {
    if (!this.#started) {
      this.#runtime.start();
      this.#started = true;
    }
    const frame = this.#frameContext();
    this.#transport.drain();
    this.#runTimedSystems("preUpdate", frame);
    this.#runTimedSystems("update", frame);
    this.#runTimedSystems("postUpdate", frame);
    this.#runTimedSystems("network", frame);
    this.#runtime.update();
  }

  send<TFields extends FieldDefinitions>(
    rpc: CommandDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "command", "ClientWorld.send");
    this.#assignedPeerEntity("ClientWorld.send()");
    this.#runtime.send(rpc, payload);
  }

  sendCommand<TFields extends FieldDefinitions>(
    target: number | ReadonlyEntityRef,
    rpc: CommandDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void {
    const targetId = entityIdFrom(target, "ClientWorld.sendCommand()");
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "command", "ClientWorld.sendCommand");
    this.#assignedPeerEntity("ClientWorld.sendCommand()");
    this.#runtime.sendCommand(targetId, rpc, payload);
  }

  pushCommandStream<TFields extends FieldDefinitions>(
    target: number | ReadonlyEntityRef,
    stream: StreamDefinition<TFields>,
    payload: Partial<FieldValues<TFields>>,
    clientTick: number,
    dtMs: number,
  ): void {
    const targetId = entityIdFrom(target, "ClientWorld.pushCommandStream()");
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, stream, "stream", "ClientWorld.pushCommandStream");
    this.#assignedPeerEntity("ClientWorld.pushCommandStream()");
    assertStreamSampleNumber(clientTick, "clientTick");
    assertStreamSampleNumber(dtMs, "dtMs");
    this.#runtime.pushCommandStream(targetId, stream, payload, clientTick, dtMs);
  }

  on<TFields extends FieldDefinitions>(
    rpc: EventDefinition<TFields>,
    handler: RpcHandler<TFields>,
  ): () => void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ClientWorld.on");
    return this.#runtime.on(rpc, handler);
  }

  onEvent<TFields extends FieldDefinitions>(
    rpc: EventDefinition<TFields>,
    handler: EventHandler<TFields>,
    validator?: EventValidator<TFields>,
  ): () => void {
    assertProtocolRpc(this.#protocol, this.#knownProtocolRpcs, rpc, "event", "ClientWorld.onEvent");
    return this.#runtime.onEvent(rpc, handler, validator);
  }

  onSnapshot(handler: SnapshotHandler<ClientWorld>): () => void {
    if (!isFunction(handler)) {
      throw new Error("ClientWorld.onSnapshot() requires a function");
    }
    this.#snapshotHandlers.add(handler);
    return () => {
      this.#snapshotHandlers.delete(handler);
    };
  }

  requestFullSnapshot(): void {
    this.#runtime.requestFullSnapshot();
  }

  #assignedPeerEntity(label: string): ReadonlyEntityRef {
    const peerId = this.myPeerId();
    const peerEntity = this.#core.peerEntity(peerId);
    if (peerId === ServerPeerId || peerEntity === undefined) {
      throw new Error(`${label} cannot send commands before peer assignment`);
    }
    return peerEntity;
  }

  #notifySnapshot(context: SnapshotContext): void {
    const frozenContext = Object.isFrozen(context) ? context : Object.freeze(context);
    // Snapshot hooks mirror RPC dispatch semantics: isolated errors and stable handler membership.
    for (const handler of [...this.#snapshotHandlers]) {
      try {
        handler(this, frozenContext);
      } catch (error) {
        this.#logger.error?.("ClientWorld snapshot handler failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  #runTimedSystems(phase: SystemPhase, frame: FrameContext): void {
    this.#core.runSystems(this, phase, { ...frame, phase });
  }

  #frameContext(): FrameContext {
    const nowMs = this.#clock.nowMs();
    assertMonotonicNowMs("createClientWorld()", this.#lastNowMs, nowMs);
    const dtMs = this.#lastNowMs === undefined ? 0 : nowMs - this.#lastNowMs;
    this.#lastNowMs = nowMs;
    this.#systemTick += 1;
    return { tick: this.#systemTick, dtMs, nowMs };
  }
}

/** Creates an authoritative server world. There is no public local-only world factory. */
export function createServerWorld(options: ServerWorldOptions): ServerWorld {
  return new ServerWorldImpl(options);
}

/** Creates a replicated client world. Client replicated state is read-only and driven by snapshots. */
export function createClientWorld(options: ClientWorldOptions): ClientWorld {
  return new ClientWorldImpl(options);
}

function serverRuntimeOptions(
  world: ServerWorld,
  transport: QueuedServerTransport,
  options: ServerWorldOptions,
  clock: Clock,
  canReusePeerSnapshots: () => boolean,
): SyncServerOptions {
  return {
    world,
    transport,
    clock,
    registry: registryFromOptions(options),
    ...(options.protocol.hash === undefined ? {} : { protocolHash: options.protocol.hash }),
    logger: options.logger ?? defaultLogger,
    isVisible: (peer, entityId) => world.isVisible(peer, entityId),
    canReusePeerSnapshots,
    ensurePeerEntity: (peerId) => (world as ServerWorldImpl)._ensurePeerEntity(peerId).id,
    markPeerDisconnected: (peerId) => (world as ServerWorldImpl)._markPeerDisconnected(peerId),
    snapshotEncoding: options.snapshotEncoding ?? "default",
    ...(options.streamLimits === undefined ? {} : { streamLimits: options.streamLimits }),
  };
}

function clientRuntimeOptions(
  world: ClientWorld,
  transport: QueuedClientTransport,
  options: ClientWorldOptions,
  clock: Clock,
  onSnapshot: (context: SnapshotContext) => void,
): SyncRuntimeOptions {
  return {
    world,
    transport,
    clock,
    registry: registryFromOptions(options),
    ...(options.protocol.hash === undefined ? {} : { protocolHash: options.protocol.hash }),
    logger: options.logger ?? defaultLogger,
    ...(options.streamLimits === undefined ? {} : { streamLimits: options.streamLimits }),
    onSnapshot,
    assignPeerEntity: (peerId, peerEntityId) => (world as ClientWorldImpl)._assignPeerEntity(peerId, peerEntityId),
  };
}

function registryFromOptions(options: {
  readonly protocol: ProtocolDefinition;
}) {
  return registryForProtocol(options.protocol);
}

type ExpectedRpcKind = "command" | "event" | "stream";

function assertProtocolRpc(
  protocol: ProtocolDefinition,
  knownRpcs: WeakSet<RpcDefinition>,
  rpc: unknown,
  expectedKind: ExpectedRpcKind,
  operation: string,
): asserts rpc is RpcDefinition {
  if (!isRpcDefinition(rpc)) {
    throw new Error(`${operation}() requires ${rpcKindArticle(expectedKind)} from defineProtocol()`);
  }

  if (rpc.kind !== expectedKind) {
    throw new Error(
      `${operation}() expects ${rpcKindArticle(expectedKind)}; received ${rpc.kind} "${rpc.name}"`,
    );
  }

  if (knownRpcs.has(rpc)) {
    return;
  }

  if (registryForProtocol(protocol).getRpc(rpc.rpcId) === rpc) {
    knownRpcs.add(rpc);
    return;
  }

  throw new Error(
    `${operation}() cannot use RPC "${rpc.name}" because it is not registered in this world protocol`,
  );
}

function isRpcDefinition(value: unknown): value is RpcDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly name?: unknown }).name === "string" &&
    typeof (value as { readonly rpcId?: unknown }).rpcId === "number" &&
    ((value as { readonly kind?: unknown }).kind === "command" ||
      (value as { readonly kind?: unknown }).kind === "event" ||
      (value as { readonly kind?: unknown }).kind === "stream")
  );
}

function rpcKindArticle(kind: ExpectedRpcKind): string {
  if (kind === "event") return "an event";
  if (kind === "stream") return "a stream";
  return "a command";
}

function assertServerWorldOptions(options: unknown): asserts options is ServerWorldOptions {
  const source = assertOptionObject("createServerWorld", options);
  assertProtocol("createServerWorld", source.protocol);
  assertServerTransport(source.transport);
  assertClock("createServerWorld", source.clock);
  assertLogger("createServerWorld", source.logger);
  if (
    source.visibility !== undefined &&
    source.visibility !== "all" &&
    source.visibility !== "none"
  ) {
    throw new Error('createServerWorld() visibility must be "all" or "none"');
  }
  if (
    source.snapshotEncoding !== undefined &&
    source.snapshotEncoding !== "default" &&
    source.snapshotEncoding !== "batched"
  ) {
    throw new Error('createServerWorld() snapshotEncoding must be "default" or "batched"');
  }
  if (source.interest !== undefined && !isFunction(source.interest)) {
    throw new Error("createServerWorld() interest must be a function");
  }
  if (source.channel !== undefined) {
    throw new Error("createServerWorld() does not accept channel; control and snapshots use reliable, while RPCs declare their own channel");
  }
  assertKnownOptionKeys("createServerWorld", source, serverWorldOptionKeys);
}

function assertClientWorldOptions(options: unknown): asserts options is ClientWorldOptions {
  const source = assertOptionObject("createClientWorld", options);
  assertProtocol("createClientWorld", source.protocol);
  assertClientTransport(source.transport);
  assertClock("createClientWorld", source.clock);
  assertLogger("createClientWorld", source.logger);
  if (source.channel !== undefined) {
    throw new Error("createClientWorld() does not accept channel; control and snapshots use reliable, while RPCs declare their own channel");
  }
  assertKnownOptionKeys("createClientWorld", source, clientWorldOptionKeys);
}

const serverWorldOptionKeys = new Set([
  "protocol",
  "transport",
  "clock",
  "logger",
  "snapshotEncoding",
  "visibility",
  "interest",
  "streamLimits",
]);

const clientWorldOptionKeys = new Set([
  "protocol",
  "transport",
  "clock",
  "logger",
  "onSnapshot",
  "streamLimits",
]);

function assertKnownOptionKeys(
  factoryName: "createServerWorld" | "createClientWorld",
  options: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): void {
  for (const key of Object.keys(options)) {
    if (!knownKeys.has(key)) {
      throw new Error(`${factoryName}() received unknown option "${key}"`);
    }
  }
}

function assertOptionObject(
  factoryName: "createServerWorld" | "createClientWorld",
  options: unknown,
): Record<string, unknown> {
  if (!isPlainObjectMap(options)) {
    throw new Error(`${factoryName}() requires an options object (plain object map)`);
  }
  return options;
}

function assertProtocol(
  factoryName: "createServerWorld" | "createClientWorld",
  protocol: unknown,
): asserts protocol is ProtocolDefinition {
  if (!isProtocolDefinition(protocol)) {
    throw new Error(`${factoryName}() requires a protocol from defineProtocol()`);
  }
}

function assertServerTransport(transport: unknown): asserts transport is ServerTransport {
  if (
    transport === null ||
    typeof transport !== "object" ||
    !isFunction((transport as { readonly send?: unknown }).send) ||
    !isFunction((transport as { readonly broadcast?: unknown }).broadcast) ||
    !isFunction((transport as { readonly onPacket?: unknown }).onPacket)
  ) {
    throw new Error("createServerWorld() requires a server transport with send(), broadcast(), and onPacket()");
  }
}

function assertClientTransport(transport: unknown): asserts transport is ClientTransport {
  if (
    transport === null ||
    typeof transport !== "object" ||
    !isFunction((transport as { readonly send?: unknown }).send) ||
    !isFunction((transport as { readonly onPacket?: unknown }).onPacket)
  ) {
    throw new Error("createClientWorld() requires a client transport with send() and onPacket()");
  }
}

function assertClock(
  factoryName: "createServerWorld" | "createClientWorld",
  clock: unknown,
): asserts clock is Clock {
  if (
    clock === null ||
    typeof clock !== "object" ||
    !isFunction((clock as { readonly nowMs?: unknown }).nowMs) ||
    !isFunction((clock as { readonly tick?: unknown }).tick)
  ) {
    throw new Error(`${factoryName}() requires a clock with nowMs() and tick()`);
  }
}

function assertLogger(
  factoryName: "createServerWorld" | "createClientWorld",
  logger: unknown,
): asserts logger is Logger | undefined {
  if (logger === undefined) {
    return;
  }
  if (logger === null || typeof logger !== "object" || Array.isArray(logger)) {
    throw new Error(`${factoryName}() logger must be an object`);
  }
  for (const method of ["debug", "info", "warn", "error"] as const) {
    const value = (logger as Record<string, unknown>)[method];
    if (value !== undefined && !isFunction(value)) {
      throw new Error(`${factoryName}() logger.${method} must be a function`);
    }
  }
}

function checkedClock(factoryName: "createServerWorld()" | "createClientWorld()", clock: Clock): Clock {
  return {
    nowMs() {
      const nowMs = clock.nowMs();
      if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
        throw new Error(`${factoryName} clock.nowMs() must return a finite number`);
      }
      return nowMs;
    },
    tick() {
      const tick = clock.tick();
      if (!Number.isInteger(tick) || tick < 0 || tick > 0xffffffff) {
        throw new Error(`${factoryName} clock.tick() must return an integer in [0, 4294967295]`);
      }
      return tick;
    },
  };
}

function assertMonotonicNowMs(
  factoryName: "createServerWorld()" | "createClientWorld()",
  previousNowMs: number | undefined,
  nowMs: number,
): void {
  if (previousNowMs !== undefined && nowMs < previousNowMs) {
    throw new Error(`${factoryName} clock.nowMs() must be monotonic`);
  }
}

function assertSystemRegistration(
  name: unknown,
  phase: unknown,
  fn: unknown,
): asserts fn is SystemFn {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("world.system() requires a non-empty system name");
  }
  if (typeof phase !== "string" || !systemPhases.has(phase)) {
    throw new Error('world.system() phase must be "preUpdate", "update", "postUpdate", or "network"');
  }
  if (!isFunction(fn)) {
    throw new Error("world.system() requires a function");
  }
}

function assertEachCallback(fn: unknown): asserts fn is EachFn<readonly ComponentSchema[]> {
  if (!isFunction(fn)) {
    throw new Error("world.each() requires a function");
  }
}

function entityIdFrom(entity: number | ReadonlyEntityRef, label: string): number {
  if (typeof entity === "number") {
    assertEntityId(entity, label);
    return entity;
  }
  if (entity === null || typeof entity !== "object" || !("id" in entity)) {
    throw new Error(`${label} requires an entity id or entity ref`);
  }
  const entityId = (entity as { readonly id?: unknown }).id;
  if (typeof entityId !== "number") {
    throw new Error(`${label} requires an entity id or entity ref`);
  }
  assertEntityId(entityId, label);
  return entityId;
}

function assertEntityId(entityId: number, label: string): void {
  if (!Number.isSafeInteger(entityId) || entityId < 0) {
    throw new Error(`${label} requires a non-negative integer entity id`);
  }
}

function peerEventTargets(
  core: WorldCore,
  targets: number | ReadonlyEntityRef | readonly ReadonlyEntityRef[],
  label: string,
):
  | { readonly peerId: PeerId; readonly peerEntityId: number }
  | readonly { readonly peerId: PeerId; readonly peerEntityId: number }[] {
  if (typeof targets !== "number" && Array.isArray(targets)) {
    return targets.map((target) => peerEventTarget(core, target, label));
  }
  return peerEventTarget(core, targets as number | ReadonlyEntityRef, label);
}

function peerEventTarget(
  core: WorldCore,
  target: number | ReadonlyEntityRef,
  label: string,
): { readonly peerId: PeerId; readonly peerEntityId: number } {
  if (typeof target === "number") {
    return { peerId: peerIdFrom(target, label), peerEntityId: core.peerEntity(target)?.id ?? target };
  }
  return { peerId: core.peerId(target), peerEntityId: entityIdFrom(target, label) };
}

function assertPeerRef(peer: unknown, label: string): asserts peer is PeerRef {
  const kind = typeof peer;
  if (
    peer === null ||
    peer === undefined ||
    kind === "boolean" ||
    kind === "bigint" ||
    kind === "function" ||
    (kind === "number" && !Number.isFinite(peer))
  ) {
    throw new Error(`${label} requires a peer ref`);
  }
}

function assertPeerId(peerId: unknown, label: string): asserts peerId is PeerId {
  if (typeof peerId !== "number" || !Number.isSafeInteger(peerId) || peerId < 0) {
    throw new Error(`${label} requires a non-negative integer peer id`);
  }
}

function assertStreamSampleNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} must be an integer in [0, 4294967295]`);
  }
}

function peerIdFrom(peer: PeerId | ReadonlyEntityRef, label: string): PeerId {
  if (typeof peer === "number") {
    assertPeerId(peer, label);
    return peer;
  }
  return entityIdFrom(peer, label);
}

function peerTargetIdsFrom(
  targets: number | ReadonlyEntityRef | readonly ReadonlyEntityRef[],
  label: string,
): number | readonly number[] {
  if (Array.isArray(targets)) {
    return targets.map((target) => peerIdFrom(target, label));
  }
  return peerIdFrom(targets as number | ReadonlyEntityRef, label);
}

function assertChannelName(channel: unknown, label: string): asserts channel is ChannelName {
  if (channel !== "reliable" && channel !== "unreliable") {
    throw new Error(`${label} channel must be "reliable" or "unreliable"`);
  }
}

function assertPacketBytes(bytes: unknown, label: string): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${label} bytes must be a Uint8Array`);
  }
}

function copyPacketBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}
