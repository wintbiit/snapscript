import { Bench, hrtimeNow } from "tinybench";
import { describe, expect, it } from "vitest";
import {
  defineComponent,
  defineProtocol,
  qf32,
  u16,
  type ClientWorld,
  type ComponentSchema,
} from "../src/index";
import { createRegistry } from "../src/registry/index";
import { applySnapshot, encodeDirty } from "../src/sync/index";
import type { ComponentRecord } from "../src/world/records";
import {
  MapComponentStorage,
  SparseSetComponentStorage,
  type ComponentStorage,
} from "../src/world/storage";
import { createTestClientWorld, createTestHostWorld } from "./helpers";

interface BranchBenchRow {
  readonly name: string;
  readonly entities: number;
  readonly rows?: number;
  readonly bytes?: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly samples: number;
  readonly iterations: number;
}

const DEFAULT_SAMPLES = 9;
const DEFAULT_WARMUPS = 2;
const DEFAULT_BENCH_TIME_MS = Math.max(
  1,
  Number.parseInt(process.env.BENCH_TIME_MS ?? "20", 10),
);
const DEFAULT_BENCH_WARMUP_TIME_MS = Math.max(
  0,
  Number.parseInt(process.env.BENCH_WARMUP_TIME_MS ?? "5", 10),
);

const Position = defineComponent("BranchBenchPosition", {
  x: qf32({ min: -100_000, max: 100_000, precision: 0.01, default: 0 }),
  y: qf32({ min: -100_000, max: 100_000, precision: 0.01, default: 0 }),
});

const Velocity = defineComponent("BranchBenchVelocity", {
  x: qf32({ min: -1_000, max: 1_000, precision: 0.01, default: 0 }),
  y: qf32({ min: -1_000, max: 1_000, precision: 0.01, default: 0 }),
});

const Health = defineComponent("BranchBenchHealth", {
  hp: u16(100),
});

const Team = defineComponent("BranchBenchTeam", {
  id: u16(0),
});

const ChurnFlag = defineComponent("BranchBenchChurnFlag", {
  value: u16(1),
});

const protocol = defineProtocol({
  components: { Position, Velocity, Health },
});

const registry = createRegistry()
  .registerComponent(Position)
  .registerComponent(Velocity)
  .registerComponent(Health);

