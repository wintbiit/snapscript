import type { CommandCtx, CommandStreamCtx, ServerWorld } from "snapscript";
import { events } from "../../generated/events";
import { Player } from "../../generated/protocol";
import type {
  PlayerMovePayload,
  PlayerMoveStreamPayload,
} from "../../generated/protocol";

export function Move(world: ServerWorld, ctx: CommandCtx<PlayerMovePayload>): void {
  applyMove(world, ctx.source, ctx.target, ctx.payload);
}

export function MoveStream(world: ServerWorld, ctx: CommandStreamCtx<PlayerMoveStreamPayload>): void {
  for (const sample of ctx.samples) {
    applyMove(world, ctx.source, ctx.target, sample.payload);
  }
}

function applyMove(
  world: ServerWorld,
  source: CommandCtx<PlayerMovePayload>["source"],
  target: CommandCtx<PlayerMovePayload>["target"],
  payload: PlayerMovePayload,
): void {
  const player = findControlledPlayer(world, source, target);
  if (player === undefined) {
    return;
  }

  if (world.ownerOf(target) === 0) {
    world.setOwner(target, source);
  }

  player.position.x.value += payload.dx;
  player.position.y.value += payload.dy;

  const disabled = Math.abs(player.position.x.value) > 5 || Math.abs(player.position.y.value) > 5;
  player.position.hidden.value = disabled;
  if (disabled) {
    events.Player.MoveDisabled.sendTo(world, source, target, { disabled: true });
  }
}

function findControlledPlayer(
  world: ServerWorld,
  source: CommandCtx<PlayerMovePayload>["source"],
  targetRef: CommandCtx<PlayerMovePayload>["target"],
) {
  const target = world.getPrefab(targetRef, Player);
  const sourcePeerId = world.peerId(source);
  if (target !== undefined && (world.ownerOf(targetRef) === sourcePeerId || world.ownerOf(targetRef) === 0)) {
    return { id: targetRef.id, position: target.position, health: target.health };
  }
  return undefined;
}
