import { PeerState, bool, defineCommand, defineComponent, defineEntity, defineEvent, defineProtocol, defineStream, qf32, u16, u32, u8 } from "snapscript";
import { WorldEntity } from "snapscript";
import type { ClientWorld, CommandDefinition, CommandHandler, CommandStreamHandler, EventDefinition, EventHandler, FieldDefinitions, FieldValues, ReadonlyEntityRef, ServerWorld, StreamDefinition, ComponentSchema, PrefabDefinition } from "snapscript";

type RpcFields<T> = T extends CommandDefinition<infer TFields> ? TFields : T extends EventDefinition<infer TFields> ? TFields : T extends StreamDefinition<infer TFields> ? TFields : never;
type RpcPayload<T> = FieldValues<RpcFields<T> & FieldDefinitions>;
type EndpointValidationCtx = { readonly rpc?: { readonly name: string }; readonly stream?: { readonly name: string }; readonly source?: ReadonlyEntityRef; readonly target?: ReadonlyEntityRef };
type EndpointSpec = { readonly name: string; readonly ref: "source" | "target"; readonly entity?: PrefabDefinition | ComponentSchema; readonly world?: true };

export const Vector2Fields = { x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }) } as const;

export const MoveInputFields = { dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }), dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }) } as const;

export const MatchState = defineComponent("MatchState", { phase: u8(0), timeLeftMs: u32(0) }, { id: 1, fieldIds: {"phase":0,"timeLeftMs":1} });
export const ConnectionInfo = defineComponent("ConnectionInfo", { region: u8(0) }, { id: 2, fieldIds: {"region":0} });
export const Position = defineComponent("Position", { x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), hidden: bool(false) }, { id: 3, fieldIds: {"x":0,"y":1,"hidden":2} });
export const Health = defineComponent("Health", { hp: u16(100) }, { id: 4, fieldIds: {"hp":0} });

export const Peer = defineEntity("Peer", { peerState: PeerState, connectionInfo: ConnectionInfo }, { id: 0 });

export const Player = defineEntity("Player", { position: Position, health: Health }, { id: 1 });

const WorldStartGame = defineCommand("World.StartGame", {  }, { id: 1, fieldIds: {}, channel: "reliable" });
export type WorldStartGamePayload = RpcPayload<typeof WorldStartGame>;
const WorldGameStarted = defineEvent("World.GameStarted", {  }, { id: 2, fieldIds: {}, channel: "reliable" });
export type WorldGameStartedPayload = RpcPayload<typeof WorldGameStarted>;
const PeerReady = defineCommand("Peer.Ready", {  }, { id: 3, fieldIds: {}, channel: "reliable" });
export type PeerReadyPayload = RpcPayload<typeof PeerReady>;
const PeerAlert = defineEvent("Peer.Alert", { reason: u8(0) }, { id: 4, fieldIds: {"reason":0}, channel: "reliable" });
export type PeerAlertPayload = RpcPayload<typeof PeerAlert>;
const PlayerMove = defineCommand("Player.Move", { dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }), dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }) }, { id: 5, fieldIds: {"dx":0,"dy":1}, channel: "unreliable" });
export type PlayerMovePayload = RpcPayload<typeof PlayerMove>;
const PlayerMoveStream = defineStream("Player.MoveStream", { dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }), dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }) }, { id: 6, fieldIds: {"dx":0,"dy":1} });
export type PlayerMoveStreamPayload = RpcPayload<typeof PlayerMoveStream>;
const PlayerMoveDisabled = defineEvent("Player.MoveDisabled", { disabled: bool(false) }, { id: 7, fieldIds: {"disabled":0}, channel: "reliable" });
export type PlayerMoveDisabledPayload = RpcPayload<typeof PlayerMoveDisabled>;

export const protocolHash = "89379d7bfa31cde5de07dab073cc1a1831d124fc7379d685df1479a0541363ef";

export const protocol = defineProtocol({
  components: { PeerState, MatchState, ConnectionInfo, Position, Health },
  prefabs: { Peer, Player },
  commands: { WorldStartGame, PeerReady, PlayerMove },
  events: { WorldGameStarted, PeerAlert, PlayerMoveDisabled },
  streams: { PlayerMoveStream },
  hash: protocolHash,
});

function worldEndpoint(ref: "source" | "target"): EndpointSpec {
  return { name: "World", ref, world: true };
}

function peerEndpoint(ref: "source" | "target"): EndpointSpec {
  return { name: "Peer", ref, entity: Peer };
}

function entityEndpoint(ref: "source" | "target", entity: PrefabDefinition | ComponentSchema): EndpointSpec {
  return { name: entity.name, ref, entity };
}

function validateEndpointCtx(world: ServerWorld | ClientWorld, ctx: EndpointValidationCtx, ...specs: readonly EndpointSpec[]): { readonly reason: string; readonly details?: Record<string, unknown> } | undefined {
  const packetName = ctx.rpc?.name ?? ctx.stream?.name ?? "unknown";
  for (const spec of specs) {
    const ref = ctx[spec.ref];
    if (ref === undefined) {
      return { reason: "missing endpoint ref", details: { rpc: packetName, endpoint: spec.name, ref: spec.ref } };
    }
    if (spec.world === true) {
      if (ref.id !== WorldEntity.id) {
        return { reason: "endpoint entity type mismatch", details: { rpc: packetName, endpoint: spec.name, ref: spec.ref, entityId: ref.id } };
      }
      continue;
    }
    if (spec.entity !== undefined && !world.has(ref, spec.entity)) {
      return { reason: "endpoint entity type mismatch", details: { rpc: packetName, endpoint: spec.name, ref: spec.ref, entityId: ref.id } };
    }
  }
  return undefined;
}

