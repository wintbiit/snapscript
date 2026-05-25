import { readVarU32 as readVarU32FromBytes, writeVarU32 as writeVarU32ToBytes } from "./varint";
import type { BinaryReader, BinaryWriter } from "./types";

export class ByteWriter implements BinaryWriter {
  #bytes = new Uint8Array(256);
  #offset = 0;

  writeU8(value: number): void {
    this.#reserve(1);
    this.#bytes[this.#offset] = value & 0xff;
    this.#offset += 1;
  }

  writeU16(value: number): void {
    this.#reserve(2);
    this.#bytes[this.#offset] = value & 0xff;
    this.#bytes[this.#offset + 1] = (value >>> 8) & 0xff;
    this.#offset += 2;
  }

  writeU32(value: number): void {
    this.#reserve(4);
    this.#bytes[this.#offset] = value & 0xff;
    this.#bytes[this.#offset + 1] = (value >>> 8) & 0xff;
    this.#bytes[this.#offset + 2] = (value >>> 16) & 0xff;
    this.#bytes[this.#offset + 3] = (value >>> 24) & 0xff;
    this.#offset += 4;
  }

  writeI8(value: number): void {
    this.writeU8(value);
  }

  writeI16(value: number): void {
    this.writeU16(value);
  }

  writeI32(value: number): void {
    this.writeU32(value);
  }

  writeF32(value: number): void {
    this.#reserve(4);
    new DataView(this.#bytes.buffer).setFloat32(this.#offset, value, true);
    this.#offset += 4;
  }

  writeBytes(bytes: Uint8Array): void {
    this.#reserve(bytes.byteLength);
    this.#bytes.set(bytes, this.#offset);
    this.#offset += bytes.byteLength;
  }

  writeVarU32(value: number): void {
    writeVarU32ToBytes(this, value);
  }

  writeBits(value: number, bitCount: number): void {
    if (bitCount % 8 !== 0) {
      throw new RangeError("ByteWriter only supports byte-aligned writeBits");
    }

    for (let shift = 0; shift < bitCount; shift += 8) {
      this.writeU8((value >>> shift) & 0xff);
    }
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  align(): void {}

  finish(): Uint8Array {
    return this.toUint8Array();
  }

  reset(): void {
    this.#offset = 0;
  }

  toUint8Array(): Uint8Array {
    return this.#bytes.slice(0, this.#offset);
  }

  #reserve(size: number): void {
    const required = this.#offset + size;
    if (required <= this.#bytes.byteLength) {
      return;
    }

    let capacity = this.#bytes.byteLength;
    while (capacity < required) {
      capacity *= 2;
    }
    const bytes = new Uint8Array(capacity);
    bytes.set(this.#bytes.subarray(0, this.#offset));
    this.#bytes = bytes;
  }
}

export class ByteReader implements BinaryReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.#offset;
  }

  readU8(): number {
    this.#require(1);
    const value = this.bytes[this.#offset]!;
    this.#offset += 1;
    return value;
  }

  readU16(): number {
    this.#require(2);
    const value = this.bytes[this.#offset]! | (this.bytes[this.#offset + 1]! << 8);
    this.#offset += 2;
    return value;
  }

  readU32(): number {
    this.#require(4);
    const value =
      (this.bytes[this.#offset]! |
        (this.bytes[this.#offset + 1]! << 8) |
        (this.bytes[this.#offset + 2]! << 16) |
        (this.bytes[this.#offset + 3]! << 24)) >>>
      0;
    this.#offset += 4;
    return value;
  }

  readI8(): number {
    const value = this.readU8();
    return value > 0x7f ? value - 0x100 : value;
  }

  readI16(): number {
    const value = this.readU16();
    return value > 0x7fff ? value - 0x10000 : value;
  }

  readI32(): number {
    return this.readU32() | 0;
  }

  readF32(): number {
    this.#require(4);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.#offset, 4);
    const value = view.getFloat32(0, true);
    this.#offset += 4;
    return value;
  }

  readBytes(byteLength: number): Uint8Array {
    if (!Number.isInteger(byteLength) || byteLength < 0) {
      throw new RangeError(`ByteReader readBytes length must be a non-negative integer, got ${byteLength}`);
    }
    this.#require(byteLength);
    const value = this.bytes.slice(this.#offset, this.#offset + byteLength);
    this.#offset += byteLength;
    return value;
  }

  readVarU32(): number {
    return readVarU32FromBytes(this);
  }

  readBits(bitCount: number): number {
    if (bitCount % 8 !== 0) {
      throw new RangeError("ByteReader only supports byte-aligned readBits");
    }

    let value = 0;
    for (let shift = 0; shift < bitCount; shift += 8) {
      value |= this.readU8() << shift;
    }
    return value >>> 0;
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  align(): void {}

  remaining(): number {
    return this.remainingBytes;
  }

  get remainingBytes(): number {
    return this.bytes.length - this.#offset;
  }

  #require(size: number): void {
    if (this.remainingBytes < size) {
      throw new RangeError(`ByteReader expected ${size} byte(s), got ${this.remainingBytes}`);
    }
  }
}
