import { describe, expect, it } from "vitest";
import {
  createHostWorld,
  defineComponent,
  defineProtocol,
  qf32,
  u16,
  type ChannelName,
  type ClientWorld,
  type ClientTransport,
  type Clock,
  type ComponentQuery,
  type ComponentSchema,
  type HostWorld,
  type HostTransport,
  type PeerRef,
} from "../src/index";
import { BitReader, BitWriter, ByteWriter } from "../src/binary/index";
import { createRegistry } from "../src/registry/index";
import { codecForSchema } from "../src/schema/schema";
import {
  applySnapshot,
  ControlCapability,
  ControlType,
  encodeControl,
  encodeDirty,
  encodeDirtyBatched,
  MessageType,
  SnapshotOp,
} from "../src/sync/index";
import type { ComponentRecord } from "../src/world/records";
import {
  SlotBackedComponentStorage,
  SlotBackedComponentTable,
} from "../src/world/slot-storage";
import {
  MapComponentStorage,
  SparseSetComponentStorage,
  type ComponentStorage,
} from "../src/world/storage";
import {
  createClientWorldForStorageBenchmark,
  createHostWorldForStorageBenchmark,
} from "../src/world/world";
import { createTestClientWorld, createTestHostWorld } from "./helpers";

const Position = defineComponent("BenchPosition", {
  x: qf32({ min: -100_000, max: 100_000, precision: 0.01, default: 0 }),
  y: qf32({ min: -100_000, max: 100_000, precision: 0.01, default: 0 }),
});

const Velocity = defineComponent("BenchVelocity", {
  x: qf32({ min: -1_000, max: 1_000, precision: 0.01, default: 0 }),
  y: qf32({ min: -1_000, max: 1_000, precision: 0.01, default: 0 }),
});

const Health = defineComponent("BenchHealth", {
  hp: u16(100),
});

const Team = defineComponent("BenchTeam", {
  id: u16(0),
});

const ChurnFlag = defineComponent("BenchChurnFlag", {
  value: u16(1),
});

type PositionFields = typeof Position extends ComponentSchema<infer TFields> ? TFields : never;
type VelocityFields = typeof Velocity extends ComponentSchema<infer TFields> ? TFields : never;
type ChurnFlagFields = typeof ChurnFlag extends ComponentSchema<infer TFields> ? TFields : never;

interface BenchRow {
  readonly name: string;
  readonly entities: number;
  readonly peers?: number;
  readonly rows?: number;
  readonly bytes?: number;
  readonly ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly samples: number;
  readonly iterations: number;
}

const DEFAULT_SAMPLES = 9;
const DEFAULT_WARMUPS = 2;
const BatchedUpdateComponentOp = 0xff;

class BenchHostTransport implements HostTransport {
  readonly sent: { peer: PeerRef; channel: ChannelName; bytes: Uint8Array }[] = [];
  #handler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  constructor(readonly peerList: readonly PeerRef[]) {}

  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    this.sent.push({ peer, channel, bytes });
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    for (const peer of this.peerList) {
      this.send(peer, channel, bytes);
    }
  }

  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void {
    this.#handler = cb;
  }

  peers(): Iterable<PeerRef> {
    return this.peerList;
  }

  receive(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    this.#handler?.(peer, channel, bytes);
  }
}

class BenchClientTransport implements ClientTransport {
  send(_channel: ChannelName, _bytes: Uint8Array): void {}
  onPacket(_cb: (channel: ChannelName, bytes: Uint8Array) => void): void {}
}

function clock(): Clock {
  let tick = 0;
  return {
    nowMs: () => tick * 16,
    tick: () => {
      tick += 1;
      return tick;
    },
  };
}

const benchProtocol = defineProtocol({
  components: { Position, Velocity, Health },
});
const ReadonlyRenderQuery = [Position, Health] as const satisfies ComponentQuery;

function buildWorld(entityCount: number) {
  const world = createTestHostWorld(benchProtocol);
  for (let i = 0; i < entityCount; i += 1) {
    const entity = world.spawn();
    world.add(entity, Position, { x: i, y: -i });
    world.add(entity, Velocity, { x: 1, y: -1 });
    world.add(entity, Health, { hp: 100 });
  }
  return world;
}

function buildSlotBackedWorld(entityCount: number) {
  const world = createHostWorldForStorageBenchmark(
    {
      protocol: benchProtocol,
      transport: new BenchHostTransport([]),
      clock: clock(),
    },
    new SlotBackedComponentStorage(),
  );
  for (let i = 0; i < entityCount; i += 1) {
    const entity = world.spawn();
    world.add(entity, Position, { x: i, y: -i });
    world.add(entity, Velocity, { x: 1, y: -1 });
    world.add(entity, Health, { hp: 100 });
  }
  return world;
}

function buildSlotBackedClientWorld() {
  return createClientWorldForStorageBenchmark(
    {
      protocol: benchProtocol,
      transport: new BenchClientTransport(),
      clock: clock(),
    },
    new SlotBackedComponentStorage(),
  );
}

function buildMixedWorld(entityCount: number, velocityEvery: number) {
  const world = createTestHostWorld(benchProtocol);
  for (let i = 0; i < entityCount; i += 1) {
    const entity = world.spawn();
    world.add(entity, Position, { x: i, y: -i });
    if (i % velocityEvery === 0) {
      world.add(entity, Velocity, { x: 1, y: -1 });
    }
    if (i % 3 === 0) {
      world.add(entity, Health, { hp: 100 });
    }
  }
  return world;
}

function buildStorage(
  storage: ComponentStorage,
  entityCount: number,
  velocityEvery: number,
): ComponentStorage {
  for (let i = 0; i < entityCount; i += 1) {
    storage.addEntity(i + 1);
    storage.set(i + 1, Position.schemaId, storageRecord(i + 1, Position));
    if (i % velocityEvery === 0) {
      storage.set(i + 1, Velocity.schemaId, storageRecord(i + 1, Velocity));
    }
    if (i % 3 === 0) {
      storage.set(i + 1, Health.schemaId, storageRecord(i + 1, Health));
    }
    if (i % 7 === 0) {
      storage.set(i + 1, Team.schemaId, storageRecord(i + 1, Team));
    }
  }
  return storage;
}

function storageRecord(entityId: number, schema: ComponentSchema): ComponentRecord {
  return {
    entityId,
    schema,
    instance: {
      entityId,
      id: schema.schemaId,
      schema,
    } as never,
  };
}

function time<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function sample<T>(
  fn: () => T,
  samples = DEFAULT_SAMPLES,
  iterations = 1,
  warmups = DEFAULT_WARMUPS,
): { value: T; ms: number; minMs: number; maxMs: number; samples: number; iterations: number } {
  const timings: number[] = [];
  let value: T | undefined;
  for (let index = 0; index < warmups; index += 1) {
    fn();
  }
  for (let index = 0; index < samples; index += 1) {
    const measured = time(() => {
      let current: T | undefined;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        current = fn();
      }
      return current as T;
    });
    value = measured.value;
    timings.push(measured.ms / iterations);
  }

  const sorted = [...timings].sort((a, b) => a - b);
  return {
    value: value as T,
    ms: sorted[Math.floor(sorted.length / 2)]!,
    minMs: sorted[0]!,
    maxMs: sorted.at(-1)!,
    samples,
    iterations,
  };
}

function moveAll(world: HostWorld): number {
  let rows = 0;
  world.each([Position, Velocity] as const, (_entity, pos, vel) => {
    pos.x.value += vel.x.value;
    pos.y.value += vel.y.value;
    rows += 1;
  });
  return rows;
}

function moveAndDampenAll(world: HostWorld): number {
  let rows = 0;
  world.each([Position, Velocity] as const, (_entity, pos, vel) => {
    pos.x.value += vel.x.value;
    pos.y.value += vel.y.value;
    vel.x.value *= 0.98;
    vel.y.value *= 0.98;
    rows += 1;
  });
  return rows;
}

function touchTriple(world: HostWorld): number {
  let rows = 0;
  world.each([Position, Velocity, Health] as const, (_entity, pos, vel, health) => {
    pos.x.value += vel.x.value;
    rows += health.hp.value >= 0 ? 1 : 0;
  });
  return rows;
}

