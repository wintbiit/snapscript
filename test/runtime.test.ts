import { describe, expect, it } from "vitest";
import {
  defineCommand,
  defineEntity,
  defineEvent,
  qf32,
  u16,
  varu32,
  type ChannelName,
  type ClientTransport,
  type Clock,
  type PeerRef,
  type Logger,
  type HostTransport,
} from "../src/index";
import { createRegistry } from "../src/registry/index";
import { createSyncClient, createSyncHost } from "../src/runtime/index";
import { BitReader } from "../src/binary/index";
import {
  applySnapshot,
  ControlCapability,
  ControlType,
  decodeControl,
  encodeControl,
  SnapshotOp,
} from "../src/sync/index";
import { worldInternals } from "../src/world/internals";
import { createTestClientWorld, createTestHostWorld, testProtocol } from "./helpers";

class ManualTransport implements ClientTransport, HostTransport {
  peer?: ManualTransport;
  readonly packets: Uint8Array[] = [];
  readonly peerId: PeerRef = {};
  #clientHandler?: (channel: ChannelName, bytes: Uint8Array) => void;
  #hostHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  send(a: PeerRef | ChannelName, b: ChannelName | Uint8Array, c?: Uint8Array): void {
    const channel = c === undefined ? (a as ChannelName) : (b as ChannelName);
    const bytes = c ?? (b as Uint8Array);
    this.packets.push(bytes);
    this.peer?.receive(this.peerId, channel, bytes);
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

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    this.send(channel, bytes);
  }

  peers(): Iterable<PeerRef> {
    return [this.peerId];
  }

  receive(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    this.#clientHandler?.(channel, bytes);
    this.#hostHandler?.(peer, channel, bytes);
  }
}

