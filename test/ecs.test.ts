import { describe, expect, it } from "vitest";
import {
  createClientWorld,
  createHostWorld,
  defineComponent,
  defineEntity,
  defineProtocol,
  qf32,
  u16,
  type ChannelName,
  type ClientTransport,
  type Clock,
  type ComponentSchema,
  type HostTransport,
  type PeerRef,
} from "../src/index";
import { createRegistry } from "../src/registry/index";
import { createSyncHost } from "../src/runtime/index";
import { applySnapshot, encodeDirty } from "../src/sync/index";
import type { ComponentRecord } from "../src/world/records";
import { SparseSetComponentStorage } from "../src/world/storage";
import { createTestClientWorld, createTestHostWorld, testProtocol } from "./helpers";

function clock(): Clock {
  let tick = 0;
  return {
    nowMs: () => tick * 16,
    tick: () => {
      tick += 1;
      return tick;
    },
  };
}

class RecordingTransport implements ClientTransport, HostTransport {
  readonly channels: ChannelName[] = [];
  readonly peer: PeerRef = {};
  #clientHandler?: (channel: ChannelName, bytes: Uint8Array) => void;
  #hostHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  send(a: PeerRef | ChannelName, b: ChannelName | Uint8Array, c?: Uint8Array): void {
    const channel = c === undefined ? (a as ChannelName) : (b as ChannelName);
    const bytes = c ?? (b as Uint8Array);
    this.channels.push(channel);
    this.#clientHandler?.(channel, bytes);
  }

  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void;
  onPacket(
    cb:
      | ((channel: ChannelName, bytes: Uint8Array) => void)
      | ((peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void),
  ): void {
    if (cb.length >= 3) {
      this.#hostHandler = cb as (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
    } else {
      this.#clientHandler = cb as (channel: ChannelName, bytes: Uint8Array) => void;
    }
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    this.send(channel, bytes);
  }

  peers(): Iterable<PeerRef> {
    return [this.peer];
  }
}

