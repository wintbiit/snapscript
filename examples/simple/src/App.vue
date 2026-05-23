<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ClientPeer, HostPeer, type PeerSnapshot } from "./sync-demo";

type Mode = "home" | "host" | "client";

const mode = computed<Mode>(() => {
  if (window.location.pathname === "/host") {
    return "host";
  }
  if (window.location.pathname === "/client") {
    return "client";
  }
  return "home";
});

const host = mode.value === "host" ? new HostPeer() : undefined;
const client = mode.value === "client" ? new ClientPeer() : undefined;

const peerState = ref<PeerSnapshot>(
  host?.snapshot() ??
    client?.snapshot() ?? {
      connected: false,
      error: undefined,
      tick: 0,
      lastBytes: 0,
      lastEvent: undefined,
      player: undefined,
    },
);

const wsUrl = computed(() => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sync`;
});

const pageTitle = computed(() => {
  if (mode.value === "host") {
    return "Host";
  }
  if (mode.value === "client") {
    return "Client";
  }
  return "SnapScript Simple Sync";
});

let frame = 0;

function refresh() {
  host?.tick();
  client?.tick();
  peerState.value = host?.snapshot() ?? client?.snapshot() ?? peerState.value;
}

function animate() {
  refresh();
  frame = window.requestAnimationFrame(animate);
}

onMounted(() => {
  host?.connect(wsUrl.value);
  client?.connect(wsUrl.value);
  frame = window.requestAnimationFrame(animate);
});

onUnmounted(() => {
  window.cancelAnimationFrame(frame);
  host?.dispose();
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
        <p v-if="mode === 'home'">Open Host and Client in separate browser pages. The Vite dev server relays WebSocket packets between them.</p>
        <p v-else-if="mode === 'host'">Host world. Local NetRef writes produce dirty snapshots; client joins request a full snapshot.</p>
        <p v-else>Client world. Binary snapshots arrive over WebSocket and apply through the client world.</p>
      </div>
      <div class="endpoint">{{ wsUrl }}</div>
    </header>

    <section v-if="mode === 'home'" class="home">
      <a class="launch" href="/host" target="_blank" rel="noreferrer">
        <strong>Open Host</strong>
        <span>Controls authoritative state and sends snapshots.</span>
      </a>
      <a class="launch" href="/client" target="_blank" rel="noreferrer">
        <strong>Open Client</strong>
        <span>Receives binary snapshots in a separate page instance.</span>
      </a>
    </section>

    <section v-else class="grid single">
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>{{ mode === "host" ? "Host Instance" : "Client Instance" }}</h2>
            <p>{{ mode === "host" ? "Host Session" : "Client Session" }}</p>
          </div>
          <span :class="['status', peerState.connected ? 'online' : 'offline']">
            {{ peerState.connected ? "online" : "offline" }}
          </span>
        </div>

        <div v-if="peerState.error" class="error">{{ peerState.error }}</div>

        <div class="stats">
          <div><span>tick</span><strong>{{ peerState.tick }}</strong></div>
          <div><span>last packet</span><strong>{{ peerState.lastBytes }} B</strong></div>
          <div><span>last event</span><strong>{{ peerState.lastEvent ?? "--" }}</strong></div>
          <div><span>entity</span><strong>#{{ peerState.player?.id ?? "--" }}</strong></div>
          <div><span>hp</span><strong>{{ peerState.player?.hp ?? "--" }}</strong></div>
          <div><span>x</span><strong>{{ n(peerState.player?.x, 2) }}</strong></div>
          <div><span>y</span><strong>{{ n(peerState.player?.y, 2) }}</strong></div>
          <div><span>yaw</span><strong>{{ n(peerState.player?.yaw, 1) }}</strong></div>
          <div><span>dead</span><strong>{{ peerState.player?.dead ? "yes" : "no" }}</strong></div>
        </div>

        <div v-if="mode === 'client'" class="actions">
          <button @click="client?.damage()">Damage</button>
          <button @click="client?.heal()">Heal</button>
          <button @click="client?.move(-1, 0)">Left</button>
          <button @click="client?.move(1, 0)">Right</button>
          <button @click="client?.move(0, 1)">Up</button>
          <button @click="client?.rotate(15)">Rotate</button>
          <button @click="client?.requestFull()">Request Full</button>
        </div>

        <div v-else class="actions">
          <button @click="host?.sendFull()">Send Full</button>
        </div>

        <div class="mirror">
          <div
            class="avatar"
            :style="{
              transform: `translate(${(peerState.player?.x ?? 0) * 4}px, ${-(peerState.player?.y ?? 0) * 4}px) rotate(${peerState.player?.yaw ?? 0}deg)`,
              opacity: peerState.player?.dead ? 0.45 : 1,
            }"
          >
            <span></span>
          </div>
        </div>
      </article>
    </section>
  </main>
</template>
