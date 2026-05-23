import type { ByteReader, ByteWriter } from "./byte";

export function writeVarUint(writer: ByteWriter, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`varuint value must be a non-negative safe integer, got ${value}`);
  }

  let current = value;
  do {
    let byte = current & 0x7f;
    current = Math.floor(current / 0x80);
    if (current !== 0) {
      byte |= 0x80;
    }
    writer.writeU8(byte);
  } while (current !== 0);
}

export function writeVarU32(writer: ByteWriter, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`varu32 value must be an integer in [0, 4294967295], got ${value}`);
  }

  writeVarUint(writer, value);
}

export function readVarUint(reader: ByteReader): number {
  let result = 0;
  let shift = 0;

  for (let index = 0; index < 8; index += 1) {
    const byte = reader.readU8();
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(result)) {
        throw new RangeError(`varuint value exceeds JavaScript safe integer range`);
      }
      return result;
    }
    shift += 7;
  }

  throw new RangeError("varuint exceeds the supported 8 byte limit");
}

export function readVarU32(reader: ByteReader): number {
  const value = readVarUint(reader);
  if (value > 0xffffffff) {
    throw new RangeError(`varu32 value exceeds u32 range, got ${value}`);
  }
  return value;
}
