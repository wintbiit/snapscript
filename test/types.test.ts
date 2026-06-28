import {
  createClientWorld,
  createServerWorld,
  WorldEntity,
  defineCommand,
  defineComponent,
  defineEntity,
  defineEvent,
  defineProtocol,
  u16,
  type Clock,
  type ClientTransport,
  type ComponentOrPrefab,
  type ComponentQuery,
  type ServerWorld,
  type ServerTransport,
  type PrefabInstanceOf,
  type ProtocolManifestEntry,
  type ReadonlyPrefabInstanceOf,
  type PeerId,
  type PeerRef,
  type ReplicatedStateReader,
} from "../packages/snapscript/src/index";
// @ts-expect-error World is intentionally not part of the public entrypoint.
import type { World } from "../packages/snapscript/src/index";
// @ts-expect-error SnapScript does not expose a local-only world factory.
import { createWorld } from "../packages/snapscript/src/index";
// @ts-expect-error legacy host API was renamed to createServerWorld().
import { createHostWorld } from "../packages/snapscript/src/index";
// @ts-expect-error legacy host type was renamed to ServerWorld.
import type { HostWorld } from "../packages/snapscript/src/index";
// @ts-expect-error legacy host transport type was renamed to ServerTransport.
import type { HostTransport } from "../packages/snapscript/src/index";
import { ServerWorld as ServerWorldValue } from "../packages/snapscript/src/index";
// @ts-expect-error generic direct runtime context is not public; use CommandCtx/EventCtx/CommandStreamCtx.
import type { RpcCtx } from "../packages/snapscript/src/index";
// @ts-expect-error generic direct runtime handler is not public; use CommandHandler/EventHandler.
import type { RpcHandler } from "../packages/snapscript/src/index";
// @ts-expect-error low-level sync runtime is internal; use createServerWorld/createClientWorld.
import { createSyncServer } from "../packages/snapscript/src/index";
// @ts-expect-error snapshot codec helpers are internal to the world runtime.
import { encodeDirty } from "../packages/snapscript/src/index";
// @ts-expect-error rpc packet helpers are internal to the world runtime.
import { encodeRpc } from "../packages/snapscript/src/index";
// @ts-expect-error engine bridge abstractions are server-owned, not framework API.
import type { EngineBridge } from "../packages/snapscript/src/index";
// @ts-expect-error field codecs are internal; use built-in field helpers.
import type { FieldCodec } from "../packages/snapscript/src/index";
// @ts-expect-error rpc codecs are internal; use command/event APIs.
import type { RpcCodec } from "../packages/snapscript/src/index";
// @ts-expect-error raw registries are internal; use defineProtocol().
import { createRegistry } from "../packages/snapscript/src/index";
// @ts-expect-error raw registry types are internal; use ProtocolDefinition.
import type { RegistryLike } from "../packages/snapscript/src/index";
// @ts-expect-error protocol registry is internal; use defineProtocol() and world APIs.
import type { ProtocolRegistry } from "../packages/snapscript/src/index";
// @ts-expect-error binary readers/writers are internal codec machinery.
import { BitReader } from "../packages/snapscript/src/index";
// @ts-expect-error global schema lookup is internal; use protocol/world APIs.
import { getSchemaById } from "../packages/snapscript/src/index";
// @ts-expect-error use explicit ClientTransport or ServerTransport instead.
import type { Transport } from "../packages/snapscript/src/index";
// @ts-expect-error component storage is an internal implementation detail.
import type { ComponentStorage } from "../packages/snapscript/src/index";
// @ts-expect-error map storage exists only for internal benchmarks.
import { MapComponentStorage } from "../packages/snapscript/src/index";
// @ts-expect-error sparse storage is selected internally by the world runtime.
import { SparseSetComponentStorage } from "../packages/snapscript/src/index";
// @ts-expect-error storage options are internal tuning details.
import type { SparseSetComponentStorageOptions } from "../packages/snapscript/src/index";
import { describe, it } from "vitest";

