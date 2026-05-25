import type { FieldCodec } from "../binary/index";
import { fieldDefinitionBrand, type FieldDefinition, type InternalFieldDefinition } from "./types";
import { assertPlainObjectMap } from "../utils/object";

function numberEquals(a: number, b: number): boolean {
  return Object.is(a, b);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function assertIntegerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

function assertFiniteNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${value}`);
  }
}

function integerCodec(
  kind: string,
  min: number,
  max: number,
  write: FieldCodec<number>["write"],
  read: FieldCodec<number>["read"],
): FieldCodec<number> {
  return {
    kind,
    write(writer, value) {
      assertIntegerInRange(kind, value, min, max);
      write(writer, value);
    },
    read,
    equals: numberEquals,
    validate(value) {
      assertIntegerInRange(kind, value, min, max);
    },
  };
}

const u8Codec = integerCodec(
  "u8",
  0,
  0xff,
  (writer, value) => writer.writeU8(value),
  (reader) => reader.readU8(),
);

const u16Codec = integerCodec(
  "u16",
  0,
  0xffff,
  (writer, value) => writer.writeU16(value),
  (reader) => reader.readU16(),
);

const u32Codec = integerCodec(
  "u32",
  0,
  0xffffffff,
  (writer, value) => writer.writeU32(value),
  (reader) => reader.readU32(),
);

const i8Codec = integerCodec(
  "i8",
  -0x80,
  0x7f,
  (writer, value) => writer.writeI8(value),
  (reader) => reader.readI8(),
);

const i16Codec = integerCodec(
  "i16",
  -0x8000,
  0x7fff,
  (writer, value) => writer.writeI16(value),
  (reader) => reader.readI16(),
);

const i32Codec = integerCodec(
  "i32",
  -0x80000000,
  0x7fffffff,
  (writer, value) => writer.writeI32(value),
  (reader) => reader.readI32(),
);

const varu32Codec = integerCodec(
  "varu32",
  0,
  0xffffffff,
  (writer, value) => writer.writeVarU32(value),
  (reader) => reader.readVarU32(),
);

const f32Codec: FieldCodec<number> = {
  kind: "f32",
  write(writer, value) {
    assertFiniteNumber("f32", value);
    writer.writeF32(value);
  },
  read(reader) {
    return reader.readF32();
  },
  equals: numberEquals,
  validate(value) {
    assertFiniteNumber("f32", value);
  },
};

const boolCodec: FieldCodec<boolean> = {
  kind: "bool",
  write(writer, value) {
    if (typeof value !== "boolean") {
      throw new TypeError(`bool must be a boolean, got ${value}`);
    }
    writer.writeBool(value);
  },
  read(reader) {
    return reader.readBool();
  },
  equals(a, b) {
    return a === b;
  },
  validate(value) {
    if (typeof value !== "boolean") {
      throw new TypeError(`bool must be a boolean, got ${value}`);
    }
  },
};

function angleToU16(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return Math.round((normalized / 360) * 0xffff) & 0xffff;
}

function angleToUint(value: number, max: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return Math.round((normalized / 360) * max) & max;
}

function uintToAngle(value: number, max: number): number {
  return (value / max) * 360;
}

function u16ToAngle(value: number): number {
  return (value / 0xffff) * 360;
}

const angle16Codec: FieldCodec<number> = {
  kind: "angle16",
  write(writer, value) {
    assertFiniteNumber("angle16", value);
    writer.writeU16(angleToU16(value));
  },
  read(reader) {
    return u16ToAngle(reader.readU16());
  },
  equals(a, b) {
    return angleToU16(a) === angleToU16(b);
  },
  validate(value) {
    assertFiniteNumber("angle16", value);
  },
};

const angle8Codec: FieldCodec<number> = {
  kind: "angle8",
  write(writer, value) {
    assertFiniteNumber("angle8", value);
    writer.writeU8(angleToUint(value, 0xff));
  },
  read(reader) {
    return uintToAngle(reader.readU8(), 0xff);
  },
  equals(a, b) {
    return angleToUint(a, 0xff) === angleToUint(b, 0xff);
  },
  validate(value) {
    assertFiniteNumber("angle8", value);
  },
};

const angle12Codec: FieldCodec<number> = {
  kind: "angle12",
  write(writer, value) {
    assertFiniteNumber("angle12", value);
    writer.writeBits(angleToUint(value, 0xfff), 12);
  },
  read(reader) {
    return uintToAngle(reader.readBits(12), 0xfff);
  },
  equals(a, b) {
    return angleToUint(a, 0xfff) === angleToUint(b, 0xfff);
  },
  validate(value) {
    assertFiniteNumber("angle12", value);
  },
};

/** Options for quantized numeric fields. Values are clamped to `[min, max]` and encoded at `precision` steps. */
export interface QuantizedFloatOptions {
  readonly min: number;
  readonly max: number;
  readonly precision: number;
  readonly default: number;
  readonly metadata?: Record<string, unknown>;
}

/** Options for UTF-8 strings encoded as `varuint byteLength + bytes`. */
export interface StringFieldOptions {
  readonly maxBytes: number;
  readonly metadata?: Record<string, unknown>;
}

/** Options for byte arrays encoded as `varuint byteLength + bytes`. */
export interface BytesFieldOptions {
  readonly maxBytes: number;
  readonly metadata?: Record<string, unknown>;
}

/** Options for variable-count arrays encoded as `varuint length + repeated item codec`. */
export interface ArrayFieldOptions {
  readonly maxItems: number;
  readonly metadata?: Record<string, unknown>;
}

function createQuantizer(
  name: "qf32" | "vec2q" | "vec3q",
  options: Omit<QuantizedFloatOptions, "default" | "metadata">,
) {
  const steps = Math.round((options.max - options.min) / options.precision);
  if (!Number.isFinite(options.min) || !Number.isFinite(options.max) || options.max <= options.min) {
    throw new RangeError(`${name} requires finite min and max with max > min`);
  }
  if (!Number.isFinite(options.precision) || options.precision <= 0) {
    throw new RangeError(`${name} precision must be a positive finite number`);
  }
  if (steps < 0 || steps > 0xffffffff) {
    throw new RangeError(`${name} quantized range must fit in u32, got ${steps} steps`);
  }

  return {
    quantize(value: number): number {
      const clamped = Math.min(options.max, Math.max(options.min, value));
      return Math.round((clamped - options.min) / options.precision);
    },
    dequantize(value: number): number {
      return options.min + value * options.precision;
    },
  };
}

function createQf32Codec(options: QuantizedFloatOptions): FieldCodec<number> {
  const quantizer = createQuantizer("qf32", options);

  return {
    kind: "qf32",
    write(writer, value) {
      assertFiniteNumber("qf32", value);
      writer.writeVarU32(quantizer.quantize(value));
    },
    read(reader) {
      return quantizer.dequantize(reader.readVarU32());
    },
    equals(a, b) {
      return quantizer.quantize(a) === quantizer.quantize(b);
    },
    validate(value) {
      assertFiniteNumber("qf32", value);
    },
  };
}

/** Two-dimensional vector value used by `vec2q()`. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Three-dimensional vector value used by `vec3q()`. */
export interface Vec3 extends Vec2 {
  readonly z: number;
}

/** Options for a quantized 2D vector field. */
export interface QuantizedVec2Options extends Omit<QuantizedFloatOptions, "default"> {
  readonly default: Vec2;
}

/** Options for a quantized 3D vector field. */
export interface QuantizedVec3Options extends Omit<QuantizedFloatOptions, "default"> {
  readonly default: Vec3;
}

function createVec2qCodec(options: QuantizedVec2Options): FieldCodec<Vec2> {
  const quantizer = createQuantizer("vec2q", options);
  return {
    kind: "vec2q",
    write(writer, value) {
      assertVec2("vec2q", value);
      writer.writeVarU32(quantizer.quantize(value.x));
      writer.writeVarU32(quantizer.quantize(value.y));
    },
    read(reader) {
      return {
        x: quantizer.dequantize(reader.readVarU32()),
        y: quantizer.dequantize(reader.readVarU32()),
      };
    },
    equals(a, b) {
      return (
        quantizer.quantize(a.x) === quantizer.quantize(b.x) &&
        quantizer.quantize(a.y) === quantizer.quantize(b.y)
      );
    },
    clone(value) {
      return { x: value.x, y: value.y };
    },
    validate(value) {
      assertVec2("vec2q", value);
    },
  };
}

function createVec3qCodec(options: QuantizedVec3Options): FieldCodec<Vec3> {
  const quantizer = createQuantizer("vec3q", options);
  return {
    kind: "vec3q",
    write(writer, value) {
      assertVec3("vec3q", value);
      writer.writeVarU32(quantizer.quantize(value.x));
      writer.writeVarU32(quantizer.quantize(value.y));
      writer.writeVarU32(quantizer.quantize(value.z));
    },
    read(reader) {
      return {
        x: quantizer.dequantize(reader.readVarU32()),
        y: quantizer.dequantize(reader.readVarU32()),
        z: quantizer.dequantize(reader.readVarU32()),
      };
    },
    equals(a, b) {
      return (
        quantizer.quantize(a.x) === quantizer.quantize(b.x) &&
        quantizer.quantize(a.y) === quantizer.quantize(b.y) &&
        quantizer.quantize(a.z) === quantizer.quantize(b.z)
      );
    },
    clone(value) {
      return { x: value.x, y: value.y, z: value.z };
    },
    validate(value) {
      assertVec3("vec3q", value);
    },
  };
}

function assertVec2(name: string, value: Vec2): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${name} must be an object with finite x and y`);
  }
  assertFiniteNumber(`${name}.x`, value.x);
  assertFiniteNumber(`${name}.y`, value.y);
}

