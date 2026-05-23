import type { ClientTransport, Clock, HostTransport, Logger, PeerRef } from "../platform/index";
import type { RegistryLike } from "../registry/index";
import { decodeRpc, encodeRpc } from "../rpc/index";
import type { RpcContext, RpcDefinition, RpcHandler } from "../rpc/index";
import type { FieldDefinitions, FieldValues } from "../schema/index";
import {
  applySnapshot,
  ControlType,
  decodeControl,
  encodeControl,
  encodeFullSnapshot,
  encodeSnapshotOps,
  encodeSnapshotOpsBatched,
  hasSnapshotOps,
  MessageType,
  peekMessageType,
} from "../sync/index";
import type { SnapshotWriteOps } from "../sync/index";
import type { ClientWorld, HostWorld, SnapshotContext } from "../world/index";
import type { DirtyOps } from "../world/dirty-graph";
import { worldInternals } from "../world/internals";

export interface SyncHostOptions {
  readonly world: HostWorld;
  readonly transport: HostTransport;
  readonly clock: Clock;
  readonly registry: RegistryLike;
  readonly logger?: Logger;
  readonly sendRate?: number;
  readonly snapshotEncoding?: "default" | "batched";
  readonly isVisible?: (peer: PeerRef, entityId: number) => boolean;
  readonly canReusePeerSnapshots?: () => boolean;
}

export interface SyncClientOptions {
  readonly world: ClientWorld;
  readonly transport: ClientTransport;
  readonly clock: Clock;
  readonly registry: RegistryLike;
  readonly logger?: Logger;
  readonly sendRate?: number;
  readonly onSnapshot?: (context: SnapshotContext) => void;
}

export type SyncRuntimeOptions = SyncClientOptions;

export interface SyncHost {
  start(): void;
  update(): void;
  sendFullSnapshot(peer?: PeerRef): void;
  broadcast<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  on<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: RpcHandler<TFields>,
  ): () => void;
}

export interface SyncClient {
  start(): void;
  requestFullSnapshot(): void;
  send<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  on<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: RpcHandler<TFields>,
  ): () => void;
}

interface PeerState {
  readonly knownEntities: Set<number>;
  readonly knownComponents: Set<string>;
}

type HandlerEntry = {
  readonly rpc: RpcDefinition;
  readonly handler: RpcHandler<FieldDefinitions>;
};

class HandlerTable {
  readonly #handlers = new Map<number, HandlerEntry[]>();

