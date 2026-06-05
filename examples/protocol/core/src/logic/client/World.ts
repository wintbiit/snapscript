import type { ClientWorld, EventCtx } from "snapscript";
import type {
  WorldGameStartedPayload,
} from "../../generated/protocol";

export function GameStarted(world: ClientWorld, ctx: EventCtx<WorldGameStartedPayload>): void {
  void world;
  void ctx;
}

