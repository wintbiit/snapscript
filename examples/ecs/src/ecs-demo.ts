import {
  bool,
  createClientWorld,
  createServerWorld,
  WorldEntity,
  defineCommand,
  defineComponent,
  defineEntity,
  defineEvent,
  defineProtocol,
  qf32,
  u16,
  varu32,
  type ChannelName,
  type ClientTransport,
  type Clock,
  type ComponentQuery,
  type EntityRef,
  type ServerTransport,
  type PeerRef,
  type ClientWorld,
  type ServerWorld,
  type ReplicatedStateReader,
} from "snapscript";

export const Position = defineComponent("EcsExamplePosition", {
  x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }),
  y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }),
});

export const Velocity = defineComponent("EcsExampleVelocity", {
  x: qf32({ min: -16, max: 16, precision: 0.01, default: 0 }),
  y: qf32({ min: -16, max: 16, precision: 0.01, default: 0 }),
});

export const Health = defineComponent("EcsExampleHealth", {
  hp: u16(100),
  dead: bool(false),
});

export const Player = defineEntity("EcsExamplePlayer", {
  position: Position,
  velocity: Velocity,
  health: Health,
});

// Reusable query tuples should keep literal tuple inference for typed each/query rows.
const MovementQuery = [Position, Velocity] as const satisfies ComponentQuery;
const RenderQuery = [Position, Health] as const satisfies ComponentQuery;

export const MoveCommand = defineCommand("EcsExampleMove", {
  dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
  dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
});

export const DamageCommand = defineCommand("EcsExampleDamage", {
  target: varu32(0),
  amount: u16(10),
});

export const DamageEvent = defineEvent("EcsExampleDamageEvent", {
  entityId: varu32(0),
  amount: u16(0),
});

export const protocol = defineProtocol({
  components: { Position, Velocity, Health },
  prefabs: { Player },
  commands: { MoveCommand, DamageCommand },
  events: { DamageEvent },
});

export interface EntityView {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly hp: number | undefined;
  readonly dead: boolean;
  readonly visible: boolean;
}

export interface DemoSnapshot {
  readonly connected: boolean;
  readonly error: string | undefined;
  readonly tick: number;
  readonly sent: number;
  readonly received: number;
  readonly lastChannel: ChannelName | undefined;
  readonly lastEvent: string | undefined;
  readonly entities: readonly EntityView[];
  readonly benchmark: string;
}

export class BrowserClock implements Clock {
  #tick = 0;

  nowMs(): number {
    return performance.now();
  }

  tick(): number {
    this.#tick += 1;
    return this.#tick;
  }

  peek(): number {
    return this.#tick;
  }
}

export interface EcsDemoTransport {
  readonly connected: boolean;
  readonly error: string | undefined;
  readonly sent: number;
  readonly received: number;
  readonly lastChannel: ChannelName | undefined;
  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  broadcast(channel: ChannelName, bytes: Uint8Array): void;
  peers(): Iterable<PeerRef>;
  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void;
  connect(url: string): void;
  close(): void;
}

class WebSocketTransport implements EcsDemoTransport {
  readonly #peer: PeerRef = "relay";
  #socket?: WebSocket;
  #clientHandler?: (channel: ChannelName, bytes: Uint8Array) => void;
  #hostHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
  #pending: { channel: ChannelName; bytes: Uint8Array }[] = [];
  #connected = false;
  #error: string | undefined;
  #sent = 0;
  #received = 0;
  #lastChannel: ChannelName | undefined;

  get connected(): boolean {
    return this.#connected;
  }

  get error(): string | undefined {
    return this.#error;
  }

  get sent(): number {
    return this.#sent;
  }

  get received(): number {
    return this.#received;
  }

  get lastChannel(): ChannelName | undefined {
    return this.#lastChannel;
  }

  connect(url: string): void {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#connected = true;
      this.#error = undefined;
      for (const packet of this.#pending.splice(0)) {
        this.send(packet.channel, packet.bytes);
      }
    });
    socket.addEventListener("close", () => {
      this.#connected = false;
    });
    socket.addEventListener("error", () => {
      this.#error = "WebSocket error";
    });
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.#receive(new Uint8Array(event.data));
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => this.#receive(new Uint8Array(buffer)));
      }
    });
  }

  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  send(a: PeerRef | ChannelName, b: ChannelName | Uint8Array, c?: Uint8Array): void {
    const channel = c === undefined ? (a as ChannelName) : (b as ChannelName);
    const bytes = c ?? (b as Uint8Array);
    this.#sent = bytes.byteLength;
    this.#lastChannel = channel;
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      this.#pending.push({ channel, bytes });
      return;
    }

    const framed = new Uint8Array(bytes.byteLength + 1);
    framed[0] = channel === "reliable" ? 0 : 1;
    framed.set(bytes, 1);
    this.#socket.send(framed);
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    this.send(channel, bytes);
  }

  peers(): Iterable<PeerRef> {
    return [this.#peer];
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

  close(): void {
    this.#socket?.close();
  }

  #receive(framed: Uint8Array): void {
    if (framed.byteLength === 0) {
      return;
    }
    const channel: ChannelName = framed[0] === 1 ? "unreliable" : "reliable";
    const bytes = framed.slice(1);
    this.#received = bytes.byteLength;
    this.#lastChannel = channel;
    // The first byte is this example's transport framing, not a SnapScript protocol wrapper.
    this.#clientHandler?.(channel, bytes);
    this.#hostHandler?.(this.#peer, channel, bytes);
  }
}

export class ServerDemo {
  readonly clock: BrowserClock;
  readonly #transport: EcsDemoTransport;
  readonly world: ServerWorld;
  readonly player: EntityRef;
  readonly npc: EntityRef;
  #lastEvent: string | undefined;
  #benchmark = "--";

