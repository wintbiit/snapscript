<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ClientDemo, HostDemo, protocol as snapProtocol, type DemoSnapshot } from "./ecs-demo";

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

const host = mode.value === "host" ? new HostDemo() : undefined;
const client = mode.value === "client" ? new ClientDemo() : undefined;

const emptySnapshot: DemoSnapshot = {
  connected: false,
  error: undefined,
  tick: 0,
  sent: 0,
  received: 0,
  lastChannel: undefined,
  lastEvent: undefined,
  entities: [],
  benchmark: "--",
};

const state = ref<DemoSnapshot>(host?.snapshot() ?? client?.snapshot() ?? emptySnapshot);
const manifest = snapProtocol.manifest();

const wsUrl = computed(() => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sync`;
});

let frame = 0;

function refresh() {
  host?.tick();
  client?.tick();
  state.value = host?.snapshot() ?? client?.snapshot() ?? state.value;
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

function n(value: number, digits = 2): string {
  return value.toFixed(digits);
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>SnapScript ECS</h1>
        <p v-if="mode === 'home'">Open host and client pages. The example uses component storage, queries, systems, RPC, named channels, and binary snapshots.</p>
        <p v-else-if="mode === 'host'">Authoritative ECS world. Systems update components, commands mutate NetRefs, dirty snapshots sync state.</p>
        <p v-else>Client ECS world. Controls send commands; local state only changes from host snapshots and events.</p>
      </div>
      <code>{{ wsUrl }}</code>
    </header>

    <section v-if="mode === 'home'" class="home">
      <a href="/host" target="_blank" rel="noreferrer">
        <strong>Host</strong>
        <span>Runs systems and authoritative state.</span>
      </a>
      <a href="/client" target="_blank" rel="noreferrer">
        <strong>Client</strong>
        <span>Sends commands and applies snapshots.</span>
      </a>
    </section>

    <section v-else class="layout">
      <article class="panel">
        <div class="panel-head">
          <div>
            <h2>{{ mode === "host" ? "Host Session" : "Client Session" }}</h2>
            <p>{{ state.entities.length }} query rows</p>
          </div>
          <span :class="['status', state.connected ? 'online' : 'offline']">
            {{ state.connected ? "online" : "offline" }}
          </span>
        </div>

        <div v-if="state.error" class="error">{{ state.error }}</div>

        <div class="stats">
          <div><span>tick</span><strong>{{ state.tick }}</strong></div>
          <div><span>last channel</span><strong>{{ state.lastChannel ?? "--" }}</strong></div>
          <div><span>sent</span><strong>{{ state.sent }} B</strong></div>
          <div><span>received</span><strong>{{ state.received }} B</strong></div>
          <div><span>last event</span><strong>{{ state.lastEvent ?? "--" }}</strong></div>
          <div><span>bench</span><strong>{{ state.benchmark }}</strong></div>
        </div>

        <div class="actions" v-if="mode === 'client'">
          <button @click="client?.move(-1, 0)">Left</button>
          <button @click="client?.move(1, 0)">Right</button>
          <button @click="client?.move(0, 1)">Up</button>
          <button @click="client?.move(0, -1)">Down</button>
          <button @click="client?.damage(1)">Damage #1</button>
          <button @click="client?.requestFull()">Full</button>
          <button @click="client?.runBenchmark()">Benchmark</button>
        </div>
        <div class="actions" v-else>
          <button @click="host?.runBenchmark()">Benchmark</button>
        </div>
      </article>

      <article class="panel playfield">
        <div
          v-for="entity in state.entities"
          :key="entity.id"
          class="entity"
          :class="{ dead: entity.dead }"
          :style="{ transform: `translate(${entity.x * 12}px, ${-entity.y * 12}px)` }"
        >
          <span>#{{ entity.id }}</span>
          <small>{{ entity.hp ?? "--" }}</small>
        </div>
      </article>

      <article class="panel manifest">
        <h2>Manifest</h2>
        <div>
          <strong>Components</strong>
          <p v-for="entry in manifest.components" :key="`c${entry.id}`">{{ entry.name }}: {{ entry.id }}</p>
        </div>
        <div>
          <strong>Commands</strong>
          <p v-for="entry in manifest.commands" :key="`cmd${entry.id}`">{{ entry.name }}: {{ entry.id }}</p>
        </div>
        <div>
          <strong>Events</strong>
          <p v-for="entry in manifest.events" :key="`evt${entry.id}`">{{ entry.name }}: {{ entry.id }}</p>
        </div>
      </article>
    </section>
  </main>
</template>