function assertVec3(name: string, value: Vec3): void {
  assertVec2(name, value);
  assertFiniteNumber(`${name}.z`, value.z);
}

function createFlagsCodec(bitCount: number): FieldCodec<number> {
  if (!Number.isInteger(bitCount) || bitCount < 1 || bitCount > 32) {
    throw new RangeError(`flags bitCount must be an integer in [1, 32], got ${bitCount}`);
  }

  const max = bitCount === 32 ? 0xffffffff : 2 ** bitCount - 1;
  return {
    kind: "flags",
    write(writer, value) {
      assertIntegerInRange("flags", value, 0, max);
      writer.writeBits(value, bitCount);
    },
    read(reader) {
      return reader.readBits(bitCount);
    },
    equals: numberEquals,
    validate(value) {
      assertIntegerInRange("flags", value, 0, max);
    },
  };
}

function createEnumCodec<T extends string>(values: readonly T[]): FieldCodec<T> {
  const enumValues = enumValuesSnapshot(values);
  const indexByValue = new Map<T, number>();
  enumValues.forEach((value, index) => {
    if (indexByValue.has(value)) {
      throw new RangeError(`Duplicate enum value "${value}"`);
    }
    indexByValue.set(value, index);
  });

  return {
    kind: "enum",
    write(writer, value) {
      const index = indexByValue.get(value);
      if (index === undefined) {
        throw new RangeError(`Unknown enum value "${value}"`);
      }
      writer.writeVarU32(index);
    },
    read(reader) {
      const value = enumValues[reader.readVarU32()];
      if (value === undefined) {
        throw new RangeError("Enum index is out of range");
      }
      return value;
    },
    equals(a, b) {
      return a === b;
    },
    validate(value) {
      if (!indexByValue.has(value)) {
        throw new RangeError(`Unknown enum value "${value}"`);
      }
    },
  };
}

