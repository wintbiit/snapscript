import { BitReader, BitWriter } from "../binary/index";
import type { RegistryLike } from "../registry/index";
import { codecForSchema } from "../schema/schema";
import type { ClientWorld, ServerWorld } from "../world/index";
import { worldInternals } from "../world/internals";
import type { DirtyOps } from "../world/dirty-graph";
import { MessageType } from "./message";

type SnapshotWorld = ServerWorld | ClientWorld;
const MAX_POOLED_WRITERS = 16;
const MAX_LINEAR_BATCH_GROUPS = 16;
const writerPool: BitWriter[] = [];

export enum SnapshotOp {
  CreateEntity = 1,
  AddComponent = 2,
  UpdateComponent = 3,
  RemoveComponent = 4,
  DestroyEntity = 5,
  BatchUpdateComponent = 6,
  SetNetwork = 7,
}

export interface SnapshotWriteOps {
  readonly created?: readonly number[];
  readonly network?: readonly { readonly entityId: number; readonly owner?: number }[];
  readonly added?: readonly { readonly entityId: number; readonly componentId: number }[];
  readonly updated?: readonly {
    readonly entityId: number;
    readonly componentId: number;
    readonly fieldMask: number;
  }[];
  readonly removed?: readonly { readonly entityId: number; readonly componentId: number }[];
  readonly destroyed?: readonly number[];
}

type SnapshotUpdateOp = {
  readonly entityId: number;
  readonly componentId: number;
  readonly fieldMask: number;
};

export function encodeFullSnapshot(world: SnapshotWorld, tick: number): Uint8Array {
  const internals = worldInternals(world);
  return encodeSnapshotOps(world, tick, {
    created: internals.getReplicatedEntityIds(),
    network: internals.getNetworkOwners(),
    added: internals.getReplicatedRecords().map((record) => ({
      entityId: record.entityId,
      componentId: record.schema.schemaId,
    })),
  });
}

export function encodeDirty(world: SnapshotWorld, tick: number): Uint8Array {
  const internals = worldInternals(world);
  const dirty = internals.getDirtySnapshot();
  const bytes = encodeSnapshotOps(world, tick, snapshotWriteOps(internals, dirty));
  internals.clearWrittenDirty(dirty);
  return bytes;
}

export function encodeDirtyBatched(world: SnapshotWorld, tick: number): Uint8Array {
  const internals = worldInternals(world);
  const dirty = internals.getDirtySnapshot();
  const bytes = encodeSnapshotOpsBatched(world, tick, snapshotWriteOps(internals, dirty));
  internals.clearWrittenDirty(dirty);
  return bytes;
}

export function encodeSnapshotOps(world: SnapshotWorld, tick: number, ops: SnapshotWriteOps): Uint8Array {
  // Snapshot encoding is a hot path; reuse BitWriter instances while still returning immutable packet bytes.
  const writer = acquireWriter();
  try {
    writeSnapshotOps(writer, world, tick, ops);
    return writer.finish();
  } finally {
    releaseWriter(writer);
  }
}

export function encodeSnapshotOpsBatched(
  world: SnapshotWorld,
  tick: number,
  ops: SnapshotWriteOps,
): Uint8Array {
  // Candidate fast path for homogeneous dirty updates. The default encoder stays unchanged so
  // wire-format compatibility can be gated by runtime protocol capability later.
  const writer = acquireWriter();
  try {
    writeSnapshotOpsBatched(writer, world, tick, ops);
    return writer.finish();
  } finally {
    releaseWriter(writer);
  }
}

function writeSnapshotOps(
  writer: BitWriter,
  world: SnapshotWorld,
  tick: number,
  ops: SnapshotWriteOps,
): void {
  const internals = worldInternals(world);
  const created = ops.created ?? [];
  const network = ops.network ?? [];
  const added = ops.added ?? [];
  const updated = ops.updated ?? [];
  const removed = ops.removed ?? [];
  const destroyed = ops.destroyed ?? [];

  writeSnapshotHeader(
    writer,
    tick,
    created.length + network.length + added.length + updated.length + removed.length + destroyed.length,
  );

  writeCreateAndAddOps(writer, internals, created, added);
  writeNetworkOps(writer, internals, network);

  for (const { entityId, componentId, fieldMask } of updated) {
    writeUpdateOp(writer, internals, entityId, componentId, fieldMask);
  }

  writeRemoveAndDestroyOps(writer, removed, destroyed);
}

