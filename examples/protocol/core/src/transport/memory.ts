import type {
  ChannelName,
  ClientTransport,
  PeerRef,
  ServerTransport,
} from "snapscript";

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