function countQuery(world: ReturnType<typeof createTestHostWorld>, mode: "single" | "pair" | "triple"): number {
  let rows = 0;
  const query =
    mode === "single"
      ? world.query(Position)
      : mode === "pair"
        ? world.query(Position, Velocity)
        : world.query(Position, Velocity, Health);
  for (const _row of query) {
    rows += 1;
  }
  return rows;
}

function queryLength(
  world: ReturnType<typeof createTestHostWorld>,
  mode: "single" | "pair" | "triple",
): number {
  return mode === "single"
    ? world.query(Position).length
    : mode === "pair"
      ? world.query(Position, Velocity).length
      : world.query(Position, Velocity, Health).length;
}

function readonlyQueryLength(world: ClientWorld): number {
  return world.query(Position, Health).length;
}

function renderReadonlyViews(world: ClientWorld): number {
  return world.query(Position).map(([entity, pos]) => {
    const health = world.get(entity, Health);
    return pos.x.value + pos.y.value + (health?.hp.value ?? 0);
  }).length;
}

function renderReadonlyViewsEach(world: ClientWorld): number {
  let rows = 0;
  let checksum = 0;
  world.each([Position] as const, (entity, pos) => {
    const health = world.get(entity, Health);
    checksum += pos.x.value + pos.y.value + (health?.hp.value ?? 0);
    rows += 1;
  });
  return checksum === Number.POSITIVE_INFINITY ? 0 : rows;
}

function renderReadonlyRequiredPairEach(world: ClientWorld): number {
  let rows = 0;
  let checksum = 0;
  world.each(ReadonlyRenderQuery, (_entity, pos, health) => {
    checksum += pos.x.value + pos.y.value + health.hp.value;
    rows += 1;
  });
  return checksum === Number.POSITIVE_INFINITY ? 0 : rows;
}

function countStorageRows(storage: ComponentStorage, componentIds: readonly number[]): number {
  let rows = 0;
  for (const _row of storage.queryRows(componentIds)) {
    rows += 1;
  }
  return rows;
}

interface SoAPrototype {
  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly velX: Float64Array;
  readonly velY: Float64Array;
  readonly velocityRows: Uint32Array;
}

interface SlotBackedSoAPrototype extends SoAPrototype {
  readonly dirtyMasks: Uint32Array;
  readonly positions: readonly SlotPosition[];
  readonly velocities: readonly SlotVelocity[];
}

interface BitecsStylePrototype {
  readonly Position: {
    readonly x: Float64Array;
    readonly y: Float64Array;
  };
  readonly Velocity: {
    readonly x: Float64Array;
    readonly y: Float64Array;
  };
  readonly queryEids: Uint32Array;
  readonly dirtyMasks: Uint32Array;
}

interface BitecsArrayStylePrototype {
  readonly Position: {
    readonly x: number[];
    readonly y: number[];
  };
  readonly Velocity: {
    readonly x: number[];
    readonly y: number[];
  };
  readonly queryEids: number[];
  readonly dirtyMasks: number[];
}

interface SlotTablePrototype {
  readonly positionTable: SlotBackedComponentTable<PositionFields>;
  readonly velXByEntity: Float64Array;
  readonly velYByEntity: Float64Array;
  readonly queryEids: Uint32Array;
  readonly queryRows: Uint32Array;
  readonly dirtyMasks: Uint32Array;
}

interface MultiSlotTablePrototype {
  readonly positionTable: SlotBackedComponentTable<PositionFields>;
  readonly velocityTable: SlotBackedComponentTable<VelocityFields>;
  readonly queryEids: Uint32Array;
  readonly positionRows: Uint32Array;
  readonly velocityRows: Uint32Array;
  readonly positionDirtyMasks: Uint32Array;
  readonly velocityDirtyMasks: Uint32Array;
}

interface SlotDeltaWriter {
  writeDeltaAt(row: number, writer: BitWriter, fieldMask: number): void;
}

interface SlotPosition {
  readonly x: NumericSlotRef;
  readonly y: NumericSlotRef;
}

interface SlotVelocity {
  readonly x: NumericSlotRef;
  readonly y: NumericSlotRef;
}

class NumericSlotRef {
  constructor(
    private readonly values: Float64Array,
    private readonly row: number,
    private readonly dirtyMasks?: Uint32Array,
    private readonly dirtyBit = 0,
  ) {}

  get value(): number {
    return this.values[this.row]!;
  }

  set value(value: number) {
    if (this.values[this.row] === value) {
      return;
    }
    this.values[this.row] = value;
    if (this.dirtyMasks !== undefined) {
      this.dirtyMasks[this.row] = (this.dirtyMasks[this.row] ?? 0) | this.dirtyBit;
    }
  }

  peek(): number {
    return this.value;
  }

  setFromRemote(value: number): void {
    this.values[this.row] = value;
  }
}

function buildSoAPrototype(entityCount: number, velocityEvery: number): SoAPrototype {
  const velocityCount = Math.ceil(entityCount / velocityEvery);
  const posX = new Float64Array(entityCount);
  const posY = new Float64Array(entityCount);
  const velX = new Float64Array(velocityCount);
  const velY = new Float64Array(velocityCount);
  const velocityRows = new Uint32Array(velocityCount);
  let velocityIndex = 0;

  for (let row = 0; row < entityCount; row += 1) {
    posX[row] = row;
    posY[row] = -row;
    if (row % velocityEvery === 0) {
      velocityRows[velocityIndex] = row;
      velX[velocityIndex] = 1;
      velY[velocityIndex] = -1;
      velocityIndex += 1;
    }
  }

  return { posX, posY, velX, velY, velocityRows };
}

function moveSoAPrototype(world: SoAPrototype): number {
  // This is intentionally not production storage. It measures the upper bound of columnar movement loops
  // before paying the API cost of converting NetRefs into slot handles.
  for (let index = 0; index < world.velocityRows.length; index += 1) {
    const row = world.velocityRows[index]!;
    world.posX[row] = world.posX[row]! + world.velX[index]!;
    world.posY[row] = world.posY[row]! + world.velY[index]!;
  }
  return world.velocityRows.length;
}

function buildSlotBackedSoAPrototype(entityCount: number, velocityEvery: number): SlotBackedSoAPrototype {
  const base = buildSoAPrototype(entityCount, velocityEvery);
  const dirtyMasks = new Uint32Array(entityCount);
  const positions: SlotPosition[] = [];
  const velocities: SlotVelocity[] = [];

  for (let row = 0; row < entityCount; row += 1) {
    positions[row] = {
      x: new NumericSlotRef(base.posX, row, dirtyMasks, 1),
      y: new NumericSlotRef(base.posY, row, dirtyMasks, 2),
    };
  }

  for (let row = 0; row < base.velocityRows.length; row += 1) {
    velocities[row] = {
      x: new NumericSlotRef(base.velX, row),
      y: new NumericSlotRef(base.velY, row),
    };
  }

  return { ...base, dirtyMasks, positions, velocities };
}

function moveSlotBackedSoAPrototype(world: SlotBackedSoAPrototype): number {
  // This keeps the public `ref.value` shape while redirecting reads/writes to typed-array slots.
  for (let index = 0; index < world.velocityRows.length; index += 1) {
    const entityRow = world.velocityRows[index]!;
    const pos = world.positions[entityRow]!;
    const vel = world.velocities[index]!;
    pos.x.value += vel.x.value;
    pos.y.value += vel.y.value;
  }
  return world.velocityRows.length;
}

function buildBitecsStylePrototype(entityCount: number, velocityEvery: number): BitecsStylePrototype {
  const capacity = entityCount + 1;
  const velocityCount = Math.ceil(entityCount / velocityEvery);
  const Position = {
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
  };
  const Velocity = {
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
  };
  const queryEids = new Uint32Array(velocityCount);
  const dirtyMasks = new Uint32Array(capacity);
  let queryIndex = 0;

  for (let eid = 1; eid <= entityCount; eid += 1) {
    Position.x[eid] = eid;
    Position.y[eid] = -eid;
    if ((eid - 1) % velocityEvery === 0) {
      Velocity.x[eid] = 1;
      Velocity.y[eid] = -1;
      queryEids[queryIndex] = eid;
      queryIndex += 1;
    }
  }

  return { Position, Velocity, queryEids, dirtyMasks };
}

