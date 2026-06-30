import {
  createServerWorld,
  type Logger,
  type ServerTransport,
  type ServerWorld,
} from "snapscript";
import { Player, protocol } from "./generated/protocol";
import { registerServerRpc } from "./generated/register";
import { registerServerSystems } from "./generated/systems.server";

export interface CreateServerOptions {
  readonly transport: ServerTransport;
  readonly logger?: Logger;
}

export function createServer(options: CreateServerOptions): ServerWorld {
  const world = createServerWorld({
    protocol,
    transport: options.transport,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const player = world.spawn(Player, {
    position: { x: 0, y: 0 },
    health: { hp: 100 },
  });

  registerServerRpc(world);
  registerServerSystems(world);

  return world;
}
