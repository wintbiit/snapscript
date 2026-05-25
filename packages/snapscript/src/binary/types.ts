export interface BinaryWriter {
  writeU8(value: number): void;
  writeU16(value: number): void;
  writeU32(value: number): void;
  writeI8(value: number): void;
  writeI16(value: number): void;
  writeI32(value: number): void;
  writeF32(value: number): void;
  writeVarU32(value: number): void;
  writeBytes(bytes: Uint8Array): void;
  writeBits(value: number, bitCount: number): void;
  writeBool(value: boolean): void;
  align(): void;
  finish(): Uint8Array;
}

export interface BinaryReader {
  readU8(): number;
  readU16(): number;
  readU32(): number;
  readI8(): number;
  readI16(): number;
  readI32(): number;
  readF32(): number;
  readVarU32(): number;
  readBytes(byteLength: number): Uint8Array;
  readBits(bitCount: number): number;
  readBool(): boolean;
  align(): void;
  remaining(): number;
}

export interface FieldCodec<T> {
  readonly kind: string;
  write(writer: BinaryWriter, value: T): void;
  read(reader: BinaryReader): T;
  equals(a: T, b: T): boolean;
  validate?(value: T): void;
  clone?(value: T): T;
}