function moveBitecsStylePrototype(world: BitecsStylePrototype): number {
  // bitECS-style systems iterate entity ids and operate on component columns indexed by eid.
  for (let index = 0; index < world.queryEids.length; index += 1) {
    const eid = world.queryEids[index]!;
    world.Position.x[eid] = world.Position.x[eid]! + world.Velocity.x[eid]!;
    world.Position.y[eid] = world.Position.y[eid]! + world.Velocity.y[eid]!;
    world.dirtyMasks[eid] = (world.dirtyMasks[eid] ?? 0) | 0b11;
  }
  return world.queryEids.length;
}

function buildBitecsArrayStylePrototype(
  entityCount: number,
  velocityEvery: number,
): BitecsArrayStylePrototype {
  const capacity = entityCount + 1;
  const Position = {
    x: new Array<number>(capacity).fill(0),
    y: new Array<number>(capacity).fill(0),
  };
  const Velocity = {
    x: new Array<number>(capacity).fill(0),
    y: new Array<number>(capacity).fill(0),
  };
  const queryEids: number[] = [];
  const dirtyMasks = new Array<number>(capacity).fill(0);

  for (let eid = 1; eid <= entityCount; eid += 1) {
    Position.x[eid] = eid;
    Position.y[eid] = -eid;
    if ((eid - 1) % velocityEvery === 0) {
      Velocity.x[eid] = 1;
      Velocity.y[eid] = -1;
      queryEids.push(eid);
    }
  }

  return { Position, Velocity, queryEids, dirtyMasks };
}

function moveBitecsArrayStylePrototype(world: BitecsArrayStylePrototype): number {
  // bitECS 0.4 documents plain SoA arrays as a first-class component storage shape.
  for (let index = 0; index < world.queryEids.length; index += 1) {
    const eid = world.queryEids[index]!;
    world.Position.x[eid] = world.Position.x[eid]! + world.Velocity.x[eid]!;
    world.Position.y[eid] = world.Position.y[eid]! + world.Velocity.y[eid]!;
    world.dirtyMasks[eid] = (world.dirtyMasks[eid] ?? 0) | 0b11;
  }
  return world.queryEids.length;
}

function buildSlotTablePrototype(entityCount: number, velocityEvery: number): SlotTablePrototype {
  const positionTable = new SlotBackedComponentTable(Position, { capacity: entityCount });
  const dirtyMasks = new Uint32Array(entityCount + 1);
  const velXByEntity = new Float64Array(entityCount + 1);
  const velYByEntity = new Float64Array(entityCount + 1);
  const queryEids = new Uint32Array(Math.ceil(entityCount / velocityEvery));
  const queryRows = new Uint32Array(queryEids.length);
  let queryIndex = 0;

  for (let eid = 1; eid <= entityCount; eid += 1) {
    positionTable.add(eid, { x: eid, y: -eid }, (entityId, _componentId, fieldId) => {
      dirtyMasks[entityId] = (dirtyMasks[entityId] ?? 0) | (1 << fieldId);
    });
    if ((eid - 1) % velocityEvery === 0) {
      velXByEntity[eid] = 1;
      velYByEntity[eid] = -1;
      queryEids[queryIndex] = eid;
      queryRows[queryIndex] = positionTable.rowOf(eid)!;
      queryIndex += 1;
    }
  }

  return {
    positionTable,
    velXByEntity,
    velYByEntity,
    queryEids,
    queryRows,
    dirtyMasks,
  };
}

function buildMultiSlotTablePrototype(
  entityCount: number,
  velocityEvery: number,
): MultiSlotTablePrototype {
  const positionTable = new SlotBackedComponentTable(Position, { capacity: entityCount });
  const velocityTable = new SlotBackedComponentTable(Velocity, {
    capacity: Math.ceil(entityCount / velocityEvery),
  });
  const positionDirtyMasks = new Uint32Array(entityCount + 1);
  const velocityDirtyMasks = new Uint32Array(entityCount + 1);
  const queryEids = new Uint32Array(Math.ceil(entityCount / velocityEvery));
  const positionRows = new Uint32Array(queryEids.length);
  const velocityRows = new Uint32Array(queryEids.length);
  let queryIndex = 0;

  for (let eid = 1; eid <= entityCount; eid += 1) {
    positionTable.add(eid, { x: eid, y: -eid }, (entityId, _componentId, fieldId) => {
      positionDirtyMasks[entityId] = (positionDirtyMasks[entityId] ?? 0) | (1 << fieldId);
    });
    if ((eid - 1) % velocityEvery === 0) {
      velocityTable.add(eid, { x: 1, y: -1 }, (entityId, _componentId, fieldId) => {
        velocityDirtyMasks[entityId] = (velocityDirtyMasks[entityId] ?? 0) | (1 << fieldId);
      });
      queryEids[queryIndex] = eid;
      positionRows[queryIndex] = positionTable.rowOf(eid)!;
      velocityRows[queryIndex] = velocityTable.rowOf(eid)!;
      queryIndex += 1;
    }
  }

  return {
    positionTable,
    velocityTable,
    queryEids,
    positionRows,
    velocityRows,
    positionDirtyMasks,
    velocityDirtyMasks,
  };
}

function moveSlotTablePrototype(world: SlotTablePrototype): number {
  for (let index = 0; index < world.queryEids.length; index += 1) {
    const eid = world.queryEids[index]!;
    const position = world.positionTable.recordAt(world.queryRows[index]!)!.instance;
    position.x.value += world.velXByEntity[eid]!;
    position.y.value += world.velYByEntity[eid]!;
  }
  return world.queryEids.length;
}

function moveSlotTableDensePrototype(world: SlotTablePrototype): number {
  let rows = 0;
  world.positionTable.forEachRow((row) => {
    const eid = row.entityId;
    row.record.instance.x.value += world.velXByEntity[eid]!;
    row.record.instance.y.value += world.velYByEntity[eid]!;
    rows += 1;
  });
  return rows;
}

function moveMultiSlotTablePrototype(world: MultiSlotTablePrototype): number {
  for (let index = 0; index < world.queryEids.length; index += 1) {
    const position = world.positionTable.recordAt(world.positionRows[index]!)!.instance;
    const velocity = world.velocityTable.recordAt(world.velocityRows[index]!)!.instance;
    position.x.value += velocity.x.value;
    position.y.value += velocity.y.value;
    velocity.x.value *= 0.98;
    velocity.y.value *= 0.98;
  }
  return world.queryEids.length;
}

function encodeSlotBackedPositionDeltas(world: SlotBackedSoAPrototype, tick: number): Uint8Array {
  const writer = new BitWriter();
  const codec = codecForSchema(Position);
  writer.writeU8(MessageType.Snapshot);
  writer.writeU32(tick);
  writer.writeVarUint(world.velocityRows.length);

  for (let index = 0; index < world.velocityRows.length; index += 1) {
    const row = world.velocityRows[index]!;
    const fieldMask = world.dirtyMasks[row] ?? 0;
    writer.writeVarUint(row + 1);
    writer.writeVarUint(Position.schemaId);
    writer.writeU8(SnapshotOp.UpdateComponent);
    writer.writeVarUint(fieldMask);
    codec.writeDelta(writer, world.positions[row] as unknown as Record<string, NumericSlotRef>, fieldMask);
  }

  return writer.finish();
}

function applySlotBackedPositionDeltas(world: SlotBackedSoAPrototype, bytes: Uint8Array): number {
  const reader = new BitReader(bytes);
  const codec = codecForSchema(Position);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Snapshot) {
    throw new Error(`Unexpected message type ${messageType}`);
  }
  reader.readU32();
  const count = reader.readVarUint();

  for (let index = 0; index < count; index += 1) {
    const entityId = reader.readVarUint();
    const componentId = reader.readVarUint();
    const op = reader.readU8();
    if (componentId !== Position.schemaId || op !== SnapshotOp.UpdateComponent) {
      throw new Error("Unexpected slot-backed snapshot op");
    }
    const fieldMask = reader.readVarUint();
    codec.readDelta(
      reader,
      world.positions[entityId - 1] as unknown as Record<string, NumericSlotRef>,
      fieldMask,
    );
  }

  return count;
}

