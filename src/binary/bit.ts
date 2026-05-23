import { ByteReader, ByteWriter } from "./byte";
import type { BinaryReader, BinaryWriter } from "./types";
import { readVarU32, readVarUint, writeVarU32, writeVarUint } from "./varint";

export class BitWriter implements BinaryWriter {
  readonly #writer: ByteWriter;
  #scratch = 0;
  #bitOffset = 0;

  constructor(writer = new ByteWriter()) {
    this.#writer = writer;
  }

  writeBit(value: boolean): void {
    if (value) {
      this.#scratch |= 1 << this.#bitOffset;
    }

    this.#bitOffset += 1;
    if (this.#bitOffset === 8) {
      this.#flushBits();
    }
  }

  writeBool(value: boolean): void {
    this.writeBit(value);
  }

  writeBits(value: number, bitCount: number): void {
    if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
      throw new RangeError(`bitCount must be an integer in [0, 32], got ${bitCount}`);
    }

    for (let bit = 0; bit < bitCount; bit += 1) {
      this.writeBit(((value >>> bit) & 1) === 1);
    }
  }

  writeU8(value: number): void {
    this.alignToByte();
    this.#writer.writeU8(value);
  }

  writeU16(value: number): void {
    this.alignToByte();
    this.#writer.writeU16(value);
  }

  writeU32(value: number): void {
    this.alignToByte();
    this.#writer.writeU32(value);
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
    this.alignToByte();
    this.#writer.writeF32(value);
  }

  writeVarUint(value: number): void {
    this.alignToByte();
    writeVarUint(this.#writer, value);
  }

  writeVarU32(value: number): void {
    this.alignToByte();
    writeVarU32(this.#writer, value);
  }

  alignToByte(): void {
    if (this.#bitOffset !== 0) {
      this.#flushBits();
    }
  }

  align(): void {
    this.alignToByte();
  }

  toUint8Array(): Uint8Array {
    this.alignToByte();
    return this.#writer.toUint8Array();
  }

  finish(): Uint8Array {
    return this.toUint8Array();
  }

  reset(): void {
    this.#scratch = 0;
    this.#bitOffset = 0;
    this.#writer.reset();
  }

  #flushBits(): void {
    this.#writer.writeU8(this.#scratch);
    this.#scratch = 0;
    this.#bitOffset = 0;
  }
}

export class BitReader implements BinaryReader {
  readonly #reader: ByteReader;
  #scratch = 0;
  #bitOffset = 8;

  constructor(readerOrBytes: ByteReader | Uint8Array) {
    this.#reader =
      readerOrBytes instanceof ByteReader ? readerOrBytes : new ByteReader(readerOrBytes);
  }

  readBit(): boolean {
    if (this.#bitOffset === 8) {
      this.#scratch = this.#reader.readU8();
      this.#bitOffset = 0;
    }

    const value = (this.#scratch & (1 << this.#bitOffset)) !== 0;
    this.#bitOffset += 1;
    return value;
  }

  readBool(): boolean {
    return this.readBit();
  }

  readBits(bitCount: number): number {
    if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
      throw new RangeError(`bitCount must be an integer in [0, 32], got ${bitCount}`);
    }

    let value = 0;
    for (let bit = 0; bit < bitCount; bit += 1) {
      if (this.readBit()) {
        value |= 1 << bit;
      }
    }
    return value >>> 0;
  }

  readU8(): number {
    this.alignToByte();
    return this.#reader.readU8();
  }

  readU16(): number {
    this.alignToByte();
    return this.#reader.readU16();
  }

  readU32(): number {
    this.alignToByte();
    return this.#reader.readU32();
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
    this.alignToByte();
    return this.#reader.readF32();
  }

  readVarUint(): number {
    this.alignToByte();
    return readVarUint(this.#reader);
  }

  readVarU32(): number {
    this.alignToByte();
    return readVarU32(this.#reader);
  }

  alignToByte(): void {
    this.#bitOffset = 8;
  }

  align(): void {
    this.alignToByte();
  }

  remaining(): number {
    this.alignToByte();
    return this.#reader.remaining();
  }
}
