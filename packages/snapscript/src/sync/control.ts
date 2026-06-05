import { BitReader, BitWriter } from "../binary/index";
import { MessageType } from "./message";

export enum ControlType {
  Hello = 1,
  FullSnapshotRequest = 2,
  PeerAssigned = 3,
}

export enum ControlCapability {
  BatchedSnapshots = 1,
}

export interface ControlMessage {
  readonly tick: number;
  readonly type: ControlType;
  readonly capabilities: number;
  readonly peerId?: number;
  readonly peerEntityId?: number;
  readonly protocolHash?: string;
}

export function encodeControl(
  type: ControlType,
  tick: number,
  capabilities = 0,
  peerId?: number,
  protocolHash?: string,
  peerEntityId?: number,
): Uint8Array {
  const writer = new BitWriter();
  writer.writeU8(MessageType.Control);
  writer.writeU32(tick);
  writer.writeU8(type);
  if (type === ControlType.PeerAssigned) {
    writer.writeVarUint(peerId ?? 0);
    writer.writeVarUint(peerEntityId ?? peerId ?? 0);
    writeOptionalString(writer, protocolHash);
  } else if (capabilities !== 0 || protocolHash !== undefined) {
    writer.writeVarUint(capabilities);
    writeOptionalString(writer, protocolHash);
  }
  return writer.finish();
}

export function decodeControl(bytes: Uint8Array): ControlMessage {
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Control) {
    throw new Error(`Unknown control message type ${messageType}`);
  }

  const tick = reader.readU32();
  const type = reader.readU8() as ControlType;
  if (type === ControlType.PeerAssigned) {
    const peerId = reader.readVarUint();
    const peerEntityId = reader.remaining() === 0 ? peerId : reader.readVarUint();
    return {
      tick,
      type,
      capabilities: 0,
      peerId,
      peerEntityId,
      ...optionalProtocolHash(readOptionalString(reader)),
    };
  }
  const capabilities = reader.remaining() === 0 ? 0 : reader.readVarUint();

  return {
    tick,
    type,
    capabilities,
    ...optionalProtocolHash(readOptionalString(reader)),
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeOptionalString(writer: BitWriter, value: string | undefined): void {
  if (value === undefined) {
    writer.writeVarUint(0);
    return;
  }
  const bytes = textEncoder.encode(value);
  writer.writeVarUint(bytes.byteLength + 1);
  writer.writeBytes(bytes);
}

function readOptionalString(reader: BitReader): string | undefined {
  if (reader.remaining() === 0) {
    return undefined;
  }
  const encodedLength = reader.readVarUint();
  if (encodedLength === 0) {
    return undefined;
  }
  return textDecoder.decode(reader.readBytes(encodedLength - 1));
}

function optionalProtocolHash(protocolHash: string | undefined): Pick<ControlMessage, "protocolHash"> | Record<never, never> {
  return protocolHash === undefined ? {} : { protocolHash };
}
