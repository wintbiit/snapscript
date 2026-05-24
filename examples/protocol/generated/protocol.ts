import { bool, defineCommand, defineComponent, defineEntity, defineEvent, defineProtocol, qf32, u16 } from "snapscript";
import type { ClientWorld, CommandDefinition, EventDefinition, FieldDefinitions, FieldValues, HostWorld, PeerId, RpcHandler } from "snapscript";

type RpcFields<T> = T extends CommandDefinition<infer TFields> ? TFields : T extends EventDefinition<infer TFields> ? TFields : never;
type RpcPayload<T> = FieldValues<RpcFields<T> & FieldDefinitions>;

export const Vector2Fields = { x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }) } as const;

export const MoveInputFields = { dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }), dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }) } as const;

export const Position = defineComponent("Position", { x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), hidden: bool(false) }, { id: 1, fieldIds: {"x":0,"y":1,"hidden":2} });
export const Health = defineComponent("Health", { hp: u16(100) }, { id: 2, fieldIds: {"hp":0} });

export const Player = defineEntity("Player", { position: Position, health: Health }, { id: 1 });

export const MovementMove = defineCommand("Movement.Move", { dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }), dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }) }, { id: 1, fieldIds: {"dx":0,"dy":1}, channel: "unreliable" });
export const MovementMoveDisabled = defineEvent("Movement.MoveDisabled", { disabled: bool(false) }, { id: 1, fieldIds: {"disabled":0}, channel: "reliable" });

export const protocol = defineProtocol({
  components: { Position, Health },
  prefabs: { Player },
  commands: { MovementMove },
  events: { MovementMoveDisabled },
});

export const rpc = {
  commands: {
    MovementMove: {
      send(world: ClientWorld, payload?: Partial<RpcPayload<typeof MovementMove>>) { world.send(MovementMove, payload); },
      on(world: HostWorld, handler: RpcHandler<RpcFields<typeof MovementMove> & FieldDefinitions>) { return world.on(MovementMove, handler); },
    },
  },
  events: {
    MovementMoveDisabled: {
      broadcast(world: HostWorld, payload?: Partial<RpcPayload<typeof MovementMoveDisabled>>) { world.broadcast(MovementMoveDisabled, payload); },
      sendTo(world: HostWorld, peerId: PeerId, payload?: Partial<RpcPayload<typeof MovementMoveDisabled>>) { world.sendTo(peerId, MovementMoveDisabled, payload); },
      on(world: ClientWorld, handler: RpcHandler<RpcFields<typeof MovementMoveDisabled> & FieldDefinitions>) { return world.on(MovementMoveDisabled, handler); },
    },
  },
} as const;
