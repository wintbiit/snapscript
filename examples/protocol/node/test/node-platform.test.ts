import { commands, createClient, createServer, Position } from "@snapscript/example-protocol-core";
import { afterEach, describe, expect, it } from "vitest";
import { NodeClock, NodeWebSocketClientTransport, NodeWebSocketServerTransport } from "../src/index";

const disposables: { close(): void }[] = [];

afterEach(() => {
  for (const item of disposables.splice(0)) item.close();
});

describe("node protocol platform", () => {
  it("wires the generated core through WebSocket transports", async () => {
    const serverTransport = new NodeWebSocketServerTransport();
    disposables.push(serverTransport);
    const server = createServer({ transport: serverTransport, clock: new NodeClock() });

    const clientTransport = new NodeWebSocketClientTransport(`ws://127.0.0.1:${serverTransport.port}`);
    disposables.push(clientTransport);
    const client = createClient({ transport: clientTransport, clock: new NodeClock() });

    await wait(25);
    client.tick();
    await wait(25);
    server.tick();
    await wait(25);
    client.tick();

    commands.Player.Move(client, { id: 1 }, { dx: 1, dy: 0 });
    await wait(25);
    server.tick();
    await wait(25);
    client.tick();

    expect(client.myPeerId()).toBe(1);
    expect(client.get(1, Position)?.x.value).toBe(1);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
