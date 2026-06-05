import type { ClientWorld } from "snapscript";
import { Position } from "../../generated/protocol";

export function register(world: ClientWorld): void {
  world.system("view.sample", "postUpdate", (world) => {
    world.each([Position] as const, () => {
      // Platform projects read replicated state after tick; this system marks the client hook point.
    });
  });
}
