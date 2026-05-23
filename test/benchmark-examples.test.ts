import { Bench, hrtimeNow } from "tinybench";
import { describe, expect, it } from "vitest";
import type {
  ChannelName,
  Clock,
  ClientWorld,
  ClientTransport,
  ComponentQuery,
  HostTransport,
  HostWorld,
  PeerRef,
} from "snapscript";
import { createClientWorld, createHostWorld } from "snapscript";
import {
  Health,
  Player,
  Position,
  protocol,
  Velocity,
} from "../examples/ecs/src/ecs-demo";

interface ExampleBenchRow {
  readonly name: string;
  readonly entities: number;
  readonly mode: string;
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
const COMPARE_COMPAT_MODE = process.env.SNAPSCRIPT_BRANCH_COMPARE === "1";

interface EcsBenchMode {
  readonly label: string;
  readonly snapshotEncoding?: "default" | "batched";
}

class ExampleBenchTransport implements ClientTransport, HostTransport {
  peer?: ExampleBenchTransport;
  readonly peerId: PeerRef = {};
  connected = true;
  error: string | undefined;
  sent = 0;
  received = 0;
  lastChannel: ChannelName | undefined;
  #clientHandler?: (channel: ChannelName, bytes: Uint8Array) => void;
  #hostHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  connect(): void {
    this.connected = true;
  }

  close(): void {
    this.connected = false;
  }

  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  send(a: PeerRef | ChannelName, b: ChannelName | Uint8Array, c?: Uint8Array): void {
    const channel = c === undefined ? (a as ChannelName) : (b as ChannelName);
    const bytes = c ?? (b as Uint8Array);
    this.sent += bytes.byteLength;
    this.lastChannel = channel;
    this.peer?.receive(this.peerId, channel, bytes);
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    this.send(channel, bytes);
  }

  peers(): Iterable<PeerRef> {
    return [this.peerId];
  }

  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void;
  onPacket(
    cb:
      | ((channel: ChannelName, bytes: Uint8Array) => void)
      | ((peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void),
  ): void {
    if (cb.length >= 3) {
      this.#hostHandler = cb as (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
    } else {
      this.#clientHandler = cb as (channel: ChannelName, bytes: Uint8Array) => void;
    }
  }

  receive(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    this.received += bytes.byteLength;
    this.lastChannel = channel;
    this.#clientHandler?.(channel, bytes);
    this.#hostHandler?.(peer, channel, bytes);
  }

  resetCounters(): void {
    this.sent = 0;
    this.received = 0;
    this.lastChannel = undefined;
  }
}

class ExampleBenchClock implements Clock {
  #tick = 0;

  nowMs(): number {
    return this.#tick * 16.666;
  }

