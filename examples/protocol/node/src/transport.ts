import type {
  ChannelName,
  ClientTransport,
  PeerRef,
  ServerTransport,
} from "snapscript";
import { WebSocket, WebSocketServer } from "ws";

const channelIds = {
  reliable: 1,
  unreliable: 2,
} as const;

function encode(channel: ChannelName, bytes: Uint8Array): Uint8Array {
  const packet = new Uint8Array(bytes.byteLength + 1);
  packet[0] = channelIds[channel];
  packet.set(bytes, 1);
  return packet;
}

function decode(data: WebSocket.RawData): { channel: ChannelName; bytes: Uint8Array } | undefined {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : Array.isArray(data)
      ? Buffer.concat(data)
      : new Uint8Array(data);
  const channel = bytes[0] === channelIds.unreliable ? "unreliable" : bytes[0] === channelIds.reliable ? "reliable" : undefined;
  if (channel === undefined) return undefined;
  return { channel, bytes: bytes.slice(1) };
}

export class NodeWebSocketServerTransport implements ServerTransport {
  readonly #server: WebSocketServer;
  readonly #peers = new Set<WebSocket>();
  #handler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  constructor(port = 0) {
    this.#server = new WebSocketServer({ port });
    this.#server.on("connection", (socket) => {
      this.#peers.add(socket);
      socket.on("message", (data) => {
        const packet = decode(data);
        if (packet !== undefined) this.#handler?.(socket, packet.channel, packet.bytes);
      });
      socket.on("close", () => this.#peers.delete(socket));
    });
  }

  get port(): number {
    const address = this.#server.address();
    if (typeof address === "string" || address === null) return 0;
    return address.port;
  }

  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    if (peer instanceof WebSocket && peer.readyState === WebSocket.OPEN) {
      peer.send(encode(channel, bytes));
    }
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    for (const peer of this.#peers) {
      this.send(peer, channel, bytes);
    }
  }

  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void {
    this.#handler = cb;
  }

  peers(): Iterable<PeerRef> {
    return this.#peers;
  }

  close(): void {
    for (const peer of this.#peers) peer.close();
    this.#server.close();
  }
}

export class NodeWebSocketClientTransport implements ClientTransport {
  readonly #socket: WebSocket;
  readonly #pending: Uint8Array[] = [];
  #handler?: (channel: ChannelName, bytes: Uint8Array) => void;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.binaryType = "arraybuffer";
    this.#socket.on("open", () => {
      for (const packet of this.#pending.splice(0)) this.#socket.send(packet);
    });
    this.#socket.on("message", (data) => {
      const packet = decode(data);
      if (packet !== undefined) this.#handler?.(packet.channel, packet.bytes);
    });
  }

  send(channel: ChannelName, bytes: Uint8Array): void {
    const packet = encode(channel, bytes);
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(packet);
    } else {
      this.#pending.push(packet);
    }
  }

  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void {
    this.#handler = cb;
  }

  close(): void {
    this.#socket.close();
  }
}
