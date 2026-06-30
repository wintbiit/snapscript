/** Logical packet channel requested by SnapScript. The transport adapter owns the actual delivery semantics. */
export type ChannelName = "reliable" | "unreliable";

/** Stable peer handle chosen by the server transport. Object refs are allowed when the adapter owns identity. */
export type PeerRef = string | number | symbol | object;

/** SnapScript connection id assigned by a ServerWorld. `0` is always the server. */
export type PeerId = number;

/** Reserved peer id for the authoritative server. */
export const ServerPeerId: PeerId = 0;

/** Client-side transport adapter passed to `createClientWorld()`. */
export interface ClientTransport {
  send(channel: ChannelName, bytes: Uint8Array): void;
  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
}

/** Server-side transport adapter passed to `createServerWorld()`. */
export interface ServerTransport {
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  broadcast(channel: ChannelName, bytes: Uint8Array): void;
  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void;
  peers?(): Iterable<PeerRef>;
}

/** Local in-memory transport pair for tests, host-mode wiring, and examples. */
export interface MemoryTransportPair {
  readonly server: ServerTransport;
  readonly client: ClientTransport;
}

export function createMemoryTransportPair(): MemoryTransportPair {
  const peer: PeerRef = "memory-client";
  let serverHandler: ((peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void) | undefined;
  let clientHandler: ((channel: ChannelName, bytes: Uint8Array) => void) | undefined;

  return {
    server: {
      send(_peer, channel, bytes) {
        clientHandler?.(channel, bytes);
      },
      broadcast(channel, bytes) {
        clientHandler?.(channel, bytes);
      },
      onPacket(cb) {
        serverHandler = cb;
      },
      peers() {
        return [peer];
      },
    },
    client: {
      send(channel, bytes) {
        serverHandler?.(peer, channel, bytes);
      },
      onPacket(cb) {
        clientHandler = cb;
      },
    },
  };
}

/** Structured logger used for isolated handler and packet errors. */
export interface ILogger {
  debug?(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
}

/** Backward-compatible logger type alias. */
export type Logger = ILogger;

export const defaultLogger: ILogger = Object.freeze({
  debug(message: string, context?: Record<string, unknown>) {
    writeConsole("debug", message, context);
  },
  info(message: string, context?: Record<string, unknown>) {
    writeConsole("info", message, context);
  },
  warn(message: string, context?: Record<string, unknown>) {
    writeConsole("warn", message, context);
  },
  error(message: string, context?: Record<string, unknown>) {
    writeConsole("error", message, context);
  },
});

function writeConsole(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  context: Record<string, unknown> | undefined,
): void {
  const writer = console[level] ?? console.log;
  if (context === undefined) {
    writer(message);
    return;
  }
  writer(message, context);
}
