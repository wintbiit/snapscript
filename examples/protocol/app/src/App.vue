<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ClientPeer, ServerPeer, type PeerSnapshot } from "./protocol-app";

type Mode = "home" | "server" | "client";

const mode = computed<Mode>(() => {
  if (window.location.pathname === "/server") {
    return "server";
  }
  if (window.location.pathname === "/client") {
    return "client";
  }
  return "home";
});

const server = mode.value === "server" ? new ServerPeer() : undefined;
const client = mode.value === "client" ? new ClientPeer() : undefined;

const peerState = ref<PeerSnapshot>(
  server?.snapshot() ??
    client?.snapshot() ?? {
      connected: false,
      error: undefined,
      tick: 0,
      lastBytes: 0,
      lastEvent: undefined,
      myPeerId: undefined,
      player: undefined,
    },
);

const wsUrl = computed(() => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sync`;
});

const pageTitle = computed(() => {
  if (mode.value === "server") {
    return "Protocol Server";
  }
  if (mode.value === "client") {
    return "Protocol Client";
  }
  return "SnapScript Protocol Example";
});

let frame = 0;

function refresh() {
  server?.tick();
  client?.tick();
  peerState.value = server?.snapshot() ?? client?.snapshot() ?? peerState.value;
}

function animate() {
  refresh();
  frame = window.requestAnimationFrame(animate);
}

onMounted(() => {
  server?.connect(wsUrl.value);
  client?.connect(wsUrl.value);
  frame = window.requestAnimationFrame(animate);
});

onUnmounted(() => {
  window.cancelAnimationFrame(frame);
  server?.dispose();
  client?.dispose();
});

function n(value: number | undefined, digits = 0): string {
  return value === undefined ? "--" : value.toFixed(digits);
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>{{ pageTitle }}</h1>
        <p v-if="mode === 'home'">Open Server and Client in separate browser pages. The app package supplies WebSocket, clock, input, and rendering; the core package owns .snap, RPC handlers, and systems.</p>
        <p v-else-if="mode === 'server'">Server world created through the generated core package. Command handlers live under core/src/logic/server.</p>
        <p v-else>Client world created through the generated core package. Buttons send typed commands from generated protocol exports.</p>
      </div>
      <div class="endpoint">{{ wsUrl }}</div>
    </header>

    <section v-if="mode === 'home'" class="home">
      <a class="launch" href="/server" target="_blank" rel="noreferrer">
        <strong>Open Server</strong>
        <span>Runs authoritative world composition from the core package.</span>
      </a>
      <a class="launch" href="/client" target="_blank" rel="noreferrer">
        <strong>Open Client</strong>
        <span>Sends generated Player.Move commands and renders replicated state.</span>
      </a>
    </section>

    <section v-else class="grid single">
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>{{ mode === "server" ? "Server Instance" : "Client Instance" }}</h2>
            <p>{{ mode === "server" ? "Core authoritative world" : "Platform client bridge" }}</p>
          </div>
          <span :class="['status', peerState.connected ? 'online' : 'offline']">
            {{ peerState.connected ? "online" : "offline" }}
          </span>
        </div>

        <div v-if="peerState.error" class="error">{{ peerState.error }}</div>

        <div class="stats">
          <div><span>tick</span><strong>{{ peerState.tick }}</strong></div>
          <div><span>last packet</span><strong>{{ peerState.lastBytes }} B</strong></div>
          <div><span>peer id</span><strong>{{ peerState.myPeerId ?? "--" }}</strong></div>
          <div><span>last event</span><strong>{{ peerState.lastEvent ?? "--" }}</strong></div>
          <div><span>entity</span><strong>#{{ peerState.player?.id ?? "--" }}</strong></div>
          <div><span>hp</span><strong>{{ peerState.player?.hp ?? "--" }}</strong></div>
          <div><span>x</span><strong>{{ n(peerState.player?.x, 2) }}</strong></div>
          <div><span>y</span><strong>{{ n(peerState.player?.y, 2) }}</strong></div>
          <div><span>mine</span><strong>{{ peerState.player?.mine ? "yes" : "no" }}</strong></div>
          <div><span>hidden</span><strong>{{ peerState.player?.hidden ? "yes" : "no" }}</strong></div>
        </div>

        <div v-if="mode === 'client'" class="actions">
          <button @click="client?.move(-1, 0)">Left</button>
          <button @click="client?.move(1, 0)">Right</button>
          <button @click="client?.move(0, 1)">Up</button>
          <button @click="client?.move(0, -1)">Down</button>
          <button @click="client?.requestFull()">Request Full</button>
        </div>

        <div v-else class="actions">
          <button @click="server?.sendFull()">Send Full</button>
        </div>

        <div class="mirror">
          <div
            class="avatar"
            :style="{
              transform: `translate(${(peerState.player?.x ?? 0) * 18}px, ${-(peerState.player?.y ?? 0) * 18}px)`,
              opacity: peerState.player?.hidden ? 0.45 : 1,
            }"
          >
            <span></span>
          </div>
        </div>
      </article>
    </section>
  </main>
</template>
