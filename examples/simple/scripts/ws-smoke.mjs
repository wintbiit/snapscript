import { WebSocket } from "ws";
import {
  angle16,
  bool,
  createClientWorld,
  WorldEntity,
  defineCommand,
  defineEntity,
  defineEvent,
  defineProtocol,
  qf32,
  u16,
  varu32,
} from "../../../dist/index.mjs";

const url = process.argv[2] ?? "ws://127.0.0.1:5175/sync";

const Player = defineEntity("SimplePlayer", {
  hp: u16(100),
  dead: bool(false),
  x: qf32({ min: -64, max: 64, precision: 0.01, default: 0 }),
  y: qf32({ min: -64, max: 64, precision: 0.01, default: 0 }),
  yaw: angle16(0),
});
const MoveCommand = defineCommand("MoveCommand", {
  dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
  dy: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
});
const DamageCommand = defineCommand("DamageCommand", { amount: u16(10) });
const HealCommand = defineCommand("HealCommand", { amount: u16(10) });
const RotateCommand = defineCommand("RotateCommand", { delta: angle16(15) });
const DamageEvent = defineEvent("DamageEvent", {
  entityId: varu32(0),
  amount: u16(0),
});
const protocol = defineProtocol({
  prefabs: { Player },
  commands: { MoveCommand, DamageCommand, HealCommand, RotateCommand },
  events: { DamageEvent },
});

class NodeTransport {
  handler;
  pending = [];
  socket = new WebSocket(url);

  constructor() {
    this.socket.binaryType = "arraybuffer";
    this.socket.on("open", () => {
      for (const bytes of this.pending.splice(0)) {
        this.send(0, bytes);
      }
    });
    this.socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        return;
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.handler?.(0, bytes);
    });
  }

  send(_channel, bytes) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
      return;
    }
    this.pending.push(bytes);
  }

  onPacket(cb) {
    this.handler = cb;
  }
}

const transport = new NodeTransport();
let tick = 0;
const world = createClientWorld({
  protocol,
  transport,
  clock: {
    nowMs: () => Date.now(),
    tick: () => {
      tick += 1;
      return tick;
    },
  },
});

world.onEvent(DamageEvent, (ctx) => {
  console.log(JSON.stringify({ event: "DamageEvent", amount: ctx.payload.amount }));
});

let sentDamage = false;
const interval = setInterval(() => {
  world.tick();
  const player = world.get(1, Player);
  if (player !== undefined) {
    console.log(
      JSON.stringify({
        tick,
        hp: player.hp.value,
        x: player.x.value,
        y: player.y.value,
        yaw: player.yaw.value,
      }),
    );
    if (!sentDamage) {
      sentDamage = true;
      world.sendCommand(WorldEntity, DamageCommand, { amount: 10 });
    }
  }
}, 100);

setTimeout(() => {
  clearInterval(interval);
  transport.socket.close();
}, 4_000);
