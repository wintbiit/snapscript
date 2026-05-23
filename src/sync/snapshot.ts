import { BitReader, BitWriter } from "../binary/index";
import type { RegistryLike } from "../registry/index";
import { codecForSchema } from "../schema/schema";
import type { ClientWorld, HostWorld } from "../world/index";
import { worldInternals } from "../world/internals";
import type { DirtyOps } from "../world/dirty-graph";
import { MessageType } from "./message";

type SnapshotWorld = HostWorld | ClientWorld;
const MAX_POOLED_WRITERS = 16;
const writerPool: BitWriter[] = [];

export enum SnapshotOp {
  CreateEntity = 1,
  AddComponent = 2,
  UpdateComponent = 3,
  RemoveComponent = 4,
  DestroyEntity = 5,
}

export interface SnapshotWriteOps {
  readonly created?: readonly number[];
  readonly added?: readonly { readonly entityId: number; readonly componentId: number }[];
  readonly updated?: readonly {
    readonly entityId: number;
    readonly componentId: number;
    readonly fieldMask: number;
  }[];
  readonly removed?: readonly { readonly entityId: number; readonly componentId: number }[];
  readonly destroyed?: readonly number[];
}

export function encodeFullSnapshot(world: SnapshotWorld, tick: number): Uint8Array {
  const internals = worldInternals(world);
  return encodeSnapshotOps(world, tick, {
    created: internals.getEntityIds(),
    added: internals.getRecords().map((record) => ({
      entityId: record.entityId,
      componentId: record.schema.schemaId,
    })),
  });
}

export function encodeDirty(world: SnapshotWorld, tick: number): Uint8Array {
  const internals = worldInternals(world);
  const dirty = internals.getDirtySnapshot();
  const bytes = encodeSnapshotOps(world, tick, dirty);
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

function writeSnapshotOps(
  writer: BitWriter,
  world: SnapshotWorld,
  tick: number,
  ops: SnapshotWriteOps,
): void {
  const internals = worldInternals(world);
  const created = ops.created ?? [];
  const added = ops.added ?? [];
  const updated = ops.updated ?? [];
  const removed = ops.removed ?? [];
  const destroyed = ops.destroyed ?? [];

  writer.writeU8(MessageType.Snapshot);
  writer.writeU32(tick);
  writer.writeVarUint(
    created.length + added.length + updated.length + removed.length + destroyed.length,
  );

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

  for (const { entityId, componentId, fieldMask } of updated) {
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
      (ops.added?.length ?? 0) +
      (ops.updated?.length ?? 0) +
      (ops.removed?.length ?? 0) +
      (ops.destroyed?.length ?? 0) >
    0
  );
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

    if (op === SnapshotOp.RemoveComponent) {
      internals.applyRemoveFromRemote(entityId, componentId);
      continue;
    }

    throw new Error(`Unknown snapshot op ${op} for entity ${entityId}`);
  }

  return tick;
}
