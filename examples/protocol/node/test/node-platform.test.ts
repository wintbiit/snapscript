import { commands, createClient, createServer, entities, Position } from "@snapscript/example-protocol-core";
import { afterEach, describe, expect, it } from "vitest";
import { NodeWebSocketClientTransport, NodeWebSocketServerTransport } from "../src/index";

const disposables: { close(): void }[] = [];

afterEach(() => {
  for (const item of disposables.splice(0)) item.close();
});

describe("node protocol platform", () => {
  it("wires the generated core through WebSocket transports", async () => {
    const serverTransport = new NodeWebSocketServerTransport();
    disposables.push(serverTransport);
    const server = createServer({ transport: serverTransport });

    const clientTransport = new NodeWebSocketClientTransport(`ws://127.0.0.1:${serverTransport.port}`);
    disposables.push(clientTransport);
    const client = createClient({ transport: clientTransport });

    await wait(25);
    client.tick(16);
    await wait(25);
    server.tick(16);
    await wait(25);
    client.tick(16);

    const playerEntity = entities.Player.first(client);
    if (playerEntity === undefined) throw new Error("expected a replicated Player");
    commands.Player.Move(client, playerEntity, { dx: 1, dy: 0 });
    await wait(25);
    server.tick(16);
    await wait(25);
    client.tick(16);

    expect(client.myPeerId()).toBe(1);
    expect(client.get(playerEntity, Position)?.x.value).toBe(1);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
