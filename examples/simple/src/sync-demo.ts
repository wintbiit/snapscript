import {
  angle16,
  bool,
  createClientWorld,
  createServerWorld,
  defineCommand,
  defineEntity,
  defineEvent,
  defineProtocol,
  qf32,
  u16,
  varu32,
  type ChannelName,
  type ClientTransport,
  type Clock,
  type ComponentInstanceOf,
  type ServerTransport,
  type PeerRef,
  type ReadonlyComponentInstanceOf,
} from "snapscript";

export const PlayerSchema = defineEntity("SimplePlayer", {
  hp: u16(100),
  dead: bool(false),
  x: qf32({ min: -64, max: 64, precision: 0.01, default: 0 }),
  y: qf32({ min: -64, max: 64, precision: 0.01, default: 0 }),
  yaw: angle16(0),
});

// Commands are client intent. The server owns validation and authoritative mutation.
export const MoveCommand = defineCommand("MoveCommand", {
  dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
  dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
});

export const DamageCommand = defineCommand("DamageCommand", {
  amount: u16(10),
});

export const HealCommand = defineCommand("HealCommand", {
  amount: u16(10),
});

export const RotateCommand = defineCommand("RotateCommand", {
  delta: angle16(15),
});

export const DamageEvent = defineEvent("DamageEvent", {
  entityId: varu32(0),
  amount: u16(0),
});

// The protocol is the only registry a world accepts. Server and client must construct worlds with the same object shape.
export const protocol = defineProtocol({
  prefabs: { Player: PlayerSchema },
  commands: { MoveCommand, DamageCommand, HealCommand, RotateCommand },
  events: { DamageEvent },
});

type Player = ComponentInstanceOf<typeof PlayerSchema.component>;
type ReadonlyPlayer = ReadonlyComponentInstanceOf<typeof PlayerSchema.component>;

export interface PlayerView {
  readonly id: number;
  readonly hp: number;
  readonly dead: boolean;
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
}

export interface PeerSnapshot {
  readonly connected: boolean;
  readonly error: string | undefined;
  readonly tick: number;
  readonly lastBytes: number;
  readonly lastEvent: string | undefined;
  readonly player: PlayerView | undefined;
}

function toView(player: Player | ReadonlyPlayer | undefined): PlayerView | undefined {
  if (player === undefined) {
    return undefined;
  }

  return {
    id: player.id,
    hp: player.hp.value,
    dead: player.dead.value,
    x: player.x.value,
    y: player.y.value,
    yaw: player.yaw.value,
  };
}

class BrowserClock implements Clock {
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

class WebSocketTransport implements ClientTransport, ServerTransport {
  readonly #peer: PeerRef = "relay";
  #socket?: WebSocket;
  #clientHandler?: (channel: ChannelName, bytes: Uint8Array) => void;
  #hostHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
  #pending: Uint8Array[] = [];
  #connected = false;
  #error: string | undefined;
  #lastSentBytes = 0;
  #lastReceivedBytes = 0;

  get connected(): boolean {
    return this.#connected;
  }

  get error(): string | undefined {
    return this.#error;
  }

  get lastSentBytes(): number {
    return this.#lastSentBytes;
  }

  get lastReceivedBytes(): number {
    return this.#lastReceivedBytes;
  }

  connect(url: string): void {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#connected = true;
      this.#error = undefined;
      for (const bytes of this.#pending.splice(0)) {
        this.send("reliable", bytes);
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
        return;
      }

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => this.#receive(new Uint8Array(buffer)));
      }
    });
  }

  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  send(a: PeerRef | ChannelName, b: ChannelName | Uint8Array, c?: Uint8Array): void {
    const bytes = c ?? (b as Uint8Array);
    this.#lastSentBytes = bytes.byteLength;
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(bytes);
      return;
    }

    this.#pending.push(bytes);
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

  #receive(bytes: Uint8Array): void {
    this.#lastReceivedBytes = bytes.byteLength;
    // This simple demo treats every WebSocket packet as reliable. Real adapters should preserve channel semantics.
    this.#clientHandler?.("reliable", bytes);
    this.#hostHandler?.(this.#peer, "reliable", bytes);
  }
}