class PeerHostTransport implements HostTransport {
  readonly sent: { peer: PeerRef; channel: ChannelName; bytes: Uint8Array }[] = [];
  #handler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    this.sent.push({ peer, channel, bytes });
  }

  broadcast(channel: ChannelName, bytes: Uint8Array): void {
    for (const peer of this.peers()) {
      this.send(peer, channel, bytes);
    }
  }

  onPacket(cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void {
    this.#handler = cb;
  }

  peers(): Iterable<PeerRef> {
    return [];
  }

  receive(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void {
    this.#handler?.(peer, channel, bytes);
  }
}

function pair(): [ManualTransport, ManualTransport] {
  const a = new ManualTransport();
  const b = new ManualTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
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

describe("sync runtime", () => {
  it("keeps control capability bits backward compatible", () => {
    expect(decodeControl(encodeControl(ControlType.Hello, 7))).toEqual({
      tick: 7,
      type: ControlType.Hello,
      capabilities: 0,
    });
    expect(
      decodeControl(encodeControl(ControlType.Hello, 8, ControlCapability.BatchedSnapshots)),
    ).toEqual({
      tick: 8,
      type: ControlType.Hello,
      capabilities: ControlCapability.BatchedSnapshots,
    });
  });

  it("sends a full snapshot when the client starts", () => {
    const Player = defineEntity("RuntimeFullPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const hostWorld = createTestHostWorld(protocol);
    const clientWorld = createTestClientWorld(protocol);
    const player = hostWorld.spawn(Player, { hp: 80 });
    const [hostTransport, clientTransport] = pair();
    const host = createSyncHost({
      world: hostWorld,
      transport: hostTransport,
      clock: clock(),
      registry,
    });
    const client = createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
    });

    client.start();

    expect(decodeControl(clientTransport.packets[0]!)).toMatchObject({
      type: ControlType.Hello,
      capabilities: ControlCapability.BatchedSnapshots,
    });
    expect(clientWorld.get(player.id, PlayerState)?.hp.value).toBe(80);
    expect(host).toBeDefined();
  });

  it("sends dirty snapshots on host update without client dirty echo", () => {
    const Player = defineEntity("RuntimeDirtyPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const hostWorld = createTestHostWorld(protocol);
    const clientWorld = createTestClientWorld(protocol);
    const player = hostWorld.spawn(Player);
    const [hostTransport, clientTransport] = pair();
    const host = createSyncHost({ world: hostWorld, transport: hostTransport, clock: clock(), registry });
    const client = createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
    });
    client.start();

    hostWorld.get(player, PlayerState)!.hp.value = 40;
    host.update();

    expect(clientWorld.get(player.id, PlayerState)?.hp.value).toBe(40);
    expect(worldInternals(clientWorld).getDirtyMask(player.id)).toBe(0);
  });

  it("routes client commands to host handlers and syncs resulting dirty state", () => {
    const Player = defineEntity("RuntimeCommandPlayer", {
      hp: u16(100),
      x: qf32({ min: -10, max: 10, precision: 0.01, default: 0 }),
    });
    const Move = defineCommand("RuntimeMoveCommand", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState).registerRpc(Move);
    const protocol = testProtocol(Player, Move);
    const hostWorld = createTestHostWorld(protocol);
    const clientWorld = createTestClientWorld(protocol);
    const player = hostWorld.spawn(Player);
    const [hostTransport, clientTransport] = pair();
    const host = createSyncHost({ world: hostWorld, transport: hostTransport, clock: clock(), registry });
    const client = createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
    });
    host.on(Move, (payload) => {
      hostWorld.get(player, PlayerState)!.x.value += payload.dx;
    });
    client.start();

    client.send(Move, { dx: 0.5 });
    host.update();

    expect(clientWorld.get(player.id, PlayerState)?.x.value).toBeCloseTo(0.5, 2);
  });

  it("isolates host command handler failures", () => {
    const Move = defineCommand("RuntimeIsolatedMoveCommand", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const registry = createRegistry().registerRpc(Move);
    const hostWorld = createTestHostWorld(testProtocol(Move));
    const clientWorld = createTestClientWorld(testProtocol(Move));
    const [hostTransport, clientTransport] = pair();
    const errors: string[] = [];
    const host = createSyncHost({
      world: hostWorld,
      transport: hostTransport,
      clock: clock(),
      registry,
      logger: {
        error: (message, context) => errors.push(`${message}:${String(context?.rpc)}:${String(context?.error)}`),
      },
    });
    const client = createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
    });
    let handled = false;
    host.on(Move, () => {
      throw new Error("move failed");
    });
    host.on(Move, () => {
      handled = true;
    });

    client.send(Move, { dx: 0.5 });

    expect(handled).toBe(true);
    expect(errors[0]).toContain("RPC handler failed:RuntimeIsolatedMoveCommand:move failed");
  });

  it("broadcasts events to client handlers without dirtying world", () => {
    const Player = defineEntity("RuntimeEventPlayer", {
      hp: u16(100),
    });
    const Damage = defineEvent("RuntimeDamageEvent", {
      entityId: varu32(0),
      amount: u16(0),
    });
    const registry = createRegistry().registerComponent(Player.component).registerRpc(Damage);
    const protocol = testProtocol(Player, Damage);
    const hostWorld = createTestHostWorld(protocol);
    const clientWorld = createTestClientWorld(protocol);
    const [hostTransport, clientTransport] = pair();
    const host = createSyncHost({ world: hostWorld, transport: hostTransport, clock: clock(), registry });
    const client = createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
    });
    let received = 0;
    client.on(Damage, (payload) => {
      received = payload.amount;
    });

    host.broadcast(Damage, { entityId: 1, amount: 10 });

    expect(received).toBe(10);
    expect(worldInternals(clientWorld).getDirtyMask(1)).toBe(0);
  });

  it("isolates client event handler failures", () => {
    const Damage = defineEvent("RuntimeIsolatedDamageEvent", {
      amount: u16(0),
    });
    const registry = createRegistry().registerRpc(Damage);
    const hostWorld = createTestHostWorld(testProtocol(Damage));
    const clientWorld = createTestClientWorld(testProtocol(Damage));
    const [hostTransport, clientTransport] = pair();
    const host = createSyncHost({ world: hostWorld, transport: hostTransport, clock: clock(), registry });
    const errors: string[] = [];
    const client = createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
      logger: {
        error: (message, context) => errors.push(`${message}:${String(context?.rpc)}:${String(context?.error)}`),
      },
    });
    let received = 0;
    client.on(Damage, () => {
      throw new Error("damage failed");
    });
    client.on(Damage, (payload) => {
      received = payload.amount;
    });

    host.broadcast(Damage, { amount: 7 });

    expect(received).toBe(7);
    expect(errors[0]).toContain("RPC handler failed:RuntimeIsolatedDamageEvent:damage failed");
  });

  it("dispatches RPC handlers from a stable snapshot", () => {
    const Damage = defineEvent("RuntimeSnapshotDamageEvent", {
      amount: u16(0),
    });
    const registry = createRegistry().registerRpc(Damage);
    const hostWorld = createTestHostWorld(testProtocol(Damage));
    const clientWorld = createTestClientWorld(testProtocol(Damage));
    const [hostTransport, clientTransport] = pair();
    const host = createSyncHost({ world: hostWorld, transport: hostTransport, clock: clock(), registry });
    const client = createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
    });
    const seen: string[] = [];
    let registeredLate = false;

    client.on(Damage, () => {
      seen.push("first");
      if (!registeredLate) {
        registeredLate = true;
        client.on(Damage, () => seen.push("late"));
      }
    });
    client.on(Damage, () => seen.push("second"));

    host.broadcast(Damage, { amount: 1 });
    expect(seen).toEqual(["first", "second"]);

    host.broadcast(Damage, { amount: 2 });
    expect(seen).toEqual(["first", "second", "first", "second", "late"]);
  });

  it("logs unknown rpc ids without mutating world", () => {
    const Unknown = defineEvent("RuntimeUnknownEvent", {
      amount: u16(0),
    });
    const registry = createRegistry();
    const hostWorld = createTestHostWorld();
    const clientWorld = createTestClientWorld();
    const [hostTransport, clientTransport] = pair();
    const errors: string[] = [];
    const logger: Logger = {
      error: (message, context) => errors.push(`${message}:${String(context?.error)}`),
    };
    const host = createSyncHost({ world: hostWorld, transport: hostTransport, clock: clock(), registry });
    createSyncClient({
      world: clientWorld,
      transport: clientTransport,
      clock: clock(),
      registry,
      logger,
    });

    host.broadcast(Unknown, { amount: 1 });

    expect(errors[0]).toContain("Unknown rpcId");
  });

  it("tracks known state per peer and sends visibility removals", () => {
    const Player = defineEntity("RuntimePeerPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const hostWorld = createTestHostWorld(protocol);
    const clientWorld = createTestClientWorld(protocol);
    const player = hostWorld.spawn(Player);
    const visible = new Map<PeerRef, boolean>();
    const peerA = "peer-a";
    const peerB = "peer-b";
    const transport = new PeerHostTransport();
    const host = createSyncHost({
      world: hostWorld,
      transport,
      clock: clock(),
      registry,
      isVisible: (peer) => visible.get(peer) ?? true,
    });
    host.update();

    transport.receive(peerA, "reliable", encodeControl(ControlType.Hello, 1));
    expect(transport.sent.filter((packet) => packet.peer === peerA)).toHaveLength(1);
    expect(transport.sent.filter((packet) => packet.peer === peerB)).toHaveLength(0);
    applySnapshot(clientWorld, transport.sent[0]!.bytes, registry);
    expect(clientWorld.get(player, PlayerState)?.hp.value).toBe(100);

    hostWorld.get(player, PlayerState)!.hp.value = 90;
    host.update();
    const update = transport.sent.at(-1)!;
    expect(update.peer).toBe(peerA);
    expect(update.channel).toBe("unreliable");
    applySnapshot(clientWorld, update.bytes, registry);
    expect(clientWorld.get(player, PlayerState)?.hp.value).toBe(90);

    visible.set(peerA, false);
    host.update();
    const removal = transport.sent.at(-1)!;
    expect(removal.channel).toBe("reliable");
    applySnapshot(clientWorld, removal.bytes, registry);
    expect(clientWorld.get(player, PlayerState)).toBeUndefined();
  });

  it("filters peer-specific full snapshot broadcasts when visibility is configured", () => {
    const Player = defineEntity("RuntimeFilteredFullSnapshotPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const hostWorld = createTestHostWorld(testProtocol(Player));
    const visibleClient = createTestClientWorld(testProtocol(Player));
    const hiddenClient = createTestClientWorld(testProtocol(Player));
    const player = hostWorld.spawn(Player);
    const peerA = "peer-a";
    const peerB = "peer-b";
    const transport = new PeerHostTransport();
    const host = createSyncHost({
      world: hostWorld,
      transport,
      clock: clock(),
      registry,
      isVisible: (peer) => peer === peerA,
    });

    transport.receive(peerA, "reliable", encodeControl(ControlType.Hello, 1));
    transport.receive(peerB, "reliable", encodeControl(ControlType.Hello, 2));
    transport.sent.splice(0);

    host.sendFullSnapshot();

    const visiblePacket = transport.sent.find((packet) => packet.peer === peerA);
    const hiddenPacket = transport.sent.find((packet) => packet.peer === peerB);
    expect(visiblePacket?.channel).toBe("reliable");
    expect(hiddenPacket?.channel).toBe("reliable");

    applySnapshot(visibleClient, visiblePacket!.bytes, registry);
    applySnapshot(hiddenClient, hiddenPacket!.bytes, registry);
    expect(visibleClient.get(player, PlayerState)?.hp.value).toBe(100);
    expect(hiddenClient.get(player, PlayerState)).toBeUndefined();
  });

  it("uses full snapshots to reconcile stale peer state", () => {
    const Player = defineEntity("RuntimeReconcileFullSnapshotPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const hostWorld = createTestHostWorld(protocol);
    const clientWorld = createTestClientWorld(protocol);
    const player = hostWorld.spawn(Player);
    const peer = "peer";
    const visible = new Map<PeerRef, boolean>();
    const transport = new PeerHostTransport();
    const host = createSyncHost({
      world: hostWorld,
      transport,
      clock: clock(),
      registry,
      isVisible: (targetPeer) => visible.get(targetPeer) ?? true,
    });

    transport.receive(peer, "reliable", encodeControl(ControlType.Hello, 1));
    applySnapshot(clientWorld, transport.sent.at(-1)!.bytes, registry);
    expect(clientWorld.get(player, PlayerState)?.hp.value).toBe(100);

    visible.set(peer, false);
    host.sendFullSnapshot(peer);
    applySnapshot(clientWorld, transport.sent.at(-1)!.bytes, registry);
    expect(clientWorld.get(player, PlayerState)).toBeUndefined();

    visible.set(peer, true);
    host.sendFullSnapshot(peer);
    applySnapshot(clientWorld, transport.sent.at(-1)!.bytes, registry);
    expect(clientWorld.get(player, PlayerState)?.hp.value).toBe(100);

    hostWorld.remove(player, PlayerState);
    host.sendFullSnapshot(peer);
    applySnapshot(clientWorld, transport.sent.at(-1)!.bytes, registry);
    expect(clientWorld.get(player, PlayerState)).toBeUndefined();
  });

  it("splits structural reliable packets from update unreliable packets in the same tick", () => {
    const Player = defineEntity("RuntimeSplitPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const world = createTestHostWorld(testProtocol(Player));
    const existing = world.spawn(Player);
    const transport = new PeerHostTransport();
    const peer = "peer";
    const host = createSyncHost({ world, transport, clock: clock(), registry });
    host.update();

    transport.receive(peer, "reliable", encodeControl(ControlType.Hello, 1));
    transport.sent.splice(0);
    world.get(existing, PlayerState)!.hp.value = 80;
    world.spawn(Player, { hp: 50 });
    host.update();

    expect(transport.sent.map((packet) => packet.channel)).toEqual(["reliable", "unreliable"]);
  });

  it("uses batched snapshot updates only when the host runtime opts in", () => {
    const Player = defineEntity("RuntimeBatchedSnapshotPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const world = createTestHostWorld(protocol);
    const first = world.spawn(Player);
    const second = world.spawn(Player);
    const transport = new PeerHostTransport();
    const peer = "peer";
    const host = createSyncHost({
      world,
      transport,
      clock: clock(),
      registry,
      snapshotEncoding: "batched",
    });

    transport.receive(
      peer,
      "reliable",
      encodeControl(ControlType.Hello, 1, ControlCapability.BatchedSnapshots),
    );
    transport.sent.splice(0);
    const internals = worldInternals(world);
    internals.clearWrittenDirty(internals.getDirtySnapshot());
    world.get(first, PlayerState)!.hp.value = 80;
    world.get(second, PlayerState)!.hp.value = 70;
    host.update();

    const packet = transport.sent.at(-1)!;
    expect(packet.channel).toBe("unreliable");
    const reader = new BitReader(packet.bytes);
    expect(reader.readU8()).toBe(1);
    reader.readU32();
    expect(reader.readVarUint()).toBe(1);
    expect(reader.readVarUint()).toBe(0);
    expect(reader.readVarUint()).toBe(PlayerState.schemaId);
    expect(reader.readU8()).toBe(SnapshotOp.BatchUpdateComponent);
  });

  it("falls back to normal updates for peers that did not advertise batched snapshots", () => {
    const Player = defineEntity("RuntimeBatchedSnapshotFallbackPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const registry = createRegistry().registerComponent(PlayerState);
    const protocol = testProtocol(Player);
    const world = createTestHostWorld(protocol);
    const first = world.spawn(Player);
    const second = world.spawn(Player);
    const transport = new PeerHostTransport();
    const peer = "peer";
    const host = createSyncHost({
      world,
      transport,
      clock: clock(),
      registry,
      snapshotEncoding: "batched",
    });

    transport.receive(peer, "reliable", encodeControl(ControlType.Hello, 1));
    transport.sent.splice(0);
    const internals = worldInternals(world);
    internals.clearWrittenDirty(internals.getDirtySnapshot());
    world.get(first, PlayerState)!.hp.value = 80;
    world.get(second, PlayerState)!.hp.value = 70;
    host.update();

    const packet = transport.sent.at(-1)!;
    expect(packet.channel).toBe("unreliable");
    const reader = new BitReader(packet.bytes);
    expect(reader.readU8()).toBe(1);
    reader.readU32();
    expect(reader.readVarUint()).toBe(2);
    expect(reader.readVarUint()).toBe(first.id);
    expect(reader.readVarUint()).toBe(PlayerState.schemaId);
    expect(reader.readU8()).toBe(SnapshotOp.UpdateComponent);
  });
});