function encodeSlotTablePositionDeltas(world: SlotTablePrototype, tick: number): Uint8Array {
  const writer = new BitWriter();
  const codec = codecForSchema(Position);
  writer.writeU8(MessageType.Snapshot);
  writer.writeU32(tick);
  writer.writeVarUint(world.queryEids.length);

  for (let index = 0; index < world.queryEids.length; index += 1) {
    const entityId = world.queryEids[index]!;
    const fieldMask = world.dirtyMasks[entityId] ?? 0;
    writer.writeVarUint(entityId);
    writer.writeVarUint(Position.schemaId);
    writer.writeU8(SnapshotOp.UpdateComponent);
    writer.writeVarUint(fieldMask);
    codec.writeDelta(
      writer,
      world.positionTable.recordAt(world.queryRows[index]!)!.instance as never,
      fieldMask,
    );
  }

  return writer.finish();
}

function encodeSlotTablePositionDeltasBulk(world: SlotTablePrototype, tick: number): Uint8Array {
  const writer = new BitWriter();
  return encodeSlotTablePositionDeltasBulkWithBitWriter(world, tick, writer);
}

function encodeSlotTablePositionDeltasBulkWithBitWriter(
  world: SlotTablePrototype,
  tick: number,
  writer: BitWriter,
): Uint8Array {
  writer.writeU8(MessageType.Snapshot);
  writer.writeU32(tick);
  writer.writeVarUint(world.queryEids.length);

  for (let index = 0; index < world.queryEids.length; index += 1) {
    const entityId = world.queryEids[index]!;
    const fieldMask = world.dirtyMasks[entityId] ?? 0;
    writer.writeVarUint(entityId);
    writer.writeVarUint(Position.schemaId);
    writer.writeU8(SnapshotOp.UpdateComponent);
    writer.writeVarUint(fieldMask);
    world.positionTable.writeDeltaAt(world.queryRows[index]!, writer, fieldMask);
  }

  return writer.finish();
}

function encodeSlotTablePositionDeltasBulkPooled(
  world: SlotTablePrototype,
  tick: number,
  writer: BitWriter,
): Uint8Array {
  try {
    return encodeSlotTablePositionDeltasBulkWithBitWriter(world, tick, writer);
  } finally {
    writer.reset();
  }
}

function encodeSlotTablePositionDeltasBulkByteWriter(
  world: SlotTablePrototype,
  tick: number,
  writer: ByteWriter,
): Uint8Array {
  try {
    writer.writeU8(MessageType.Snapshot);
    writer.writeU32(tick);
    writer.writeVarU32(world.queryEids.length);

    for (let index = 0; index < world.queryEids.length; index += 1) {
      const entityId = world.queryEids[index]!;
      const fieldMask = world.dirtyMasks[entityId] ?? 0;
      writer.writeVarU32(entityId);
      writer.writeVarU32(Position.schemaId);
      writer.writeU8(SnapshotOp.UpdateComponent);
      writer.writeVarU32(fieldMask);
      world.positionTable.writeDeltaAt(world.queryRows[index]!, writer, fieldMask);
    }

    return writer.finish();
  } finally {
    writer.reset();
  }
}

function encodeSlotTablePositionDeltasBatched(
  world: SlotTablePrototype,
  tick: number,
  writer: BitWriter,
): Uint8Array {
  const fieldMask = 0b11;
  try {
    writer.writeU8(MessageType.Snapshot);
    writer.writeU32(tick);
    writer.writeVarUint(1);
    writer.writeVarUint(Position.schemaId);
    writer.writeU8(BatchedUpdateComponentOp);
    writer.writeVarUint(fieldMask);
    writer.writeVarUint(world.queryEids.length);

    for (let index = 0; index < world.queryEids.length; index += 1) {
      writer.writeVarUint(world.queryEids[index]!);
      world.positionTable.writeDeltaAt(world.queryRows[index]!, writer, fieldMask);
    }

    return writer.finish();
  } finally {
    writer.reset();
  }
}

function applySlotTablePositionDeltasBatched(world: SlotTablePrototype, bytes: Uint8Array): number {
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Snapshot) {
    throw new Error(`Unexpected message type ${messageType}`);
  }
  reader.readU32();
  const batchCount = reader.readVarUint();
  if (batchCount !== 1) {
    throw new Error(`Unexpected batch count ${batchCount}`);
  }

  const componentId = reader.readVarUint();
  const op = reader.readU8();
  if (componentId !== Position.schemaId || op !== BatchedUpdateComponentOp) {
    throw new Error("Unexpected slot table batched snapshot op");
  }

  const fieldMask = reader.readVarUint();
  const count = reader.readVarUint();
  for (let index = 0; index < count; index += 1) {
    const entityId = reader.readVarUint();
    world.positionTable.readDeltaAt(world.positionTable.rowOf(entityId)!, reader, fieldMask);
  }

  return count;
}

function encodeMultiSlotTableDeltas(
  world: MultiSlotTablePrototype,
  tick: number,
  writer: BitWriter,
): Uint8Array {
  const fieldMask = 0b11;
  try {
    writer.writeU8(MessageType.Snapshot);
    writer.writeU32(tick);
    writer.writeVarUint(world.queryEids.length * 2);

    for (let index = 0; index < world.queryEids.length; index += 1) {
      const entityId = world.queryEids[index]!;
      writer.writeVarUint(entityId);
      writer.writeVarUint(Position.schemaId);
      writer.writeU8(SnapshotOp.UpdateComponent);
      writer.writeVarUint(fieldMask);
      world.positionTable.writeDeltaAt(world.positionRows[index]!, writer, fieldMask);

      writer.writeVarUint(entityId);
      writer.writeVarUint(Velocity.schemaId);
      writer.writeU8(SnapshotOp.UpdateComponent);
      writer.writeVarUint(fieldMask);
      world.velocityTable.writeDeltaAt(world.velocityRows[index]!, writer, fieldMask);
    }

    return writer.finish();
  } finally {
    writer.reset();
  }
}

function encodeMultiSlotTableDeltasBatched(
  world: MultiSlotTablePrototype,
  tick: number,
  writer: BitWriter,
): Uint8Array {
  const fieldMask = 0b11;
  try {
    writer.writeU8(MessageType.Snapshot);
    writer.writeU32(tick);
    writer.writeVarUint(2);
    writeSlotTableBatch(
      writer,
      Position.schemaId,
      fieldMask,
      world.queryEids,
      world.positionRows,
      world.positionTable,
    );
    writeSlotTableBatch(
      writer,
      Velocity.schemaId,
      fieldMask,
      world.queryEids,
      world.velocityRows,
      world.velocityTable,
    );
    return writer.finish();
  } finally {
    writer.reset();
  }
}

function writeSlotTableBatch(
  writer: BitWriter,
  componentId: number,
  fieldMask: number,
  entityIds: Uint32Array,
  rows: Uint32Array,
  table: SlotDeltaWriter,
): void {
  writer.writeVarUint(0);
  writer.writeVarUint(componentId);
  writer.writeU8(SnapshotOp.BatchUpdateComponent);
  writer.writeVarUint(fieldMask);
  writer.writeVarUint(entityIds.length);
  for (let index = 0; index < entityIds.length; index += 1) {
    writer.writeVarUint(entityIds[index]!);
    table.writeDeltaAt(rows[index]!, writer, fieldMask);
  }
}

function applySlotTablePositionDeltas(world: SlotTablePrototype, bytes: Uint8Array): number {
  const reader = new BitReader(bytes);
  const codec = codecForSchema(Position);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Snapshot) {
    throw new Error(`Unexpected message type ${messageType}`);
  }
  reader.readU32();
  const count = reader.readVarUint();

  for (let index = 0; index < count; index += 1) {
    const entityId = reader.readVarUint();
    const componentId = reader.readVarUint();
    const op = reader.readU8();
    if (componentId !== Position.schemaId || op !== SnapshotOp.UpdateComponent) {
      throw new Error("Unexpected slot table snapshot op");
    }
    const fieldMask = reader.readVarUint();
    codec.readDelta(reader, world.positionTable.get(entityId)!.instance as never, fieldMask);
  }

  return count;
}

function applySlotTablePositionDeltasBulk(world: SlotTablePrototype, bytes: Uint8Array): number {
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Snapshot) {
    throw new Error(`Unexpected message type ${messageType}`);
  }
  reader.readU32();
  const count = reader.readVarUint();

  for (let index = 0; index < count; index += 1) {
    const entityId = reader.readVarUint();
    const componentId = reader.readVarUint();
    const op = reader.readU8();
    if (componentId !== Position.schemaId || op !== SnapshotOp.UpdateComponent) {
      throw new Error("Unexpected slot table snapshot op");
    }
    const fieldMask = reader.readVarUint();
    world.positionTable.readDeltaAt(world.positionTable.rowOf(entityId)!, reader, fieldMask);
  }

  return count;
}