export class ServerPeer {
  readonly clock = new BrowserClock();
  readonly #transport = new WebSocketTransport();
  readonly world = createServerWorld({
    protocol,
    transport: this.#transport,
    clock: this.clock,
  });
  // Server code owns entity creation and mutable NetRefs.
  readonly player = this.world.spawn(PlayerSchema);
  #lastEvent: string | undefined;

  constructor() {
    this.world.on(MoveCommand, (ctx) => {
      // Command handlers mutate server-side NetRefs; dirty snapshots are produced during world.tick().
      const payload = ctx.payload;
      const player = this.playerState();
      player.x.value += payload.dx;
      player.y.value += payload.dy;
    });

    this.world.on(DamageCommand, (ctx) => {
      const payload = ctx.payload;
      const player = this.playerState();
      player.hp.value = Math.max(0, player.hp.value - payload.amount);
      player.dead.value = player.hp.value <= 0;
      this.world.broadcast(DamageEvent, { entityId: this.player.id, amount: payload.amount });
    });

    this.world.on(HealCommand, (ctx) => {
      const payload = ctx.payload;
      const player = this.playerState();
      player.hp.value = Math.min(100, player.hp.value + payload.amount);
      player.dead.value = false;
    });

    this.world.on(RotateCommand, (ctx) => {
      const payload = ctx.payload;
      const player = this.playerState();
      player.yaw.value = (player.yaw.value + payload.delta + 360) % 360;
    });
  }

  connect(url: string): void {
    this.#transport.connect(url);
  }

  tick(): void {
    this.world.tick();
  }

  sendFull(): void {
    this.world.sendFullSnapshot();
  }

  snapshot(): PeerSnapshot {
    return {
      connected: this.#transport.connected,
      error: this.#transport.error,
      tick: this.clock.peek(),
      lastBytes: this.#transport.lastSentBytes,
      lastEvent: this.#lastEvent,
      player: toView(this.playerState()),
    };
  }

  playerState(): Player {
    return this.world.get(this.player, PlayerSchema)!;
  }

  dispose(): void {
    this.#transport.close();
  }
}

export class ClientPeer {
  readonly clock = new BrowserClock();
  readonly #transport = new WebSocketTransport();
  readonly world = createClientWorld({
    protocol,
    transport: this.#transport,
    clock: this.clock,
  });
  #playerId = 1;
  #lastEvent: string | undefined;

  constructor() {
    this.world.on(DamageEvent, (ctx) => {
      const payload = ctx.payload;
      // Events are for client effects and UI bookkeeping; replicated state still comes from snapshots.
      this.#lastEvent = `damage ${payload.amount} on #${payload.entityId}`;
    });
  }

  connect(url: string): void {
    this.#transport.connect(url);
  }

  tick(): void {
    this.world.tick();
  }

  damage(): void {
    this.world.send(DamageCommand, { amount: 10 });
  }

  heal(): void {
    this.world.send(HealCommand, { amount: 10 });
  }

  move(dx: number, dy: number): void {
    this.world.send(MoveCommand, { dx, dy });
  }

  rotate(delta: number): void {
    this.world.send(RotateCommand, { delta });
  }

  requestFull(): void {
    this.world.requestFullSnapshot();
  }

  snapshot(): PeerSnapshot {
    // Client reads are read-only views over the last applied replicated snapshot.
    const player = this.world.get(this.#playerId, PlayerSchema);

    return {
      connected: this.#transport.connected,
      error: this.#transport.error,
      tick: this.clock.peek(),
      lastBytes: this.#transport.lastReceivedBytes,
      lastEvent: this.#lastEvent,
      player: toView(player),
    };
  }

  dispose(): void {
    this.#transport.close();
  }
}
