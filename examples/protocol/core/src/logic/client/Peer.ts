import type { ClientWorld, EventCtx } from "snapscript";
import type {
  PeerAlertPayload,
} from "../../generated/protocol";

export function Alert(world: ClientWorld, ctx: EventCtx<PeerAlertPayload>): void {
  void world;
  void ctx;
}

