import type { CommandCtx, ServerWorld } from "snapscript";
import type {
  WorldStartGamePayload,
} from "../../generated/protocol";

export function StartGame(world: ServerWorld, ctx: CommandCtx<WorldStartGamePayload>): void {
  void world;
  void ctx;
}

