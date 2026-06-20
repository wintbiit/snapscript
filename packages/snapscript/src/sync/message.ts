export enum MessageType {
  Snapshot = 1,
  Rpc = 2,
  Control = 3,
  CommandStream = 4,
  CommandStreamAck = 5,
}

export function peekMessageType(bytes: Uint8Array): MessageType | undefined {
  return bytes[0] as MessageType | undefined;
}