export const internal = {
  World: {
    commands: {
      StartGame: {
        send(world: ClientWorld, payload?: Partial<RpcPayload<typeof WorldStartGame>>) {
          world.sendCommand(WorldEntity, WorldStartGame, payload);
        },
        on(world: ServerWorld, handler: CommandHandler<RpcFields<typeof WorldStartGame> & FieldDefinitions>) {
          return world.onCommand(WorldStartGame, handler, (ctx) => validateEndpointCtx(world, ctx, peerEndpoint("source"), worldEndpoint("target")));
        },
      },
    },
    events: {
      GameStarted: {
        broadcast(world: ServerWorld, payload?: Partial<RpcPayload<typeof WorldGameStarted>>) {
          world.broadcastEvent(WorldEntity, WorldGameStarted, payload);
        },
        sendTo(world: ServerWorld, targets: ReadonlyEntityRef | readonly ReadonlyEntityRef[], payload?: Partial<RpcPayload<typeof WorldGameStarted>>) {
          world.sendEventTo(targets, WorldEntity, WorldGameStarted, payload);
        },
        on(world: ClientWorld, handler: EventHandler<RpcFields<typeof WorldGameStarted> & FieldDefinitions>) {
          return world.onEvent(WorldGameStarted, handler, (ctx) => validateEndpointCtx(world, ctx, worldEndpoint("source"), peerEndpoint("target")));
        },
      },
    },
    streams: {

    },
  },
  Peer: {
    commands: {
      Ready: {
        send(world: ClientWorld, payload?: Partial<RpcPayload<typeof PeerReady>>) {
          world.sendCommand(world.myPeerEntity(), PeerReady, payload);
        },
        on(world: ServerWorld, handler: CommandHandler<RpcFields<typeof PeerReady> & FieldDefinitions>) {
          return world.onCommand(PeerReady, handler, (ctx) => validateEndpointCtx(world, ctx, peerEndpoint("source"), peerEndpoint("target")));
        },
      },
    },
    events: {
      Alert: {
        broadcast(world: ServerWorld, payload?: Partial<RpcPayload<typeof PeerAlert>>) {
          world.broadcastPeerEvent(PeerAlert, payload);
        },
        sendTo(world: ServerWorld, targets: ReadonlyEntityRef | readonly ReadonlyEntityRef[], payload?: Partial<RpcPayload<typeof PeerAlert>>) {
          world.sendPeerEventTo(targets, PeerAlert, payload);
        },
        on(world: ClientWorld, handler: EventHandler<RpcFields<typeof PeerAlert> & FieldDefinitions>) {
          return world.onEvent(PeerAlert, handler, (ctx) => validateEndpointCtx(world, ctx, peerEndpoint("source"), peerEndpoint("target")));
        },
      },
    },
    streams: {

    },
  },
  Player: {
      commands: {
        Move: {
          send(world: ClientWorld, target: ReadonlyEntityRef, payload?: Partial<RpcPayload<typeof PlayerMove>>) {
            world.sendCommand(target, PlayerMove, payload);
          },
          on(world: ServerWorld, handler: CommandHandler<RpcFields<typeof PlayerMove> & FieldDefinitions>) {
            return world.onCommand(PlayerMove, handler, (ctx) => validateEndpointCtx(world, ctx, peerEndpoint("source"), entityEndpoint("target", Player)));
          },
        },
      },
      events: {
        MoveDisabled: {
          broadcast(world: ServerWorld, source: ReadonlyEntityRef, payload?: Partial<RpcPayload<typeof PlayerMoveDisabled>>) {
            world.broadcastEvent(source, PlayerMoveDisabled, payload);
          },
          sendTo(world: ServerWorld, targets: ReadonlyEntityRef | readonly ReadonlyEntityRef[], source: ReadonlyEntityRef, payload?: Partial<RpcPayload<typeof PlayerMoveDisabled>>) {
            world.sendEventTo(targets, source, PlayerMoveDisabled, payload);
          },
          on(world: ClientWorld, handler: EventHandler<RpcFields<typeof PlayerMoveDisabled> & FieldDefinitions>) {
            return world.onEvent(PlayerMoveDisabled, handler, (ctx) => validateEndpointCtx(world, ctx, entityEndpoint("source", Player), peerEndpoint("target")));
          },
        },
      },
      streams: {
        MoveStream: {
          push(world: ClientWorld, target: ReadonlyEntityRef, payload: RpcPayload<typeof PlayerMoveStream>, clientTick: number, dtMs: number) {
            world.pushCommandStream(target, PlayerMoveStream, payload, clientTick, dtMs);
          },
          on(world: ServerWorld, handler: CommandStreamHandler<RpcFields<typeof PlayerMoveStream> & FieldDefinitions>) {
            return world.onCommandStream(PlayerMoveStream, handler, (ctx) => validateEndpointCtx(world, ctx, peerEndpoint("source"), entityEndpoint("target", Player)));
          },
        },
      },
  },
} as const;