  tick(): number {
    this.#tick += 1;
    return this.#tick;
  }
}

function transportPair(): [ExampleBenchTransport, ExampleBenchTransport] {
  const host = new ExampleBenchTransport();
  const client = new ExampleBenchTransport();
  host.peer = client;
  client.peer = host;
  return [host, client];
}

async function sample<T>(
  fn: () => T,
  samples = DEFAULT_SAMPLES,
  iterations = 1,
  warmups = DEFAULT_WARMUPS,
  hooks: {
    readonly beforeEach?: () => void;
    readonly afterEach?: () => void;
  } = {},
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

  bench.add(
    "sample",
    () => {
      value = fn();
    },
    hooks,
  );

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

function createEcsBenchPair(extraEntities: number, mode: EcsBenchMode): {
  readonly host: HostWorld;
  readonly client: ClientWorld;
  readonly hostTransport: ExampleBenchTransport;
  readonly clientTransport: ExampleBenchTransport;
} {
  const [hostTransport, clientTransport] = transportPair();
  const hostOptions = {
    protocol,
    transport: hostTransport,
    clock: new ExampleBenchClock(),
    visibility: "all",
    ...(mode.snapshotEncoding === undefined ? {} : { snapshotEncoding: mode.snapshotEncoding }),
  } as Parameters<typeof createHostWorld>[0];
  const host = createHostWorld({
    ...hostOptions,
  });
  const client = createClientWorld({
    protocol,
    transport: clientTransport,
    clock: new ExampleBenchClock(),
  });

  seedDefaultExampleActors(host);
  seedExtraExampleActors(host, extraEntities);
  host.system("movement", "update", (world) => {
    runExampleMovement(world);
  });

  client.tick();
  host.tick();
  client.tick();
  hostTransport.resetCounters();
  clientTransport.resetCounters();
  return { host, client, hostTransport, clientTransport };
}

const MovementQuery = [Position, Velocity] as const satisfies ComponentQuery;
const RenderQuery = [Position, Health] as const satisfies ComponentQuery;

function seedDefaultExampleActors(world: HostWorld): void {
  world.spawn(Player, {
    position: { x: -4, y: 0 },
    health: { hp: 100 },
  });
  const npc = world.spawn();
  world.add(npc, Player, {
    position: { x: 5, y: 2 },
    velocity: { x: -0.02, y: 0 },
    health: { hp: 60 },
  });
}

function seedExtraExampleActors(world: HostWorld, count: number): void {
  for (let index = 0; index < count; index += 1) {
    world.spawn(Player, {
      position: {
        x: (index % 64) - 32,
        y: Math.floor(index / 64) % 64,
      },
      velocity: {
        x: index % 2 === 0 ? 0.02 : -0.02,
        y: index % 3 === 0 ? 0.01 : -0.01,
      },
      health: {
        hp: 100 - (index % 40),
      },
    });
  }
}

function runExampleMovement(world: HostWorld): number {
  let rows = 0;
  world.each(MovementQuery, (_entity, pos, vel) => {
    pos.x.value += vel.x.value;
    pos.y.value += vel.y.value;
    vel.x.value *= 0.92;
    vel.y.value *= 0.92;
    rows += 1;
  });
  return rows;
}

function countExampleRenderViews(world: ClientWorld): number {
  let rows = 0;
  world.each(RenderQuery, () => {
    rows += 1;
  });
  return rows;
}

function runNetworkedFrame(host: HostWorld, client: ClientWorld): number {
  host.tick();
  client.tick();
  return countExampleRenderViews(client);
}

function runHostTickSend(host: HostWorld, hostTransport: ExampleBenchTransport): number {
  hostTransport.resetCounters();
  host.tick();
  return hostTransport.sent;
}

function runClientTickApply(client: ClientWorld): void {
  client.tick();
}

function report(rows: readonly ExampleBenchRow[]): void {
  console.info(`\nSnapScript examples benchmark (${new Date().toISOString()})`);
  for (const row of rows) {
    console.info(`[example-bench-summary] ${JSON.stringify(row)}`);
    const details = [
      `entities=${row.entities}`,
      `mode=${row.mode}`,
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

describe("example-derived benchmark", () => {
  it("measures ECS example host, sync, and render paths", async () => {
    const rows: ExampleBenchRow[] = [];
    const modes: EcsBenchMode[] = [
      { label: "default-compatible" },
      ...(COMPARE_COMPAT_MODE
        ? []
        : [{ label: "batched-opt-in", snapshotEncoding: "batched" as const }]),
    ];

    for (const mode of modes) {
      for (const extraEntities of [1_000, 10_000]) {
        const totalEntities = extraEntities + 2;
        const { host, client, hostTransport } = createEcsBenchPair(extraEntities, mode);

        const movement = await sample(() => runExampleMovement(host));
        rows.push({
          name: "ecs example movement system",
          entities: totalEntities,
          mode: mode.label,
          rows: movement.value,
          medianMs: movement.medianMs,
          minMs: movement.minMs,
          maxMs: movement.maxMs,
          samples: movement.samples,
          iterations: movement.iterations,
        });

        const render = await sample(() => countExampleRenderViews(client));
        rows.push({
          name: "ecs example client render views",
          entities: totalEntities,
          mode: mode.label,
          rows: render.value,
          medianMs: render.medianMs,
          minMs: render.minMs,
          maxMs: render.maxMs,
          samples: render.samples,
          iterations: render.iterations,
        });

        const hostSend = await sample(
          () => runHostTickSend(host, hostTransport),
          DEFAULT_SAMPLES,
          1,
          DEFAULT_WARMUPS,
          {
            afterEach: () => {
              client.tick();
            },
          },
        );
        rows.push({
          name: "ecs example host tick send",
          entities: totalEntities,
          mode: mode.label,
          rows: totalEntities,
          bytes: hostSend.value,
          medianMs: hostSend.medianMs,
          minMs: hostSend.minMs,
          maxMs: hostSend.maxMs,
          samples: hostSend.samples,
          iterations: hostSend.iterations,
        });

        const clientApply = await sample(
          () => {
            runClientTickApply(client);
            return hostTransport.sent;
          },
          DEFAULT_SAMPLES,
          1,
          DEFAULT_WARMUPS,
          {
            beforeEach: () => {
              client.tick();
              hostTransport.resetCounters();
              host.tick();
            },
          },
        );
        rows.push({
          name: "ecs example client tick apply",
          entities: totalEntities,
          mode: mode.label,
          rows: totalEntities,
          bytes: clientApply.value,
          medianMs: clientApply.medianMs,
          minMs: clientApply.minMs,
          maxMs: clientApply.maxMs,
          samples: clientApply.samples,
          iterations: clientApply.iterations,
        });

        const networked = await sample(() => {
          hostTransport.resetCounters();
          const renderedRows = runNetworkedFrame(host, client);
          return { renderedRows, bytes: hostTransport.sent };
        });
        rows.push({
          name: "ecs example host tick sync client render",
          entities: totalEntities,
          mode: mode.label,
          rows: networked.value.renderedRows,
          bytes: networked.value.bytes,
          medianMs: networked.medianMs,
          minMs: networked.minMs,
          maxMs: networked.maxMs,
          samples: networked.samples,
          iterations: networked.iterations,
        });
      }
    }

    report(rows);
    expect(rows).toHaveLength(modes.length * 10);
    expect(
      rows.some((row) => row.name === "ecs example movement system" && row.rows === row.entities),
    ).toBe(true);
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