const transport: ClientTransport = {
  send() {},
  onPacket() {},
};
const serverTransport: ServerTransport = {
  send() {},
  broadcast() {},
  onPacket() {},
  peers(): Iterable<PeerRef> {
    return [];
  },
};
const clock: Clock = {
  nowMs: () => 0,
  tick: () => 0,
};
const Player = defineEntity("TypePlayer", { hp: u16(1) });
const Position = defineComponent("TypePosition", { x: u16(0) });
const Velocity = defineComponent("TypeVelocity", { x: u16(0) });
const Actor = defineEntity("TypeActor", {
  position: Position,
  velocity: Velocity,
});
const Command = defineCommand("TypeCommand", { amount: u16(1) });
const Event = defineEvent("TypeEvent", { amount: u16(1) });
const protocol = defineProtocol({
  components: { Position, Velocity },
  prefabs: { Player, Actor },
  commands: { Command },
  events: { Event },
});
const manifestEntry: ProtocolManifestEntry = protocol.manifest().components[0]!;
manifestEntry.id.toFixed();
const componentOrPrefab: ComponentOrPrefab = Actor;
const componentQuery = [Position, Velocity] as const satisfies ComponentQuery;
componentOrPrefab.name.toString();
componentQuery[0].name.toString();
const host = createServerWorld({ protocol, transport: serverTransport, clock });
const client = createClientWorld({ protocol, transport, clock });
const worldEntityId: number = WorldEntity.id;
const typedServer: ServerWorld = host;
typedServer.tick();
const hostReader: ReplicatedStateReader = host;
const clientReader: ReplicatedStateReader = client;
host.add(WorldEntity, Position);
host.get(WorldEntity, Position)!.x.value = 1;
host.getComponent(Position)!.x.value = 1;
host.has(WorldEntity, Position).valueOf();
host.remove(WorldEntity, Position);
client.get(WorldEntity, Position)?.x.value.toFixed();
client.getComponent(Position)?.x.value.toFixed();
hostReader.getComponent(Position)?.x.value.toFixed();
hostReader.each(componentQuery, (_entity, position, velocity) => {
  position.x.value.toFixed();
  velocity.x.value.toFixed();
  // @ts-expect-error shared replicated readers expose read-only component refs
  position.x.value = 2;
});
clientReader.query(Position).forEach(([_entity, position]) => {
  position.x.value.toFixed();
});
if (false) {
  // @ts-expect-error worlds require a protocol instead of a raw registry fallback
  createServerWorld({ transport: serverTransport, clock });
  // @ts-expect-error component fields must come from SnapScript field helpers
  defineComponent("FakeField", { hp: { defaultValue: 1 } });
  createServerWorld({
    protocol: {
      components: {},
      prefabs: {},
      commands: {},
      events: {},
      streams: {},
      // @ts-expect-error protocol must be produced by defineProtocol()
      registry: {
        getSchema: () => undefined,
        getRpc: () => undefined,
      },
      manifest: () => ({ components: [], prefabs: [], commands: [], events: [], streams: [] }),
    },
    transport: serverTransport,
    clock,
  });
  createServerWorld({
    protocol,
    transport: serverTransport,
    clock,
    interest(_peerId, entity, world) {
      entity.id.toFixed();
      world.has(entity, Position);
      world.get(entity, Position)!.x.value.toFixed();
      world.getComponent(Position)?.x.value.toFixed();
      // @ts-expect-error interest hook entity refs are read-only policy inputs
      entity.add(Position);
      // @ts-expect-error read-only policy refs are not server-authored EntityRef values
      host.add(entity, Position);
      // @ts-expect-error interest world is a read-only policy view
      world.spawn(Position);
      // @ts-expect-error interest world cannot change manual visibility
      world.setVisible(1, entity, true);
      // @ts-expect-error interest world component refs are read-only
      world.get(entity, Position)!.x.value = 1;
      // @ts-expect-error interest world component refs are read-only
      world.getComponent(Position)!.x.value = 1;
      return true;
    },
  });
  createServerWorld({
    protocol,
    transport: serverTransport,
    clock,
    // @ts-expect-error world-level channels are fixed; set channel on commands/events instead
    channel: "unreliable",
  });
  createServerWorld({
    protocol,
    transport: serverTransport,
    clock,
    // @ts-expect-error server world options fail fast for unknown keys
    visiblity: "none",
  });
  createClientWorld({
    protocol,
    transport,
    clock,
    // @ts-expect-error world-level channels are fixed; set channel on commands/events instead
    channel: "unreliable",
  });
  createClientWorld({
    protocol,
    transport,
    clock,
    // @ts-expect-error client worlds do not accept server visibility hooks
    interest: () => true,
  });
  // @ts-expect-error ServerWorld is a type-only public surface; use createServerWorld().
  new ServerWorldValue({ protocol, transport: serverTransport, clock });
  // @ts-expect-error field codec is internal
  u16(0).codec;
  // @ts-expect-error schema codec is internal
  Position.codec;
  // @ts-expect-error schema field codec is internal
  Position.fields.x.codec;
  // @ts-expect-error rpc codec is internal
  Command.codec;
}

