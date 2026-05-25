import type { Clock } from "snapscript";

export class NodeClock implements Clock {
  #tick = 0;

  nowMs(): number {
    return Date.now();
  }

  tick(): number {
    this.#tick += 1;
    return this.#tick;
  }
}
