import { bool, defineCommand, defineComponent, defineEntity, defineEvent, defineProtocol, qf32, u16 } from "snapscript";
import type { ClientWorld, CommandDefinition, EventDefinition, FieldDefinitions, FieldValues, ServerWorld, PeerId, RpcHandler } from "snapscript";

type RpcFields<T> = T extends CommandDefinition<infer TFields> ? TFields : T extends EventDefinition<infer TFields> ? TFields : never;
type RpcPayload<T> = FieldValues<RpcFields<T> & FieldDefinitions>;

export const Vector2Fields = { x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }) } as const;

export const MoveInputFields = { dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }), dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }) } as const;

export const Position = defineComponent("Position", { x: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), y: qf32({ min: -128, max: 128, precision: 0.01, default: 0 }), hidden: bool(false) }, { id: 1, fieldIds: {"x":0,"y":1,"hidden":2} });
export const Health = defineComponent("Health", { hp: u16(100) }, { id: 2, fieldIds: {"hp":0} });

export const Player = defineEntity("Player", { position: Position, health: Health }, { id: 1 });

export const MovementMove = defineCommand("Movement.Move", { dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }), dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }) }, { id: 1, fieldIds: {"dx":0,"dy":1}, channel: "unreliable" });
export type MovementMovePayload = RpcPayload<typeof MovementMove>;
export const MovementMoveDisabled = defineEvent("Movement.MoveDisabled", { disabled: bool(false) }, { id: 2, fieldIds: {"disabled":0}, channel: "reliable" });
export type MovementMoveDisabledPayload = RpcPayload<typeof MovementMoveDisabled>;

export const protocolHash = "cc1f9d0503009fb94139c3241ecc545c0c1465ce8ac11d844cb86897f7069f0f";

export const protocol = defineProtocol({
  components: { Position, Health },
  prefabs: { Player },
  commands: { MovementMove },
  events: { MovementMoveDisabled },
  hash: protocolHash,
});

export const rpc = {
  commands: {
    MovementMove: {
      /** Sends the MovementMove command from a client world to the server. */
      send(world: ClientWorld, payload?: Partial<RpcPayload<typeof MovementMove>>) {
        world.send(MovementMove, payload);
      },
      /** Registers the server-side handler for the MovementMove command. */
      on(world: ServerWorld, handler: RpcHandler<RpcFields<typeof MovementMove> & FieldDefinitions>) {
        return world.on(MovementMove, handler);
      },
    },
  },
  events: {
    MovementMoveDisabled: {
      /** Broadcasts the MovementMoveDisabled event from the server to all connected clients. */
      broadcast(world: ServerWorld, payload?: Partial<RpcPayload<typeof MovementMoveDisabled>>) {
        world.broadcast(MovementMoveDisabled, payload);
      },
      /** Sends the MovementMoveDisabled event from the server to one peer id. */
      sendTo(world: ServerWorld, peerId: PeerId, payload?: Partial<RpcPayload<typeof MovementMoveDisabled>>) {
        world.sendTo(peerId, MovementMoveDisabled, payload);
      },
      /** Registers the client-side handler for the MovementMoveDisabled event. */
      on(world: ClientWorld, handler: RpcHandler<RpcFields<typeof MovementMoveDisabled> & FieldDefinitions>) {
        return world.on(MovementMoveDisabled, handler);
      },
    },
  },
} as const;