  constructor(transport: EcsDemoTransport = new WebSocketTransport(), clock = new BrowserClock()) {
    this.#transport = transport;
    this.clock = clock;
    this.world = createServerWorld({
      protocol,
      transport: this.#transport,
      clock: this.clock,
      // Keep the example's interest model explicit: every entity is visible to every peer.
      visibility: "all",
      // Opt into the negotiated batched snapshot path used by query-heavy ECS examples.
      snapshotEncoding: "batched",
    });

    // Server constructs and owns all authoritative entities.
    this.player = this.world.spawn(Player, {
      position: { x: -4, y: 0 },
      health: { hp: 100 },
    });
    this.npc = this.world.spawn();
    this.world.add(this.npc, Player, {
      position: { x: 5, y: 2 },
      velocity: { x: -0.02, y: 0 },
      health: { hp: 60 },
    });

    this.world.system("movement", "update", (world) => {
      // `each()` avoids materializing public query rows in hot update loops.
      world.each(MovementQuery, (_entity, pos, vel) => {
        pos.x.value += vel.x.value;
        pos.y.value += vel.y.value;
        vel.x.value *= 0.92;
        vel.y.value *= 0.92;
      });
    });

    this.world.onCommand(MoveCommand, (ctx) => {
      // Commands are intent; the server decides how intent changes replicated state.
      const payload = ctx.payload;
      const vel = this.world.get(this.player, Velocity);
      if (vel !== undefined) {
        vel.x.value += payload.dx * 0.18;
        vel.y.value += payload.dy * 0.18;
      }
    });

    this.world.onCommand(DamageCommand, (ctx) => {
      const payload = ctx.payload;
      const target = this.world.get(payload.target || this.player.id, Health);
      if (target === undefined) {
        return;
      }
      target.hp.value = Math.max(0, target.hp.value - payload.amount);
      target.dead.value = target.hp.value <= 0;
      this.#lastEvent = `damage ${payload.amount} on #${payload.target || this.player.id}`;
      this.world.broadcastEvent(WorldEntity, DamageEvent, {
        entityId: payload.target || this.player.id,
        amount: payload.amount,
      });
    });
  }

  connect(url: string): void {
    this.#transport.connect(url);
  }

  tick(): void {
    this.world.tick();
  }

  runBenchmark(): void {
    // Local micro-benchmark for the public ECS loop, separate from the repository benchmark suite.
    const bench = createServerWorld({
      protocol,
      transport: this.#transport,
      clock: this.clock,
    });
    for (let i = 0; i < 1000; i += 1) {
      const entity = bench.spawn();
      bench.add(entity, Position, { x: i % 32, y: 0 });
      bench.add(entity, Velocity, { x: 0.01, y: 0 });
    }
    const start = performance.now();
    let count = 0;
    bench.each(MovementQuery, (_entity, pos, vel) => {
      pos.x.value += vel.x.value;
      count += 1;
    });
    this.#benchmark = `${count} each rows in ${(performance.now() - start).toFixed(2)} ms`;
  }

  snapshot(): DemoSnapshot {
    return {
      connected: this.#transport.connected,
      error: this.#transport.error,
      tick: this.clock.peek(),
      sent: this.#transport.sent,
      received: this.#transport.received,
      lastChannel: this.#transport.lastChannel,
      lastEvent: this.#lastEvent,
      entities: toViews(this.world),
      benchmark: this.#benchmark,
    };
  }

  dispose(): void {
    this.#transport.close();
  }
}

export class ClientDemo {
  readonly clock: BrowserClock;
  readonly #transport: EcsDemoTransport;
  readonly world: ClientWorld;
  #lastEvent: string | undefined;
  #benchmark = "--";

  constructor(transport: EcsDemoTransport = new WebSocketTransport(), clock = new BrowserClock()) {
    this.#transport = transport;
    this.clock = clock;
    this.world = createClientWorld({ protocol, transport: this.#transport, clock: this.clock });

    this.world.onEvent(DamageEvent, (ctx) => {
      const payload = ctx.payload;
      // Events are side-channel notifications; component truth still comes from snapshots.
      this.#lastEvent = `damage fx ${payload.amount} on #${payload.entityId}`;
    });
  }

  connect(url: string): void {
    this.#transport.connect(url);
  }

  tick(): void {
    this.world.tick();
  }

  move(dx: number, dy: number): void {
    this.world.sendCommand(WorldEntity, MoveCommand, { dx, dy });
  }

  damage(target = 1): void {
    this.world.sendCommand(WorldEntity, DamageCommand, { target, amount: 10 });
  }

  requestFull(): void {
    this.world.requestFullSnapshot();
  }

  runBenchmark(): void {
    const start = performance.now();
    const rows = this.world.query(Position, Health).length;
    this.#benchmark = `${rows} visible rows in ${(performance.now() - start).toFixed(2)} ms`;
  }

  snapshot(): DemoSnapshot {
    return {
      connected: this.#transport.connected,
      error: this.#transport.error,
      tick: this.clock.peek(),
      sent: this.#transport.sent,
      received: this.#transport.received,
      lastChannel: this.#transport.lastChannel,
      lastEvent: this.#lastEvent,
      entities: toViews(this.world),
      benchmark: this.#benchmark,
    };
  }

  dispose(): void {
    this.#transport.close();
  }
}

function toViews(world: ReplicatedStateReader): EntityView[] {
  const views: EntityView[] = [];
  world.each(RenderQuery, (entity, pos, health) => {
    // The example renders Player rows, so read required render components in one typed pass.
    views.push({
      id: entity.id,
      x: pos.x.value,
      y: pos.y.value,
      hp: health.hp.value,
      dead: health.dead.value,
      visible: true,
    });
  });
  return views;
}