function churnStorage(storage: ComponentStorage, startEntityId: number): number {
  for (let i = 0; i < 500; i += 1) {
    const entityId = startEntityId + i;
    storage.addEntity(entityId);
    storage.set(entityId, Position.schemaId, storageRecord(entityId, Position));
    storage.set(entityId, Velocity.schemaId, storageRecord(entityId, Velocity));
    storage.remove(entityId, Velocity.schemaId);
    storage.deleteEntity(entityId);
  }
  return 500;
}

function churnStorageComponents(storage: ComponentStorage, entityCount: number): number {
  for (let i = 0; i < 500; i += 1) {
    const entityId = (i % entityCount) + 1;
    storage.set(entityId, ChurnFlag.schemaId, storageRecord(entityId, ChurnFlag));
    storage.remove(entityId, ChurnFlag.schemaId);
  }
  return 500;
}

function buildSlotChurnTable(entityCount: number): SlotBackedComponentTable<ChurnFlagFields> {
  const table = new SlotBackedComponentTable(ChurnFlag, { capacity: entityCount });
  for (let entityId = 1; entityId <= entityCount; entityId += 1) {
    table.add(entityId, undefined, () => {});
  }
  return table;
}

function churnSlotTableRows(
  table: SlotBackedComponentTable<ChurnFlagFields>,
  startEntityId: number,
): number {
  for (let i = 0; i < 500; i += 1) {
    const entityId = startEntityId + i;
    table.add(entityId, undefined, () => {});
    table.remove(entityId);
  }
  return 500;
}

function buildSlotMaterializationTable(entityCount: number): SlotBackedComponentTable<PositionFields> {
  const table = new SlotBackedComponentTable(Position, { capacity: entityCount });
  for (let entityId = 1; entityId <= entityCount; entityId += 1) {
    table.add(entityId, { x: entityId, y: -entityId }, () => {});
  }
  return table;
}

function materializeSlotTableRows(
  table: SlotBackedComponentTable<PositionFields>,
): number {
  let rows = 0;
  table.forEachRow((row) => {
    rows += row.record.instance.x.value >= 0 ? 1 : 0;
  });
  return rows;
}

function report(rows: readonly BenchRow[]): void {
  console.info(`\nSnapScript benchmark (${new Date().toISOString()})`);
  for (const row of rows) {
    const details = [
      `entities=${row.entities}`,
      row.peers === undefined ? undefined : `peers=${row.peers}`,
      row.rows === undefined ? undefined : `rows=${row.rows}`,
      row.bytes === undefined ? undefined : `bytes=${row.bytes}`,
      `medianMs=${formatMs(row.ms)}`,
      `minMs=${formatMs(row.minMs)}`,
      `maxMs=${formatMs(row.maxMs)}`,
      `samples=${row.samples}`,
      row.iterations === 1 ? undefined : `iterations=${row.iterations}`,
    ]
      .filter(Boolean)
      .join(" ");
    console.info(`${row.name}: ${details}`);
  }
}

function formatMs(value: number): string {
  return value < 0.001 ? value.toFixed(6) : value.toFixed(3);
}

function formatEntityCountName(value: number): string {
  return value >= 1_000 && value % 1_000 === 0 ? `${value / 1_000}k` : `${value}`;
}

