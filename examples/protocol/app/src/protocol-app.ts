import {
  commands,
  createClient,
  createServer,
  Health,
  MatchState,
  Position,
} from "@snapscript/example-protocol-core";
import type {
  ChannelName,
  ClientWorld,
  ClientTransport,
  Clock,
  PeerRef,
  ReplicatedStateReader,
  ServerTransport,
  ServerWorld,
} from "snapscript";

export interface PeerSnapshot {
  readonly connected: boolean;
  readonly error: string | undefined;
  readonly tick: number;
  readonly lastBytes: number;
  readonly lastEvent: string | undefined;
  readonly myPeerId: number | undefined;
  readonly player: PlayerView | undefined;
}

export interface MatchView {
  readonly phase: number;
  readonly timeLeftMs: number;
}

export interface PlayerView {
  readonly id: number;
  readonly hp: number;
  readonly x: number;
  readonly y: number;
  readonly hidden: boolean;
  readonly mine: boolean;
}

interface ServerSnapshot {
  readonly match: MatchView | undefined;
  readonly players: readonly PlayerView[];
}

interface ClientSnapshot {
  readonly myPeerId: number;
  readonly match: MatchView | undefined;
  readonly players: readonly PlayerView[];
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
  #serverHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
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
      this.#serverHandler = cb as (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
    } else {
      this.#clientHandler = cb as (channel: ChannelName, bytes: Uint8Array) => void;
    }
  }

  close(): void {
    this.#socket?.close();
  }

  #receive(bytes: Uint8Array): void {
    this.#lastReceivedBytes = bytes.byteLength;
    this.#clientHandler?.("reliable", bytes);
    this.#serverHandler?.(this.#peer, "reliable", bytes);
  }
}

export class ServerPeer {
  readonly clock = new BrowserClock();
  readonly #transport = new WebSocketTransport();
  readonly world = createServer({
    transport: this.#transport,
    clock: this.clock,
  });

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
    return toPeerSnapshot(
      readServerSnapshot(this.world),
      this.#transport.connected,
      this.#transport.error,
      this.clock.peek(),
      this.#transport.lastSentBytes,
      undefined,
      undefined,
    );
  }

  dispose(): void {
    this.#transport.close();
  }
}

export class ClientPeer {
  readonly clock = new BrowserClock();
  readonly #transport = new WebSocketTransport();
  readonly world = createClient({
    transport: this.#transport,
    clock: this.clock,
  });
  #lastEvent: string | undefined;

  connect(url: string): void {
    this.#transport.connect(url);
  }

  tick(): void {
    this.world.tick();
  }

  move(dx: number, dy: number): void {
    const player = readClientSnapshot(this.world).players[0];
    if (player === undefined) {
      return;
    }
    commands.Player.Move(this.world, { id: player.id }, { dx, dy });
    if (Math.abs(player.x + dx) > 5 || Math.abs(player.y + dy) > 5) {
      this.#lastEvent = "movement disabled";
    }
  }

  requestFull(): void {
    this.world.requestFullSnapshot();
  }

  snapshot(): PeerSnapshot {
    return toPeerSnapshot(
      readClientSnapshot(this.world),
      this.#transport.connected,
      this.#transport.error,
      this.clock.peek(),
      this.#transport.lastReceivedBytes,
      this.#lastEvent,
      this.world.myPeerId(),
    );
  }

  dispose(): void {
    this.#transport.close();
  }
}

function toPeerSnapshot(
  snapshot: ServerSnapshot | ClientSnapshot,
  connected: boolean,
  error: string | undefined,
  tick: number,
  lastBytes: number,
  lastEvent: string | undefined,
  myPeerId: number | undefined,
): PeerSnapshot {
  return {
    connected,
    error,
    tick,
    lastBytes,
    lastEvent,
    myPeerId,
    player: snapshot.players[0],
  };
}

function readServerSnapshot(world: ServerWorld): ServerSnapshot {
  return {
    match: readMatch(world),
    players: readPlayers(world, () => false),
  };
}

function readClientSnapshot(world: ClientWorld): ClientSnapshot {
  return {
    myPeerId: world.myPeerId(),
    match: readMatch(world),
    players: readPlayers(world, (id) => world.isMine(id)),
  };
}

function readMatch(world: ReplicatedStateReader): MatchView | undefined {
  const match = world.getComponent(MatchState);
  return match === undefined
    ? undefined
    : {
        phase: match.phase.value,
        timeLeftMs: match.timeLeftMs.value,
      };
}

function readPlayers(
  world: ReplicatedStateReader,
  isMine: (entityId: number) => boolean,
): PlayerView[] {
  const players: PlayerView[] = [];
  world.each([Position, Health] as const, (entity, position, health) => {
    players.push({
      id: entity.id,
      hp: health.hp.value,
      x: position.x.value,
      y: position.y.value,
      hidden: position.hidden.value,
      mine: isMine(entity.id),
    });
  });
  return players;
}