host.onCommand(Command, (context) => {
  context.payload.amount.toFixed();
  const peer: PeerId = context.source.id;
  peer.toFixed();
});
host.broadcastEvent(WorldEntity, Event, { amount: 1 });
host.broadcastEvent(WorldEntity, Event);
if (false) {
  host.sendEventTo(WorldEntity, WorldEntity, Event, { amount: 1 });
  client.sendCommand(WorldEntity, Command, { amount: 1 });
  client.sendCommand(WorldEntity, Command);
}
client.onEvent(Event, (context) => {
  context.payload.amount.toFixed();
});
host.each([Position, Velocity], (entity, pos, vel) => {
  entity.id.toFixed();
  pos.x.value.toFixed();
  vel.x.value.toFixed();
});
host.each(componentQuery, (_entity, pos, vel) => {
  pos.x.value.toFixed();
  vel.x.value.toFixed();
});
host.system("host-system", "update", (world) => {
  const entity = world.spawn(Player);
  const emptyEntity = world.spawn();
  world.add(entity, Velocity);
  world.add(emptyEntity, Position);
  world.broadcastEvent(WorldEntity, Event, { amount: 1 });
});
const emptyActor = host.spawn();
host.add(emptyActor, Position).x.value = 1;
const simpleState = host.add(emptyActor, Player, { hp: 2 });
simpleState.hp.value.toFixed();
const actor = host.spawn(Actor);
const actorFromAdd = host.spawn();
const addedActorParts = host.add(actorFromAdd, Actor, {
  position: { x: 1 },
  velocity: { x: 2 },
});
const typedAddedActorParts: PrefabInstanceOf<typeof Actor> = addedActorParts;
typedAddedActorParts.velocity.x.value.toFixed();
const actorParts = host.getPrefab(actor, Actor)!;
const actorHasPrefab: boolean = host.has(actor, Actor);
const typedActorParts: PrefabInstanceOf<typeof Actor> = actorParts;
typedActorParts.position.x.value.toFixed();
typedActorParts.position.x.value = 1;
typedActorParts.position.x.set(2);
typedActorParts.velocity.x.value.toFixed();
actorHasPrefab.valueOf();
client.onSnapshot((world, context) => {
  context.tick.toFixed();
  const channel: "reliable" | "unreliable" = context.channel;
  channel.toString();
  world.get(actor, Position);
  world.has(actor, Actor);
  // @ts-expect-error snapshot hook world is a read-only client world
  world.spawn(Position);
  // @ts-expect-error snapshot hook component refs are read-only
  world.get(actor, Position)!.x.value = 1;
});
client.system("client-system", "update", (world) => {
  world.query(Position).forEach(([entity]) => {
    world.get(entity, Position);
  });
  world.sendCommand(WorldEntity, Command, { amount: 1 });
});

