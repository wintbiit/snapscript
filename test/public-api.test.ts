import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as SnapScript from "../packages/snapscript/src/index";

const expectedValueExports = [
  "ServerPeerId",
  "angle12",
  "angle16",
  "angle8",
  "bool",
  "createClientWorld",
  "createServerWorld",
  "defineCommand",
  "defineComponent",
  "defineEntity",
  "defineEvent",
  "defineProtocol",
  "enumOf",
  "f32",
  "flags",
  "i16",
  "i32",
  "i8",
  "qf32",
  "u16",
  "u32",
  "u8",
  "varu32",
  "vec2q",
  "vec3q",
] as const;

const forbiddenValueExports = [
  "World",
  "HostWorld",
  "ServerWorld",
  "ClientWorld",
  "createWorld",
  "createHostWorld",
  "createRegistry",
  "ProtocolRegistry",
  "registryForProtocol",
  "isProtocolDefinition",
  "createSyncHost",
  "createSyncServer",
  "createSyncClient",
  "encodeDirty",
  "applySnapshot",
  "encodeRpc",
  "decodeRpc",
  "BitReader",
  "BitWriter",
  "ByteReader",
  "ByteWriter",
  "DirtyGraph",
  "MapComponentStorage",
  "SparseSetComponentStorage",
] as const;

const forbiddenEntrypointFragments = [
  "./binary",
  "./registry",
  "./runtime",
  "./sync",
  "./world/internals",
  "./world/records",
  "./world/storage",
  "ComponentStorage",
  "ComponentRecord",
  "MapComponentStorage",
  "SparseSetComponentStorage",
  "WorldInternals",
  "worldInternals",
] as const;

describe("public entrypoint", () => {
  it("exports only user-facing runtime values", () => {
    expect(Object.keys(SnapScript).sort()).toEqual([...expectedValueExports].sort());
    for (const name of forbiddenValueExports) {
      expect(SnapScript).not.toHaveProperty(name);
    }
  });

  it("publishes only the root package entrypoint", () => {
    const packageJson = JSON.parse(readFileSync("packages/snapscript/package.json", "utf8")) as {
      readonly exports?: unknown;
    };
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.mts",
        import: "./dist/index.mjs",
      },
    });
  });

  it("does not re-export internal implementation modules from the source entrypoint", () => {
    const entrypoint = readFileSync("packages/snapscript/src/index.ts", "utf8");
    for (const fragment of forbiddenEntrypointFragments) {
      expect(entrypoint).not.toContain(fragment);
    }
  });
});
