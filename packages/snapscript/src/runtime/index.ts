import { ServerPeerId, defaultLogger, type ClientTransport, type Clock, type ServerTransport, type Logger, type PeerId, type PeerRef } from "../platform/index";
import type { RegistryLike } from "../registry/index";
import { decodeRpc, encodeRpc } from "../rpc/index";
import type {
  CommandHandler,
  CommandValidator,
  EventHandler,
  EventValidator,
  RpcCtx,
  RpcDefinition,
  RpcHandler,
  RpcValidationFailure,
} from "../rpc/index";
import type { FieldDefinitions, FieldValues } from "../schema/index";
import {
  applySnapshot,
  ControlCapability,
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
import { WorldEntity, type ClientWorld, type ServerWorld, type SnapshotContext } from "../world/index";
import type { DirtyOps } from "../world/dirty-graph";
import { worldInternals } from "../world/internals";

export interface SyncServerOptions {
  readonly world: ServerWorld;
  readonly transport: ServerTransport;
  readonly clock: Clock;
  readonly registry: RegistryLike;
  readonly protocolHash?: string;
  readonly logger?: Logger;
  readonly sendRate?: number;
  readonly snapshotEncoding?: "default" | "batched";
  readonly isVisible?: (peerId: PeerId, entityId: number) => boolean;
  readonly canReusePeerSnapshots?: () => boolean;
  readonly ensurePeerEntity?: (peerId: PeerId) => number;
  readonly markPeerDisconnected?: (peerId: PeerId) => void;
}

export interface SyncClientOptions {
  readonly world: ClientWorld;
  readonly transport: ClientTransport;
  readonly clock: Clock;
  readonly registry: RegistryLike;
  readonly protocolHash?: string;
  readonly logger?: Logger;
  readonly sendRate?: number;
  readonly onSnapshot?: (context: SnapshotContext) => void;
  readonly assignPeerEntity?: (peerId: PeerId, peerEntityId: number) => void;
}

export type SyncRuntimeOptions = SyncClientOptions;

export interface SyncServer {
  start(): void;
  update(): void;
  sendFullSnapshot(peer?: PeerRef): void;
  sendTo<TFields extends FieldDefinitions>(
    peerId: PeerId,
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  sendEventTo<TFields extends FieldDefinitions>(
    targets: PeerEventTarget | readonly PeerEventTarget[],
    sourceId: number,
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  sendPeerEventTo<TFields extends FieldDefinitions>(
    targets: PeerEventTarget | readonly PeerEventTarget[],
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  broadcastPeerEvent<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  broadcast<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  broadcastEvent<TFields extends FieldDefinitions>(
    sourceId: number,
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  on<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: RpcHandler<TFields>,
  ): () => void;
  onCommand<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: CommandHandler<TFields>,
    validator?: CommandValidator<TFields>,
  ): () => void;
}

export interface PeerEventTarget {
  readonly peerId: PeerId;
  readonly peerEntityId: number;
}

export interface SyncClient {
  start(): void;
  requestFullSnapshot(): void;
  peerId(): PeerId;
  send<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  sendCommand<TFields extends FieldDefinitions>(
    targetId: number,
    rpc: RpcDefinition<TFields>,
    payload?: Partial<FieldValues<TFields>>,
  ): void;
  on<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: RpcHandler<TFields>,
  ): () => void;
  onEvent<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: EventHandler<TFields>,
    validator?: EventValidator<TFields>,
  ): () => void;
}

interface PeerState {
  readonly knownEntities: Set<number>;
  readonly knownComponents: Set<string>;
  capabilities: number;
}

class PeerIds {
  readonly #byRef = new Map<PeerRef, PeerId>();
  readonly #byId = new Map<PeerId, PeerRef>();
  #next = 1;

  idFor(peer: PeerRef): PeerId {
    const existing = this.#byRef.get(peer);
    if (existing !== undefined) {
      return existing;
    }
    const peerId = this.#next;
    this.#next += 1;
    this.#byRef.set(peer, peerId);
    this.#byId.set(peerId, peer);
    return peerId;
  }

  refFor(peerId: PeerId): PeerRef | undefined {
    return this.#byId.get(peerId);
  }
}

type HandlerEntry = {
  readonly rpc: RpcDefinition;
  readonly handler: RpcHandler<FieldDefinitions>;
  readonly validator?: (context: RpcCtx<FieldValues<FieldDefinitions>>) => RpcValidationFailure | undefined;
};

class HandlerTable {
  readonly #handlers = new Map<number, HandlerEntry[]>();

  add<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: RpcHandler<TFields>,
    validator?: (context: RpcCtx<FieldValues<TFields>>) => RpcValidationFailure | undefined,
  ): () => void {
    if (typeof handler !== "function") {
      throw new Error(`RPC "${rpc.name}" handler must be a function`);
    }
    const entry: HandlerEntry = {
      rpc,
      handler: handler as RpcHandler<FieldDefinitions>,
      ...(validator === undefined
        ? {}
        : {
            validator: validator as (context: RpcCtx<FieldValues<FieldDefinitions>>) => RpcValidationFailure | undefined,
          }),
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

  addCommand<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: CommandHandler<TFields>,
    validator?: CommandValidator<TFields>,
  ): () => void {
    return this.add(rpc, handler as unknown as RpcHandler<TFields>, validator as unknown as (context: RpcCtx<FieldValues<TFields>>) => RpcValidationFailure | undefined);
  }

  addEvent<TFields extends FieldDefinitions>(
    rpc: RpcDefinition<TFields>,
    handler: EventHandler<TFields>,
    validator?: EventValidator<TFields>,
  ): () => void {
    return this.add(rpc, handler as unknown as RpcHandler<TFields>, validator as unknown as (context: RpcCtx<FieldValues<TFields>>) => RpcValidationFailure | undefined);
  }

  dispatch(
    rpc: RpcDefinition,
    payload: FieldValues<FieldDefinitions>,
    context: Omit<RpcCtx<FieldValues<FieldDefinitions>>, "payload"> & {
      readonly source?: { readonly id: number };
      readonly target?: { readonly id: number };
    },
    logger: Logger | undefined,
  ): void {
    const frozenContext = Object.freeze({
      ...context,
      payload: Object.freeze(payload) as Readonly<FieldValues<FieldDefinitions>>,
    });
    // Handlers run from a stable snapshot so registration changes during dispatch affect later packets only.
    for (const entry of [...(this.#handlers.get(rpc.rpcId) ?? [])]) {
      try {
        const failure = entry.validator?.(frozenContext);
        if (failure !== undefined) {
          logger?.warn?.("RPC packet dropped", {
            rpc: entry.rpc.name,
            reason: failure.reason,
            ...(failure.details === undefined ? {} : failure.details),
          });
          continue;
        }
        entry.handler(frozenContext);
      } catch (error) {
        logger?.error?.("RPC handler failed", {
          error: error instanceof Error ? error.message : String(error),
          rpc: entry.rpc.name,
        });
      }
    }
  }
}

export function createSyncServer(options: SyncServerOptions): SyncServer {
  const logger = options.logger ?? defaultLogger;
  const handlers = new HandlerTable();
  const peers = new Set<PeerRef>();
  const peerIds = new PeerIds();
  const peerStates = new Map<PeerRef, PeerState>();

  options.transport.onPacket((peer, packetChannel, bytes) => {
    peers.add(peer);
    const peerId = peerIds.idFor(peer);
    const peerEntityId = options.ensurePeerEntity?.(peerId) ?? peerId;
    try {
      const messageType = peekMessageType(bytes);
      if (messageType === MessageType.Control) {
        const control = decodeControl(bytes);
        assertProtocolHashMatch("server", options.protocolHash, control.protocolHash);
        stateFor(peerStates, peer).capabilities = control.capabilities;
        if (
          control.type === ControlType.Hello ||
          control.type === ControlType.FullSnapshotRequest
        ) {
          options.transport.send(
            peer,
            "reliable",
            encodeControl(ControlType.PeerAssigned, options.clock.tick(), 0, peerId, options.protocolHash, peerEntityId),
          );
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
            source: { id: peerEntityId },
            target: { id: decoded.targetId },
          },
          logger,
        );
        return;
      }
    } catch (error) {
      logError(logger, "Failed to handle server packet", error);
    }
  });

  function sendFullSnapshot(peer?: PeerRef): void {
    if (peer !== undefined) {
      const peerId = peerIds.idFor(peer);
      options.ensurePeerEntity?.(peerId);
      const state = stateFor(peerStates, peer);
      const ops = buildFullOpsForPeer(options.world, peerId, options.isVisible, state);
      const bytes = encodeSnapshotOps(options.world, options.clock.tick(), ops);
      options.transport.send(peer, "reliable", bytes);
      replaceKnownState(peerStates, peer, ops);
      worldInternals(options.world).clearWrittenDirty(dirtyOpsFromSnapshotOps(ops));
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
      markDisconnectedPeers(options, peerIds, peers, [...peers]);
      if (trySendSharedUpdate(options, peerStates, peerList, dirty, tick)) {
        internals.clearWrittenDirty(dirty);
        return;
      }
      const encodedStructural = new Map<string, Uint8Array>();
      const encodedUpdates = new Map<string, Uint8Array>();
      for (const peer of peerList) {
        const peerId = peerIds.idFor(peer);
        const state = stateFor(peerStates, peer);
        const structural = buildStructuralOpsForPeer(options.world, dirty, peerId, state, options.isVisible);
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

        const updates = buildUpdateOpsForPeer(dirty, peerId, state, options.isVisible);
        if (hasSnapshotOps(updates)) {
          options.transport.send(
            peer,
            "unreliable",
            encodedPacket(encodedUpdates, updateEncodingKey(options, state), updates, () =>
              encodeUpdateSnapshotOps(options, state, tick, updates),
            ),
          );
        }
      }
      internals.clearWrittenDirty(dirty);
    },
    sendFullSnapshot,
    sendTo(peerId, rpc, payload) {
      const peer = peerIds.refFor(peerId);
      if (peer === undefined) {
        throw new Error(`ServerWorld.sendTo() unknown peer ${peerId}`);
      }
      options.transport.send(peer, rpc.channel, encodeRpc(rpc, payload, options.clock.tick(), ServerPeerId, peerId));
    },
    sendEventTo(targets, sourceId, rpc, payload) {
      for (const target of Array.isArray(targets) ? targets : [targets]) {
        const peer = peerIds.refFor(target.peerId);
        if (peer === undefined) {
          throw new Error(`ServerWorld.sendEventTo() unknown peer entity ${target.peerEntityId}`);
        }
        options.transport.send(peer, rpc.channel, encodeRpc(rpc, payload, options.clock.tick(), sourceId, target.peerEntityId));
      }
    },
    sendPeerEventTo(targets, rpc, payload) {
      for (const target of Array.isArray(targets) ? targets : [targets]) {
        const peer = peerIds.refFor(target.peerId);
        if (peer === undefined) {
          throw new Error(`ServerWorld.sendPeerEventTo() unknown peer entity ${target.peerEntityId}`);
        }
        options.transport.send(peer, rpc.channel, encodeRpc(rpc, payload, options.clock.tick(), target.peerEntityId, target.peerEntityId));
      }
    },
    broadcastPeerEvent(rpc, payload) {
      const tick = options.clock.tick();
      for (const peer of currentPeers(options.transport, peers)) {
        const peerId = peerIds.idFor(peer);
        const peerEntityId = options.ensurePeerEntity?.(peerId) ?? peerId;
        if (!isVisible(peerId, peerEntityId, options.isVisible)) {
          continue;
        }
        options.transport.send(peer, rpc.channel, encodeRpc(rpc, payload, tick, peerEntityId, peerEntityId));
      }
    },
    broadcast(rpc, payload) {
      options.transport.broadcast(rpc.channel, encodeRpc(rpc, payload, options.clock.tick(), ServerPeerId, 0));
    },
    broadcastEvent(sourceId, rpc, payload) {
      const tick = options.clock.tick();
      for (const peer of currentPeers(options.transport, peers)) {
        const peerId = peerIds.idFor(peer);
        if (sourceId !== WorldEntity.id && !isVisible(peerId, sourceId, options.isVisible)) {
          continue;
        }
        const peerEntityId = options.ensurePeerEntity?.(peerId) ?? peerId;
        options.transport.send(peer, rpc.channel, encodeRpc(rpc, payload, tick, sourceId, peerEntityId));
      }
    },
    on(rpc, handler) {
      return handlers.add(rpc, handler);
    },
    onCommand(rpc, handler, validator) {
      return handlers.addCommand(rpc, handler, validator);
    },
  };
}

function trySendSharedUpdate(
  options: SyncServerOptions,
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
    dirty.network.length !== 0 ||
    dirty.created.length !== 0 ||
    dirty.added.length !== 0 ||
    dirty.removed.length !== 0 ||
    dirty.destroyed.length !== 0
  ) {
    return false;
  }

  for (const peer of peers) {
    const state = stateFor(peerStates, peer);
    if (options.snapshotEncoding === "batched" && !supportsBatchedSnapshots(state)) {
      return false;
    }
    for (const op of dirty.updated) {
      if (!state.knownComponents.has(componentKey(op.entityId, op.componentId))) {
        return false;
      }
    }
  }

  const bytes = encodeUpdateSnapshotOps(options, stateFor(peerStates, peers[0]!), tick, {
    updated: dirty.updated,
  });
  for (const peer of peers) {
    options.transport.send(peer, "unreliable", bytes);
  }
  return true;
}

function encodeUpdateSnapshotOps(
  options: SyncServerOptions,
  state: PeerState,
  tick: number,
  ops: SnapshotWriteOps,
): Uint8Array {
  return options.snapshotEncoding === "batched" && supportsBatchedSnapshots(state)
    ? encodeSnapshotOpsBatched(options.world, tick, ops)
    : encodeSnapshotOps(options.world, tick, ops);
}

function updateEncodingKey(options: SyncServerOptions, state: PeerState): string {
  return options.snapshotEncoding === "batched" && supportsBatchedSnapshots(state) ? "ub" : "u";
}

function supportsBatchedSnapshots(state: PeerState): boolean {
  return (state.capabilities & ControlCapability.BatchedSnapshots) !== 0;
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
    `n${networkOpsKey(ops.network)}`,
    `a${componentOpsKey(ops.added)}`,
    `u${updateOpsKey(ops.updated)}`,
    `r${componentOpsKey(ops.removed)}`,
    `d${(ops.destroyed ?? []).join(",")}`,
  ].join("|");
}

