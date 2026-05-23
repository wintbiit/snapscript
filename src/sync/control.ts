import { BitReader, BitWriter } from "../binary/index";
import { MessageType } from "./message";

export enum ControlType {
  Hello = 1,
  FullSnapshotRequest = 2,
}

export function encodeControl(type: ControlType, tick: number): Uint8Array {
  const writer = new BitWriter();
  writer.writeU8(MessageType.Control);
  writer.writeU32(tick);
  writer.writeU8(type);
  return writer.finish();
}

export function decodeControl(bytes: Uint8Array): { tick: number; type: ControlType } {
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Control) {
    throw new Error(`Unknown control message type ${messageType}`);
  }

  return {
    tick: reader.readU32(),
    type: reader.readU8() as ControlType,
  };
}
