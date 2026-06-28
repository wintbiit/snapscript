import { describe, expect, it } from "vitest";
import { createClientWorld, createServerWorld, defineComponent, defineEntity, qf32, u16, vec2q } from "../packages/snapscript/src/index";
import { createRegistry } from "../packages/snapscript/src/registry/index";
import { applySnapshot, encodeDirty } from "../packages/snapscript/src/sync/index";
import { worldInternals } from "../packages/snapscript/src/world/internals";
import { createTestClientWorld, createTestServerWorld, testClientTransport, testClock, testProtocol, testServerTransport } from "./helpers";

describe("world and NetRef", () => {
  it("marks changed local refs dirty", () => {
    const Player = defineEntity("DirtyPlayer", {
      hp: u16(100),
      maxHp: u16(100),
    });
    const PlayerState = Player.component;
    const world = createTestServerWorld(testProtocol(Player));
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
    const world = createTestServerWorld(testProtocol(Player));
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
    const world = createTestServerWorld(testProtocol(Player));
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
    const world = createTestServerWorld(testProtocol(Player));
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
    const world = createTestServerWorld(testProtocol(Player));
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
    const a = createTestServerWorld(protocol);
    const b = createTestClientWorld(protocol);
    const player = a.spawn(Player);
    const state = a.get(player, PlayerState)!;

    applySnapshot(b, encodeDirty(a, 1), registry);
    state.hp.value = 80;
    applySnapshot(b, encodeDirty(a, 2), registry);

    expect(b.get(player, PlayerState)?.hp.value).toBe(80);
    expect(worldInternals(b).getDirtyMask(player.id)).toBe(0);
  });

  it("registers local components on server and client worlds", () => {
    const Local = defineComponent("RegisteredLocalComponent", { hp: u16(100) }, { replicated: false });
    const protocol = testProtocol();
    const server = createServerWorld({
      protocol,
      localComponents: [Local],
      transport: testServerTransport(),
      clock: testClock(),
    });
    const client = createClientWorld({
      protocol,
      localComponents: [Local],
      transport: testClientTransport(),
      clock: testClock(),
    });

    const serverEntity = server.spawn(Local, { hp: 80 });
    const clientEntity = client.spawn(Local, { hp: 70 });

    expect(server.get(serverEntity, Local)?.hp.value).toBe(80);
    expect(client.get(clientEntity, Local)?.hp.value).toBe(70);
  });

  it("rejects invalid local component registration", () => {
    const Replicated = defineComponent("InvalidLocalReplicatedComponent", { hp: u16(100) });
    const Local = defineComponent("DuplicateLocalComponent", { hp: u16(100) }, { replicated: false });

    expect(() =>
      createServerWorld({
        protocol: testProtocol(),
        localComponents: [Replicated],
        transport: testServerTransport(),
        clock: testClock(),
      }),
    ).toThrow(/localComponents/);
    expect(() =>
      createClientWorld({
        protocol: testProtocol(),
        localComponents: [Local, Local],
        transport: testClientTransport(),
        clock: testClock(),
      }),
    ).toThrow(/duplicate local component/);
  });

  it("lets clients mutate local components but not replicated state", () => {
    const Replicated = defineEntity("ClientReplicatedMutationPlayer", { hp: u16(100) });
    const Local = defineComponent("ClientMutableLocalComponent", { hp: u16(100) }, { replicated: false });
    const protocol = testProtocol(Replicated);
    const server = createTestServerWorld(protocol);
    const client = createClientWorld({
      protocol,
      localComponents: [Local],
      transport: testClientTransport(),
      clock: testClock(),
    });
    const replicatedEntity = server.spawn(Replicated);
    applySnapshot(client, encodeDirty(server, 1), createRegistry().registerComponent(Replicated.component));

    const localEntity = client.spawn();
    client.add(localEntity, Local, { hp: 50 });
    client.get(localEntity, Local)!.hp.value = 40;

    expect(client.get(localEntity, Local)?.hp.value).toBe(40);
    expect(() => {
      (client.get(replicatedEntity, Replicated.component) as any).hp.value = 10;
    }).toThrow(/read-only replicated field/);
    expect(() => client.add(replicatedEntity, Local)).toThrow(/replicated entity/);
    expect(() => client.destroy(replicatedEntity)).toThrow(/replicated entity/);
  });
});