async function sample<T>(
  fn: () => T,
  samples = DEFAULT_SAMPLES,
  iterations = 1,
  warmups = DEFAULT_WARMUPS,
): Promise<{
  readonly value: T;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly samples: number;
  readonly iterations: number;
}> {
  let value: T | undefined;
  const minIterations = Math.max(iterations, samples);
  const bench = new Bench({
    iterations: minIterations,
    now: hrtimeNow,
    throws: true,
    time: Math.max(DEFAULT_BENCH_TIME_MS, samples),
    warmupIterations: warmups,
    warmupTime: warmups === 0 ? 0 : DEFAULT_BENCH_WARMUP_TIME_MS,
  });

  bench.add("sample", () => {
    value = fn();
  });

  if (warmups > 0 || DEFAULT_BENCH_WARMUP_TIME_MS > 0) {
    await bench.warmup();
  }

  const [task] = await bench.run();
  const result = task?.result;
  if (result === undefined || result.error !== undefined) {
    throw result?.error ?? new Error("Benchmark sample did not produce a result");
  }

  return {
    value: value as T,
    medianMs: median(result.samples),
    minMs: result.min,
    maxMs: result.max,
    samples: result.samples.length,
    iterations: minIterations,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function buildWorld(entityCount: number) {
  const world = createTestHostWorld(protocol);
  for (let index = 0; index < entityCount; index += 1) {
    const entity = world.spawn();
    world.add(entity, Position, { x: index, y: -index });
    world.add(entity, Velocity, { x: 1, y: -1 });
    world.add(entity, Health, { hp: 100 });
  }
  return world;
}

function buildMixedWorld(entityCount: number, velocityEvery: number) {
  const world = createTestHostWorld(protocol);
  for (let index = 0; index < entityCount; index += 1) {
    const entity = world.spawn();
    world.add(entity, Position, { x: index, y: -index });
    if (index % velocityEvery === 0) {
      world.add(entity, Velocity, { x: 1, y: -1 });
    }
    if (index % 3 === 0) {
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
  for (let index = 0; index < entityCount; index += 1) {
    const entityId = index + 1;
    storage.addEntity(entityId);
    storage.set(entityId, Position.schemaId, storageRecord(entityId, Position));
    if (index % velocityEvery === 0) {
      storage.set(entityId, Velocity.schemaId, storageRecord(entityId, Velocity));
    }
    if (index % 3 === 0) {
      storage.set(entityId, Health.schemaId, storageRecord(entityId, Health));
    }
    if (index % 7 === 0) {
      storage.set(entityId, Team.schemaId, storageRecord(entityId, Team));
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

function countQuery(
  world: ReturnType<typeof createTestHostWorld>,
  mode: "single" | "pair" | "triple",
): number {
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

function countStorageRows(storage: ComponentStorage, componentIds: readonly number[]): number {
  let rows = 0;
  for (const _row of storage.queryRows(componentIds)) {
    rows += 1;
  }
  return rows;
}

function churnStorageComponents(storage: ComponentStorage, entityCount: number): number {
  for (let index = 0; index < 500; index += 1) {
    const entityId = (index % entityCount) + 1;
    storage.set(entityId, ChurnFlag.schemaId, storageRecord(entityId, ChurnFlag));
    storage.remove(entityId, ChurnFlag.schemaId);
  }
  return 500;
}

function readonlyPairEach(world: ClientWorld): number {
  let rows = 0;
  world.each([Position, Health] as const, (_entity, pos, health) => {
    rows += pos.x.value + health.hp.value >= 0 ? 1 : 0;
  });
  return rows;
}

function report(rows: readonly BranchBenchRow[]): void {
  console.info(`\nSnapScript branch benchmark (${new Date().toISOString()})`);
  for (const row of rows) {
    console.info(`[branch-bench-summary] ${JSON.stringify(row)}`);
    const details = [
      `entities=${row.entities}`,
      row.rows === undefined ? undefined : `rows=${row.rows}`,
      row.bytes === undefined ? undefined : `bytes=${row.bytes}`,
      `medianMs=${formatMs(row.medianMs)}`,
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

describe("branch comparable benchmark", () => {
  it("measures common world, query, storage, and readonly paths", async () => {
    const rows: BranchBenchRow[] = [];

    for (const entityCount of [1_000, 10_000]) {
      const source = buildWorld(entityCount);
      const target = createTestClientWorld(protocol);
      applySnapshot(target, encodeDirty(source, 1), registry);

      const moved = await sample(() => moveAll(source));
      rows.push({
        name: "each+mutate",
        entities: entityCount,
        rows: moved.value,
        medianMs: moved.medianMs,
        minMs: moved.minMs,
        maxMs: moved.maxMs,
        samples: moved.samples,
        iterations: moved.iterations,
      });

      let tick = 2;
      const encoded = await sample(() => {
        moveAll(source);
        return encodeDirty(source, tick++);
      });
      rows.push({
        name: "encode dirty",
        entities: entityCount,
        bytes: encoded.value.byteLength,
        medianMs: encoded.medianMs,
        minMs: encoded.minMs,
        maxMs: encoded.maxMs,
        samples: encoded.samples,
        iterations: encoded.iterations,
      });

      const applied = await sample(() => applySnapshot(target, encoded.value, registry));
      rows.push({
        name: "apply dirty",
        entities: entityCount,
        bytes: encoded.value.byteLength,
        medianMs: applied.medianMs,
        minMs: applied.minMs,
        maxMs: applied.maxMs,
        samples: applied.samples,
        iterations: applied.iterations,
      });
    }

    for (const [name, world, mode] of [
      ["single query 50k", buildMixedWorld(50_000, 2), "single"],
      ["dense pair query 50k", buildMixedWorld(50_000, 1), "pair"],
      ["sparse pair query 50k", buildMixedWorld(50_000, 20), "pair"],
      ["triple query 50k", buildMixedWorld(50_000, 2), "triple"],
    ] as const) {
      const measured = await sample(() => countQuery(world, mode));
      rows.push({
        name,
        entities: 50_000,
        rows: measured.value,
        medianMs: measured.medianMs,
        minMs: measured.minMs,
        maxMs: measured.maxMs,
        samples: measured.samples,
        iterations: measured.iterations,
      });
    }

    const readonlySource = buildWorld(50_000);
    const readonlyTarget = createTestClientWorld(protocol);
    applySnapshot(readonlyTarget, encodeDirty(readonlySource, 1), registry);
    const readonlyMeasured = await sample(() => readonlyPairEach(readonlyTarget));
    rows.push({
      name: "client readonly pair each 50k",
      entities: 50_000,
      rows: readonlyMeasured.value,
      medianMs: readonlyMeasured.medianMs,
      minMs: readonlyMeasured.minMs,
      maxMs: readonlyMeasured.maxMs,
      samples: readonlyMeasured.samples,
      iterations: readonlyMeasured.iterations,
    });

    const storageFactories = [
      ["map storage", () => new MapComponentStorage()],
      ["sparse storage", () => new SparseSetComponentStorage({ archetypeIndex: false })],
      ["sparse+archetype storage", () => new SparseSetComponentStorage()],
    ] as const;
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
      for (const entityCount of [10_000, 50_000] as const) {
        for (const [queryName, componentIds, velocityEvery] of storageQueries) {
          const storage = buildStorage(factory(), entityCount, velocityEvery);
          const measured = await sample(() => countStorageRows(storage, componentIds));
          rows.push({
            name: `${storageName} ${queryName} ${formatEntityCountName(entityCount)}`,
            entities: entityCount,
            rows: measured.value,
            medianMs: measured.medianMs,
            minMs: measured.minMs,
            maxMs: measured.maxMs,
            samples: measured.samples,
            iterations: measured.iterations,
          });
        }

        const churnTarget = buildStorage(factory(), entityCount, 1);
        const churn = await sample(() => churnStorageComponents(churnTarget, entityCount));
        rows.push({
          name: `${storageName} component add/remove churn ${formatEntityCountName(entityCount)}`,
          entities: entityCount,
          rows: churn.value,
          medianMs: churn.medianMs,
          minMs: churn.minMs,
          maxMs: churn.maxMs,
          samples: churn.samples,
          iterations: churn.iterations,
        });
      }
    }

    const tripleEachWorld = buildMixedWorld(50_000, 2);
    const tripleEach = await sample(() => touchTriple(tripleEachWorld));
    rows.push({
      name: "triple each 50k",
      entities: 50_000,
      rows: tripleEach.value,
      medianMs: tripleEach.medianMs,
      minMs: tripleEach.minMs,
      maxMs: tripleEach.maxMs,
      samples: tripleEach.samples,
      iterations: tripleEach.iterations,
    });

    report(rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (row) =>
          Number.isFinite(row.medianMs) &&
          Number.isFinite(row.minMs) &&
          Number.isFinite(row.maxMs) &&
          row.medianMs >= 0 &&
          row.minMs >= 0 &&
          row.maxMs >= row.minMs,
      ),
    ).toBe(true);
  }, 120_000);
});
