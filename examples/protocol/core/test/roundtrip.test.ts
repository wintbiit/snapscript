import { describe, expect, it } from "vitest";
import { createClient, createServer, Position, commands } from "../src/index";
import { createMemoryTransportPair, type Clock } from "snapscript";

function clock(): Clock {
  let tick = 0;
  return {
    nowMs: () => tick * 16,
    tick: () => {
      tick += 1;
      return tick;
    },
  };
}

describe("protocol core", () => {
  it("round-trips a generated command through memory transport", () => {
    const transport = createMemoryTransportPair();
    const server = createServer({ transport: transport.server, clock: clock() });
    const client = createClient({ transport: transport.client, clock: clock() });

    client.tick();
    server.tick();
    client.tick();

    commands.Player.Move(client, { id: 1 }, { dx: 1, dy: 0 });
    server.tick();
    client.tick();

    const position = client.get(1, Position);
    expect(client.myPeerId()).toBe(1);
    expect(client.isMine(1)).toBe(true);
    expect(position?.x.value).toBe(1);
    expect(position?.y.value).toBe(0);
  });
});