function networkOpsKey(
  ops: readonly { readonly entityId: number; readonly owner?: number }[] | undefined,
): string {
  return (ops ?? []).map((op) => `${op.entityId}:${op.owner ?? ""}`).join(",");
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
  const logger = options.logger ?? defaultLogger;
  const handlers = new HandlerTable();
  let assignedPeerId: PeerId = ServerPeerId;
  let assignedPeerEntityId = ServerPeerId;

  options.transport.onPacket((packetChannel, bytes) => {
    try {
      const messageType = peekMessageType(bytes);
      if (messageType === MessageType.Control) {
        const control = decodeControl(bytes);
        assertProtocolHashMatch("client", options.protocolHash, control.protocolHash);
        if (control.type === ControlType.PeerAssigned) {
          assignedPeerId = control.peerId ?? ServerPeerId;
          assignedPeerEntityId = control.peerEntityId ?? assignedPeerId;
          options.assignPeerEntity?.(assignedPeerId, assignedPeerEntityId);
        }
        return;
      }
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
            source: { id: decoded.sourceId },
            target: { id: decoded.targetId === 0 ? assignedPeerEntityId : decoded.targetId },
          },
          logger,
        );
        return;
      }
    } catch (error) {
      logError(logger, "Failed to handle client packet", error);
    }
  });

  function requestFullSnapshot(): void {
    options.transport.send(
      "reliable",
      encodeControl(ControlType.FullSnapshotRequest, options.clock.tick(), clientCapabilities(), undefined, options.protocolHash),
    );
  }

  return {
    start() {
      options.transport.send(
        "reliable",
        encodeControl(ControlType.Hello, options.clock.tick(), clientCapabilities(), undefined, options.protocolHash),
      );
    },
    peerId() {
      return assignedPeerId;
    },
    requestFullSnapshot,
    send(rpc, payload) {
      options.transport.send(rpc.channel, encodeRpc(rpc, payload, options.clock.tick(), assignedPeerEntityId, 0));
    },
    sendCommand(targetId, rpc, payload) {
      options.transport.send(rpc.channel, encodeRpc(rpc, payload, options.clock.tick(), assignedPeerEntityId, targetId));
    },
    on(rpc, handler) {
      return handlers.add(rpc, handler);
    },
    onEvent(rpc, handler, validator) {
      return handlers.addEvent(rpc, handler, validator);
    },
  };
}