function createStringCodec(options: StringFieldOptions): FieldCodec<string> {
  assertMax("stringOf maxBytes", options.maxBytes);
  return {
    kind: "string",
    write(writer, value) {
      assertStringBytes(value, options.maxBytes);
      const bytes = textEncoder.encode(value);
      writer.writeVarU32(bytes.byteLength);
      writer.writeBytes(bytes);
    },
    read(reader) {
      const byteLength = reader.readVarU32();
      if (byteLength > options.maxBytes) {
        throw new RangeError(`string byte length ${byteLength} exceeds maxBytes ${options.maxBytes}`);
      }
      return textDecoder.decode(reader.readBytes(byteLength));
    },
    equals(a, b) {
      return a === b;
    },
    validate(value) {
      assertStringBytes(value, options.maxBytes);
    },
  };
}

function createBytesCodec(options: BytesFieldOptions): FieldCodec<Uint8Array> {
  assertMax("bytesOf maxBytes", options.maxBytes);
  return {
    kind: "bytes",
    write(writer, value) {
      assertBytes(value, options.maxBytes);
      writer.writeVarU32(value.byteLength);
      writer.writeBytes(value);
    },
    read(reader) {
      const byteLength = reader.readVarU32();
      if (byteLength > options.maxBytes) {
        throw new RangeError(`bytes length ${byteLength} exceeds maxBytes ${options.maxBytes}`);
      }
      return reader.readBytes(byteLength);
    },
    equals(a, b) {
      if (a.byteLength !== b.byteLength) return false;
      for (let index = 0; index < a.byteLength; index += 1) {
        if (a[index] !== b[index]) return false;
      }
      return true;
    },
    clone(value) {
      return new Uint8Array(value);
    },
    validate(value) {
      assertBytes(value, options.maxBytes);
    },
  };
}

