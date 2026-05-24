import type { ClientWorld, ReplicatedStateReader, ServerWorld } from "snapscript";
import { Health, Position } from "./generated/snapscript/protocol";

export interface PlayerView {
  readonly id: number;
  readonly hp: number;
  readonly x: number;
  readonly y: number;
  readonly hidden: boolean;
  readonly mine: boolean;
}

export interface ServerSnapshot {
  readonly players: readonly PlayerView[];
}

export interface ClientSnapshot {
  readonly myPeerId: number;
  readonly players: readonly PlayerView[];
}

export function readServerSnapshot(world: ServerWorld): ServerSnapshot {
  return {
    players: readPlayers(world, () => false),
  };
}

export function readClientSnapshot(world: ClientWorld): ClientSnapshot {
  return {
    myPeerId: world.myPeerId(),
    players: readPlayers(world, (id) => world.isMine(id)),
  };
}

function readPlayers(
  world: ReplicatedStateReader,
  isMine: (entityId: number) => boolean,
): PlayerView[] {
  const players: PlayerView[] = [];
  world.each([Position, Health] as const, (entity, position, health) => {
    players.push({
      id: entity.id,
      hp: health.hp.value,
      x: position.x.value,
      y: position.y.value,
      hidden: position.hidden.value,
      mine: isMine(entity.id),
    });
  });
  return players;
}
