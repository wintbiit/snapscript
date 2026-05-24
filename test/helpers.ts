import {
  createClientWorld,
  createServerWorld,
  defineProtocol,
  type CommandDefinition,
  type ChannelName,
  type Clock,
  type ClientTransport,
  type ComponentSchema,
  type EventDefinition,
  type ServerTransport,
  type PeerRef,
  type PrefabDefinition,
  type ProtocolDefinition,
} from "../packages/snapscript/src/index";

class NullServerTransport implements ServerTransport {
  send(_peer: PeerRef, _channel: ChannelName, _bytes: Uint8Array): void {}
  broadcast(_channel: ChannelName, _bytes: Uint8Array): void {}
  onPacket(_cb: (peer: PeerRef, channel: ChannelName, bytes: Uint8Array) => void): void {}
  peers(): Iterable<PeerRef> {
    return [];
  }
}

class NullClientTransport implements ClientTransport {
  send(_channel: ChannelName, _bytes: Uint8Array): void {}
  onPacket(_cb: (channel: ChannelName, bytes: Uint8Array) => void): void {}
}

export function testClock(): Clock {
  let tick = 0;
  return {
    nowMs: () => tick * 16,
    tick: () => {
      tick += 1;
      return tick;
    },
  };
}

type ProtocolItem =
  | ComponentSchema
  | PrefabDefinition
  | CommandDefinition
  | EventDefinition;

export function testProtocol(...items: readonly ProtocolItem[]): ProtocolDefinition {
  const components: Record<string, ComponentSchema> = {};
  const prefabs: Record<string, PrefabDefinition> = {};
  const commands: Record<string, CommandDefinition> = {};
  const events: Record<string, EventDefinition> = {};

  for (const item of items) {
    if (item.kind === "component") {
      components[item.name] = item;
    } else if (item.kind === "prefab") {
      prefabs[item.name] = item;
    } else if (item.kind === "command") {
      commands[item.name] = item;
    } else {
      events[item.name] = item;
    }
  }

  return defineProtocol({ components, prefabs, commands, events });
}

export function createTestServerWorld(protocol: ProtocolDefinition = defineProtocol({})) {
  return createServerWorld({
    protocol,
    transport: new NullServerTransport(),
    clock: testClock(),
  });
}

export function createTestClientWorld(protocol: ProtocolDefinition = defineProtocol({})) {
  return createClientWorld({
    protocol,
    transport: new NullClientTransport(),
    clock: testClock(),
  });
}
