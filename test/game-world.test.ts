import { describe, expect, it } from "vitest";
import {
  createClientWorld,
  createHostWorld,
  defineCommand,
  defineComponent,
  defineEntity,
  defineEvent,
  defineProtocol,
  qf32,
  u16,
  varu32,
  vec2q,
  type ChannelName,
  type ClientTransport,
  type Clock,
  type HostTransport,
  type PeerRef,
} from "../src/index";

class ManualTransport implements ClientTransport, HostTransport {
  peer?: ManualTransport;
  mutateAfterReceive = false;
  readonly peerId: PeerRef = {};
  #clientHandler?: (channel: ChannelName, bytes: Uint8Array) => void;
  #hostHandler?: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void;

  send(channel: ChannelName, bytes: Uint8Array): void;
  send(peer: PeerRef, channel: ChannelName, bytes: Uint8Array): void;
  send(a: PeerRef | ChannelName, b: ChannelName | Uint8Array, c?: Uint8Array): void {
    const channel = c === undefined ? (a as ChannelName) : (b as ChannelName);
    const bytes = c ?? (b as Uint8Array);
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
    if (this.mutateAfterReceive) {
      bytes.fill(0);
    }
  }
}

function pair(): [ManualTransport, ManualTransport] {
  const host = new ManualTransport();
  const client = new ManualTransport();
  host.peer = client;
  client.peer = host;
  return [host, client];
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

describe("single world sync api", () => {
  it("fails fast with friendly world construction errors", () => {
    const protocol = defineProtocol({});
    const hostTransport = new ManualTransport();
    const clientTransport = new ManualTransport();
    const validClock = clock();

    expect(() => createHostWorld(new Date() as never)).toThrow(/requires an options object/);
    expect(() => createClientWorld([] as never)).toThrow(/requires an options object/);
    expect(() =>
      createHostWorld(new (class HostWorldOptions {})() as never),
    ).toThrow(/plain object map/);
    expect(() =>
      createHostWorld({ transport: hostTransport, clock: validClock } as never),
    ).toThrow(/createHostWorld\(\) requires a protocol from defineProtocol\(\)/);
    expect(() =>
      createClientWorld({ transport: clientTransport, clock: validClock } as never),
    ).toThrow(/createClientWorld\(\) requires a protocol from defineProtocol\(\)/);
    expect(() =>
      createHostWorld({
        protocol: {
          components: {},
          prefabs: {},
          commands: {},
          events: {},
          registry: {
            getSchema: () => undefined,
            getRpc: () => undefined,
          },
          manifest: () => ({ components: [], prefabs: [], commands: [], events: [] }),
        },
        transport: hostTransport,
        clock: validClock,
      } as never),
    ).toThrow(/createHostWorld\(\) requires a protocol from defineProtocol\(\)/);
    expect(() =>
      createHostWorld({
        protocol: { ...protocol },
        transport: hostTransport,
        clock: validClock,
      } as never),
    ).toThrow(/createHostWorld\(\) requires a protocol from defineProtocol\(\)/);
    expect(() =>
      createHostWorld({ protocol, transport: {}, clock: validClock } as never),
    ).toThrow(/host transport with send\(\), broadcast\(\), and onPacket\(\)/);
    expect(() =>
      createClientWorld({ protocol, transport: {}, clock: validClock } as never),
    ).toThrow(/client transport with send\(\) and onPacket\(\)/);
    expect(() => createHostWorld({ protocol, transport: hostTransport } as never)).toThrow(
      /createHostWorld\(\) requires a clock with nowMs\(\) and tick\(\)/,
    );
    expect(() =>
      createHostWorld({
        protocol,
        transport: hostTransport,
        clock: validClock,
        channel: "unreliable",
      } as never),
    ).toThrow(/does not accept channel/);
    expect(() =>
      createClientWorld({
        protocol,
        transport: clientTransport,
        clock: validClock,
        channel: "unreliable",
      } as never),
    ).toThrow(/does not accept channel/);
    expect(() =>
      createHostWorld({
        protocol,
        transport: hostTransport,
        clock: validClock,
        visiblity: "none",
      } as never),
    ).toThrow(/unknown option "visiblity"/);
    expect(() =>
      createClientWorld({
        protocol,
        transport: clientTransport,
        clock: validClock,
        interest: () => true,
      } as never),
    ).toThrow(/unknown option "interest"/);
    expect(() =>
      createHostWorld({
        protocol,
        transport: hostTransport,
        clock: validClock,
        visibility: "nearby",
      } as never),
    ).toThrow(/visibility must be "all" or "none"/);
    expect(() =>
      createHostWorld({
        protocol,
        transport: hostTransport,
        clock: validClock,
        snapshotEncoding: "always-batch",
      } as never),
    ).toThrow(/snapshotEncoding must be "default" or "batched"/);
    expect(() =>
      createHostWorld({
        protocol,
        transport: hostTransport,
        clock: validClock,
        interest: true,
      } as never),
    ).toThrow(/interest must be a function/);
    expect(() =>
      createHostWorld({
        protocol,
        transport: hostTransport,
        clock: validClock,
        logger: true,
      } as never),
    ).toThrow(/logger must be an object/);
    expect(() =>
      createClientWorld({
        protocol,
        transport: clientTransport,
        clock: validClock,
        logger: { error: true },
      } as never),
    ).toThrow(/logger\.error must be a function/);
  });

  it("returns frozen host and client world handles", () => {
    const protocol = defineProtocol({});
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });

    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(client)).toBe(true);
    expect(() => {
      (host as { customState?: unknown }).customState = {};
    }).toThrow();
    expect(() => {
      (client as { customState?: unknown }).customState = {};
    }).toThrow();
  });

  it("fails fast when transports deliver invalid packet boundaries", () => {
    const protocol = defineProtocol({});
    const [hostTransport, clientTransport] = pair();
    createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    createClientWorld({ protocol, transport: clientTransport, clock: clock() });

    expect(() =>
      hostTransport.receive("peer", "ordered" as never, new Uint8Array()),
    ).toThrow(/HostTransport\.onPacket\(\) channel must be "reliable" or "unreliable"/);
    expect(() =>
      hostTransport.receive(null as never, "reliable", new Uint8Array()),
    ).toThrow(/HostTransport\.onPacket\(\) requires a peer ref/);
    expect(() =>
      clientTransport.receive("peer", "reliable", [] as never),
    ).toThrow(/ClientTransport\.onPacket\(\) bytes must be a Uint8Array/);
  });

  it("isolates queued inbound packets from transport buffer reuse", () => {
    const Player = defineEntity("TransportBufferReusePlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const protocol = defineProtocol({ prefabs: { Player } });
    const [hostTransport, clientTransport] = pair();
    hostTransport.mutateAfterReceive = true;
    clientTransport.mutateAfterReceive = true;
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    const player = host.spawn(Player, { hp: 77 });

    client.tick();
    host.tick();
    client.tick();

    expect(client.get(player.id, PlayerState)?.hp.value).toBe(77);
  });

  it("fails fast when host transport peers are invalid", () => {
    const protocol = defineProtocol({});
    const transport: HostTransport = {
      send() {},
      broadcast() {},
      onPacket() {},
      peers: () => [Number.NaN as never],
    };
    const host = createHostWorld({ protocol, transport, clock: clock() });

    expect(() => host.tick()).toThrow(/HostTransport\.peers\(\) requires a peer ref/);
  });

  it("fails fast when clock functions return invalid values", () => {
    const protocol = defineProtocol({});
    const [hostTransport, clientTransport] = pair();
    let hostNowMs = 10;
    let clientNowMs = 20;
    const invalidTickHost = createHostWorld({
      protocol,
      transport: hostTransport,
      clock: {
        nowMs: () => 0,
        tick: () => 1.5,
      },
    });
    const invalidNowClient = createClientWorld({
      protocol,
      transport: clientTransport,
      clock: {
        nowMs: () => Number.NaN,
        tick: () => 1,
      },
    });
    const backwardsHost = createHostWorld({
      protocol,
      transport: hostTransport,
      clock: {
        nowMs: () => hostNowMs,
        tick: () => 1,
      },
    });
    const backwardsClient = createClientWorld({
      protocol,
      transport: clientTransport,
      clock: {
        nowMs: () => clientNowMs,
        tick: () => 1,
      },
    });

    expect(() => invalidTickHost.tick()).toThrow(
      /createHostWorld\(\) clock\.tick\(\) must return an integer/,
    );
    expect(() => invalidNowClient.tick()).toThrow(
      /createClientWorld\(\) clock\.nowMs\(\) must return a finite number/,
    );
    backwardsHost.tick();
    hostNowMs = 9;
    expect(() => backwardsHost.tick()).toThrow(/createHostWorld\(\) clock\.nowMs\(\) must be monotonic/);
    backwardsClient.tick();
    clientNowMs = 19;
    expect(() => backwardsClient.tick()).toThrow(
      /createClientWorld\(\) clock\.nowMs\(\) must be monotonic/,
    );
  });

  it("fails fast when world logic uses components outside the protocol", () => {
    const Outside = defineComponent("OutsideProtocolComponent", {
      hp: u16(100),
    });
    const Position = defineComponent("OutsideProtocolPrefabPosition", {
      hp: u16(100),
    });
    const OutsidePrefab = defineEntity("OutsideProtocolPrefab", {
      position: Position,
    });
    const protocol = defineProtocol({ components: { Position } });
    const [hostTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const entity = host.spawn();

    expect(() => host.add(entity, Outside)).toThrow(/not registered in this world protocol/);
    expect(() => host.spawn(Outside)).toThrow(/not registered in this world protocol/);
    expect(() => host.query(Outside).length).toThrow(/not registered in this world protocol/);
    expect(() => host.spawn(OutsidePrefab)).toThrow(/prefab "OutsideProtocolPrefab".*not registered/);
    expect(() => host.add(entity, OutsidePrefab)).toThrow(/prefab "OutsideProtocolPrefab".*not registered/);
    expect(() => host.has(entity, OutsidePrefab)).toThrow(/prefab "OutsideProtocolPrefab".*not registered/);
    expect(() => host.remove(entity, OutsidePrefab)).toThrow(/prefab "OutsideProtocolPrefab".*not registered/);
    expect(() => host.getPrefab(entity, OutsidePrefab)).toThrow(/prefab "OutsideProtocolPrefab".*not registered/);
  });

  it("fails fast for invalid component and prefab arguments", () => {
    const Position = defineComponent("InvalidComponentArgPosition", {
      hp: u16(100),
    });
    const protocol = defineProtocol({ components: { Position } });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    const entity = host.spawn();

    expect(() => host.add(entity, {} as never)).toThrow(/expected a component from defineComponent/);
    expect(() => host.get(entity, null as never)).toThrow(/expected a component from defineComponent/);
    expect(() => host.spawn(null as never)).toThrow(/expected a component from defineComponent/);
    expect(() => host.getPrefab(entity, {} as never)).toThrow(/expected a prefab from defineEntity/);
    expect(() => (host as { query: () => { length: number } }).query().length).toThrow(
      /requires at least one component/,
    );
    expect(() => host.query(null as never).length).toThrow(/expected a component from defineComponent/);
    expect(() => host.query(Position, Position).length).toThrow(
      /duplicate component "InvalidComponentArgPosition"/,
    );
    expect(() => host.each(Position as never, () => {})).toThrow(/requires a component array/);
    expect(() =>
      (host as { each: (components: [], fn: () => void) => void }).each([], () => {}),
    ).toThrow(/requires at least one component/);
    expect(() => host.each([Position, Position] as const, () => {})).toThrow(
      /duplicate component "InvalidComponentArgPosition"/,
    );
    expect(() => client.each([Position] as const, null as never)).toThrow(
      /world\.each\(\) requires a function/,
    );
    expect(() => client.query(Position, Position).length).toThrow(
      /duplicate component "InvalidComponentArgPosition"/,
    );
    expect(() => client.query({ kind: "component", name: "Fake", schemaId: 1 } as never).length)
      .toThrow(/expected a component from defineComponent/);
  });

  it("fails fast for invalid entity ids and refs", () => {
    const Position = defineComponent("InvalidEntityInputPosition", {
      hp: u16(100),
    });
    const MissingEntityPrefab = defineEntity("MissingEntityPrefab", { hp: Position });
    const protocol = defineProtocol({
      components: { Position },
      prefabs: { MissingEntityPrefab },
    });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    const entity = host.spawn();

    expect(() => host.add({} as never, Position)).toThrow(/requires an entity id or entity ref/);
    expect(() => host.add(999, Position)).toThrow(/requires an existing entity/);
    expect(() => host.add(999, MissingEntityPrefab)).toThrow(/requires an existing entity/);
    expect(host.destroy(entity)).toBe(true);
    expect(() => host.add(entity, Position)).toThrow(/requires an existing entity/);
    expect(() => host.get(null as never, Position)).toThrow(/requires an entity id or entity ref/);
    expect(() => client.get({ id: "1" } as never, Position)).toThrow(
      /requires an entity id or entity ref/,
    );
    expect(() => host.remove({ id: 0 } as never, Position)).toThrow(
      /requires a positive integer entity id/,
    );
    expect(() => host.destroy(Number.NaN as never)).toThrow(
      /requires a positive integer entity id/,
    );
    expect(() => host.setVisible("peer", { id: 1.5 } as never, true)).toThrow(
      /requires a positive integer entity id/,
    );
    expect(() => host.setVisible("peer", entity, "yes" as never)).toThrow(
      /visible must be a boolean/,
    );
    expect(() => host.setVisible(null as never, entity, true)).toThrow(/requires a peer ref/);
    expect(() => host.clearVisible("peer", -1 as never)).toThrow(
      /requires a positive integer entity id/,
    );
    expect(() => host.clearVisible(undefined as never)).toThrow(/requires a peer ref/);
    expect(() => host.isVisible("peer", {} as never)).toThrow(
      /requires an entity id or entity ref/,
    );
    expect(() => host.isVisible(Number.NaN as never, entity)).toThrow(/requires a peer ref/);
    expect(() => host.sendFullSnapshot(Number.NaN as never)).toThrow(/requires a peer ref/);
  });

  it("passes read-only entity refs into interest hooks", () => {
    const Visible = defineComponent("InterestVisible", {
      hp: u16(100),
    });
    const protocol = defineProtocol({ components: { Visible } });
    const [hostTransport] = pair();
    let inspected = false;
    const host = createHostWorld({
      protocol,
      transport: hostTransport,
      clock: clock(),
      interest(_peer, entity, world) {
        inspected = true;
        expect(Object.isFrozen(world)).toBe(true);
        expect(Object.isFrozen(entity)).toBe(true);
        expect(() => {
          (entity as { id: number }).id = 99;
        }).toThrow();
        expect("add" in entity).toBe(false);
        expect("remove" in entity).toBe(false);
        expect("destroy" in entity).toBe(false);
        expect("spawn" in world).toBe(false);
        expect("add" in world).toBe(false);
        expect("remove" in world).toBe(false);
        expect("destroy" in world).toBe(false);
        expect("setVisible" in world).toBe(false);
        const state = world.get(entity, Visible);
        expect(state).toBeDefined();
        expect("set" in state!.hp).toBe(false);
        expect(() => {
          (state!.hp as { value: number }).value = 1;
        }).toThrow(/Cannot mutate read-only replicated field "InterestVisible.hp"/);
        return world.has(entity, Visible);
      },
    });
    const entity = host.spawn();
    host.add(entity, Visible);

    expect(host.isVisible("peer", entity)).toBe(true);
    expect(inspected).toBe(true);
  });

  it("fails fast when interest hooks return non-boolean visibility", () => {
    const protocol = defineProtocol({});
    const [hostTransport] = pair();
    const host = createHostWorld({
      protocol,
      transport: hostTransport,
      clock: clock(),
      interest: () => "yes" as never,
    });
    const entity = host.spawn();

    expect(() => host.isVisible("peer", entity)).toThrow(
      /createHostWorld\(\) interest must return a boolean/,
    );
  });

  it("fails fast when RPC usage is outside the world protocol or direction", () => {
    const Move = defineCommand("OutsideProtocolMove", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const Ping = defineCommand("InsideProtocolMove", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const Flash = defineEvent("InsideProtocolFlash", {
      amount: u16(0),
    });
    const UnregisteredFlash = defineEvent("OutsideProtocolFlash", {
      amount: u16(0),
    });
    const protocol = defineProtocol({ commands: { Ping }, events: { Flash } });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });

    expect(() => host.on(Move, () => {})).toThrow(/not registered in this world protocol/);
    expect(() => client.send(Move, {})).toThrow(/not registered in this world protocol/);
    expect(() => host.broadcast(UnregisteredFlash, {})).toThrow(/not registered in this world protocol/);
    expect(() => client.on(UnregisteredFlash, () => {})).toThrow(/not registered in this world protocol/);

    expect(() => host.on(Flash as never, () => {})).toThrow(/expects a command/);
    expect(() => host.broadcast(Ping as never, {})).toThrow(/expects an event/);
    expect(() => client.send(Flash as never, {})).toThrow(/expects a command/);
    expect(() => client.on(Ping as never, () => {})).toThrow(/expects an event/);
    expect(() => host.on(Ping, true as never)).toThrow(/handler must be a function/);
    expect(() => client.on(Flash, true as never)).toThrow(/handler must be a function/);
    expect(() => client.send(Ping)).not.toThrow();
    expect(() => host.broadcast(Flash)).not.toThrow();
    expect(() => client.send(Ping, { amount: 1 } as never)).toThrow(/unknown field "amount"/);
    expect(() => host.broadcast(Flash, { dx: 1 } as never)).toThrow(/unknown field "dx"/);
    expect(() => client.send(Ping, null as never)).toThrow(/RPC payload must be an object/);
    expect(() => host.broadcast(Flash, [] as never)).toThrow(/RPC payload must be an object/);
  });

  it("freezes RPC payloads and callback contexts", () => {
    const Player = defineEntity("FrozenContextPlayer", {
      hp: u16(100),
    });
    const Move = defineCommand("FrozenContextMove", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const Flash = defineEvent("FrozenContextFlash", {
      amount: u16(0),
    });
    const protocol = defineProtocol({
      prefabs: { Player },
      commands: { Move },
      events: { Flash },
    });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    host.spawn(Player);
    const seen: string[] = [];

    host.on(Move, (payload, context) => {
      expect(Object.isFrozen(payload)).toBe(true);
      expect(() => {
        (payload as { dx: number }).dx = 1;
      }).toThrow();
      expect(Object.isFrozen(context)).toBe(true);
      expect(() => {
        (context as { channel: ChannelName }).channel = "unreliable";
      }).toThrow();
      seen.push(`host:${payload.dx}:${context.channel}:${context.peer === undefined ? "no-peer" : "peer"}`);
    });
    host.on(Move, (payload, context) => {
      seen.push(`host2:${payload.dx}:${context.channel}:${context.peer === undefined ? "no-peer" : "peer"}`);
    });
    client.on(Flash, (payload, context) => {
      expect(Object.isFrozen(payload)).toBe(true);
      expect(() => {
        (payload as { amount: number }).amount = 99;
      }).toThrow();
      expect(Object.isFrozen(context)).toBe(true);
      expect(() => {
        (context as { tick: number }).tick = 99;
      }).toThrow();
      seen.push(`client:${payload.amount}:${context.channel}`);
    });
    client.on(Flash, (payload, context) => {
      seen.push(`client2:${payload.amount}:${context.channel}:${context.tick}`);
    });
    client.onSnapshot((_world, context) => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(() => {
        (context as { channel: ChannelName }).channel = "unreliable";
      }).toThrow();
      seen.push(`snapshot:${context.channel}`);
    });
    client.onSnapshot((_world, context) => {
      seen.push(`snapshot2:${context.channel}:${context.tick}`);
    });

    client.tick();
    host.tick();
    client.tick();
    client.send(Move, { dx: 0.25 });
    host.broadcast(Flash, { amount: 1 });
    host.tick();
    client.tick();

    expect(seen).toContain("host:0.25:reliable:peer");
    expect(seen).toContain("host2:0.25:reliable:peer");
    expect(seen).toContain("client:1:reliable");
    expect(seen.some((value) => value.startsWith("client2:1:reliable:"))).toBe(true);
    expect(seen).toContain("snapshot:reliable");
    expect(seen.some((value) => value.startsWith("snapshot2:reliable:"))).toBe(true);
  });

  it("drives sync through world.tick", () => {
    const Player = defineEntity("GameWorldPlayer", {
      hp: u16(100),
      x: qf32({ min: -10, max: 10, precision: 0.01, default: 0 }),
    });
    const PlayerState = Player.component;
    const Move = defineCommand("GameWorldMove", {
      dx: qf32({ min: -1, max: 1, precision: 0.01, default: 0 }),
    });
    const DamageFx = defineEvent("GameWorldDamageFx", {
      entityId: varu32(0),
      amount: u16(0),
    });
    const protocol = defineProtocol({
      prefabs: { Player },
      commands: { Move },
      events: { DamageFx },
    });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    const player = host.spawn(Player);
    let eventAmount = 0;

    host.on(Move, (payload) => {
      host.get(player, PlayerState)!.x.value += payload.dx;
      host.broadcast(DamageFx, { entityId: player.id, amount: 3 });
    });
    client.on(DamageFx, (payload) => {
      eventAmount = payload.amount;
    });

    client.tick();
    host.tick();
    client.tick();
    expect(client.get(player.id, PlayerState)?.hp.value).toBe(100);

    client.send(Move, { dx: 0.5 });
    host.tick();
    client.tick();

    expect(client.get(player.id, PlayerState)?.x.value).toBeCloseTo(0.5, 2);
    expect(eventAmount).toBe(3);
  });

  it("notifies clients after snapshots are applied", () => {
    const Player = defineEntity("SnapshotHookPlayer", {
      hp: u16(100),
    });
    const PlayerState = Player.component;
    const protocol = defineProtocol({ prefabs: { Player } });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    const player = host.spawn(Player);
    const seen: { tick: number; channel: ChannelName; hp: number | undefined }[] = [];
    const off = client.onSnapshot((world, context) => {
      seen.push({
        tick: context.tick,
        channel: context.channel,
        hp: world.get(player, PlayerState)?.hp.value,
      });
    });

    client.tick();
    host.tick();
    client.tick();

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)).toMatchObject({ channel: "reliable", hp: 100 });

    host.get(player, PlayerState)!.hp.value = 80;
    const beforeUpdate = seen.length;
    host.tick();
    client.tick();

    expect(seen.length).toBeGreaterThan(beforeUpdate);
    expect(seen.at(-1)).toMatchObject({ channel: "unreliable", hp: 80 });

    off();
    host.get(player, PlayerState)!.hp.value = 60;
    const beforeOffUpdate = seen.length;
    host.tick();
    client.tick();
    expect(seen).toHaveLength(beforeOffUpdate);
  });

  it("notifies snapshot handlers from a stable snapshot", () => {
    const Player = defineEntity("SnapshotHookStablePlayer", {
      hp: u16(100),
    });
    const protocol = defineProtocol({ prefabs: { Player } });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    host.spawn(Player);
    client.tick();
    host.tick();
    client.tick();

    const seen: string[] = [];
    let registeredLate = false;
    client.onSnapshot(() => {
      seen.push("first");
      if (!registeredLate) {
        registeredLate = true;
        client.onSnapshot(() => seen.push("late"));
      }
    });
    client.onSnapshot(() => seen.push("second"));

    host.sendFullSnapshot(clientTransport.peerId);
    client.tick();
    expect(seen).toEqual(["first", "second"]);

    seen.length = 0;
    host.sendFullSnapshot(clientTransport.peerId);
    client.tick();
    expect(seen).toEqual(["first", "second", "late"]);
  });

  it("isolates snapshot hook failures", () => {
    const Player = defineEntity("SnapshotHookFailurePlayer", {
      hp: u16(100),
    });
    const protocol = defineProtocol({ prefabs: { Player } });
    const [hostTransport, clientTransport] = pair();
    const errors: string[] = [];
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({
      protocol,
      transport: clientTransport,
      clock: clock(),
      logger: {
        error: (message, context) => errors.push(`${message}:${String(context?.error)}`),
      },
    });
    let called = 0;
    host.spawn(Player);
    client.onSnapshot(() => {
      throw new Error("sample failure");
    });
    client.onSnapshot(() => {
      called += 1;
    });

    client.tick();
    host.tick();
    client.tick();

    expect(called).toBeGreaterThan(0);
    expect(errors[0]).toContain("ClientWorld snapshot handler failed:sample failure");
  });

  it("keeps client replicated entity access read-only at runtime", () => {
    const Player = defineEntity("ClientReadonlyPlayer", {
      hp: u16(100, { label: "health" }),
      pos: vec2q({ min: -100, max: 100, precision: 0.01, default: { x: 0, y: 0 } }),
    });
    const PlayerState = Player.component;
    const protocol = defineProtocol({ prefabs: { Player } });
    const [hostTransport, clientTransport] = pair();
    const host = createHostWorld({ protocol, transport: hostTransport, clock: clock() });
    const client = createClientWorld({ protocol, transport: clientTransport, clock: clock() });
    const hostPlayer = host.spawn(Player);
    const hostState = host.get(hostPlayer, PlayerState)!;

    expect(Object.isFrozen(hostState.hp.meta)).toBe(true);
    expect(Object.isFrozen(hostState.hp.meta.metadata)).toBe(true);
    expect("codec" in hostState.hp.meta).toBe(false);
    expect(() => {
      (hostState.hp.meta as { schemaName: string }).schemaName = "Mutated";
    }).toThrow();

    client.tick();
    host.tick();
    client.tick();

    const rows = client.query(PlayerState).toArray();
    expect(rows).toHaveLength(1);
    const [entity, state] = rows[0]!;
    expect(entity.id).toBe(1);
    expect("add" in entity).toBe(false);
    expect("remove" in entity).toBe(false);
    expect("destroy" in entity).toBe(false);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.hp.meta)).toBe(true);
    expect(Object.isFrozen(state.hp.meta.metadata)).toBe(true);
    expect("codec" in state.hp.meta).toBe(false);
    expect(() => {
      (state.hp.meta as { fieldName: string }).fieldName = "mutated";
    }).toThrow();
    expect("set" in state.hp).toBe(false);
    expect(() => {
      (state.hp as { value: number }).value = 1;
    }).toThrow(/Cannot mutate read-only replicated field "ClientReadonlyPlayer.hp"/);
    expect(Object.isFrozen(state.pos.value)).toBe(true);
    expect(() => {
      (state.pos.value as { x: number }).x = 1;
    }).toThrow();
    expect(client.get(entity, PlayerState)?.hp.value).toBe(100);
    const prefab = client.getPrefab(entity, Player)!;
    expect(Object.isFrozen(prefab)).toBe(true);
    expect(Object.isFrozen(prefab.state)).toBe(true);
    expect(client.has(entity, Player)).toBe(true);
    expect(() => {
      (prefab as Record<string, unknown>).extra = true;
    }).toThrow();
    expect(() => {
      (prefab.state.hp as { value: number }).value = 1;
    }).toThrow(/Cannot mutate read-only replicated field "ClientReadonlyPlayer.hp"/);
    expect("spawn" in client).toBe(false);
    expect("add" in client).toBe(false);
    expect("remove" in client).toBe(false);
    expect("destroy" in client).toBe(false);
  });

  it("has stable name-hash ids and deterministic manifests", () => {
    const A = defineEntity("HashStableA", { hp: u16(1) });
    const B = defineEntity("HashStableB", { hp: u16(1) });
    const Again = defineEntity("HashStableA", { hp: u16(1) });
    const Move = defineCommand("HashStableMove", { dx: qf32({ min: -1, max: 1, precision: 1, default: 0 }) });
    const protocol = defineProtocol({ prefabs: { B, A }, commands: { Move } });

    expect(A.prefabId).toBe(Again.prefabId);
    expect(A.prefabId).not.toBe(B.prefabId);
    const manifest = protocol.manifest();

    expect(manifest.components.map((entry) => entry.name)).toEqual(["HashStableA", "HashStableB"]);
    expect(manifest.prefabs.map((entry) => entry.name)).toEqual(["HashStableA", "HashStableB"]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.components)).toBe(true);
    expect(Object.isFrozen(manifest.prefabs)).toBe(true);
    expect(Object.isFrozen(manifest.commands)).toBe(true);
    expect(Object.isFrozen(manifest.events)).toBe(true);
    expect(Object.isFrozen(manifest.components[0])).toBe(true);
    expect(() => {
      (manifest.components as unknown as unknown[]).push({ name: "Injected", id: 1 });
    }).toThrow();
    expect(() => {
      (manifest.components[0] as { name: string }).name = "Injected";
    }).toThrow();
    expect(protocol.manifest().components.map((entry) => entry.name)).toEqual([
      "HashStableA",
      "HashStableB",
    ]);
  });

  it("fails fast on id collisions", () => {
    const A = defineEntity("CollisionA", { hp: u16(1) }, { id: 7 });
    const B = defineEntity("CollisionB", { hp: u16(1) }, { id: 7 });

    expect(() => defineProtocol({ prefabs: { A, B } })).toThrow(/Duplicate schema id/);
  });
});