  add<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: RpcHandler<TFields>,
  ): () => void {
    if (typeof handler !== "function") {
      throw new Error(`RPC "${rpc.name}" handler must be a function`);
    }
    const entry: HandlerEntry = {
      rpc,
      handler: handler as RpcHandler<FieldDefinitions>,
    };
    const handlers = this.#handlers.get(rpc.rpcId) ?? [];
    handlers.push(entry);
    this.#handlers.set(rpc.rpcId, handlers);

    return () => {
      const current = this.#handlers.get(rpc.rpcId);
      if (current === undefined) {
        return;
      }
      const next = current.filter((item) => item !== entry);
      if (next.length === 0) {
        this.#handlers.delete(rpc.rpcId);
      } else {
        this.#handlers.set(rpc.rpcId, next);
      }
    };
  }

  dispatch(
    rpc: RpcDefinition,
    payload: FieldValues<FieldDefinitions>,
    context: RpcContext,
    logger: Logger | undefined,
  ): void {
    const frozenPayload = Object.freeze(payload) as Readonly<FieldValues<FieldDefinitions>>;
    const frozenContext = Object.freeze(context);
    // Handlers run from a stable snapshot so registration changes during dispatch affect later packets only.
    for (const entry of [...(this.#handlers.get(rpc.rpcId) ?? [])]) {
      try {
        entry.handler(frozenPayload, frozenContext);
      } catch (error) {
        logger?.error?.("RPC handler failed", {
          error: error instanceof Error ? error.message : String(error),
          rpc: entry.rpc.name,
        });
      }
    }
  }
}

export function createSyncHost(options: SyncHostOptions): SyncHost {
  const handlers = new HandlerTable();
  const peers = new Set<PeerRef>();
  const peerStates = new Map<PeerRef, PeerState>();

  options.transport.onPacket((peer, packetChannel, bytes) => {
    peers.add(peer);
    try {
      const messageType = peekMessageType(bytes);
      if (messageType === MessageType.Control) {
        const control = decodeControl(bytes);
        if (
          control.type === ControlType.Hello ||
          control.type === ControlType.FullSnapshotRequest
        ) {
          sendFullSnapshot(peer);
        }
        return;
      }

      if (messageType === MessageType.Rpc) {
        const decoded = decodeRpc(bytes, options.registry);
        handlers.dispatch(
          decoded.rpc,
          decoded.payload,
          {
            tick: decoded.tick,
            channel: packetChannel,
            rpc: decoded.rpc,
            peer,
          },
          options.logger,
        );
        return;
      }
    } catch (error) {
      logError(options.logger, "Failed to handle host packet", error);
    }
  });

  function sendFullSnapshot(peer?: PeerRef): void {
    if (peer !== undefined) {
      const state = stateFor(peerStates, peer);
      const ops = buildFullOpsForPeer(options.world, peer, options.isVisible, state);
      const bytes = encodeSnapshotOps(options.world, options.clock.tick(), ops);
      options.transport.send(peer, "reliable", bytes);
      replaceKnownState(peerStates, peer, ops);
      return;
    }

    const peerList = currentPeers(options.transport, peers);
    if (peerList.length > 0) {
      for (const knownPeer of peerList) {
        sendFullSnapshot(knownPeer);
      }
      return;
    }

    if (options.isVisible !== undefined) {
      return;
    }

    const bytes = encodeFullSnapshot(options.world, options.clock.tick());
    options.transport.broadcast("reliable", bytes);
  }

  return {
    start() {
      for (const peer of currentPeers(options.transport, peers)) {
        sendFullSnapshot(peer);
      }
    },
    update() {
      const internals = worldInternals(options.world);
      const dirty = internals.getDirtySnapshot();
      const tick = options.clock.tick();
      const peerList = currentPeers(options.transport, peers);
      if (trySendSharedUpdate(options, peerStates, peerList, dirty, tick)) {
        internals.clearWrittenDirty(dirty);
        return;
      }
      const encodedStructural = new Map<string, Uint8Array>();
      const encodedUpdates = new Map<string, Uint8Array>();
      for (const peer of peerList) {
        const state = stateFor(peerStates, peer);
        const structural = buildStructuralOpsForPeer(options.world, dirty, peer, state, options.isVisible);
        if (hasSnapshotOps(structural)) {
          options.transport.send(
            peer,
            "reliable",
            encodedPacket(encodedStructural, "s", structural, () =>
              encodeSnapshotOps(options.world, tick, structural),
            ),
          );
          applyKnownOps(state, structural);
        }

        const updates = buildUpdateOpsForPeer(dirty, peer, state, options.isVisible);
        if (hasSnapshotOps(updates)) {
          options.transport.send(
            peer,
            "unreliable",
            encodedPacket(encodedUpdates, "u", updates, () =>
              encodeUpdateSnapshotOps(options, tick, updates),
            ),
          );
        }
      }
      internals.clearWrittenDirty(dirty);
    },
    sendFullSnapshot,
    broadcast(rpc, payload) {
      options.transport.broadcast(rpc.channel, encodeRpc(rpc, payload, options.clock.tick()));
    },
    on(rpc, handler) {
      return handlers.add(rpc, handler);
    },
  };
}

function trySendSharedUpdate(
  options: SyncHostOptions,
  peerStates: Map<PeerRef, PeerState>,
  peers: readonly PeerRef[],
  dirty: DirtyOps,
  tick: number,
): boolean {
  // Fast path for all-visible worlds: encode one update-only dirty packet and fan it out to all peers.
  if (
    options.canReusePeerSnapshots?.() !== true ||
    peers.length === 0 ||
    dirty.updated.length === 0 ||
    dirty.created.length !== 0 ||
    dirty.added.length !== 0 ||
    dirty.removed.length !== 0 ||
    dirty.destroyed.length !== 0
  ) {
    return false;
  }

  for (const peer of peers) {
    const state = stateFor(peerStates, peer);
    for (const op of dirty.updated) {
      if (!state.knownComponents.has(componentKey(op.entityId, op.componentId))) {
        return false;
      }
    }
  }

  const bytes = encodeUpdateSnapshotOps(options, tick, { updated: dirty.updated });
  for (const peer of peers) {
    options.transport.send(peer, "unreliable", bytes);
  }
  return true;
}

function encodeUpdateSnapshotOps(
  options: SyncHostOptions,
  tick: number,
  ops: SnapshotWriteOps,
): Uint8Array {
  return options.snapshotEncoding === "batched"
    ? encodeSnapshotOpsBatched(options.world, tick, ops)
    : encodeSnapshotOps(options.world, tick, ops);
}

function encodedPacket(
  cache: Map<string, Uint8Array>,
  prefix: string,
  ops: SnapshotWriteOps,
  encode: () => Uint8Array,
): Uint8Array {
  // Per-peer visibility can produce identical structural/update op sets; reuse encoded bytes within a tick.
  const key = `${prefix}:${snapshotOpsKey(ops)}`;
  const existing = cache.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const bytes = encode();
  cache.set(key, bytes);
  return bytes;
}

function snapshotOpsKey(ops: SnapshotWriteOps): string {
  return [
    `c${(ops.created ?? []).join(",")}`,
    `a${componentOpsKey(ops.added)}`,
    `u${updateOpsKey(ops.updated)}`,
    `r${componentOpsKey(ops.removed)}`,
    `d${(ops.destroyed ?? []).join(",")}`,
  ].join("|");
}

function componentOpsKey(
  ops: readonly { readonly entityId: number; readonly componentId: number }[] | undefined,
): string {
  return (ops ?? []).map((op) => `${op.entityId}:${op.componentId}`).join(",");
}

function updateOpsKey(
  ops:
    | readonly {
        readonly entityId: number;
        readonly componentId: number;
        readonly fieldMask: number;
      }[]
    | undefined,
): string {
  return (ops ?? [])
    .map((op) => `${op.entityId}:${op.componentId}:${op.fieldMask}`)
    .join(",");
}

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const handlers = new HandlerTable();

  options.transport.onPacket((packetChannel, bytes) => {
    try {
      const messageType = peekMessageType(bytes);
      if (messageType === MessageType.Snapshot) {
        const tick = applySnapshot(options.world, bytes, options.registry);
        options.onSnapshot?.(Object.freeze({ tick, channel: packetChannel }));
        return;
      }

      if (messageType === MessageType.Rpc) {
        const decoded = decodeRpc(bytes, options.registry);
        handlers.dispatch(
          decoded.rpc,
          decoded.payload,
          {
            tick: decoded.tick,
            channel: packetChannel,
            rpc: decoded.rpc,
          },
          options.logger,
        );
        return;
      }
    } catch (error) {
      logError(options.logger, "Failed to handle client packet", error);
    }
  });

  function requestFullSnapshot(): void {
    options.transport.send(
      "reliable",
      encodeControl(ControlType.FullSnapshotRequest, options.clock.tick()),
    );
  }

  return {
    start() {
      options.transport.send("reliable", encodeControl(ControlType.Hello, options.clock.tick()));
    },
    requestFullSnapshot,
    send(rpc, payload) {
      options.transport.send(rpc.channel, encodeRpc(rpc, payload, options.clock.tick()));
    },
    on(rpc, handler) {
      return handlers.add(rpc, handler);
    },
  };
}

