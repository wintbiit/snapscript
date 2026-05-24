import {
  createClientWorld,
  createServerWorld,
  ServerPeerId,
  type ChannelName,
  type ClientTransport,
  type Clock,
  type ServerTransport,
  type PeerRef,
} from "snapscript";
import {
  Health,
  MovementMove,
  MovementMoveDisabled,
  Player,
  Position,
  protocol,
  rpc,
} from "../generated/protocol";

class LocalLink implements ServerTransport, ClientTransport {
  readonly #peer: PeerRef = "client-1";
  #hostHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
  #clientHandler?: (channel: ChannelName, bytes: Uint8Array) => void;

  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  send(
    peerOrChannel: PeerRef | ChannelName,
    channelOrBytes: ChannelName | Uint8Array,
    maybeBytes?: Uint8Array,
  ): void {
    if (maybeBytes === undefined) {
      this.#hostHandler?.(this.#peer, peerOrChannel as ChannelName, channelOrBytes as Uint8Array);
      return;
    }
    this.#clientHandler?.(channelOrBytes as ChannelName, maybeBytes);
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    this.#clientHandler?.(channel, bytes);
  }

  onPacket(cb: (channel: ChannelName, bytes: Uint8Array) => void): void;
  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void;
  onPacket(
    cb:
      | ((channel: ChannelName, bytes: Uint8Array) => void)
      | ((peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void),
  ): void {
    if (cb.length >= 3) {
      this.#hostHandler = cb as (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;
    } else {
      this.#clientHandler = cb as (channel: ChannelName, bytes: Uint8Array) => void;
    }
  }

  peers(): Iterable<PeerRef> {
    return [this.#peer];
  }
}

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

const link = new LocalLink();
const serverWorld = createServerWorld({ protocol, transport: link, clock: clock() });
const clientWorld = createClientWorld({ protocol, transport: link, clock: clock() });

const player = serverWorld.spawn(Player, {
  position: { x: 0, y: 0 },
  health: { hp: 100 },
});

rpc.commands.MovementMove.on(serverWorld, (ctx) => {
  const position = serverWorld.get(player, Position);
  if (position === undefined) {
    return;
  }

  position.x.value += ctx.payload.dx;
  position.y.value += ctx.payload.dy;

  if (Math.abs(position.x.value) > 5 || Math.abs(position.y.value) > 5) {
    rpc.events.MovementMoveDisabled.sendTo(serverWorld, ctx.sender, { disabled: true });
  }
});

rpc.events.MovementMoveDisabled.on(clientWorld, (ctx) => {
  console.log(`movement disabled by peer ${ctx.sender}; disabled=${ctx.payload.disabled}`);
});

clientWorld.tick();
serverWorld.tick();
clientWorld.tick();

serverWorld.setOwner(player, clientWorld.myPeerId());
serverWorld.tick();
clientWorld.tick();

rpc.commands.MovementMove.send(clientWorld, { dx: 1, dy: 0 });
serverWorld.tick();
clientWorld.tick();

const replicatedPosition = clientWorld.get(player.id, Position);
const replicatedHealth = clientWorld.get(player.id, Health);

console.log({
  serverPeerId: ServerPeerId,
  myPeerId: clientWorld.myPeerId(),
  isMine: clientWorld.isMine(player.id),
  x: replicatedPosition?.x.value,
  y: replicatedPosition?.y.value,
  hp: replicatedHealth?.hp.value,
  rpcName: MovementMove.name,
  eventName: MovementMoveDisabled.name,
});
