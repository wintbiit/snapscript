# SnapScript Protocol Project Example

This example shows the `.snap`-driven project layout:

- `game.snap` is the protocol source of truth.
- `core/` is the platform-neutral game core package.
- `app/` is a browser/Vite platform package that depends on the core package.
- `node/` is a Node/WebSocket platform package used by tests.

```sh
pnpm --dir examples/protocol generate
pnpm --dir examples/protocol build
pnpm --dir examples/protocol dev
```

## RPC In The IDL

RPC is declared inside endpoint blocks in `game.snap`:

```snap
world {
  state: MatchState

  command StartGame() reliable
  event GameStarted() reliable
}

peer {
  connectionInfo: ConnectionInfo

  command Ready() reliable
  event Alert(reason: u8(0)) reliable
}

entity Player {
  position: Position
  health: Health

  command Move(input: MoveInput) unreliable
  stream MoveStream(input: MoveInput)
  event MoveDisabled(disabled: bool) reliable
}
```

Endpoint blocks define routing:

- `world {}` maps to `WorldEntity`.
- `peer {}` maps to one replicated PeerEntity per connected peer.
- `entity Player {}` maps to replicated gameplay entities with the declared component set.

RPC direction is fixed by keyword:

- `command` travels client to server.
- `event` travels server to client.
- `stream` travels client to server as an unreliable batched input stream.

Generated handler contexts expose `ctx.source` and `ctx.target` entity refs. Client-originated
commands and streams use the sending PeerEntity as `source`.

## Generated Core

The core package contains:

- generated protocol, manifest, command, event, stream, entity, and registry files under
  `src/generated/`
- user endpoint handlers under `src/logic/server/` and `src/logic/client/`
- user systems under `src/systems/server/` and `src/systems/client/`
- assembled world factories in `src/create-server.ts` and `src/create-client.ts`

Application code uses generated facades:

```ts
const playerEntity = entities.Player.first(clientWorld);
if (playerEntity === undefined) throw new Error("Player is not replicated yet");

commands.Player.Move(clientWorld, playerEntity, { dx: 1, dy: 0 });
streams.Player.MoveStream(clientWorld, playerEntity, { dx: 1, dy: 0 }, clientTick, dtMs);

events.Player.MoveDisabled.broadcast(serverWorld, playerEntity, { disabled: true });
events.Player.MoveDisabled.sendTo(serverWorld, peerEntity, playerEntity, { disabled: true });
```

The app and node packages supply platform concerns: WebSocket transports, tick loops, input,
and rendering. They do not own protocol definitions or gameplay RPC logic.
