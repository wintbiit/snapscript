import { describe, expect, it } from "vitest";
import {
  angle16,
  angle12,
  angle8,
  bool,
  enumOf,
  f32,
  flags,
  i16,
  i32,
  i8,
  qf32,
  u16,
  u32,
  u8,
  varu32,
  vec2q,
  vec3q,
} from "../src/index";
import {
  BitReader,
  BitWriter,
  ByteReader,
  ByteWriter,
  readVarUint,
  writeVarUint,
} from "../src/binary/index";
import { codecForField } from "../src/schema/fields";

describe("binary runtime", () => {
  it("round-trips varuint values", () => {
    const values = [0, 1, 127, 128, 255, 16_384, 2 ** 32 - 1];
    const writer = new ByteWriter();
    for (const value of values) {
      writeVarUint(writer, value);
    }

    const reader = new ByteReader(writer.toUint8Array());
    expect(values.map(() => readVarUint(reader))).toEqual(values);
  });

  it("round-trips field codecs", () => {
    const codecs = [
      [codecForField(u8(0)), 255],
      [codecForField(u16(0)), 65_535],
      [codecForField(u32(0)), 2 ** 32 - 1],
      [codecForField(i8(0)), -100],
      [codecForField(i16(0)), -20_000],
      [codecForField(i32(0)), -2_000_000_000],
      [codecForField(varu32(0)), 30_000],
      [codecForField(f32(0)), 12.5],
      [codecForField(bool(false)), true],
      [codecForField(angle16(0)), 90],
      [codecForField(angle8(0)), 180],
      [codecForField(angle12(0)), 270],
      [codecForField(qf32({ min: -10, max: 10, precision: 0.01, default: 0 })), 1.23],
      [codecForField(flags(0, 5)), 0b10101],
      [codecForField(enumOf(["idle", "run"] as const, "idle")), "run"],
      [codecForField(vec2q({ min: -10, max: 10, precision: 0.1, default: { x: 0, y: 0 } })), { x: 1.2, y: -3.4 }],
      [
        codecForField(vec3q({ min: -10, max: 10, precision: 0.1, default: { x: 0, y: 0, z: 0 } })),
        { x: 1.2, y: -3.4, z: 5.6 },
      ],
    ] as const;

    const writer = new BitWriter();
    for (const [codec, value] of codecs) {
      codec.write(writer, value as never);
    }

    const reader = new BitReader(writer.toUint8Array());
    const results = codecs.map(([codec]) => codec.read(reader));

    expect(results[0]).toBe(255);
    expect(results[1]).toBe(65_535);
    expect(results[2]).toBe(2 ** 32 - 1);
    expect(results[3]).toBe(-100);
    expect(results[4]).toBe(-20_000);
    expect(results[5]).toBe(-2_000_000_000);
    expect(results[6]).toBe(30_000);
    expect(results[7]).toBe(12.5);
    expect(results[8]).toBe(true);
    expect(results[9]).toBeCloseTo(90, 2);
    expect(results[10] as number).toBeGreaterThan(179);
    expect(results[10] as number).toBeLessThan(182);
    expect(results[11]).toBeCloseTo(270, 1);
    expect(results[12]).toBeCloseTo(1.23, 2);
    expect(results[13]).toBe(0b10101);
    expect(results[14]).toBe("run");
    expect(results[15]).toEqual({ x: 1.200000000000001, y: -3.3999999999999995 });
    expect(results[16]).toEqual({ x: 1.200000000000001, y: -3.3999999999999995, z: 5.600000000000001 });
  });

  it("rejects duplicate enum values", () => {
    expect(() => enumOf(["idle", "idle"] as const, "idle")).toThrow(/Duplicate enum value/);
  });

  it("isolates enum fields from caller-side value array mutation", () => {
    const values = ["idle", "run"];
    const codec = codecForField(enumOf(values, "idle"));
    values[1] = "walk";

    expect(() => codec.write(new BitWriter(), "walk")).toThrow(/Unknown enum value/);
    expect(() => codec.write(new BitWriter(), "run")).not.toThrow();
  });
});
