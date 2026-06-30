import { describe, expect, it } from "vitest";
import { createClient, createServer, Position, commands, entities } from "../src/index";
import { createMemoryTransportPair } from "snapscript";

describe("protocol core", () => {
  it("round-trips a generated command through memory transport", () => {
    const transport = createMemoryTransportPair();
    const server = createServer({ transport: transport.server });
    const client = createClient({ transport: transport.client });

    client.tick(16);
    server.tick(16);
    client.tick(16);

    const playerEntity = entities.Player.first(client);
    if (playerEntity === undefined) throw new Error("expected a replicated Player");
    commands.Player.Move(client, playerEntity, { dx: 1, dy: 0 });
    server.tick(16);
    client.tick(16);

    const position = client.get(playerEntity, Position);
    expect(client.myPeerId()).toBe(1);
    expect(client.isMine(playerEntity)).toBe(true);
    expect(position?.x.value).toBe(1);
    expect(position?.y.value).toBe(0);
  });
});
