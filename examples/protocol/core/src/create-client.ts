import {
  createClientWorld,
  type ClientTransport,
  type ClientWorld,
  type Clock,
  type Logger,
} from "snapscript";
import { protocol } from "./generated/protocol";
import { registerClientRpc } from "./generated/register";
import { registerClientSystems } from "./generated/systems.client";

export interface CreateClientOptions {
  readonly transport: ClientTransport;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export function createClient(options: CreateClientOptions): ClientWorld {
  const world = createClientWorld({
    protocol,
    transport: options.transport,
    clock: options.clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  registerClientRpc(world);
  registerClientSystems(world);

  return world;
}
