import type { ServerWorld } from "snapscript";
import { Health } from "../../generated/snapscript/protocol";

export function register(world: ServerWorld): void {
  world.system("health.clamp", "postUpdate", (world) => {
    world.each([Health] as const, (_entity, health) => {
      health.hp.value = Math.max(0, Math.min(100, health.hp.value));
    });
  });
}