function clientCapabilities(): number {
  return ControlCapability.BatchedSnapshots;
}

function assertProtocolHashMatch(
  side: "server" | "client",
  expected: string | undefined,
  received: string | undefined,
): void {
  if (expected === undefined || received === undefined) {
    return;
  }

  if (expected !== received) {
    throw new Error(`SnapScript protocol hash mismatch on ${side}: expected ${expected}, received ${received}`);
  }
}

function logError(logger: Logger | undefined, message: string, error: unknown): void {
  logger?.error?.(message, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function currentPeers(transport: ServerTransport, seen: Set<PeerRef>): readonly PeerRef[] {
  const active = transport.peers?.();
  return active === undefined ? [...seen] : [...new Set([...active, ...seen])];
}

function markDisconnectedPeers(
  options: SyncServerOptions,
  peerIds: PeerIds,
  seen: Set<PeerRef>,
  activeOrSeen: readonly PeerRef[],
): void {
  if (options.transport.peers === undefined || options.markPeerDisconnected === undefined) {
    return;
  }
  const active = new Set(options.transport.peers());
  for (const peer of activeOrSeen) {
    if (!seen.has(peer) || active.has(peer)) {
      continue;
    }
    options.markPeerDisconnected(peerIds.idFor(peer));
  }
}

function stateFor(map: Map<PeerRef, PeerState>, peer: PeerRef): PeerState {
  const existing = map.get(peer);
  if (existing !== undefined) {
    return existing;
  }
  const state = {
    knownEntities: new Set<number>(),
    knownComponents: new Set<string>(),
    capabilities: 0,
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
  peerId: PeerId,
  entityId: number,
  visibility: SyncServerOptions["isVisible"],
): boolean {
  if (entityId === WorldEntity.id) {
    return true;
  }
  return visibility?.(peerId, entityId) ?? true;
}

function buildFullOpsForPeer(
  world: ServerWorld,
  peerId: PeerId,
  visibility: SyncServerOptions["isVisible"],
  state?: PeerState,
): SnapshotWriteOps {
  // Full snapshots also reconcile stale peer state, so disappearing visibility becomes removals/destroys.
  const internals = worldInternals(world);
  const created = internals.getEntityIds().filter((entityId) => isVisible(peerId, entityId, visibility));
  const visibleCreated = new Set(created);
  const network = internals.getNetworkOwners().filter((op) => visibleCreated.has(op.entityId));
  const added = internals
    .getRecords()
    .filter((record) => isVisible(peerId, record.entityId, visibility))
    .map((record) => ({ entityId: record.entityId, componentId: record.schema.schemaId }));
  if (state === undefined) {
    return { created, network, added };
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
    network,
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
  world: ServerWorld,
  dirty: DirtyOps,
  peerId: PeerId,
  state: PeerState,
  visibility: SyncServerOptions["isVisible"],
): SnapshotWriteOps {
  const internals = worldInternals(world);
  const created = new Set<number>();
  const added = new Map<string, { entityId: number; componentId: number }>();
  const removed = new Map<string, { entityId: number; componentId: number }>();
  const destroyed = new Set<number>();

  for (const entityId of state.knownEntities) {
    if (!isVisible(peerId, entityId, visibility) || dirty.destroyed.includes(entityId)) {
      destroyed.add(entityId);
    }
  }

  for (const op of dirty.removed) {
    if (state.knownComponents.has(componentKey(op.entityId, op.componentId))) {
      removed.set(componentKey(op.entityId, op.componentId), op);
    }
  }

  for (const entityId of internals.getEntityIds()) {
    if (!isVisible(peerId, entityId, visibility) || dirty.destroyed.includes(entityId)) {
      continue;
    }
    if (!state.knownEntities.has(entityId)) {
      created.add(entityId);
    }
  }

  for (const record of internals.getRecords()) {
    if (!isVisible(peerId, record.entityId, visibility) || dirty.destroyed.includes(record.entityId)) {
      continue;
    }
    const key = componentKey(record.entityId, record.schema.schemaId);
    if (!state.knownComponents.has(key)) {
      added.set(key, { entityId: record.entityId, componentId: record.schema.schemaId });
    }
  }

  const networkByEntity = new Map<number, { entityId: number; owner: number }>();
  for (const entityId of created) {
    const owner = internals.getOwner(entityId);
    if (owner !== ServerPeerId) {
      networkByEntity.set(entityId, { entityId, owner });
    }
  }
  for (const op of dirty.network) {
    if (state.knownEntities.has(op.entityId) && isVisible(peerId, op.entityId, visibility)) {
      networkByEntity.set(op.entityId, { entityId: op.entityId, owner: internals.getOwner(op.entityId) });
    }
  }
  const network = [...networkByEntity.values()].sort((a, b) => a.entityId - b.entityId);

  return {
    created: [...created].sort((a, b) => a - b),
    network,
    added: [...added.values()].sort(compareComponentOp),
    removed: [...removed.values()].sort(compareComponentOp),
    destroyed: [...destroyed].sort((a, b) => a - b),
  };
}

function buildUpdateOpsForPeer(
  dirty: DirtyOps,
  peerId: PeerId,
  state: PeerState,
  visibility: SyncServerOptions["isVisible"],
): SnapshotWriteOps {
  return {
    updated: dirty.updated.filter(
      (op) =>
        isVisible(peerId, op.entityId, visibility) &&
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

function dirtyOpsFromSnapshotOps(ops: SnapshotWriteOps): DirtyOps {
  return {
    created: ops.created ?? [],
    network: ops.network ?? [],
    added: ops.added ?? [],
    updated: ops.updated ?? [],
    removed: ops.removed ?? [],
    destroyed: ops.destroyed ?? [],
  };
}
