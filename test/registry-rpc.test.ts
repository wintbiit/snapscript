import { describe, expect, it } from "vitest";
import {
  bool,
  defineCommand,
  defineEntity,
  defineEvent,
  qf32,
  u16,
  varu32,
} from "../src/index";
import { createRegistry } from "../src/registry/index";
import { decodeRpc, encodeRpc } from "../src/rpc/index";
import { applySnapshot, encodeFullSnapshot } from "../src/sync/index";
import { createTestClientWorld, createTestHostWorld, testProtocol } from "./helpers";

describe("registry and rpc packets", () => {
  it("registers schemas and rpcs by id", () => {
    const Player = defineEntity("RegistryPlayer", {
      hp: u16(100),
    });
    const Move = defineCommand("RegistryMove", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const registry = createRegistry().registerComponent(Player.component).registerRpc(Move);

    expect(registry.getSchema(Player.component.schemaId)).toBe(Player.component);
    expect(registry.getRpc(Move.rpcId)).toBe(Move);
  });

  it("rejects duplicate schema and rpc names", () => {
    const A = defineEntity("DuplicateRegistrySchema", { hp: u16(1) });
    const B = defineEntity("DuplicateRegistrySchema", { dead: bool(false) });
    const First = defineEvent("DuplicateRegistryRpc", { amount: u16(1) });
    const Second = defineEvent("DuplicateRegistryRpc", { entityId: varu32(0) });

    expect(() => createRegistry().registerComponent(A.component).registerComponent(B.component)).toThrow(/Duplicate schema/);
    expect(() => createRegistry().registerRpc(First).registerRpc(Second)).toThrow(/Duplicate rpc/);
  });

  it("uses registry for snapshot apply", () => {
    const Player = defineEntity("RegistrySnapshotPlayer", {
      hp: u16(100),
    });
    const registry = createRegistry().registerComponent(Player.component);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const player = a.spawn(Player, { hp: 25 });

    applySnapshot(b, encodeFullSnapshot(a, 1), registry);

    expect(b.get(player.id, Player.component)?.hp.value).toBe(25);
  });

  it("round-trips rpc payloads through field codecs", () => {
    const Move = defineCommand("RpcMoveRoundTrip", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
      dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const registry = createRegistry().registerRpc(Move);

    const decoded = decodeRpc(encodeRpc(Move, { dx: 0.42, dy: -0.5 }, 7), registry);

    expect(decoded.tick).toBe(7);
    expect(decoded.rpc).toBe(Move);
    expect(decoded.payload.dx).toBeCloseTo(0.42, 2);
    expect(decoded.payload.dy).toBeCloseTo(-0.5, 2);
  });

  it("supports explicit rpc field ids for generated definitions", () => {
    const Move = defineCommand("RpcExplicitFieldIds", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
      dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    }, { fieldIds: { dx: 5, dy: 9 } });

    expect(Move.fields.dx.fieldId).toBe(5);
    expect(Move.fields.dy.fieldId).toBe(9);
    expect(() =>
      defineEvent("RpcDuplicateExplicitFieldIds", { a: u16(0), b: u16(0) }, { fieldIds: { a: 2, b: 2 } }),
    ).toThrow(/field id 2 is used more than once/);
    expect(() =>
      defineCommand("RpcOutOfRangeExplicitFieldId", { a: u16(0) }, { fieldIds: { a: 32 } }),
    ).toThrow(/id must be an integer in \[0, 31\]/);
  });

  it("uses default rpc field values when payload is omitted", () => {
    const Move = defineCommand("RpcDefaultPayload", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0.25 }),
      amount: u16(7),
    });
    const registry = createRegistry().registerRpc(Move);

    const decoded = decodeRpc(encodeRpc(Move, undefined, 8), registry);

    expect(decoded.payload.dx).toBeCloseTo(0.25, 2);
    expect(decoded.payload.amount).toBe(7);
  });

  it("rejects unknown rpc payload fields", () => {
    const Move = defineCommand("RpcUnknownPayloadField", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });

    expect(() => encodeRpc(Move, { dy: 0.5 } as never, 1)).toThrow(
      /unknown field "dy"/,
    );
    expect(() => encodeRpc(Move, null as never, 1)).toThrow(/RPC payload must be an object/);
    expect(() => encodeRpc(Move, [] as never, 1)).toThrow(/RPC payload must be an object/);
    expect(() => encodeRpc(Move, new Date() as never, 1)).toThrow(/plain object map/);
    expect(() => encodeRpc(Move, new (class MovePayload {})() as never, 1)).toThrow(
      /plain object map/,
    );
  });

  it("rejects invalid rpc channels", () => {
    expect(() =>
      defineCommand(
        "RpcInvalidCommandChannel",
        { amount: u16(1) },
        { channel: "ordered" } as never,
      ),
    ).toThrow(/channel must be "reliable" or "unreliable"/);
    expect(() =>
      defineEvent(
        "RpcInvalidEventChannel",
        { amount: u16(1) },
        { channel: "ordered" } as never,
      ),
    ).toThrow(/channel must be "reliable" or "unreliable"/);
  });

  it("rejects invalid rpc definition shapes", () => {
    expect(() => defineCommand("", { amount: u16(1) })).toThrow(/RPC name must be a non-empty string/);
    expect(() => defineEvent(" ", { amount: u16(1) })).toThrow(/RPC name must be a non-empty string/);
    expect(() => defineCommand("RpcNullFields", null as never)).toThrow(/fields must be an object/);
    expect(() => defineEvent("RpcArrayFields", [] as never)).toThrow(/fields must be an object/);
    expect(() => defineCommand("RpcDateFields", new Date() as never)).toThrow(/plain object map/);
    expect(() => defineEvent("RpcClassFields", new (class RpcFields {})() as never)).toThrow(
      /plain object map/,
    );
    expect(() => defineCommand("RpcDateOptions", { amount: u16(1) }, new Date() as never))
      .toThrow(/RPC "RpcDateOptions" options must be an object/);
    expect(() =>
      defineEvent("RpcClassOptions", { amount: u16(1) }, new (class RpcOptions {})() as never),
    ).toThrow(/RPC "RpcClassOptions" options must be an object/);
    expect(() =>
      defineCommand("RpcDateMetadata", { amount: u16(1) }, { metadata: new Date() as never }),
    ).toThrow(/RPC "RpcDateMetadata" metadata must be an object/);
  });

  it("rejects invalid rpc ids", () => {
    expect(() => defineCommand("RpcInvalidNegativeId", { amount: u16(1) }, { id: -1 })).toThrow(
      /id must be an integer in \[0, 4294967295\]/,
    );
    expect(() => defineEvent("RpcInvalidFloatId", { amount: u16(1) }, { id: 1.5 })).toThrow(
      /id must be an integer in \[0, 4294967295\]/,
    );
    expect(() =>
      defineEvent("RpcInvalidLargeId", { amount: u16(1) }, { id: 0x1_0000_0000 }),
    ).toThrow(/id must be an integer in \[0, 4294967295\]/);
  });
});
