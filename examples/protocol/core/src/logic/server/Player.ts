import type { CommandCtx, ServerWorld } from "snapscript";
import { events } from "../../generated/events";
import { Player } from "../../generated/protocol";
import type {
  PlayerMovePayload,
} from "../../generated/protocol";

export function Move(world: ServerWorld, ctx: CommandCtx<PlayerMovePayload>): void {
  const player = findControlledPlayer(world, ctx);
  if (player === undefined) {
    return;
  }

  if (world.ownerOf(player.id) === 0) {
    world.setOwner(player.id, ctx.source);
  }

  player.position.x.value += ctx.payload.dx;
  player.position.y.value += ctx.payload.dy;

  const disabled = Math.abs(player.position.x.value) > 5 || Math.abs(player.position.y.value) > 5;
  player.position.hidden.value = disabled;
  if (disabled) {
    events.Player.MoveDisabled.sendTo(world, ctx.source, ctx.target, { disabled: true });
  }
}

function findControlledPlayer(world: ServerWorld, ctx: CommandCtx<PlayerMovePayload>) {
  const target = world.getPrefab(ctx.target, Player);
  if (target !== undefined && (world.ownerOf(ctx.target) === ctx.source.id || world.ownerOf(ctx.target) === 0)) {
    return { id: ctx.target.id, position: target.position, health: target.health };
  }
  return undefined;
}
