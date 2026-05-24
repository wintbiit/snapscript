import { describe, expect, it } from "vitest";
import {
  bool,
  defineEntity,
  u16,
  angle16,
} from "../packages/snapscript/src/index";
import { BitReader, BitWriter, type FieldCodec } from "../packages/snapscript/src/binary/index";
import { createRegistry } from "../packages/snapscript/src/registry/index";
import {
  applySnapshot,
  encodeDirty,
  encodeDirtyBatched,
  encodeFullSnapshot,
  SnapshotOp,
} from "../packages/snapscript/src/sync/index";
import { worldInternals } from "../packages/snapscript/src/world/internals";
import { createTestClientWorld, createTestHostWorld, testProtocol } from "./helpers";

describe("snapshot sync", () => {
  it("applies create snapshots with final field values", () => {
    const Player = defineEntity("CreatePlayer", {
      hp: u16(100),
      dead: bool(false),
      yaw: angle16(0),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);

    const player = a.spawn(Player);
    const state = a.get(player, PlayerState)!;
    state.hp.value = 80;
    state.dead.value = state.hp.value <= 0;

    applySnapshot(b, encodeDirty(a, 1), registry);

    expect(b.get(player.id, PlayerState)?.hp.value).toBe(80);
    expect(b.get(player.id, PlayerState)?.dead.value).toBe(false);
  });

  it("omits field masks for create and destroy ops", () => {
    const Player = defineEntity("FramingPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player, { hp: 77 });
    const createReader = new BitReader(encodeDirty(world, 1));

    expect(createReader.readU8()).toBe(1);
    expect(createReader.readU32()).toBe(1);
    expect(createReader.readVarUint()).toBe(2);
    expect(createReader.readVarUint()).toBe(player.id);
    expect(createReader.readVarUint()).toBe(0);
    expect(createReader.readU8()).toBe(SnapshotOp.CreateEntity);
    expect(createReader.readVarUint()).toBe(player.id);
    expect(createReader.readVarUint()).toBe(PlayerState.schemaId);
    expect(createReader.readU8()).toBe(SnapshotOp.AddComponent);
    expect(createReader.readU16()).toBe(77);
    expect(createReader.remaining()).toBe(0);

    world.destroy(player.id);
    const destroyReader = new BitReader(encodeDirty(world, 2));
    expect(destroyReader.readU8()).toBe(1);
    expect(destroyReader.readU32()).toBe(2);
    expect(destroyReader.readVarUint()).toBe(1);
    expect(destroyReader.readVarUint()).toBe(player.id);
    expect(destroyReader.readVarUint()).toBe(0);
    expect(destroyReader.readU8()).toBe(SnapshotOp.DestroyEntity);
    expect(destroyReader.remaining()).toBe(0);
  });

  it("encodes updates after the first dirty clear", () => {
    const Player = defineEntity("UpdatePlayer", {
      hp: u16(100),
      dead: bool(false),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const player = a.spawn(Player);

    applySnapshot(b, encodeDirty(a, 1), registry);
    a.get(player, PlayerState)!.hp.value = 50;
    applySnapshot(b, encodeDirty(a, 2), registry);

    expect(b.get(player.id, PlayerState)?.hp.value).toBe(50);
    expect(b.get(player.id, PlayerState)?.dead.value).toBe(false);
  });

  it("keeps update ops before removals and destroys in default snapshots", () => {
    const Player = defineEntity("DefaultSnapshotOrderPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const protocol = testProtocol(Player);
    const world = createTestHostWorld(protocol);
    const first = world.spawn(Player);
    const second = world.spawn(Player);

    encodeDirty(world, 1);
    world.get(first, PlayerState)!.hp.value = 50;
    world.destroy(second);
    const reader = new BitReader(encodeDirty(world, 2));

    expect(reader.readU8()).toBe(1);
    expect(reader.readU32()).toBe(2);
    expect(reader.readVarUint()).toBe(2);
    expect(reader.readVarUint()).toBe(first.id);
    expect(reader.readVarUint()).toBe(PlayerState.schemaId);
    expect(reader.readU8()).toBe(SnapshotOp.UpdateComponent);
    expect(reader.readVarUint()).toBe(PlayerState.fields.hp.dirtyBit);
    expect(reader.readU16()).toBe(50);
    expect(reader.readVarUint()).toBe(second.id);
    expect(reader.readVarUint()).toBe(0);
    expect(reader.readU8()).toBe(SnapshotOp.DestroyEntity);
    expect(reader.remaining()).toBe(0);
  });

  it("encodes homogeneous dirty updates as a batched snapshot candidate", () => {
    const Player = defineEntity("BatchedUpdatePlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const first = a.spawn(Player);
    const second = a.spawn(Player);

    applySnapshot(b, encodeDirty(a, 1), registry);
    a.get(first, PlayerState)!.hp.value = 50;
    a.get(second, PlayerState)!.hp.value = 75;
    const bytes = encodeDirtyBatched(a, 2);
    const reader = new BitReader(bytes);

    expect(reader.readU8()).toBe(1);
    expect(reader.readU32()).toBe(2);
    expect(reader.readVarUint()).toBe(1);
    expect(reader.readVarUint()).toBe(0);
    expect(reader.readVarUint()).toBe(PlayerState.schemaId);
    expect(reader.readU8()).toBe(SnapshotOp.BatchUpdateComponent);
    expect(reader.readVarUint()).toBe(PlayerState.fields.hp.dirtyBit);
    expect(reader.readVarUint()).toBe(2);

    applySnapshot(b, bytes, registry);

    expect(b.get(first.id, PlayerState)?.hp.value).toBe(50);
    expect(b.get(second.id, PlayerState)?.hp.value).toBe(75);
    expect(encodeDirty(a, 3)).toEqual(new Uint8Array([1, 3, 0, 0, 0, 0]));
  });

  it("keeps uncommon dirty masks as normal update ops in batched encoding", () => {
    const Player = defineEntity("BatchedFallbackPlayer", {
      hp: u16(100),
      armor: u16(0),
    });
    const PlayerState = Player.component;
    const protocol = testProtocol(Player);
    const world = createTestHostWorld(protocol);
    const first = world.spawn(Player);
    const second = world.spawn(Player);

    encodeDirty(world, 1);
    world.get(first, PlayerState)!.hp.value = 50;
    world.get(second, PlayerState)!.armor.value = 25;
    const reader = new BitReader(encodeDirtyBatched(world, 2));

    expect(reader.readU8()).toBe(1);
    expect(reader.readU32()).toBe(2);
    expect(reader.readVarUint()).toBe(2);
    expect(reader.readVarUint()).toBe(first.id);
    expect(reader.readVarUint()).toBe(PlayerState.schemaId);
    expect(reader.readU8()).toBe(SnapshotOp.UpdateComponent);
    expect(reader.readVarUint()).toBe(PlayerState.fields.hp.dirtyBit);
    expect(reader.readU16()).toBe(50);
    expect(reader.readVarUint()).toBe(second.id);
    expect(reader.readVarUint()).toBe(PlayerState.schemaId);
    expect(reader.readU8()).toBe(SnapshotOp.UpdateComponent);
    expect(reader.readVarUint()).toBe(PlayerState.fields.armor.dirtyBit);
    expect(reader.readU16()).toBe(25);
    expect(reader.remaining()).toBe(0);
  });

  it("encodes a full snapshot without consuming dirty state", () => {
    const Player = defineEntity("FullSnapshotPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const player = a.spawn(Player, { hp: 40 });

    applySnapshot(b, encodeFullSnapshot(a, 10), registry);

    expect(b.get(player.id, PlayerState)?.hp.value).toBe(40);
    expect(applySnapshot(b, encodeDirty(a, 11), registry)).toBe(11);
    expect(b.get(player.id, PlayerState)?.hp.value).toBe(40);
  });

  it("applies destroy snapshots", () => {
    const Player = defineEntity("DestroyPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const player = a.spawn(Player);

    applySnapshot(b, encodeDirty(a, 1), registry);
    a.destroy(player.id);
    applySnapshot(b, encodeDirty(a, 2), registry);

    expect(b.get(player.id, PlayerState)).toBeUndefined();
  });

  it("keeps remote apply from marking local dirty", () => {
    const Player = defineEntity("RemoteDirtyPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const player = a.spawn(Player);

    applySnapshot(b, encodeDirty(a, 1), registry);
    a.get(player, PlayerState)!.hp.value = 25;
    applySnapshot(b, encodeDirty(a, 2), registry);

    const echoed = encodeDirty(b, 3);
    expect(echoed).toEqual(new Uint8Array([1, 3, 0, 0, 0, 0]));
  });

  it("handles mixed entity operations in one snapshot", () => {
    const Player = defineEntity("MixedPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const first = a.spawn(Player);
    const second = a.spawn(Player, { hp: 20 });

    applySnapshot(b, encodeDirty(a, 1), registry);
    a.get(first, PlayerState)!.hp.value = 90;
    a.destroy(second.id);
    const third = a.spawn(Player, { hp: 30 });

    applySnapshot(b, encodeDirty(a, 2), registry);

    expect(b.get(first.id, PlayerState)?.hp.value).toBe(90);
    expect(b.get(second.id, PlayerState)).toBeUndefined();
    expect(b.get(third.id, PlayerState)?.hp.value).toBe(30);
  });

  it("does not clear dirty updates when encoding fails", () => {
    const throwingCodec: FieldCodec<number> = {
      kind: "throwing",
      write(_writer: BitWriter, value: number) {
        if (value === 13) {
          throw new Error("cannot encode 13");
        }
        _writer.writeU16(value);
      },
      read(reader) {
        return reader.readU16();
      },
      equals: Object.is,
    };
    const Player = defineEntity("EncodeFailurePlayer", {
      hp: { ...u16(0), codec: throwingCodec } as ReturnType<typeof u16>,
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player);

    encodeDirty(world, 1);
    world.get(player, PlayerState)!.hp.value = 13;

    expect(() => encodeDirty(world, 2)).toThrow(/cannot encode 13/);
    expect(worldInternals(world).getDirtyMask(player.id, PlayerState.schemaId)).toBe(
      PlayerState.fields.hp.dirtyBit,
    );
  });

  it("requires the provided registry instead of falling back to global schemas", () => {
    const Player = defineEntity("RegistryRequiredPlayer", {
      hp: u16(100),
    });
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    a.spawn(Player);

    expect(() => applySnapshot(b, encodeDirty(a, 1), createRegistry())).toThrow(
      /Unknown componentId/,
    );
  });
});