function writeSnapshotOpsBatched(
  writer: BitWriter,
  world: SnapshotWorld,
  tick: number,
  ops: SnapshotWriteOps,
): void {
  const internals = worldInternals(world);
  const created = ops.created ?? [];
  const network = ops.network ?? [];
  const added = ops.added ?? [];
  const updated = ops.updated ?? [];
  const removed = ops.removed ?? [];
  const destroyed = ops.destroyed ?? [];
  const grouped = groupBatchableUpdates(updated);
  const singleUpdates = grouped.singleUpdates;

  writeSnapshotHeader(
    writer,
    tick,
    created.length + network.length + added.length + removed.length + destroyed.length +
      singleUpdates.length +
      grouped.batchGroups.length,
  );

  writeCreateAndAddOps(writer, internals, created, added);
  writeNetworkOps(writer, internals, network);

  for (const { entityId, componentId, fieldMask } of singleUpdates) {
    writeUpdateOp(writer, internals, entityId, componentId, fieldMask);
  }

  for (const group of grouped.batchGroups) {
    writeBatchUpdateOp(writer, internals, group);
  }

  writeRemoveAndDestroyOps(writer, removed, destroyed);
}

function writeNetworkOps(
  writer: BitWriter,
  internals: ReturnType<typeof worldInternals>,
  network: readonly { readonly entityId: number; readonly owner?: number }[],
): void {
  for (const { entityId, owner } of network) {
    writer.writeVarUint(entityId);
    writer.writeVarUint(0);
    writer.writeU8(SnapshotOp.SetNetwork);
    writer.writeVarUint(owner ?? internals.getOwner(entityId));
  }
}

function writeSnapshotHeader(writer: BitWriter, tick: number, opCount: number): void {
  writer.writeU8(MessageType.Snapshot);
  writer.writeU32(tick);
  writer.writeVarUint(opCount);
}

function writeCreateAndAddOps(
  writer: BitWriter,
  internals: ReturnType<typeof worldInternals>,
  created: readonly number[],
  added: readonly { readonly entityId: number; readonly componentId: number }[],
): void {
  for (const entityId of created) {
    writer.writeVarUint(entityId);
    writer.writeVarUint(0);
    writer.writeU8(SnapshotOp.CreateEntity);
  }

  for (const { entityId, componentId } of added) {
    const record = internals.getRecord(entityId, componentId);
    if (record === undefined) {
      throw new Error(`Cannot encode add for missing component ${componentId} on entity ${entityId}`);
    }

    writer.writeVarUint(entityId);
    writer.writeVarUint(componentId);
    writer.writeU8(SnapshotOp.AddComponent);
    codecForSchema(record.schema).writeFull(writer, record.instance);
  }
}

function writeRemoveAndDestroyOps(
  writer: BitWriter,
  removed: readonly { readonly entityId: number; readonly componentId: number }[],
  destroyed: readonly number[],
): void {
  for (const { entityId, componentId } of removed) {
    writer.writeVarUint(entityId);
    writer.writeVarUint(componentId);
    writer.writeU8(SnapshotOp.RemoveComponent);
  }

  for (const entityId of destroyed) {
    writer.writeVarUint(entityId);
    writer.writeVarUint(0);
    writer.writeU8(SnapshotOp.DestroyEntity);
  }
}

function writeUpdateOp(
  writer: BitWriter,
  internals: ReturnType<typeof worldInternals>,
  entityId: number,
  componentId: number,
  fieldMask: number,
): void {
  const record = internals.getRecord(entityId, componentId);
  if (record === undefined || fieldMask === 0) {
    throw new Error(`Cannot encode update for missing component ${componentId} on entity ${entityId}`);
  }

  writer.writeVarUint(entityId);
  writer.writeVarUint(componentId);
  writer.writeU8(SnapshotOp.UpdateComponent);
  writer.writeVarUint(fieldMask);
  codecForSchema(record.schema).writeDelta(writer, record.instance, fieldMask);
}

interface BatchUpdateGroup {
  readonly componentId: number;
  readonly fieldMask: number;
  readonly updates: readonly SnapshotUpdateOp[];
}

interface BatchUpdateBuilder {
  readonly componentId: number;
  readonly fieldMask: number;
  readonly updates: SnapshotUpdateOp[];
}

