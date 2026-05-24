import { describe, expect, it } from "vitest";
import { defineEntity, qf32, u16, vec2q } from "../packages/snapscript/src/index";
import { createRegistry } from "../packages/snapscript/src/registry/index";
import { applySnapshot, encodeDirty } from "../packages/snapscript/src/sync/index";
import { worldInternals } from "../packages/snapscript/src/world/internals";
import { createTestClientWorld, createTestHostWorld, testProtocol } from "./helpers";

describe("world and NetRef", () => {
  it("marks changed local refs dirty", () => {
    const Player = defineEntity("DirtyPlayer", {
      hp: u16(100),
      maxHp: u16(100),
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player);
    const state = world.get(player, PlayerState)!;

    encodeDirty(world, 1);
    state.hp.set(80);

    expect(worldInternals(world).getDirtyMask(player.id, PlayerState.schemaId)).toBe(
      PlayerState.fields.hp.dirtyBit,
    );
  });

  it("does not mark unchanged values dirty", () => {
    const Player = defineEntity("UnchangedPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player);
    const state = world.get(player, PlayerState)!;

    encodeDirty(world, 1);
    state.hp.value = 100;

    expect(worldInternals(world).getDirtyMask(player.id)).toBe(0);
  });

  it("uses codec equality for dirty checks", () => {
    const Player = defineEntity("QuantizedDirtyPlayer", {
      x: qf32({ min: -10, max: 10, precision: 0.1, default: 1 }),
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player);
    const state = world.get(player, PlayerState)!;

    encodeDirty(world, 1);
    state.x.value = 1.04;

    expect(worldInternals(world).getDirtyMask(player.id)).toBe(0);
  });

  it("snapshots object values so aliases and nested writes cannot bypass dirty tracking", () => {
    const Player = defineEntity("VectorDirtyPlayer", {
      pos: vec2q({ min: -100, max: 100, precision: 0.01, default: { x: 0, y: 0 } }),
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player);
    const state = world.get(player, PlayerState)!;

    expect(Object.isFrozen(state.pos.value)).toBe(true);
    expect(() => {
      (state.pos.value as { x: number }).x = 5;
    }).toThrow();

    const next = { x: 1, y: 2 };
    encodeDirty(world, 1);
    state.pos.value = next;
    next.x = 99;

    expect(state.pos.value).toEqual({ x: 1, y: 2 });
    expect(worldInternals(world).getDirtyMask(player.id, PlayerState.schemaId)).toBe(
      PlayerState.fields.pos.dirtyBit,
    );
  });

  it("validates field values when writing local state", () => {
    const Player = defineEntity("InvalidWritePlayer", {
      hp: u16(100),
      pos: vec2q({ min: -100, max: 100, precision: 0.01, default: { x: 0, y: 0 } }),
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player);
    const state = world.get(player, PlayerState)!;

    expect(() => world.spawn(Player, { hp: 100000 } as never)).toThrow(/u16 must be an integer/);
    expect(() => state.hp.set(-1)).toThrow(/u16 must be an integer/);
    expect(() => {
      state.pos.value = { x: Number.NaN, y: 0 };
    }).toThrow(/vec2q\.x must be a finite number/);
    expect(state.hp.value).toBe(100);
    expect(state.pos.value).toEqual({ x: 0, y: 0 });
  });

  it("remote apply updates values without dirty echo", () => {
    const Player = defineEntity("RemotePlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const player = a.spawn(Player);
    const state = a.get(player, PlayerState)!;

    applySnapshot(b, encodeDirty(a, 1), registry);
    state.hp.value = 80;
    applySnapshot(b, encodeDirty(a, 2), registry);

    expect(b.get(player.id, PlayerState)?.hp.value).toBe(80);
    expect(worldInternals(b).getDirtyMask(player.id)).toBe(0);
  });
});
