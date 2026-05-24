import { describe, expect, it } from "vitest";
import {
  createHostWorld,
  defineComponent,
  defineProtocol,
  qf32,
  u16,
  type ChannelName,
  type Clock,
  type ComponentSchema,
  type HostTransport,
  type PeerRef,
} from "../src/index";
import { createRegistry } from "../src/registry/index";
import { applySnapshot, encodeDirty, encodeDirtyBatched } from "../src/sync/index";
import type { ComponentRecord } from "../src/world/records";
import {
  MapComponentStorage,
  SparseSetComponentStorage,
  type ComponentStorage,
} from "../src/world/storage";
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

function moveAll(world: ReturnType<typeof createTestHostWorld>): number {
  let rows = 0;
  world.each([Position, Velocity] as const, (_entity, pos, vel) => {
    pos.x.value += vel.x.value;
    pos.y.value += vel.y.value;
    rows += 1;
  });
  return rows;
}

function touchTriple(world: ReturnType<typeof createTestHostWorld>): number {
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

function countStorageRows(storage: ComponentStorage, componentIds: readonly number[]): number {
  let rows = 0;
  for (const _row of storage.queryRows(componentIds)) {
    rows += 1;
  }
  return rows;
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

    for (const peerCount of [1, 8, 32]) {
      const transport = new BenchHostTransport(
        Array.from({ length: peerCount }, (_, index) => `peer-${index}`),
      );
      const host = createHostWorld({
        protocol,
        transport,
        clock: clock(),
      });
      for (let i = 0; i < 1_000; i += 1) {
        const entity = host.spawn();
        host.add(entity, Position, { x: i, y: -i });
        host.add(entity, Velocity, { x: 1, y: -1 });
      }
      host.tick();
      transport.sent.splice(0);
      const fanout = sample(() => {
        transport.sent.splice(0);
        moveAll(host);
        host.tick();
        return {
          packets: transport.sent.length,
          bytes: transport.sent.reduce((total, packet) => total + packet.bytes.byteLength, 0),
        };
      });
      rows.push({
        name: "host dirty fanout",
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
  }, 30_000);
});