function createArrayCodec<T>(
  itemField: FieldDefinition<T>,
  options: ArrayFieldOptions,
): FieldCodec<readonly T[]> {
  assertMax("arrayOf maxItems", options.maxItems);
  const itemCodec = codecForField(itemField);
  return {
    kind: "array",
    write(writer, value) {
      assertArray(value, options.maxItems, itemCodec);
      writer.writeVarU32(value.length);
      for (const item of value) {
        itemCodec.write(writer, item);
      }
    },
    read(reader) {
      const length = reader.readVarU32();
      if (length > options.maxItems) {
        throw new RangeError(`array length ${length} exceeds maxItems ${options.maxItems}`);
      }
      const items: T[] = [];
      for (let index = 0; index < length; index += 1) {
        items.push(itemCodec.read(reader));
      }
      return Object.freeze(items);
    },
    equals(a, b) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) {
        if (!itemCodec.equals(a[index]!, b[index]!)) return false;
      }
      return true;
    },
    clone(value) {
      return Object.freeze(value.map((item) => itemCodec.clone?.(item) ?? item));
    },
    validate(value) {
      assertArray(value, options.maxItems, itemCodec);
    },
  };
}

function assertMax(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an integer in [0, 4294967295], got ${value}`);
  }
}

function assertStringBytes(value: string, maxBytes: number): void {
  if (typeof value !== "string") {
    throw new TypeError(`string must be a string, got ${value}`);
  }
  const byteLength = textEncoder.encode(value).byteLength;
  if (byteLength > maxBytes) {
    throw new RangeError(`string byte length ${byteLength} exceeds maxBytes ${maxBytes}`);
  }
}

function assertBytes(value: Uint8Array, maxBytes: number): void {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("bytes must be a Uint8Array");
  }
  if (value.byteLength > maxBytes) {
    throw new RangeError(`bytes length ${value.byteLength} exceeds maxBytes ${maxBytes}`);
  }
}

function assertArray<T>(
  value: readonly T[],
  maxItems: number,
  itemCodec: FieldCodec<T>,
): void {
  if (!Array.isArray(value)) {
    throw new TypeError("array must be an array");
  }
  if (value.length > maxItems) {
    throw new RangeError(`array length ${value.length} exceeds maxItems ${maxItems}`);
  }
  for (const item of value) {
    itemCodec.validate?.(item);
  }
}

function enumValuesSnapshot<T extends string>(values: readonly T[]): readonly T[] {
  if (!Array.isArray(values)) {
    throw new Error("enumOf values must be a non-empty array of strings");
  }
  if (values.length === 0) {
    throw new Error("enumOf values must be a non-empty array of strings");
  }
  const snapshot = [...values];
  for (const value of snapshot) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("enumOf values must be a non-empty array of strings");
    }
  }
  return Object.freeze(snapshot);
}

export function codecForField<T>(definition: FieldDefinition<T>): FieldCodec<T> {
  return (definition as InternalFieldDefinition<T>).codec;
}

function field<T>(
  codec: FieldCodec<T>,
  defaultValue: T,
  metadata?: Record<string, unknown>,
): FieldDefinition<T> {
  const safeDefaultValue = snapshotDefaultValue(codec, defaultValue);
  const frozenMetadata = freezeMetadata(metadata);
  const definition: InternalFieldDefinition<T> =
    frozenMetadata === undefined
      ? { [fieldDefinitionBrand]: true, codec, defaultValue: safeDefaultValue }
      : {
          [fieldDefinitionBrand]: true,
          codec,
          defaultValue: safeDefaultValue,
          metadata: frozenMetadata,
        };
  return Object.freeze(definition);
}

function freezeMetadata(
  metadata: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  assertPlainObjectMap("Field metadata", metadata);
  return Object.freeze({ ...metadata });
}

function snapshotDefaultValue<T>(codec: FieldCodec<T>, value: T): T {
  codec.validate?.(value);
  const clone = codec.clone?.(value) ?? value;
  if (clone instanceof Uint8Array) {
    return clone;
  }
  if (typeof clone === "object" && clone !== null) {
    return Object.freeze(clone);
  }
  return clone;
}

/** Defines an unsigned 8-bit integer field. */
export function u8(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  assertIntegerInRange("u8 defaultValue", defaultValue, 0, 0xff);
  return field(u8Codec, defaultValue, metadata);
}

/** Defines an unsigned 16-bit integer field. */
export function u16(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  assertIntegerInRange("u16 defaultValue", defaultValue, 0, 0xffff);
  return field(u16Codec, defaultValue, metadata);
}

/** Defines an unsigned 32-bit integer field. */
export function u32(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  assertIntegerInRange("u32 defaultValue", defaultValue, 0, 0xffffffff);
  return field(u32Codec, defaultValue, metadata);
}

/** Defines a signed 8-bit integer field. */
export function i8(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  assertIntegerInRange("i8 defaultValue", defaultValue, -0x80, 0x7f);
  return field(i8Codec, defaultValue, metadata);
}

/** Defines a signed 16-bit integer field. */
export function i16(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  assertIntegerInRange("i16 defaultValue", defaultValue, -0x8000, 0x7fff);
  return field(i16Codec, defaultValue, metadata);
}

/** Defines a signed 32-bit integer field. */
export function i32(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  assertIntegerInRange("i32 defaultValue", defaultValue, -0x80000000, 0x7fffffff);
  return field(i32Codec, defaultValue, metadata);
}

/** Defines an unsigned 32-bit integer encoded as a variable-length integer. */
export function varu32(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  assertIntegerInRange("varu32 defaultValue", defaultValue, 0, 0xffffffff);
  return field(varu32Codec, defaultValue, metadata);
}

/** Defines a 32-bit floating point field. Prefer `qf32()` for high-frequency replicated values. */
export function f32(defaultValue: number, metadata?: Record<string, unknown>): FieldDefinition<number> {
  return field(f32Codec, defaultValue, metadata);
}

/** Defines a boolean field. */
export function bool(
  defaultValue: boolean,
  metadata?: Record<string, unknown>,
): FieldDefinition<boolean> {
  return field(boolCodec, defaultValue, metadata);
}

/** Defines an angle in degrees encoded into 16 bits. */
export function angle16(
  defaultValue: number,
  metadata?: Record<string, unknown>,
): FieldDefinition<number> {
  return field(angle16Codec, defaultValue, metadata);
}

/** Defines an angle in degrees encoded into 8 bits. */
export function angle8(
  defaultValue: number,
  metadata?: Record<string, unknown>,
): FieldDefinition<number> {
  return field(angle8Codec, defaultValue, metadata);
}

/** Defines an angle in degrees encoded into 12 bits. */
export function angle12(
  defaultValue: number,
  metadata?: Record<string, unknown>,
): FieldDefinition<number> {
  return field(angle12Codec, defaultValue, metadata);
}

/** Defines a quantized finite number field for compact replicated movement, stats, and timers. */
export function qf32(options: QuantizedFloatOptions): FieldDefinition<number> {
  assertPlainObjectMap("qf32 options", options);
  return field(createQf32Codec(options), options.default, options.metadata);
}

/** Defines a quantized 2D vector field. Replace the whole `{ x, y }` value when updating it. */
export function vec2q(options: QuantizedVec2Options): FieldDefinition<Vec2> {
  assertPlainObjectMap("vec2q options", options);
  return field(createVec2qCodec(options), options.default, options.metadata);
}

/** Defines a quantized 3D vector field. Replace the whole `{ x, y, z }` value when updating it. */
export function vec3q(options: QuantizedVec3Options): FieldDefinition<Vec3> {
  assertPlainObjectMap("vec3q options", options);
  return field(createVec3qCodec(options), options.default, options.metadata);
}

/** Defines a bitset field with `bitCount` encoded bits. */
export function flags(
  defaultValue: number,
  bitCount = 32,
  metadata?: Record<string, unknown>,
): FieldDefinition<number> {
  return field(createFlagsCodec(bitCount), defaultValue, metadata);
}

/** Defines a string enum field from a fixed list of allowed values. */
export function enumOf<const TValues extends readonly string[]>(
  values: TValues,
  defaultValue: TValues[number],
  metadata?: Record<string, unknown>,
): FieldDefinition<TValues[number]> {
  return field(createEnumCodec(values), defaultValue, metadata);
}

/** Defines a UTF-8 string field with an encoded byte limit. */
export function stringOf(
  defaultValue: string,
  options: StringFieldOptions,
): FieldDefinition<string> {
  assertPlainObjectMap("stringOf options", options);
  return field(createStringCodec(options), defaultValue, options.metadata);
}

/** Defines a byte-array field. Defaults and assigned values are cloned as `Uint8Array`. */
export function bytesOf(
  defaultValue: Uint8Array,
  options: BytesFieldOptions,
): FieldDefinition<Uint8Array> {
  assertPlainObjectMap("bytesOf options", options);
  return field(createBytesCodec(options), defaultValue, options.metadata);
}

/** Defines a variable-count array field. Replace the whole array when updating it. */
export function arrayOf<T>(
  itemField: FieldDefinition<T>,
  defaultValue: readonly T[],
  options: ArrayFieldOptions,
): FieldDefinition<readonly T[]> {
  assertPlainObjectMap("arrayOf options", options);
  return field(createArrayCodec(itemField, options), defaultValue, options.metadata);
}
