/** Logical packet channel requested by SnapScript. The transport adapter owns the actual delivery semantics. */
export type ChannelName = "reliable" | "unreliable";

/** Stable peer handle chosen by the host transport. Object refs are allowed when the adapter owns identity. */
export type PeerRef = string | number | symbol | object;

/** Client-side transport adapter passed to `createClientWorld()`. */
export interface ClientTransport {
  send(channel: ChannelName, bytes: Uint8Array): void;
  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
}

/** Host-side transport adapter passed to `createHostWorld()`. */
export interface HostTransport {
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  broadcast(channel: ChannelName, bytes: Uint8Array): void;
  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void;
  peers?(): Iterable<PeerRef>;
}

/** Clock used by a world to produce frame timing and monotonically increasing network ticks. */
export interface Clock {
  nowMs(): number;
  tick(): number;
}

/** Optional structured logger used for isolated handler and packet errors. */
export interface Logger {
  debug?(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
}
