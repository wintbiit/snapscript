import {
  createServerWorld,
  type Clock,
  type Logger,
  type ServerTransport,
  type ServerWorld,
} from "snapscript";
import { Player, protocol } from "./generated/snapscript/protocol";
import { registerServerRpc } from "./generated/snapscript/rpc";
import { registerServerSystems } from "./systems/generated/server";

export interface CreateServerOptions {
  readonly transport: ServerTransport;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export function createServer(options: CreateServerOptions): ServerWorld {
  const world = createServerWorld({
    protocol,
    transport: options.transport,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const player = world.spawn(Player, {
    position: { x: 0, y: 0 },
    health: { hp: 100 },
  });
  world.setOwner(player, 0);

  registerServerRpc(world);
  registerServerSystems(world);

  return world;
}
