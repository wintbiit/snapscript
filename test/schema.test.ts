import { describe, expect, it } from "vitest";
import {
  bool,
  defineCommand,
  defineComponent,
  defineEntity,
  defineEvent,
  defineProtocol,
  enumOf,
  qf32,
  u8,
  u16,
  vec2q,
  vec3q,
  type ComponentSchema,
} from "../src/index";
import { createTestHostWorld, testProtocol } from "./helpers";

describe("schema", () => {
  it("assigns field ids in declaration order", () => {
    const Player = defineEntity("SchemaOrderPlayer", {
      hp: u16(100),
      dead: bool(false),
      team: u8(1),
    });
    const PlayerState = Player.component;

    expect(PlayerState.fields.hp.fieldId).toBe(0);
    expect(PlayerState.fields.dead.fieldId).toBe(1);
    expect(PlayerState.fields.team.fieldId).toBe(2);
    expect(PlayerState.fullMask).toBe(0b111);
  });

  it("rejects schemas with more than 32 fields", () => {
    const fields = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, u8(0)]));
    expect(() => defineEntity("TooManyFields", fields)).toThrow(/at most 32/);
  });

  it("rejects invalid schema definition shapes", () => {
    expect(() => defineEntity("", { hp: u16(1) })).toThrow(/Entity name must be a non-empty string/);
    expect(() => defineComponent(" ", { hp: u16(1) })).toThrow(/Component name must be a non-empty string/);
    expect(() => defineEntity("NullEntityFields", null as never)).toThrow(
      /fields\/components must be an object/,
    );
    expect(() => defineComponent("ArrayComponentFields", [] as never)).toThrow(
      /fields\/components must be an object/,
    );
    expect(() => defineComponent("DateComponentFields", new Date() as never)).toThrow(
      /plain object map/,
    );
    expect(() => defineEntity("ClassEntityFields", new (class EntityFields {})() as never)).toThrow(
      /plain object map/,
    );
    expect(() => defineComponent("DateComponentOptions", { hp: u16(1) }, new Date() as never))
      .toThrow(/Component "DateComponentOptions" options must be an object/);
    expect(() =>
      defineEntity("ClassEntityOptions", { hp: u16(1) }, new (class EntityOptions {})() as never),
    ).toThrow(/Entity "ClassEntityOptions" options must be an object/);
    expect(() =>
      defineComponent("DateComponentMetadata", { hp: u16(1) }, { metadata: new Date() as never }),
    ).toThrow(/Component "DateComponentMetadata" metadata must be an object/);
  });

  it("rejects invalid component and prefab ids", () => {
    expect(() => defineComponent("InvalidComponentId", { hp: u16(1) }, { id: -1 })).toThrow(
      /id must be an integer in \[0, 4294967295\]/,
    );
    expect(() => defineComponent("InvalidComponentIdFloat", { hp: u16(1) }, { id: 1.5 })).toThrow(
      /id must be an integer in \[0, 4294967295\]/,
    );
    const Health = defineComponent("InvalidPrefabIdHealth", { hp: u16(1) });
    expect(() => defineEntity("InvalidPrefabId", { health: Health }, { id: 0x1_0000_0000 })).toThrow(
      /id must be an integer in \[0, 4294967295\]/,
    );
  });

  it("rejects hand-written field-like objects", () => {
    const fakeField = { defaultValue: 1 };

    expect(() => defineComponent("FakeComponentField", { hp: fakeField } as never)).toThrow(
      /field "hp" must be created by a SnapScript field helper/,
    );
    expect(() => defineEntity("FakeEntityField", { hp: fakeField } as never)).toThrow(
      /either fields or components/,
    );
    expect(() => defineCommand("FakeCommandField", { hp: fakeField } as never)).toThrow(
      /field "hp" must be created by a SnapScript field helper/,
    );
  });

  it("returns frozen definition objects and isolates protocol maps", () => {
    const fieldMetadata = { label: "x" };
    const componentMetadata = { role: "state" };
    const prefabMetadata = { group: "actor" };
    const commandMetadata = { source: "input" };
    const eventMetadata = { source: "fx" };
    const Position = defineComponent("FrozenDefinitionPosition", {
      x: qf32({ min: -1, max: 1, precision: 0.01, default: 0, metadata: fieldMetadata }),
    }, { metadata: componentMetadata });
    const Player = defineEntity("FrozenDefinitionPlayer", { position: Position }, { metadata: prefabMetadata });
    const Move = defineCommand("FrozenDefinitionMove", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    }, { metadata: commandMetadata });
    const Flash = defineEvent("FrozenDefinitionFlash", { amount: u16(0) }, { metadata: eventMetadata });
    const components: Record<string, ComponentSchema> = { Position };
    const protocol = defineProtocol({
      components,
      prefabs: { Player },
      commands: { Move },
      events: { Flash },
    });

    expect(Object.isFrozen(Position)).toBe(true);
    expect(Object.isFrozen(Position.metadata)).toBe(true);
    expect(Object.isFrozen(Position.fields)).toBe(true);
    expect(Object.isFrozen(Position.fields.x.metadata)).toBe(true);
    expect(Object.isFrozen(Position.fieldList)).toBe(true);
    expect(Object.isFrozen(Position.fieldList[0])).toBe(true);
    expect(Object.isFrozen(Player)).toBe(true);
    expect(Object.isFrozen(Player.metadata)).toBe(true);
    expect(Object.isFrozen(Player.components)).toBe(true);
    expect(Object.isFrozen(Player.componentList)).toBe(true);
    expect(Object.isFrozen(Move)).toBe(true);
    expect(Object.isFrozen(Move.metadata)).toBe(true);
    expect(Object.isFrozen(Move.fields)).toBe(true);
    expect(Object.isFrozen(Move.fieldList)).toBe(true);
    expect(Object.isFrozen(Flash)).toBe(true);
    expect(Object.isFrozen(Flash.metadata)).toBe(true);
    expect(Object.isFrozen(protocol)).toBe(true);
    expect(Object.isFrozen(protocol.components)).toBe(true);

    expect(() => {
      (Position as { name: string }).name = "Mutated";
    }).toThrow();
    expect(() => {
      (protocol.components as Record<string, unknown>).Other = Position;
    }).toThrow();
    expect(() => {
      (Position.fields.x.metadata as Record<string, unknown>).label = "mutated";
    }).toThrow();

    components.Position = defineComponent("FrozenDefinitionOther", { hp: u16(1) });
    fieldMetadata.label = "changed after define";
    componentMetadata.role = "changed after define";
    expect(protocol.components.Position).toBe(Position);
    expect(Position.fields.x.metadata?.label).toBe("x");
    expect(Position.metadata?.role).toBe("state");
  });

  it("fails fast for invalid protocol input shapes", () => {
    const Position = defineComponent("InvalidProtocolPosition", { hp: u16(1) });
    const Player = defineEntity("InvalidProtocolPlayer", { position: Position });
    const Move = defineCommand("InvalidProtocolMove", { amount: u16(1) });
    const Flash = defineEvent("InvalidProtocolFlash", { amount: u16(1) });

    expect(() => defineProtocol(null as never)).toThrow(/requires an options object/);
    expect(() => defineProtocol([] as never)).toThrow(/requires an options object/);
    expect(() => defineProtocol({ components: [] as never })).toThrow(/components must be an object/);
    expect(() => defineProtocol({ prefabs: null as never })).toThrow(/prefabs must be an object/);
    expect(() => defineProtocol({ commands: [] as never })).toThrow(/commands must be an object/);
    expect(() => defineProtocol({ events: null as never })).toThrow(/events must be an object/);
    expect(() => defineProtocol(new Date() as never)).toThrow(/requires an options object/);
    expect(() => defineProtocol({ components: new Date() as never })).toThrow(
      /components must be an object/,
    );
    expect(() => defineProtocol({ events: new (class EventMap {})() as never })).toThrow(
      /events must be an object/,
    );
    expect(() => defineProtocol({ components: { Position: {} as never } })).toThrow(
      /components\.Position must be a component from defineComponent\(\)/,
    );
    expect(() => defineProtocol({ prefabs: { Player: Position as never } })).toThrow(
      /prefabs\.Player must be a prefab from defineEntity\(\)/,
    );
    expect(() => defineProtocol({ commands: { Move: Flash as never } })).toThrow(
      /RPC "InvalidProtocolFlash" is not a command/,
    );
    expect(() => defineProtocol({ events: { Flash: Move as never } })).toThrow(
      /RPC "InvalidProtocolMove" is not an event/,
    );
    expect(() => defineProtocol({ prefabs: { Player }, commands: { Move }, events: { Flash } }))
      .not.toThrow();
  });

  it("rejects invalid field defaults", () => {
    expect(() => qf32(null as never)).toThrow(/qf32 options must be an object/);
    expect(() => qf32(new Date() as never)).toThrow(/qf32 options must be an object/);
    expect(() => vec2q(new (class Vec2Options {})() as never)).toThrow(
      /vec2q options must be an object/,
    );
    expect(() => vec3q([] as never)).toThrow(/vec3q options must be an object/);
    expect(() => enumOf(null as never, "idle" as never)).toThrow(
      /enumOf values must be a non-empty array of strings/,
    );
    expect(() => enumOf([] as never, "idle" as never)).toThrow(
      /enumOf values must be a non-empty array of strings/,
    );
    expect(() => enumOf(["idle", ""] as unknown as readonly string[], "idle")).toThrow(
      /enumOf values must be a non-empty array of strings/,
    );
    expect(() => enumOf(["idle", 1] as unknown as readonly string[], "idle")).toThrow(
      /enumOf values must be a non-empty array of strings/,
    );
    expect(() => qf32({ min: -1, max: 1, precision: 0.1, default: Number.NaN })).toThrow(
      /qf32 must be a finite number/,
    );
    expect(() =>
      vec2q({ min: 1, max: -1, precision: 0.1, default: { x: 0, y: 0 } }),
    ).toThrow(/vec2q requires finite min and max with max > min/);
    expect(() =>
      vec3q({ min: -1, max: 1, precision: 0, default: { x: 0, y: 0, z: 0 } }),
    ).toThrow(/vec3q precision must be a positive finite number/);
    expect(() =>
      vec2q({ min: -1, max: 1, precision: 0.1, default: { x: Number.NaN, y: 0 } }),
    ).toThrow(/vec2q\.x must be a finite number/);
    expect(() => bool("yes" as never)).toThrow(/bool must be a boolean/);
    expect(() => u16(1, new Date() as never)).toThrow(/Field metadata must be an object/);
    expect(() =>
      qf32({
        min: -1,
        max: 1,
        precision: 0.1,
        default: 0,
        metadata: new (class FieldMetadata {})() as never,
      }),
    ).toThrow(/Field metadata must be an object/);
  });

  it("uses defaults when spawning", () => {
    const Player = defineEntity("DefaultsPlayer", {
      hp: u16(100),
      dead: bool(false),
    });
    const PlayerState = Player.component;
    const world = createTestHostWorld(testProtocol(Player));
    const player = world.spawn(Player);
    const state = world.get(player, PlayerState)!;

    expect(state.hp.value).toBe(100);
    expect(state.dead.value).toBe(false);
  });
});
