import type { ClientWorld, EventCtx } from "snapscript";
import type {
  PlayerMoveDisabledPayload,
} from "../../generated/protocol";

export function MoveDisabled(world: ClientWorld, ctx: EventCtx<PlayerMoveDisabledPayload>): void {
  void world;
  void ctx;
}

