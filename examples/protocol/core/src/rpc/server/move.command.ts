import type { RpcCtx, ServerWorld } from "snapscript";
import {
  Health,
  MovementMoveDisabled,
  Position,
} from "../../generated/snapscript/protocol";

interface MovePayload {
  readonly dx: number;
  readonly dy: number;
}

export function moveCommand(world: ServerWorld, ctx: RpcCtx<MovePayload>): void {
  const player = findControlledPlayer(world, ctx.sender);
  if (player === undefined) {
    return;
  }

  if (world.ownerOf(player.id) === 0) {
    world.setOwner(player.id, ctx.sender);
  }

  player.position.x.value += ctx.payload.dx;
  player.position.y.value += ctx.payload.dy;

  const disabled = Math.abs(player.position.x.value) > 5 || Math.abs(player.position.y.value) > 5;
  player.position.hidden.value = disabled;
  if (disabled) {
    world.sendTo(ctx.sender, MovementMoveDisabled, { disabled: true });
  }
}

function findControlledPlayer(world: ServerWorld, peerId: number) {
  for (const [entity, position, health] of world.query(Position, Health)) {
    const owner = world.ownerOf(entity);
    if (owner === peerId || owner === 0) {
      return { id: entity.id, position, health };
    }
  }
  return undefined;
}
