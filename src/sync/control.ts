import { BitReader, BitWriter } from "../binary/index";
import { MessageType } from "./message";

export enum ControlType {
  Hello = 1,
  FullSnapshotRequest = 2,
}

export enum ControlCapability {
  BatchedSnapshots = 1,
}

export interface ControlMessage {
  readonly tick: number;
  readonly type: ControlType;
  readonly capabilities: number;
}

export function encodeControl(type: ControlType, tick: number, capabilities = 0): Uint8Array {
  const writer = new BitWriter();
  writer.writeU8(MessageType.Control);
  writer.writeU32(tick);
  writer.writeU8(type);
  if (capabilities !== 0) {
    writer.writeVarUint(capabilities);
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
  const capabilities = reader.remaining() === 0 ? 0 : reader.readVarUint();

  return {
    tick,
    type,
    capabilities,
  };
}
