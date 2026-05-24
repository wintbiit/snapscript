import { describe, expect, it } from "vitest";
import {
  defineComponent,
  defineProtocol,
  createServerWorld,
  qf32,
  type ChannelName,
  type Clock,
  type ServerTransport,
  type ServerWorld,
  type PeerRef,
  u16,
} from "../packages/snapscript/src/index";
import { encodeDirty } from "../packages/snapscript/src/sync/index";

interface MemorySample {
  readonly scenario: string;
  readonly entities: number;
  readonly storage: string;
  readonly buildHeap: {
    readonly valueBytes: number;
    readonly clamped: boolean;
  };
  readonly buildRss: {
    readonly valueBytes: number;
    readonly clamped: boolean;
  };
  readonly encodeHeap: {
    readonly valueBytes: number;
    readonly clamped: boolean;
  };
  readonly encodeRss: {
    readonly valueBytes: number;
    readonly clamped: boolean;
  };
}

interface MemorySummary {
  readonly scenario: string;
  readonly entities: number;
  readonly storage: string;
  readonly iterations: number;
  readonly warmup: number;
  readonly samples: number;
  readonly buildHeapMedianBytes: number;
  readonly buildHeapP95Bytes: number;
  readonly buildRssMedianBytes: number;
  readonly buildRssP95Bytes: number;
  readonly encodeHeapMedianBytes: number;
  readonly encodeHeapP95Bytes: number;
  readonly encodeRssMedianBytes: number;
  readonly encodeRssP95Bytes: number;
  readonly clamped: {
    readonly buildHeap: number;
    readonly buildRss: number;
    readonly encodeHeap: number;
    readonly encodeRss: number;
  };
}

type BenchmarkStorage = never;

const ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env.BENCH_MEMORY_ITERATIONS ?? "5", 10),
);
const WARMUP_ITERATIONS = Math.max(
  0,
  Number.parseInt(process.env.BENCH_MEMORY_WARMUP ?? "2", 10),
);
const GC_ROUNDS = Math.max(1, Number.parseInt(process.env.BENCH_MEMORY_GC_ROUNDS ?? "2", 10));

const Position = defineComponent("MemBenchPosition", {
  x: qf32({ min: -100_000, max: 100_000, precision: 0.01, default: 0 }),
  y: qf32({ min: -100_000, max: 100_000, precision: 0.01, default: 0 }),
});

const Velocity = defineComponent("MemBenchVelocity", {
  x: qf32({ min: -1_000, max: 1_000, precision: 0.01, default: 0 }),
  y: qf32({ min: -1_000, max: 1_000, precision: 0.01, default: 0 }),
});

const Health = defineComponent("MemBenchHealth", {
  hp: u16(100),
});

const memProtocol = defineProtocol({ components: { Position, Velocity, Health } });
const storageVariants: Array<readonly [string, () => BenchmarkStorage | undefined]> = [];
storageVariants.push(["default storage", () => undefined]);