function groupBatchableUpdates(updated: readonly SnapshotUpdateOp[]): {
  readonly singleUpdates: readonly SnapshotUpdateOp[];
  readonly batchGroups: readonly BatchUpdateGroup[];
} {
  if (updated.length < 2) {
    return { singleUpdates: updated, batchGroups: [] };
  }

  if (updatesAreHomogeneous(updated)) {
    const first = updated[0]!;
    return {
      singleUpdates: [],
      batchGroups: [
        {
          componentId: first.componentId,
          fieldMask: first.fieldMask,
          updates: updated,
        },
      ],
    };
  }

  // Most frames touch only a few component/mask groups; avoid Map setup until grouping is wide.
  const groups: BatchUpdateBuilder[] = [];
  let groupsByComponent: Map<number, Map<number, BatchUpdateBuilder>> | undefined;
  for (const update of updated) {
    let group =
      groupsByComponent === undefined
        ? findBatchGroup(groups, update)
        : getIndexedBatchGroup(groupsByComponent, update);
    if (group === undefined) {
      group = {
        componentId: update.componentId,
        fieldMask: update.fieldMask,
        updates: [],
      };
      groups.push(group);
      if (groupsByComponent !== undefined) {
        indexBatchGroup(groupsByComponent, group);
      } else if (groups.length > MAX_LINEAR_BATCH_GROUPS) {
        groupsByComponent = indexBatchGroups(groups);
      }
    }
    group.updates.push(update);
  }

  const singleUpdates: SnapshotUpdateOp[] = [];
  const batchGroups: BatchUpdateGroup[] = [];
  for (const group of groups) {
    if (group.updates.length < 2) {
      singleUpdates.push(group.updates[0]!);
      continue;
    }
    batchGroups.push(group);
  }

  return { singleUpdates, batchGroups };
}

function updatesAreHomogeneous(updated: readonly SnapshotUpdateOp[]): boolean {
  const first = updated[0]!;
  for (let index = 1; index < updated.length; index += 1) {
    const update = updated[index]!;
    if (update.componentId !== first.componentId || update.fieldMask !== first.fieldMask) {
      return false;
    }
  }
  return true;
}

function findBatchGroup(
  groups: readonly BatchUpdateBuilder[],
  update: SnapshotUpdateOp,
): BatchUpdateBuilder | undefined {
  for (const group of groups) {
    if (group.componentId === update.componentId && group.fieldMask === update.fieldMask) {
      return group;
    }
  }
  return undefined;
}

function indexBatchGroups(
  groups: readonly BatchUpdateBuilder[],
): Map<number, Map<number, BatchUpdateBuilder>> {
  const groupsByComponent = new Map<number, Map<number, BatchUpdateBuilder>>();
  for (const group of groups) {
    indexBatchGroup(groupsByComponent, group);
  }
  return groupsByComponent;
}

function indexBatchGroup(
  groupsByComponent: Map<number, Map<number, BatchUpdateBuilder>>,
  group: BatchUpdateBuilder,
): void {
  let groupsByMask = groupsByComponent.get(group.componentId);
  if (groupsByMask === undefined) {
    groupsByMask = new Map<number, BatchUpdateBuilder>();
    groupsByComponent.set(group.componentId, groupsByMask);
  }
  groupsByMask.set(group.fieldMask, group);
}

function getIndexedBatchGroup(
  groupsByComponent: Map<number, Map<number, BatchUpdateBuilder>>,
  update: SnapshotUpdateOp,
): BatchUpdateBuilder | undefined {
  return groupsByComponent.get(update.componentId)?.get(update.fieldMask);
}

function writeBatchUpdateOp(
  writer: BitWriter,
  internals: ReturnType<typeof worldInternals>,
  group: BatchUpdateGroup,
): void {
  if (group.fieldMask === 0) {
    throw new Error(`Cannot encode batch update for component ${group.componentId} with empty field mask`);
  }

  writer.writeVarUint(0);
  writer.writeVarUint(group.componentId);
  writer.writeU8(SnapshotOp.BatchUpdateComponent);
  writer.writeVarUint(group.fieldMask);
  writer.writeVarUint(group.updates.length);

  const firstUpdate = group.updates[0]!;
  const firstRecord = internals.getRecord(firstUpdate.entityId, group.componentId);
  if (firstRecord === undefined) {
    throw new Error(
      `Cannot encode update for missing component ${group.componentId} on entity ${firstUpdate.entityId}`,
    );
  }
  const codec = codecForSchema(firstRecord.schema);
  writer.writeVarUint(firstUpdate.entityId);
  codec.writeDelta(writer, firstRecord.instance, group.fieldMask);

  for (let index = 1; index < group.updates.length; index += 1) {
    const { entityId } = group.updates[index]!;
    const record = internals.getRecord(entityId, group.componentId);
    if (record === undefined) {
      throw new Error(`Cannot encode update for missing component ${group.componentId} on entity ${entityId}`);
    }
    writer.writeVarUint(entityId);
    codec.writeDelta(writer, record.instance, group.fieldMask);
  }
}

function acquireWriter(): BitWriter {
  return writerPool.pop() ?? new BitWriter();
}

function releaseWriter(writer: BitWriter): void {
  writer.reset();
  if (writerPool.length < MAX_POOLED_WRITERS) {
    writerPool.push(writer);
  }
}

