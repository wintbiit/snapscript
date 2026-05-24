import type { ClientWorld, RpcCtx } from "snapscript";

interface MoveDisabledPayload {
  readonly disabled: boolean;
}

export function moveDisabledEvent(_world: ClientWorld, _ctx: RpcCtx<MoveDisabledPayload>): void {
  // User-owned client logic lives here. The browser app registers its own UI listener as platform code.
}