describe("benchmark baselines", () => {
  it("measures query, dirty encode, remote apply, churn, and peer fanout", () => {
    const registry = createRegistry()
      .registerComponent(Position)
      .registerComponent(Velocity)
      .registerComponent(Health);
    const protocol = benchProtocol;
    const rows: BenchRow[] = [];

    for (const entityCount of [1_000, 10_000]) {
      const source = buildWorld(entityCount);
      const target = createTestClientWorld(protocol);
      const full = encodeDirty(source, 1);
      applySnapshot(target, full, registry);

      const query = sample(() => moveAll(source));
      rows.push({
        name: "each+mutate",
        entities: entityCount,
        rows: query.value,
        ms: query.ms,
        minMs: query.minMs,
        maxMs: query.maxMs,
        samples: query.samples,
        iterations: query.iterations,
      });

      let encodeTick = 2;
      const encoded = sample(() => {
        moveAll(source);
        return encodeDirty(source, encodeTick++);
      });
      rows.push({
        name: "encode dirty",
        entities: entityCount,
        bytes: encoded.value.byteLength,
        ms: encoded.ms,
        minMs: encoded.minMs,
        maxMs: encoded.maxMs,
        samples: encoded.samples,
        iterations: encoded.iterations,
      });

      const applied = sample(() => applySnapshot(target, encoded.value, registry));
      rows.push({
        name: "apply dirty",
        entities: entityCount,
        bytes: encoded.value.byteLength,
        ms: applied.ms,
        minMs: applied.minMs,
        maxMs: applied.maxMs,
        samples: applied.samples,
        iterations: applied.iterations,
      });

      const batchedSource = buildWorld(entityCount);
      const batchedTarget = createTestClientWorld(protocol);
      applySnapshot(batchedTarget, encodeDirty(batchedSource, 1), registry);
      let batchedTick = 2;
      const batched = sample(() => {
        moveAll(batchedSource);
        return encodeDirtyBatched(batchedSource, batchedTick++);
      });
      rows.push({
        name: "encode dirty batched",
        entities: entityCount,
        bytes: batched.value.byteLength,
        ms: batched.ms,
        minMs: batched.minMs,
        maxMs: batched.maxMs,
        samples: batched.samples,
        iterations: batched.iterations,
      });

      const appliedBatched = sample(() => applySnapshot(batchedTarget, batched.value, registry));
      rows.push({
        name: "apply dirty batched",
        entities: entityCount,
        bytes: batched.value.byteLength,
        ms: appliedBatched.ms,
        minMs: appliedBatched.minMs,
        maxMs: appliedBatched.maxMs,
        samples: appliedBatched.samples,
        iterations: appliedBatched.iterations,
      });

      const multiSource = buildWorld(entityCount);
      const multiTarget = createTestClientWorld(protocol);
      applySnapshot(multiTarget, encodeDirty(multiSource, 1), registry);
      let multiTick = 2;
      const multiEncoded = sample(() => {
        moveAndDampenAll(multiSource);
        return encodeDirty(multiSource, multiTick++);
      });
      rows.push({
        name: "encode dirty multi-component",
        entities: entityCount,
        bytes: multiEncoded.value.byteLength,
        ms: multiEncoded.ms,
        minMs: multiEncoded.minMs,
        maxMs: multiEncoded.maxMs,
        samples: multiEncoded.samples,
        iterations: multiEncoded.iterations,
      });

      const multiApplied = sample(() => applySnapshot(multiTarget, multiEncoded.value, registry));
      rows.push({
        name: "apply dirty multi-component",
        entities: entityCount,
        bytes: multiEncoded.value.byteLength,
        ms: multiApplied.ms,
        minMs: multiApplied.minMs,
        maxMs: multiApplied.maxMs,
        samples: multiApplied.samples,
        iterations: multiApplied.iterations,
      });

      const multiBatchedSource = buildWorld(entityCount);
      const multiBatchedTarget = createTestClientWorld(protocol);
      applySnapshot(multiBatchedTarget, encodeDirty(multiBatchedSource, 1), registry);
      let multiBatchedTick = 2;
      const multiBatched = sample(() => {
        moveAndDampenAll(multiBatchedSource);
        return encodeDirtyBatched(multiBatchedSource, multiBatchedTick++);
      });
      rows.push({
        name: "encode dirty batched multi-component",
        entities: entityCount,
        bytes: multiBatched.value.byteLength,
        ms: multiBatched.ms,
        minMs: multiBatched.minMs,
        maxMs: multiBatched.maxMs,
        samples: multiBatched.samples,
        iterations: multiBatched.iterations,
      });

      const multiBatchedApplied = sample(() =>
        applySnapshot(multiBatchedTarget, multiBatched.value, registry),
      );
      rows.push({
        name: "apply dirty batched multi-component",
        entities: entityCount,
        bytes: multiBatched.value.byteLength,
        ms: multiBatchedApplied.ms,
        minMs: multiBatchedApplied.minMs,
        maxMs: multiBatchedApplied.maxMs,
        samples: multiBatchedApplied.samples,
        iterations: multiBatchedApplied.iterations,
      });
    }

    for (const entityCount of [1_000, 10_000]) {
      const slotSource = buildSlotBackedWorld(entityCount);
      const slotQuery = sample(() => moveAll(slotSource));
      rows.push({
        name: "slot-backed world each+mutate",
        entities: entityCount,
        rows: slotQuery.value,
        ms: slotQuery.ms,
        minMs: slotQuery.minMs,
        maxMs: slotQuery.maxMs,
        samples: slotQuery.samples,
        iterations: slotQuery.iterations,
      });

      let slotTick = 2;
      const slotEncoded = sample(() => {
        moveAll(slotSource);
        return encodeDirty(slotSource, slotTick++);
      });
      rows.push({
        name: "slot-backed world encode dirty",
        entities: entityCount,
        bytes: slotEncoded.value.byteLength,
        ms: slotEncoded.ms,
        minMs: slotEncoded.minMs,
        maxMs: slotEncoded.maxMs,
        samples: slotEncoded.samples,
        iterations: slotEncoded.iterations,
      });

      const slotApplySource = buildSlotBackedWorld(entityCount);
      const slotApplyTarget = buildSlotBackedClientWorld();
      applySnapshot(slotApplyTarget, encodeDirty(slotApplySource, 1), registry);
      let slotApplyTick = 2;
      const slotApplyEncoded = sample(() => {
        moveAll(slotApplySource);
        return encodeDirty(slotApplySource, slotApplyTick++);
      });
      const slotApplied = sample(() =>
        applySnapshot(slotApplyTarget, slotApplyEncoded.value, registry),
      );
      rows.push({
        name: "slot-backed client apply dirty",
        entities: entityCount,
        bytes: slotApplyEncoded.value.byteLength,
        ms: slotApplied.ms,
        minMs: slotApplied.minMs,
        maxMs: slotApplied.maxMs,
        samples: slotApplied.samples,
        iterations: slotApplied.iterations,
      });

      const slotMultiSource = buildSlotBackedWorld(entityCount);
      let slotMultiTick = 2;
      const slotMultiEncoded = sample(() => {
        moveAndDampenAll(slotMultiSource);
        return encodeDirtyBatched(slotMultiSource, slotMultiTick++);
      });
      rows.push({
        name: "slot-backed world encode dirty batched multi-component",
        entities: entityCount,
        bytes: slotMultiEncoded.value.byteLength,
        ms: slotMultiEncoded.ms,
        minMs: slotMultiEncoded.minMs,
        maxMs: slotMultiEncoded.maxMs,
        samples: slotMultiEncoded.samples,
        iterations: slotMultiEncoded.iterations,
      });

      const slotMultiApplySource = buildSlotBackedWorld(entityCount);
      const slotMultiApplyTarget = buildSlotBackedClientWorld();
      applySnapshot(slotMultiApplyTarget, encodeDirty(slotMultiApplySource, 1), registry);
      let slotMultiApplyTick = 2;
      const slotMultiApplyEncoded = sample(() => {
        moveAndDampenAll(slotMultiApplySource);
        return encodeDirtyBatched(slotMultiApplySource, slotMultiApplyTick++);
      });
      const slotMultiApplied = sample(() =>
        applySnapshot(slotMultiApplyTarget, slotMultiApplyEncoded.value, registry),
      );
      rows.push({
        name: "slot-backed client apply dirty batched multi-component",
        entities: entityCount,
        bytes: slotMultiApplyEncoded.value.byteLength,
        ms: slotMultiApplied.ms,
        minMs: slotMultiApplied.minMs,
        maxMs: slotMultiApplied.maxMs,
        samples: slotMultiApplied.samples,
        iterations: slotMultiApplied.iterations,
      });
    }

    for (const [name, world, mode] of [
      ["single query 50k", buildMixedWorld(50_000, 2), "single"],
      ["dense pair query 50k", buildMixedWorld(50_000, 1), "pair"],
      ["sparse pair query 50k", buildMixedWorld(50_000, 20), "pair"],
      ["triple query 50k", buildMixedWorld(50_000, 2), "triple"],
    ] as const) {
      const measured = sample(() => countQuery(world, mode));
      rows.push({
        name,
        entities: 50_000,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [storageName, sourceFactory, targetFactory] of [
      [
        "client",
        () => buildWorld(50_000),
        () => createTestClientWorld(protocol),
      ],
      [
        "slot-backed client",
        () => buildSlotBackedWorld(50_000),
        () => buildSlotBackedClientWorld(),
      ],
    ] as const) {
      const source = sourceFactory();
      const target = targetFactory();
      applySnapshot(target, encodeDirty(source, 1), registry);

      const queryMeasured = sample(() => readonlyQueryLength(target));
      rows.push({
        name: `${storageName} readonly pair query.length 50k`,
        entities: 50_000,
        rows: queryMeasured.value,
        ms: queryMeasured.ms,
        minMs: queryMeasured.minMs,
        maxMs: queryMeasured.maxMs,
        samples: queryMeasured.samples,
        iterations: queryMeasured.iterations,
      });

      const renderMeasured = sample(() => renderReadonlyViews(target));
      rows.push({
        name: `${storageName} readonly render views 50k`,
        entities: 50_000,
        rows: renderMeasured.value,
        ms: renderMeasured.ms,
        minMs: renderMeasured.minMs,
        maxMs: renderMeasured.maxMs,
        samples: renderMeasured.samples,
        iterations: renderMeasured.iterations,
      });

      const eachRenderMeasured = sample(() => renderReadonlyViewsEach(target));
      rows.push({
        name: `${storageName} readonly each render views 50k`,
        entities: 50_000,
        rows: eachRenderMeasured.value,
        ms: eachRenderMeasured.ms,
        minMs: eachRenderMeasured.minMs,
        maxMs: eachRenderMeasured.maxMs,
        samples: eachRenderMeasured.samples,
        iterations: eachRenderMeasured.iterations,
      });

      const pairEachRenderMeasured = sample(() => renderReadonlyRequiredPairEach(target));
      rows.push({
        name: `${storageName} readonly pair each render views 50k`,
        entities: 50_000,
        rows: pairEachRenderMeasured.value,
        ms: pairEachRenderMeasured.ms,
        minMs: pairEachRenderMeasured.minMs,
        maxMs: pairEachRenderMeasured.maxMs,
        samples: pairEachRenderMeasured.samples,
        iterations: pairEachRenderMeasured.iterations,
      });
    }

    const storageFactories = [
      ["map storage", () => new MapComponentStorage()],
      ["sparse storage", () => new SparseSetComponentStorage({ archetypeIndex: false })],
      ["sparse+archetype storage", () => new SparseSetComponentStorage()],
    ] as const;
    const storageEntityCounts = [10_000, 50_000] as const;
    const storageQueries = [
      ["single storage query", [Position.schemaId] as const, 2],
      ["dense pair storage query", [Position.schemaId, Velocity.schemaId] as const, 1],
      ["sparse pair storage query", [Position.schemaId, Velocity.schemaId] as const, 20],
      [
        "triple storage query",
        [Position.schemaId, Velocity.schemaId, Health.schemaId] as const,
        2,
      ],
      [
        "sparse quadruple storage query",
        [Position.schemaId, Velocity.schemaId, Health.schemaId, Team.schemaId] as const,
        2,
      ],
    ] as const;

    for (const [storageName, factory] of storageFactories) {
      for (const entityCount of storageEntityCounts) {
        for (const [queryName, componentIds, velocityEvery] of storageQueries) {
          const storage = buildStorage(factory(), entityCount, velocityEvery);
          const measured = sample(() => countStorageRows(storage, componentIds));
          rows.push({
            name: `${storageName} ${queryName} ${formatEntityCountName(entityCount)}`,
            entities: entityCount,
            rows: measured.value,
            ms: measured.ms,
            minMs: measured.minMs,
            maxMs: measured.maxMs,
            samples: measured.samples,
            iterations: measured.iterations,
          });
        }

        const componentChurnStorageTarget = buildStorage(factory(), entityCount, 1);
        const componentChurn = sample(() =>
          churnStorageComponents(componentChurnStorageTarget, entityCount),
        );
        rows.push({
          name: `${storageName} component add/remove churn ${formatEntityCountName(entityCount)}`,
          entities: entityCount,
          rows: componentChurn.value,
          ms: componentChurn.ms,
          minMs: componentChurn.minMs,
          maxMs: componentChurn.maxMs,
          samples: componentChurn.samples,
          iterations: componentChurn.iterations,
        });
      }

      const churnStorageTarget = buildStorage(factory(), 1_000, 1);
      const measured = sample(() => churnStorage(churnStorageTarget, 1_000_000));
      rows.push({
        name: `${storageName} entity add/remove churn 1k`,
        entities: 1_000,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const entityCount of storageEntityCounts) {
      const materializationTable = buildSlotMaterializationTable(entityCount);
      const materialized = sample(() => materializeSlotTableRows(materializationTable));
      rows.push({
        name: `slot table row materialization ${formatEntityCountName(entityCount)}`,
        entities: entityCount,
        rows: materialized.value,
        ms: materialized.ms,
        minMs: materialized.minMs,
        maxMs: materialized.maxMs,
        samples: materialized.samples,
        iterations: materialized.iterations,
      });
    }

    for (const entityCount of storageEntityCounts) {
      const churnTable = buildSlotChurnTable(entityCount);
      let nextEntityId = 1_000_000;
      const churn = sample(() => {
        const rowsChurned = churnSlotTableRows(churnTable, nextEntityId);
        nextEntityId += rowsChurned;
        return rowsChurned;
      });
      rows.push({
        name: `slot table add/remove churn ${formatEntityCountName(entityCount)}`,
        entities: entityCount,
        rows: churn.value,
        ms: churn.ms,
        minMs: churn.minMs,
        maxMs: churn.maxMs,
        samples: churn.samples,
        iterations: churn.iterations,
      });
    }

    const tripleEachWorld = buildMixedWorld(50_000, 2);
    const tripleEach = sample(() => touchTriple(tripleEachWorld));
    rows.push({
      name: "triple each 50k",
      entities: 50_000,
      rows: tripleEach.value,
      ms: tripleEach.ms,
      minMs: tripleEach.minMs,
      maxMs: tripleEach.maxMs,
      samples: tripleEach.samples,
      iterations: tripleEach.iterations,
    });

    for (const [name, entityCount, velocityEvery] of [
      ["soa prototype dense move 10k", 10_000, 1],
      ["soa prototype sparse move 10k", 10_000, 20],
      ["soa prototype dense move 50k", 50_000, 1],
      ["soa prototype sparse move 50k", 50_000, 20],
    ] as const) {
      const soa = buildSoAPrototype(entityCount, velocityEvery);
      const measured = sample(() => moveSoAPrototype(soa));
      rows.push({
        name,
        entities: entityCount,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["slot soa prototype dense move 10k", 10_000, 1],
      ["slot soa prototype sparse move 10k", 10_000, 20],
      ["slot soa prototype dense move 50k", 50_000, 1],
      ["slot soa prototype sparse move 50k", 50_000, 20],
    ] as const) {
      const soa = buildSlotBackedSoAPrototype(entityCount, velocityEvery);
      const measured = sample(() => moveSlotBackedSoAPrototype(soa));
      rows.push({
        name,
        entities: entityCount,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["bitecs-style soa dense move 10k", 10_000, 1],
      ["bitecs-style soa sparse move 10k", 10_000, 20],
      ["bitecs-style soa dense move 50k", 50_000, 1],
      ["bitecs-style soa sparse move 50k", 50_000, 20],
    ] as const) {
      const soa = buildBitecsStylePrototype(entityCount, velocityEvery);
      const measured = sample(() => moveBitecsStylePrototype(soa));
      rows.push({
        name,
        entities: entityCount,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["bitecs-0.4 array soa dense move 10k", 10_000, 1],
      ["bitecs-0.4 array soa sparse move 10k", 10_000, 20],
      ["bitecs-0.4 array soa dense move 50k", 50_000, 1],
      ["bitecs-0.4 array soa sparse move 50k", 50_000, 20],
    ] as const) {
      const soa = buildBitecsArrayStylePrototype(entityCount, velocityEvery);
      const measured = sample(() => moveBitecsArrayStylePrototype(soa));
      rows.push({
        name,
        entities: entityCount,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["slot soa snapshot encode dense 10k", 10_000, 1],
      ["slot soa snapshot encode sparse 10k", 10_000, 20],
      ["slot soa snapshot encode dense 50k", 50_000, 1],
      ["slot soa snapshot encode sparse 50k", 50_000, 20],
    ] as const) {
      const soa = buildSlotBackedSoAPrototype(entityCount, velocityEvery);
      let tick = 1;
      const measured = sample(() => {
        moveSlotBackedSoAPrototype(soa);
        return encodeSlotBackedPositionDeltas(soa, tick++);
      });
      rows.push({
        name,
        entities: entityCount,
        rows: soa.velocityRows.length,
        bytes: measured.value.byteLength,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });

      const target = buildSlotBackedSoAPrototype(entityCount, velocityEvery);
      const applied = sample(() => applySlotBackedPositionDeltas(target, measured.value));
      rows.push({
        name: name.replace("encode", "apply"),
        entities: entityCount,
        rows: applied.value,
        bytes: measured.value.byteLength,
        ms: applied.ms,
        minMs: applied.minMs,
        maxMs: applied.maxMs,
        samples: applied.samples,
        iterations: applied.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["slot table move+encode dense 10k", 10_000, 1],
      ["slot table move+encode sparse 10k", 10_000, 20],
      ["slot table move+encode dense 50k", 50_000, 1],
      ["slot table move+encode sparse 50k", 50_000, 20],
    ] as const) {
      const table = buildSlotTablePrototype(entityCount, velocityEvery);
      let tick = 1;
      const measured = sample(() => {
        moveSlotTablePrototype(table);
        return encodeSlotTablePositionDeltas(table, tick++);
      });
      rows.push({
        name,
        entities: entityCount,
        rows: table.queryEids.length,
        bytes: measured.value.byteLength,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });

      const target = buildSlotTablePrototype(entityCount, velocityEvery);
      const applied = sample(() => applySlotTablePositionDeltas(target, measured.value));
      rows.push({
        name: name.replace("move+encode", "apply"),
        entities: entityCount,
        rows: applied.value,
        bytes: measured.value.byteLength,
        ms: applied.ms,
        minMs: applied.minMs,
        maxMs: applied.maxMs,
        samples: applied.samples,
        iterations: applied.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["slot table bulk encode dense 10k", 10_000, 1],
      ["slot table bulk encode sparse 10k", 10_000, 20],
      ["slot table bulk encode dense 50k", 50_000, 1],
      ["slot table bulk encode sparse 50k", 50_000, 20],
    ] as const) {
      const table = buildSlotTablePrototype(entityCount, velocityEvery);
      let tick = 1;
      const measured = sample(() => {
        moveSlotTablePrototype(table);
        return encodeSlotTablePositionDeltasBulk(table, tick++);
      });
      rows.push({
        name,
        entities: entityCount,
        rows: table.queryEids.length,
        bytes: measured.value.byteLength,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });

      const target = buildSlotTablePrototype(entityCount, velocityEvery);
      const applied = sample(() => applySlotTablePositionDeltasBulk(target, measured.value));
      rows.push({
        name: name.replace("encode", "apply"),
        entities: entityCount,
        rows: applied.value,
        bytes: measured.value.byteLength,
        ms: applied.ms,
        minMs: applied.minMs,
        maxMs: applied.maxMs,
        samples: applied.samples,
        iterations: applied.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["slot table pooled bulk encode dense 10k", 10_000, 1],
      ["slot table pooled bulk encode sparse 10k", 10_000, 20],
      ["slot table pooled bulk encode dense 50k", 50_000, 1],
      ["slot table pooled bulk encode sparse 50k", 50_000, 20],
    ] as const) {
      const table = buildSlotTablePrototype(entityCount, velocityEvery);
      const writer = new BitWriter();
      let tick = 1;
      const measured = sample(() => {
        moveSlotTablePrototype(table);
        return encodeSlotTablePositionDeltasBulkPooled(table, tick++, writer);
      });
      rows.push({
        name,
        entities: entityCount,
        rows: table.queryEids.length,
        bytes: measured.value.byteLength,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["slot table byte bulk encode dense 10k", 10_000, 1],
      ["slot table byte bulk encode sparse 10k", 10_000, 20],
      ["slot table byte bulk encode dense 50k", 50_000, 1],
      ["slot table byte bulk encode sparse 50k", 50_000, 20],
    ] as const) {
      const table = buildSlotTablePrototype(entityCount, velocityEvery);
      const writer = new ByteWriter();
      let tick = 1;
      const measured = sample(() => {
        moveSlotTablePrototype(table);
        return encodeSlotTablePositionDeltasBulkByteWriter(table, tick++, writer);
      });
      rows.push({
        name,
        entities: entityCount,
        rows: table.queryEids.length,
        bytes: measured.value.byteLength,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [name, entityCount, velocityEvery] of [
      ["slot table batched encode dense 10k", 10_000, 1],
      ["slot table batched encode sparse 10k", 10_000, 20],
      ["slot table batched encode dense 50k", 50_000, 1],
      ["slot table batched encode sparse 50k", 50_000, 20],
    ] as const) {
      const table = buildSlotTablePrototype(entityCount, velocityEvery);
      const writer = new BitWriter();
      let tick = 1;
      const measured = sample(() => {
        moveSlotTablePrototype(table);
        return encodeSlotTablePositionDeltasBatched(table, tick++, writer);
      });
      rows.push({
        name,
        entities: entityCount,
        rows: table.queryEids.length,
        bytes: measured.value.byteLength,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });

      const target = buildSlotTablePrototype(entityCount, velocityEvery);
      const applied = sample(() => applySlotTablePositionDeltasBatched(target, measured.value));
      rows.push({
        name: name.replace("encode", "apply"),
        entities: entityCount,
        rows: applied.value,
        bytes: measured.value.byteLength,
        ms: applied.ms,
        minMs: applied.minMs,
        maxMs: applied.maxMs,
        samples: applied.samples,
        iterations: applied.iterations,
      });
    }

    for (const [fanoutName, encoder] of [
      ["slot table dirty fanout multi-component", encodeMultiSlotTableDeltas],
      ["slot table dirty fanout batched multi-component", encodeMultiSlotTableDeltasBatched],
    ] as const) {
      for (const peerCount of [1, 8, 32]) {
        const table = buildMultiSlotTablePrototype(1_000, 1);
        const writer = new BitWriter();
        let tick = 1;
        const measured = sample(() => {
          moveMultiSlotTablePrototype(table);
          const bytes = encoder(table, tick++, writer);
          return {
            packets: peerCount,
            bytes: bytes.byteLength * peerCount,
          };
        });
        rows.push({
          name: fanoutName,
          entities: 1_000,
          peers: peerCount,
          rows: measured.value.packets,
          bytes: measured.value.bytes,
          ms: measured.ms,
          minMs: measured.minMs,
          maxMs: measured.maxMs,
          samples: measured.samples,
          iterations: measured.iterations,
        });
      }
    }

    for (const [name, entityCount] of [
      ["slot table dense forEach move 10k", 10_000],
      ["slot table dense forEach move 50k", 50_000],
    ] as const) {
      const table = buildSlotTablePrototype(entityCount, 1);
      const measured = sample(() => moveSlotTableDensePrototype(table));
      rows.push({
        name,
        entities: entityCount,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    for (const [name, world, mode] of [
      ["single query.length 50k", buildMixedWorld(50_000, 2), "single"],
      ["dense pair query.length 50k", buildMixedWorld(50_000, 1), "pair"],
      ["sparse pair query.length 50k", buildMixedWorld(50_000, 20), "pair"],
      ["triple query.length 50k", buildMixedWorld(50_000, 2), "triple"],
    ] as const) {
      const measured = sample(() => queryLength(world, mode), DEFAULT_SAMPLES, 1_000);
      rows.push({
        name,
        entities: 50_000,
        rows: measured.value,
        ms: measured.ms,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    const churnWorld = buildWorld(1_000);
    encodeDirty(churnWorld, 1);
    const churn = sample(() => {
      const spawned = [];
      for (let i = 0; i < 500; i += 1) {
        spawned.push(churnWorld.spawn());
      }
      for (const entity of spawned) {
        churnWorld.add(entity, Position, { x: 0, y: 0 });
        churnWorld.destroy(entity);
      }
      return spawned.length;
    });
    rows.push({
      name: "spawn+destroy churn",
      entities: 1_000,
      rows: churn.value,
      ms: churn.ms,
      minMs: churn.minMs,
      maxMs: churn.maxMs,
      samples: churn.samples,
      iterations: churn.iterations,
    });

    for (const [fanoutName, snapshotEncoding, mutate] of [
      ["host dirty fanout", "default", moveAll],
      ["host dirty fanout batched", "batched", moveAll],
      ["host dirty fanout multi-component", "default", moveAndDampenAll],
      ["host dirty fanout batched multi-component", "batched", moveAndDampenAll],
    ] as const) {
      for (const peerCount of [1, 8, 32]) {
        const transport = new BenchHostTransport(
          Array.from({ length: peerCount }, (_, index) => `peer-${index}`),
        );
        const host = createHostWorld({
          protocol,
          transport,
          clock: clock(),
          snapshotEncoding,
        });
        for (let i = 0; i < 1_000; i += 1) {
          const entity = host.spawn();
          host.add(entity, Position, { x: i, y: -i });
          host.add(entity, Velocity, { x: 1, y: -1 });
        }
        host.tick();
        if (snapshotEncoding === "batched") {
          advertiseBatchedSnapshotSupport(transport);
        }
        transport.sent.splice(0);
        const fanout = sample(() => {
          transport.sent.splice(0);
          mutate(host);
          host.tick();
          return {
            packets: transport.sent.length,
            bytes: transport.sent.reduce((total, packet) => total + packet.bytes.byteLength, 0),
          };
        });
        rows.push({
          name: fanoutName,
          entities: 1_000,
          peers: peerCount,
          rows: fanout.value.packets,
          bytes: fanout.value.bytes,
          ms: fanout.ms,
          minMs: fanout.minMs,
          maxMs: fanout.maxMs,
          samples: fanout.samples,
          iterations: fanout.iterations,
        });
      }
    }

    for (const [fanoutName, snapshotEncoding, mutate] of [
      ["slot-backed host dirty fanout", "default", moveAll],
      ["slot-backed host dirty fanout batched", "batched", moveAll],
      ["slot-backed host dirty fanout multi-component", "default", moveAndDampenAll],
      ["slot-backed host dirty fanout batched multi-component", "batched", moveAndDampenAll],
    ] as const) {
      for (const peerCount of [1, 8, 32]) {
        const transport = new BenchHostTransport(
          Array.from({ length: peerCount }, (_, index) => `peer-${index}`),
        );
        const host = createHostWorldForStorageBenchmark(
          {
            protocol,
            transport,
            clock: clock(),
            snapshotEncoding,
          },
          new SlotBackedComponentStorage(),
        );
        for (let i = 0; i < 1_000; i += 1) {
          const entity = host.spawn();
          host.add(entity, Position, { x: i, y: -i });
          host.add(entity, Velocity, { x: 1, y: -1 });
        }
        host.tick();
        if (snapshotEncoding === "batched") {
          advertiseBatchedSnapshotSupport(transport);
        }
        transport.sent.splice(0);
        const fanout = sample(() => {
          transport.sent.splice(0);
          mutate(host);
          host.tick();
          return {
            packets: transport.sent.length,
            bytes: transport.sent.reduce((total, packet) => total + packet.bytes.byteLength, 0),
          };
        });
        rows.push({
          name: fanoutName,
          entities: 1_000,
          peers: peerCount,
          rows: fanout.value.packets,
          bytes: fanout.value.bytes,
          ms: fanout.ms,
          minMs: fanout.minMs,
          maxMs: fanout.maxMs,
          samples: fanout.samples,
          iterations: fanout.iterations,
        });
      }
    }

    report(rows);
    expect(
      rows.every(
        (row) =>
          Number.isFinite(row.ms) &&
          Number.isFinite(row.minMs) &&
          Number.isFinite(row.maxMs) &&
          row.ms >= 0 &&
          row.minMs >= 0 &&
          row.maxMs >= row.minMs,
      ),
    ).toBe(true);
  }, 15_000);
});

function advertiseBatchedSnapshotSupport(transport: BenchHostTransport): void {
  let helloTick = 1;
  for (const peer of transport.peerList) {
    transport.receive(
      peer,
      "reliable",
      encodeControl(ControlType.Hello, helloTick++, ControlCapability.BatchedSnapshots),
    );
  }
}