export function splitDirtyOps(dirty: DirtyOps): {
  readonly structural: SnapshotWriteOps;
  readonly updates: SnapshotWriteOps;
} {
  return {
    structural: {
      created: dirty.created,
      network: dirty.network,
      added: dirty.added,
      removed: dirty.removed,
      destroyed: dirty.destroyed,
    },
    updates: {
      updated: dirty.updated,
    },
  };
}

export function hasSnapshotOps(ops: SnapshotWriteOps): boolean {
  return (
    (ops.created?.length ?? 0) +
      (ops.network?.length ?? 0) +
      (ops.added?.length ?? 0) +
      (ops.updated?.length ?? 0) +
      (ops.removed?.length ?? 0) +
      (ops.destroyed?.length ?? 0) >
    0
  );
}

function snapshotWriteOps(
  internals: ReturnType<typeof worldInternals>,
  ops: SnapshotWriteOps,
): SnapshotWriteOps {
  const created = ops.created?.filter((entityId) => internals.isEntityReplicated(entityId));
  const network = ops.network?.filter((op) => internals.isEntityReplicated(op.entityId));
  const added = ops.added?.filter(
    (op) => internals.isEntityReplicated(op.entityId) && internals.isComponentReplicated(op.componentId),
  );
  const updated = ops.updated?.filter(
    (op) => internals.isEntityReplicated(op.entityId) && internals.isComponentReplicated(op.componentId),
  );
  const removed = ops.removed?.filter((op) => internals.isComponentReplicated(op.componentId));
  return {
    ...(created === undefined ? {} : { created }),
    ...(network === undefined ? {} : { network }),
    ...(added === undefined ? {} : { added }),
    ...(updated === undefined ? {} : { updated }),
    ...(removed === undefined ? {} : { removed }),
    ...(ops.destroyed === undefined ? {} : { destroyed: ops.destroyed }),
  };
}

export function applySnapshot(world: SnapshotWorld, bytes: Uint8Array, registry: RegistryLike): number {
  // Remote apply goes through world internals so replicated writes do not create local dirty echo.
  const internals = worldInternals(world);
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Snapshot) {
    throw new Error(`Unknown snapshot message type ${messageType}`);
  }

  const tick = reader.readU32();
  const entityCount = reader.readVarUint();

  for (let index = 0; index < entityCount; index += 1) {
    const entityId = reader.readVarUint();
    const componentId = reader.readVarUint();
    const op = reader.readU8();

    if (op === SnapshotOp.CreateEntity) {
      internals.applyCreateEntityFromRemote(entityId);
      continue;
    }

    if (op === SnapshotOp.DestroyEntity) {
      internals.applyDestroyFromRemote(entityId);
      continue;
    }

    if (op === SnapshotOp.SetNetwork) {
      internals.applyNetworkFromRemote(entityId, reader.readVarUint());
      continue;
    }

    const schema = registry.getSchema(componentId);
    if (schema === undefined) {
      throw new Error(`Unknown componentId ${componentId} while applying snapshot`);
    }

    if (op === SnapshotOp.AddComponent) {
      const instance = internals.spawnRemote(schema, entityId);
      codecForSchema(schema).readFull(reader, instance);
      continue;
    }

    if (op === SnapshotOp.UpdateComponent) {
      const record = internals.getRecord(entityId, componentId);
      if (record === undefined) {
        throw new Error(
          `Cannot apply update for unknown entity ${entityId} and component ${componentId}`,
        );
      }
      const fieldMask = reader.readVarUint();
      codecForSchema(schema).readDelta(reader, record.instance, fieldMask);
      continue;
    }

    if (op === SnapshotOp.BatchUpdateComponent) {
      if (entityId !== 0) {
        throw new Error(`Batch update op must use entityId 0, got ${entityId}`);
      }
      const fieldMask = reader.readVarUint();
      const count = reader.readVarUint();
      const codec = codecForSchema(schema);
      for (let batchIndex = 0; batchIndex < count; batchIndex += 1) {
        const batchedEntityId = reader.readVarUint();
        const record = internals.getRecord(batchedEntityId, componentId);
        if (record === undefined) {
          throw new Error(
            `Cannot apply batch update for unknown entity ${batchedEntityId} and component ${componentId}`,
          );
        }
        codec.readDelta(reader, record.instance, fieldMask);
      }
      continue;
    }

    if (op === SnapshotOp.RemoveComponent) {
      internals.applyRemoveFromRemote(entityId, componentId);
      continue;
    }

    throw new Error(`Unknown snapshot op ${op} for entity ${entityId}`);
  }

  return tick;
}
