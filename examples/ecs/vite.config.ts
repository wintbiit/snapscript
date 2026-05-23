import vue from "@vitejs/plugin-vue";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath, URL } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

function syncRelay(): Plugin {
  let wss: WebSocketServer | undefined;

  return {
    name: "snapscript-ecs-sync-relay",
    configureServer(server) {
      if (wss !== undefined) {
        return;
      }

      wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
        if (!request.url?.startsWith("/sync")) {
          return;
        }

        wss?.handleUpgrade(request, socket, head, (ws) => {
          wss?.emit("connection", ws, request);
        });
      });

      wss.on("connection", (ws) => {
        ws.on("message", (message, isBinary) => {
          for (const client of wss?.clients ?? []) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(message, { binary: isBinary });
            }
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), syncRelay()],
  resolve: {
    alias: {
      snapscript: fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
});