class MemoryServerTransport implements ServerTransport {
  send(_peer: PeerRef, _channel: ChannelName, _bytes: Uint8Array): void {}
  broadcast(_channel: ChannelName, _bytes: Uint8Array): void {}
  onPacket(_cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void {}
  peers(): Iterable<PeerRef> {
    return [];
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

function buildWorld(entityCount: number, _storage: BenchmarkStorage | undefined): ServerWorld {
  const world = createServerWorld(
    {
      protocol: memProtocol,
      transport: new MemoryServerTransport(),
      clock: clock(),
    },
  );

  for (let entityId = 1; entityId <= entityCount; entityId += 1) {
    const entity = world.spawn();
    world.add(entity, Position, { x: entityId, y: -entityId });
    world.add(entity, Velocity, { x: 1, y: -1 });
    world.add(entity, Health, { hp: 100 });
  }

  return world;
}

function mutateForDirty(world: ServerWorld): void {
  world.each([Position, Velocity], (_entity, pos, vel) => {
    pos.x.value += vel.x.value;
    pos.y.value += vel.y.value;
  });
}

function collectMemorySample(): { heapUsed: number; rss: number } | undefined {
  const globalProcess = globalThis.process;
  if (globalProcess === undefined || typeof globalProcess.memoryUsage !== "function") {
    return undefined;
  }

  const usage = globalProcess.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    rss: usage.rss,
  };
}

function forceGc(): void {
  const globalGc = (globalThis as { gc?: () => void }).gc;
  if (typeof globalGc === "function") {
    for (let i = 0; i < GC_ROUNDS; i += 1) {
      globalGc();
    }
  }
}

function clampNegativeDelta(deltaBytes: number): { valueBytes: number; clamped: boolean } {
  if (deltaBytes >= 0) {
    return { valueBytes: deltaBytes, clamped: false };
  }
  return { valueBytes: 0, clamped: true };
}

function safeMemoryDelta(after: number, before: number): number {
  return after - before;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index]!;
}

function summarizeBytes(
  rows: readonly number[],
  clampedRows: readonly boolean[],
): {
  readonly median: number;
  readonly p95: number;
  readonly clamped: number;
} {
  return {
    median: median(rows),
    p95: quantile(rows, 0.95),
    clamped: clampedRows.filter((value) => value).length,
  };
}

function formatBytes(value: number): string {
  return `${Math.round(value / 1024)} KiB`;
}

function formatMemorySample(sample: MemorySummary): void {
  console.info(`[memory-summary] ${JSON.stringify(sample)}`);
  console.info(
    `[memory] ${sample.scenario} entities=${sample.entities} storage=${sample.storage} ` +
      `buildΔheap p50=${formatBytes(sample.buildHeapMedianBytes)} p95=${formatBytes(sample.buildHeapP95Bytes)} ` +
      `encodeΔheap p50=${formatBytes(sample.encodeHeapMedianBytes)} p95=${formatBytes(sample.encodeHeapP95Bytes)} ` +
      `clamped-build=${sample.clamped.buildHeap}/${sample.samples} encode=${sample.clamped.encodeHeap}/${sample.samples}`,
  );
}

function summarizeScenario(
  scenario: string,
  entities: number,
  storage: string,
  samples: readonly MemorySample[],
): MemorySummary {
  const buildHeapValues = samples.map((sample) => sample.buildHeap.valueBytes);
  const buildHeapSummary = summarizeBytes(
    buildHeapValues,
    samples.map((sample) => sample.buildHeap.clamped),
  );
  const buildRssValues = samples.map((sample) => sample.buildRss.valueBytes);
  const buildRssSummary = summarizeBytes(
    buildRssValues,
    samples.map((sample) => sample.buildRss.clamped),
  );
  const encodeHeapValues = samples.map((sample) => sample.encodeHeap.valueBytes);
  const encodeHeapSummary = summarizeBytes(
    encodeHeapValues,
    samples.map((sample) => sample.encodeHeap.clamped),
  );
  const encodeRssValues = samples.map((sample) => sample.encodeRss.valueBytes);
  const encodeRssSummary = summarizeBytes(
    encodeRssValues,
    samples.map((sample) => sample.encodeRss.clamped),
  );

  return {
    scenario,
    entities,
    storage,
    iterations: ITERATIONS,
    warmup: WARMUP_ITERATIONS,
    samples: samples.length,
    buildHeapMedianBytes: buildHeapSummary.median,
    buildHeapP95Bytes: buildHeapSummary.p95,
    buildRssMedianBytes: buildRssSummary.median,
    buildRssP95Bytes: buildRssSummary.p95,
    encodeHeapMedianBytes: encodeHeapSummary.median,
    encodeHeapP95Bytes: encodeHeapSummary.p95,
    encodeRssMedianBytes: encodeRssSummary.median,
    encodeRssP95Bytes: encodeRssSummary.p95,
    clamped: {
      buildHeap: buildHeapSummary.clamped,
      buildRss: buildRssSummary.clamped,
      encodeHeap: encodeHeapSummary.clamped,
      encodeRss: encodeRssSummary.clamped,
    },
  };
}

describe("benchmark memory dimensions", () => {
  it("compares storage and encode memory footprints", () => {
    if (collectMemorySample() === undefined) {
      return;
    }

    const rows: MemorySummary[] = [];
    const entityCounts = [10_000, 50_000];
    const totalIterations = ITERATIONS + WARMUP_ITERATIONS;

    for (const entities of entityCounts) {
      for (const [storageName, createStorage] of storageVariants) {
        const samples: MemorySample[] = [];

        for (let iteration = 0; iteration < totalIterations; iteration += 1) {
          forceGc();
          const beforeBuild = collectMemorySample();
          if (beforeBuild === undefined) {
            continue;
          }

          const world = buildWorld(entities, createStorage());
          forceGc();
          const afterBuild = collectMemorySample();
          if (afterBuild === undefined) {
            continue;
          }

          forceGc();
          const beforeEncode = collectMemorySample();
          if (beforeEncode === undefined) {
            continue;
          }

          mutateForDirty(world);
          const bytes = encodeDirty(world, 2);
          expect(bytes.byteLength).toBeGreaterThan(0);
          forceGc();
          const afterEncode = collectMemorySample();
          if (afterEncode === undefined) {
            continue;
          }

          if (iteration >= WARMUP_ITERATIONS) {
            const buildHeap = clampNegativeDelta(safeMemoryDelta(afterBuild.heapUsed, beforeBuild.heapUsed));
            const buildRss = clampNegativeDelta(safeMemoryDelta(afterBuild.rss, beforeBuild.rss));
            const encodeHeap = clampNegativeDelta(safeMemoryDelta(afterEncode.heapUsed, beforeEncode.heapUsed));
            const encodeRss = clampNegativeDelta(safeMemoryDelta(afterEncode.rss, beforeEncode.rss));
            samples.push({
              scenario: "build+components",
              entities,
              storage: storageName,
              buildHeap,
              buildRss,
              encodeHeap,
              encodeRss,
            });
          }
        }

        if (samples.length === 0) {
          continue;
        }

        const summary = summarizeScenario("build+components", entities, storageName, samples);
        rows.push(summary);
        formatMemorySample(summary);
      }
    }

    expect(rows).toHaveLength(entityCounts.length * storageVariants.length);
    for (const row of rows) {
      if (row.samples !== ITERATIONS) {
        console.warn(`[memory] summary samples mismatch for ${row.storage} ${row.entities}: ${row.samples}/${ITERATIONS}`);
      }
      expect(row.samples).toBeGreaterThanOrEqual(1);
      expect(row.buildHeapMedianBytes).toBeGreaterThanOrEqual(0);
      expect(row.buildRssMedianBytes).toBeGreaterThanOrEqual(0);
      expect(row.encodeHeapMedianBytes).toBeGreaterThanOrEqual(0);
      expect(row.encodeRssMedianBytes).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);
});
