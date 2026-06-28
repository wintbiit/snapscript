import { describe, expect, it } from "vitest";
import { createClient, createServer, Position, commands, entities } from "../src/index";
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

    const playerEntity = entities.Player.first(client);
    if (playerEntity === undefined) throw new Error("expected a replicated Player");
    commands.Player.Move(client, playerEntity, { dx: 1, dy: 0 });
    server.tick();
    client.tick();

    const position = client.get(playerEntity, Position);
    expect(client.myPeerId()).toBe(1);
    expect(client.isMine(playerEntity)).toBe(true);
    expect(position?.x.value).toBe(1);
    expect(position?.y.value).toBe(0);
  });
});