function logError(logger: Logger | undefined, message: string, error: unknown): void {
  logger?.error?.(message, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function currentPeers(transport: HostTransport, seen: Set<PeerRef>): readonly PeerRef[] {
  return [...new Set([...(transport.peers?.() ?? []), ...seen])];
}

function stateFor(map: Map<PeerRef, PeerState>, peer: PeerRef): PeerState {
  const existing = map.get(peer);
  if (existing !== undefined) {
    return existing;
  }
  const state = {
    knownEntities: new Set<number>(),
    knownComponents: new Set<string>(),
  };
  map.set(peer, state);
  return state;
}

function componentKey(entityId: number, componentId: number): string {
  return `${entityId}:${componentId}`;
}

function componentOpFromKey(key: string): { entityId: number; componentId: number } {
  const [entityId, componentId] = key.split(":").map(Number);
  return { entityId: entityId!, componentId: componentId! };
}

function isVisible(
  peer: PeerRef,
  entityId: number,
  visibility: SyncHostOptions["isVisible"],
): boolean {
  return visibility?.(peer, entityId) ?? true;
}

function buildFullOpsForPeer(
  world: HostWorld,
  peer: PeerRef,
  visibility: SyncHostOptions["isVisible"],
  state?: PeerState,
): SnapshotWriteOps {
  // Full snapshots also reconcile stale peer state, so disappearing visibility becomes removals/destroys.
  const internals = worldInternals(world);
  const created = internals.getEntityIds().filter((entityId) => isVisible(peer, entityId, visibility));
  const added = internals
    .getRecords()
    .filter((record) => isVisible(peer, record.entityId, visibility))
    .map((record) => ({ entityId: record.entityId, componentId: record.schema.schemaId }));
  if (state === undefined) {
    return { created, added };
  }

  const currentEntities = new Set(created);
  const currentComponents = new Set(added.map((op) => componentKey(op.entityId, op.componentId)));
  const destroyed = [...state.knownEntities]
    .filter((entityId) => !currentEntities.has(entityId))
    .sort((a, b) => a - b);
  const destroyedEntities = new Set(destroyed);
  const removed = [...state.knownComponents]
    .filter((key) => !currentComponents.has(key))
    .map(componentOpFromKey)
    .filter((op) => !destroyedEntities.has(op.entityId))
    .sort(compareComponentOp);

  return {
    created,
    added,
    removed,
    destroyed,
  };
}

function replaceKnownState(
  map: Map<PeerRef, PeerState>,
  peer: PeerRef,
  ops: SnapshotWriteOps,
): void {
  const state = stateFor(map, peer);
  state.knownEntities.clear();
  state.knownComponents.clear();
  applyKnownOps(state, ops);
}

function buildStructuralOpsForPeer(
  world: HostWorld,
  dirty: DirtyOps,
  peer: PeerRef,
  state: PeerState,
  visibility: SyncHostOptions["isVisible"],
): SnapshotWriteOps {
  const internals = worldInternals(world);
  const created = new Set<number>();
  const added = new Map<string, { entityId: number; componentId: number }>();
  const removed = new Map<string, { entityId: number; componentId: number }>();
  const destroyed = new Set<number>();

  for (const entityId of state.knownEntities) {
    if (!isVisible(peer, entityId, visibility) || dirty.destroyed.includes(entityId)) {
      destroyed.add(entityId);
    }
  }

  for (const op of dirty.removed) {
    if (state.knownComponents.has(componentKey(op.entityId, op.componentId))) {
      removed.set(componentKey(op.entityId, op.componentId), op);
    }
  }

  for (const entityId of internals.getEntityIds()) {
    if (!isVisible(peer, entityId, visibility) || dirty.destroyed.includes(entityId)) {
      continue;
    }
    if (!state.knownEntities.has(entityId)) {
      created.add(entityId);
    }
  }

  for (const record of internals.getRecords()) {
    if (!isVisible(peer, record.entityId, visibility) || dirty.destroyed.includes(record.entityId)) {
      continue;
    }
    const key = componentKey(record.entityId, record.schema.schemaId);
    if (!state.knownComponents.has(key)) {
      added.set(key, { entityId: record.entityId, componentId: record.schema.schemaId });
    }
  }

  return {
    created: [...created].sort((a, b) => a - b),
    added: [...added.values()].sort(compareComponentOp),
    removed: [...removed.values()].sort(compareComponentOp),
    destroyed: [...destroyed].sort((a, b) => a - b),
  };
}

function buildUpdateOpsForPeer(
  dirty: DirtyOps,
  peer: PeerRef,
  state: PeerState,
  visibility: SyncHostOptions["isVisible"],
): SnapshotWriteOps {
  return {
    updated: dirty.updated.filter(
      (op) =>
        isVisible(peer, op.entityId, visibility) &&
        state.knownComponents.has(componentKey(op.entityId, op.componentId)),
    ),
  };
}

function applyKnownOps(state: PeerState, ops: SnapshotWriteOps): void {
  for (const entityId of ops.destroyed ?? []) {
    state.knownEntities.delete(entityId);
    for (const key of [...state.knownComponents]) {
      if (key.startsWith(`${entityId}:`)) {
        state.knownComponents.delete(key);
      }
    }
  }
  for (const entityId of ops.created ?? []) {
    state.knownEntities.add(entityId);
  }
  for (const op of ops.removed ?? []) {
    state.knownComponents.delete(componentKey(op.entityId, op.componentId));
  }
  for (const op of ops.added ?? []) {
    state.knownEntities.add(op.entityId);
    state.knownComponents.add(componentKey(op.entityId, op.componentId));
  }
}

function compareComponentOp(
  a: { readonly entityId: number; readonly componentId: number },
  b: { readonly entityId: number; readonly componentId: number },
): number {
  return a.entityId - b.entityId || a.componentId - b.componentId;
}