describe("ecs world", () => {
  it("adds, gets, removes, and queries components", () => {
    const Position = defineComponent("EcsPosition", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
      y: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("EcsHealth", {
      hp: u16(100),
    });
    const world = createTestHostWorld(testProtocol(Position, Health));

    const entity = world.spawn();
    const pos = world.add(entity, Position, { x: 4 });
    world.add(entity, Health);

    expect(pos.x.value).toBe(4);
    expect(world.get(entity, Health)?.hp.value).toBe(100);
    expect(world.query(Position, Health)).toHaveLength(1);

    expect(world.remove(entity, Health)).toBe(true);
    expect(world.query(Position, Health)).toHaveLength(0);
  });

  it("spawns empty entities through the primary host API", () => {
    const Position = defineComponent("EmptySpawnPosition", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const world = createTestHostWorld(testProtocol(Position));

    const entity = world.spawn();
    const position = world.add(entity, Position, { x: 3 });

    expect(Object.isFrozen(entity)).toBe(true);
    expect(() => {
      (entity as { id: number }).id = 99;
    }).toThrow();
    expect(Object.isFrozen(position)).toBe(true);
    expect(() => {
      (position as { entityId: number }).entityId = 99;
    }).toThrow();
    expect(() => {
      (position as Record<string, unknown>).extra = true;
    }).toThrow();
    expect(position.x.value).toBe(3);
    position.x.value = 4;
    expect(position.x.value).toBe(4);
    expect(world.get(entity, Position)).toBe(position);
    const rows = world.query(Position).toArray();
    expect(Object.isFrozen(rows[0]![0])).toBe(true);
    expect(rows.map(([rowEntity]) => rowEntity.id)).toEqual([entity.id]);
  });

  it("keeps sparse-set rows valid after dense swap removal", () => {
    const Position = defineComponent("SparseSwapPosition", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const world = createTestHostWorld(testProtocol(Position));
    const first = world.spawn();
    const second = world.spawn();
    world.add(first, Position, { x: 1 });
    world.add(second, Position, { x: 2 });

    expect(world.remove(first, Position)).toBe(true);

    expect(world.get(first, Position)).toBeUndefined();
    expect(world.get(second, Position)?.x.value).toBe(2);
    expect([...world.query(Position)].map(([entity]) => entity.id)).toEqual([second.id]);
  });

  it("updates archetype query results after component add and remove", () => {
    const Position = defineComponent("ArchetypePosition", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Velocity = defineComponent("ArchetypeVelocity", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("ArchetypeHealth", {
      hp: u16(100),
    });
    const world = createTestHostWorld(testProtocol(Position, Velocity, Health));
    const mover = world.spawn();
    const partial = world.spawn();
    world.add(mover, Position);
    world.add(mover, Velocity);
    world.add(partial, Position);

    expect(world.query(Position).length).toBe(2);
    expect(world.query(Position, Velocity).length).toBe(1);
    expect(world.query(Position, Velocity, Health).length).toBe(0);

    world.add(mover, Health, { hp: 80 });
    world.add(partial, Velocity);

    expect(world.query(Position, Velocity).length).toBe(2);
    expect(world.query(Position, Velocity, Health).length).toBe(1);

    world.remove(mover, Velocity);

    expect(world.query(Position, Velocity).length).toBe(1);
    expect(world.query(Position, Velocity, Health).length).toBe(0);
  });

  it("keeps sparse fallback and archetype query indexes consistent", () => {
    const Position = defineComponent("StorageComparePosition", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Velocity = defineComponent("StorageCompareVelocity", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("StorageCompareHealth", {
      hp: u16(100),
    });
    const Team = defineComponent("StorageCompareTeam", {
      id: u16(0),
    });
    const sparse = new SparseSetComponentStorage({ archetypeIndex: false });
    const archetype = new SparseSetComponentStorage();

    const record = (entityId: number, schema: ComponentSchema): ComponentRecord => ({
      entityId,
      schema,
      instance: { entityId, id: schema.schemaId, schema } as never,
    });
    const add = (entityId: number, components: readonly ComponentSchema[]) => {
      for (const storage of [sparse, archetype]) {
        storage.addEntity(entityId);
        for (const component of components) {
          storage.set(entityId, component.schemaId, record(entityId, component));
        }
      }
    };
    const ids = (storage: SparseSetComponentStorage, components: readonly ComponentSchema[]) =>
      [...storage.queryRows(components.map((component) => component.schemaId))]
        .map((row) => row.entityId)
        .sort((a, b) => a - b);

    add(1, [Position, Velocity, Health]);
    add(2, [Position, Velocity]);
    add(3, [Position, Health]);
    add(4, [Velocity, Health]);
    add(5, [Position]);

    expect(ids(archetype, [Position])).toEqual(ids(sparse, [Position]));
    expect(ids(archetype, [Position, Velocity])).toEqual(ids(sparse, [Position, Velocity]));
    expect(ids(archetype, [Position, Velocity, Health])).toEqual(
      ids(sparse, [Position, Velocity, Health]),
    );

    sparse.remove(1, Velocity.schemaId);
    archetype.remove(1, Velocity.schemaId);
    sparse.set(3, Velocity.schemaId, record(3, Velocity));
    archetype.set(3, Velocity.schemaId, record(3, Velocity));
    sparse.set(5, Velocity.schemaId, record(5, Velocity));
    archetype.set(5, Velocity.schemaId, record(5, Velocity));
    sparse.remove(2, Velocity.schemaId);
    archetype.remove(2, Velocity.schemaId);

    expect(ids(archetype, [Position, Velocity])).toEqual(ids(sparse, [Position, Velocity]));
    expect(ids(archetype, [Position, Velocity])).toContain(5);
    expect(ids(archetype, [Position, Velocity])).not.toContain(2);
    expect(archetype.countRows([Position.schemaId, Velocity.schemaId, Health.schemaId])).toBe(
      sparse.countRows([Position.schemaId, Velocity.schemaId, Health.schemaId]),
    );

    const pairIdsBeforeNewSignature = ids(archetype, [Position, Velocity]);
    expect(archetype.countRows([Position.schemaId, Velocity.schemaId])).toBe(
      pairIdsBeforeNewSignature.length,
    );
    add(6, [Position, Velocity, Team]);
    expect(ids(archetype, [Position, Velocity])).toEqual(ids(sparse, [Position, Velocity]));
    expect(archetype.countRows([Position.schemaId, Velocity.schemaId])).toBe(
      sparse.countRows([Position.schemaId, Velocity.schemaId]),
    );

    sparse.remove(6, Velocity.schemaId);
    archetype.remove(6, Velocity.schemaId);
    expect(ids(archetype, [Position, Velocity])).toEqual(ids(sparse, [Position, Velocity]));
    expect(archetype.countRows([Position.schemaId, Velocity.schemaId])).toBe(
      sparse.countRows([Position.schemaId, Velocity.schemaId]),
    );

    for (let index = 0; index < 4; index += 1) {
      sparse.set(1, Team.schemaId, record(1, Team));
      archetype.set(1, Team.schemaId, record(1, Team));
      expect(ids(archetype, [Position, Health, Team])).toEqual(
        ids(sparse, [Position, Health, Team]),
      );

      sparse.remove(1, Team.schemaId);
      archetype.remove(1, Team.schemaId);
      expect(ids(archetype, [Position, Health, Team])).toEqual(
        ids(sparse, [Position, Health, Team]),
      );
      expect(archetype.countRows([Position.schemaId, Health.schemaId, Team.schemaId])).toBe(
        sparse.countRows([Position.schemaId, Health.schemaId, Team.schemaId]),
      );
    }
  });

  it("preserves query helpers over sparse/archetype results", () => {
    const Position = defineComponent("QueryHelpersPosition", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("QueryHelpersHealth", {
      hp: u16(100),
    });
    const world = createTestHostWorld(testProtocol(Position, Health));
    const first = world.spawn();
    const second = world.spawn();
    world.add(first, Position, { x: 1 });
    world.add(first, Health, { hp: 10 });
    world.add(second, Position, { x: 2 });
    world.add(second, Health, { hp: 20 });

    const rows = world.query(Position, Health);
    const ids = rows.map(([entity]) => entity.id).sort((a, b) => a - b);
    const hp: number[] = [];
    rows.forEach(([, , health]) => hp.push(health.hp.value));

    expect(rows.length).toBe(2);
    expect(ids).toEqual([first.id, second.id]);
    expect(hp.sort((a, b) => a - b)).toEqual([10, 20]);
    expect(rows.toArray()).toHaveLength(2);
    expect(() => rows.map(null as never)).toThrow(/QueryResult\.map\(\) requires a function/);
    expect(() => rows.forEach(null as never)).toThrow(
      /QueryResult\.forEach\(\) requires a function/,
    );
  });

  it("iterates matching components with each without changing query semantics", () => {
    const Position = defineComponent("EachPosition", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Velocity = defineComponent("EachVelocity", {
      x: qf32({ min: -100, max: 100, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("EachHealth", {
      hp: u16(100),
    });
    const Team = defineComponent("EachTeam", {
      id: u16(1),
    });
    const world = createTestHostWorld(testProtocol(Position, Velocity, Health, Team));
    const moving = world.spawn();
    const idle = world.spawn();
    world.add(moving, Position, { x: 1 });
    world.add(moving, Velocity, { x: 2 });
    world.add(moving, Health, { hp: 80 });
    world.add(moving, Team, { id: 7 });
    world.add(idle, Position, { x: 10 });
    world.add(idle, Health, { hp: 20 });
    world.add(idle, Team, { id: 2 });

    const visited: number[] = [];
    world.each([Position, Velocity] as const, (entity, pos, vel) => {
      visited.push(entity.id);
      pos.x.value += vel.x.value;
    });

    const triple: number[] = [];
    world.each([Position, Velocity, Health] as const, (entity, pos, vel, health) => {
      triple.push(entity.id, pos.x.value, vel.x.value, health.hp.value);
    });

    const quad: number[] = [];
    world.each([Position, Velocity, Health, Team] as const, (entity, pos, vel, health, team) => {
      quad.push(entity.id, pos.x.value, vel.x.value, health.hp.value, team.id.value);
    });

    expect(visited).toEqual([moving.id]);
    expect(world.get(moving, Position)?.x.value).toBe(3);
    expect(world.get(idle, Position)?.x.value).toBe(10);
    expect(triple).toEqual([moving.id, 3, 2, 80]);
    expect(quad).toEqual([moving.id, 3, 2, 80, 7]);
    expect(world.query(Position, Velocity).length).toBe(1);
    expect(world.query(Position, Velocity, Health, Team).toArray()).toHaveLength(1);
    expect(() => world.each([Position] as const, null as never)).toThrow(
      /world\.each\(\) requires a function/,
    );
  });

  it("spawns prefabs through defineEntity sugar over components", () => {
    const Position = defineComponent("PrefabPosition", {
      x: qf32({ min: -10, max: 10, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("PrefabHealth", {
      hp: u16(100),
    });
    const Player = defineEntity("PrefabPlayer", {
      position: Position,
      health: Health,
    });
    const world = createTestHostWorld(testProtocol(Player));

    const player = world.spawn(Player, {
      position: { x: 2 },
      health: { hp: 80 },
    });

    expect(world.get(player, Position)?.x.value).toBe(2);
    expect(world.get(player, Health)?.hp.value).toBe(80);
    expect(world.has(player, Player)).toBe(true);
    const empty = world.spawn();
    const addedParts = world.add(empty, Player, {
      position: { x: 4 },
      health: { hp: 70 },
    });
    expect(Object.isFrozen(addedParts)).toBe(true);
    expect(addedParts.position.x.value).toBe(4);
    expect(addedParts.health.hp.value).toBe(70);
    expect(world.has(empty, Player)).toBe(true);
    expect(() => world.get(player, Player as never)).toThrow(/single primary component/);
    const parts = world.getPrefab(player, Player)!;
    expect(Object.isFrozen(parts)).toBe(true);
    expect(Object.isFrozen(parts.position)).toBe(true);
    expect(() => {
      (parts as Record<string, unknown>).extra = true;
    }).toThrow();
    expect(() => {
      (parts as Record<string, unknown>).position = parts.health;
    }).toThrow();
    expect(parts.position.x.value).toBe(2);
    expect(parts.health.hp.value).toBe(80);
    parts.position.x.value = 3;
    expect(world.get(player, Position)?.x.value).toBe(3);
    expect(world.remove(player, Player)).toBe(true);
    expect(world.has(player, Player)).toBe(false);
    expect(world.get(player, Position)).toBeUndefined();
    expect(world.get(player, Health)).toBeUndefined();
    expect(world.remove(player, Player)).toBe(false);
  });

  it("rejects unknown initial fields and prefab aliases", () => {
    const Position = defineComponent("InitialPosition", {
      x: qf32({ min: -10, max: 10, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("InitialHealth", {
      hp: u16(100),
    });
    const Player = defineEntity("InitialPlayer", {
      position: Position,
      health: Health,
    });
    const Simple = defineEntity("InitialSimple", {
      hp: u16(100),
    });
    const world = createTestHostWorld(testProtocol(Position, Health, Player, Simple));
    const entity = world.spawn();

    expect(() => world.add(entity, Position, { y: 1 } as never)).toThrow(/unknown field "y"/);
    expect(() => world.spawn(Position, { y: 1 } as never)).toThrow(/unknown field "y"/);
    expect(() => world.add(entity, Position, new Date() as never)).toThrow(/plain object map/);
    expect(() => world.spawn(Position, new (class PositionInitial {})() as never)).toThrow(
      /plain object map/,
    );
    expect(() => world.spawn(Player, { positon: { x: 1 } } as never)).toThrow(
      /unknown key "positon"/,
    );
    expect(() => world.spawn(Player, { position: { y: 1 } } as never)).toThrow(
      /unknown field "y"/,
    );
    expect(() => world.spawn(Player, { position: null } as never)).toThrow(
      /initial "position" must be an object/,
    );
    expect(() => world.spawn(Player, { position: new Date() } as never)).toThrow(
      /plain object map/,
    );
    expect(() => world.spawn(Simple, { state: { hp: 80 }, hp: 70 } as never)).toThrow(
      /cannot mix component aliases/,
    );
  });

  it("runs systems in phase order", () => {
    const world = createTestHostWorld();
    const order: string[] = [];

    world.system("pre", "preUpdate", () => order.push("pre"));
    world.system("update", "update", () => order.push("update"));
    world.system("post", "postUpdate", () => order.push("post"));

    world.tick();

    expect(order).toEqual(["pre", "update", "post"]);
  });

  it("fails fast for invalid system registrations", () => {
    const host = createTestHostWorld();
    const client = createTestClientWorld();

    expect(() => host.system("", "update", () => {})).toThrow(/non-empty system name/);
    host.system("duplicate", "update", () => {});
    expect(() => host.system("duplicate", "update", () => {})).toThrow(
      /already has a system named "duplicate" in phase "update"/,
    );
    expect(() => host.system("duplicate", "postUpdate", () => {})).not.toThrow();
    expect(() => host.system("bad-phase", "render" as never, () => {})).toThrow(
      /phase must be "preUpdate", "update", "postUpdate", or "network"/,
    );
    expect(() => host.system("bad-fn", "update", true as never)).toThrow(/requires a function/);
    expect(() => client.system("bad-client-fn", "update", null as never)).toThrow(
      /requires a function/,
    );
  });

  it("freezes system contexts shared within a phase", () => {
    const host = createTestHostWorld();
    const seen: string[] = [];

    host.system("first", "update", (_world, context) => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(() => {
        (context as { dtMs: number }).dtMs = 99;
      }).toThrow();
      seen.push(`first:${context.dtMs}`);
    });
    host.system("second", "update", (_world, context) => {
      expect(Object.isFrozen(context)).toBe(true);
      seen.push(`second:${context.dtMs}`);
    });

    host.tick();

    expect(seen).toEqual(["first:0", "second:0"]);
  });

  it("runs systems from a stable phase snapshot", () => {
    const host = createTestHostWorld();
    const order: string[] = [];
    let registeredLate = false;

    host.system("first", "update", (world) => {
      order.push("first");
      if (!registeredLate) {
        registeredLate = true;
        world.system("late", "update", () => order.push("late"));
      }
    });
    host.system("second", "update", () => order.push("second"));

    host.tick();
    expect(order).toEqual(["first", "second"]);

    host.tick();
    expect(order).toEqual(["first", "second", "first", "second", "late"]);
  });

  it("uses one timing context per world tick across phases", () => {
    const protocol = defineProtocol({});
    let nowMs = 1000;
    let networkTick = 0;
    const timedClock: Clock = {
      nowMs: () => nowMs,
      tick: () => {
        networkTick += 1;
        return networkTick;
      },
    };
    const host = createHostWorld({
      protocol,
      transport: new RecordingTransport(),
      clock: timedClock,
    });
    const contexts: { phase: string; tick: number; dtMs: number; nowMs: number }[] = [];

    for (const phase of ["preUpdate", "update", "postUpdate", "network"] as const) {
      host.system(`host-${phase}`, phase, (_world, context) => contexts.push(context));
    }

    host.tick();
    nowMs = 1016;
    host.tick();

    expect(contexts.map((context) => context.phase)).toEqual([
      "preUpdate",
      "update",
      "postUpdate",
      "network",
      "preUpdate",
      "update",
      "postUpdate",
      "network",
    ]);
    expect(contexts.slice(0, 4).map(({ tick, dtMs, nowMs }) => ({ tick, dtMs, nowMs }))).toEqual([
      { tick: 1, dtMs: 0, nowMs: 1000 },
      { tick: 1, dtMs: 0, nowMs: 1000 },
      { tick: 1, dtMs: 0, nowMs: 1000 },
      { tick: 1, dtMs: 0, nowMs: 1000 },
    ]);
    expect(contexts.slice(4).map(({ tick, dtMs, nowMs }) => ({ tick, dtMs, nowMs }))).toEqual([
      { tick: 2, dtMs: 16, nowMs: 1016 },
      { tick: 2, dtMs: 16, nowMs: 1016 },
      { tick: 2, dtMs: 16, nowMs: 1016 },
      { tick: 2, dtMs: 16, nowMs: 1016 },
    ]);
  });

  it("uses one timing context per client world tick", () => {
    const protocol = defineProtocol({});
    let nowMs = 2000;
    let networkTick = 0;
    const timedClock: Clock = {
      nowMs: () => nowMs,
      tick: () => {
        networkTick += 1;
        return networkTick;
      },
    };
    const client = createClientWorld({
      protocol,
      transport: new RecordingTransport(),
      clock: timedClock,
    });
    const contexts: { phase: string; tick: number; dtMs: number; nowMs: number }[] = [];

    for (const phase of ["preUpdate", "update", "postUpdate"] as const) {
      client.system(`client-${phase}`, phase, (_world, context) => contexts.push(context));
    }

    client.tick();
    nowMs = 2020;
    client.tick();

    expect(contexts.slice(0, 3).map(({ tick, dtMs, nowMs }) => ({ tick, dtMs, nowMs }))).toEqual([
      { tick: 1, dtMs: 0, nowMs: 2000 },
      { tick: 1, dtMs: 0, nowMs: 2000 },
      { tick: 1, dtMs: 0, nowMs: 2000 },
    ]);
    expect(contexts.slice(3).map(({ tick, dtMs, nowMs }) => ({ tick, dtMs, nowMs }))).toEqual([
      { tick: 2, dtMs: 20, nowMs: 2020 },
      { tick: 2, dtMs: 20, nowMs: 2020 },
      { tick: 2, dtMs: 20, nowMs: 2020 },
    ]);
  });

  it("round-trips component add, update, remove, and destroy snapshot ops", () => {
    const Position = defineComponent("SnapshotPosition", {
      x: qf32({ min: -10, max: 10, precision: 0.01, default: 0 }),
    });
    const Health = defineComponent("SnapshotHealth", {
      hp: u16(100),
    });
    const Player = defineEntity("SnapshotPlayer", {
      position: Position,
      health: Health,
    });
    const registry = createRegistry().registerComponent(Position).registerComponent(Health);
    const protocol = testProtocol(Player);
    const a = createTestHostWorld(protocol);
    const b = createTestClientWorld(protocol);
    const entity = a.spawn(Player, {
      position: { x: 1 },
      health: { hp: 90 },
    });
    const pos = a.get(entity, Position)!;

    applySnapshot(b, encodeDirty(a, 1), registry);
    expect(b.get(entity, Position)?.x.value).toBe(1);
    expect(b.get(entity, Health)?.hp.value).toBe(90);

    pos.x.value = 2;
    applySnapshot(b, encodeDirty(a, 2), registry);
    expect(b.get(entity, Position)?.x.value).toBe(2);

    a.remove(entity, Player);
    applySnapshot(b, encodeDirty(a, 3), registry);
    expect(b.get(entity, Position)).toBeUndefined();
    expect(b.get(entity, Health)).toBeUndefined();

    a.add(entity, Player, {
      position: { x: 4 },
      health: { hp: 70 },
    });
    applySnapshot(b, encodeDirty(a, 4), registry);
    expect(b.get(entity, Position)?.x.value).toBe(4);
    expect(b.get(entity, Health)?.hp.value).toBe(70);

    a.destroy(entity);
    applySnapshot(b, encodeDirty(a, 5), registry);
    expect(b.get(entity, Position)).toBeUndefined();
  });

  it("uses the unreliable channel for update-only dirty snapshots", () => {
    const Position = defineComponent("ChannelPosition", {
      x: qf32({ min: -10, max: 10, precision: 0.01, default: 0 }),
    });
    const registry = createRegistry().registerComponent(Position);
    const world = createTestHostWorld(testProtocol(Position));
    const entity = world.spawn();
    const pos = world.add(entity, Position);
    encodeDirty(world, 1);
    const transport = new RecordingTransport();
    const host = createSyncHost({ world, transport, clock: clock(), registry });

    pos.x.value = 1;
    host.update();

    expect(transport.channels.at(-1)).toBe("unreliable");
  });
});