if (false) {
  // @ts-expect-error hosts receive commands, not events
  host.onCommand(Event, () => {});
  // @ts-expect-error hosts broadcast events, not commands
  host.broadcastEvent(WorldEntity, Command, { amount: 1 });
  // @ts-expect-error clients send commands, not events
  client.sendCommand(WorldEntity, Event, { amount: 1 });
  // @ts-expect-error clients receive events, not commands
  client.onEvent(Command, () => {});
  // @ts-expect-error RPC channels are constrained to transport policy names
  defineCommand("InvalidTypeChannelCommand", { amount: u16(1) }, { channel: "ordered" });
  host.onCommand(Command, (context) => {
    // @ts-expect-error RPC payloads are read-only handler inputs
    context.payload.amount = 2;
  });
}
if (false) {
  // @ts-expect-error queries require at least one component
  host.query();
  // @ts-expect-error each requires at least one component
  host.each([], () => {});
  // @ts-expect-error client queries require at least one component
  client.query();
  // @ts-expect-error client each requires at least one component
  client.each([], () => {});
  // @ts-expect-error each preserves component field types
  host.each([Position], (_entity, pos) => pos.missing);
  // @ts-expect-error getPrefab preserves prefab aliases
  actorParts.health;
  // @ts-expect-error getPrefab preserves component field types
  actorParts.position.missing;
  // @ts-expect-error composite prefabs must be read with getPrefab()
  host.get(actor, Actor);
  // @ts-expect-error getComponent only accepts component schemas
  host.getComponent(Actor);
  host.remove(actor, Actor);
  // @ts-expect-error public world APIs require entity refs, not numeric entity ids
  host.get(actor.id, Position);
  // @ts-expect-error public world APIs require entity refs, not numeric entity ids
  host.add(actor.id, Position);
  // @ts-expect-error ownership APIs use PeerEntity refs, not numeric peer ids
  host.setOwner(actor, 1);
  // @ts-expect-error client world APIs require entity refs, not numeric entity ids
  client.get(actor.id, Position);
  // @ts-expect-error command targets are entity refs, not numeric entity ids
  client.sendCommand(WorldEntity.id, Command);
  const clientActorParts = client.getPrefab(actor, Actor)!;
  const typedClientActorParts: ReadonlyPrefabInstanceOf<typeof Actor> = clientActorParts;
  typedClientActorParts.position.x.value.toFixed();
  // @ts-expect-error client get exposes read-only NetRefs
  client.get(actor, Position)!.x.value = 1;
  // @ts-expect-error client getComponent exposes read-only NetRefs
  client.getComponent(Position)!.x.value = 1;
  // @ts-expect-error client get does not expose local mutation helpers
  client.get(actor, Position)!.x.set(1);
  client.query(Position).forEach(([, pos]) => {
    // @ts-expect-error client query components expose read-only NetRefs
    pos.x.value = 1;
    // @ts-expect-error client query components do not expose local mutation helpers
    pos.x.set(1);
  });
  client.each([Position], (_entity, pos) => {
    // @ts-expect-error client each components expose read-only NetRefs
    pos.x.value = 1;
  });
  // @ts-expect-error client getPrefab preserves read-only NetRefs
  clientActorParts.position.x.value = 1;
  // @ts-expect-error dirty graph is internal sync state, not public world API
  host.dirty;
  // @ts-expect-error spawn() is the public empty-entity creation API
  host.entity();
  // @ts-expect-error entity refs are ids; mutate through ServerWorld methods
  emptyActor.add(Position);
  // @ts-expect-error systems are driven through tick(), not an exposed phase runner
  host.runSystems("update");
  // @ts-expect-error protocol registry is internal implementation detail
  protocol.registry;
  // @ts-expect-error field meta codec is internal
  host.get(actor, Position)!.x.meta.codec;
  // @ts-expect-error internal sync hooks are not public world API
  host._getDirtySnapshot();
  // @ts-expect-error internal remote apply hooks are not public world API
  client._spawnRemote(Position, 1);
  // @ts-expect-error client query rows expose read-only entity refs
  client.query(Position).toArray()[0]![0].destroy();
  // @ts-expect-error client query entity refs are not server-authored EntityRef values
  host.add(client.query(Position).toArray()[0]![0], Position);
  client.query(Position).forEach(([entity]) => {
    client.get(entity, Position);
    client.has(entity, Position);
  });
  client.each([Position], (entity) => {
    client.get(entity, Position);
    // @ts-expect-error client each exposes read-only entity refs
    entity.add(Position);
  });
  client.system("client-readonly-system", "update", (world) => {
    // @ts-expect-error client system world cannot author replicated entities
    world.spawn(Position);
    world.each([Position], (entity) => {
      // @ts-expect-error client system query entity is read-only
      entity.destroy();
    });
  });
  // @ts-expect-error dirty clearing is runtime-internal
  host.clearDirty();
  // @ts-expect-error clients do not author replicated entities
  client.spawn(Position);
  // @ts-expect-error clients do not author replicated entities
  client.spawn();
  // @ts-expect-error systems are driven through tick(), not an exposed phase runner
  client.runSystems("update");
  // @ts-expect-error clients do not author replicated component adds
  client.add(1, Position);
  // @ts-expect-error clients do not author replicated component removals
  client.remove(1, Position);
  // @ts-expect-error clients do not destroy replicated entities
  client.destroy(1);
  // @ts-expect-error only clients receive remote snapshot hooks
  host.onSnapshot(() => {});
  // @ts-expect-error dirty clearing is runtime-internal
  client.clearDirty();
}

describe("public api type checks", () => {
  it("compiles directional server/client rpc usage", () => {});
});
