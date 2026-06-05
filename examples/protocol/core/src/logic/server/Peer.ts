import type { CommandCtx, ServerWorld } from "snapscript";
import type {
  PeerReadyPayload,
} from "../../generated/protocol";

export function Ready(world: ServerWorld, ctx: CommandCtx<PeerReadyPayload>): void {
  void world;
  void ctx;
}

