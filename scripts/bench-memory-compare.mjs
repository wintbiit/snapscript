import { copyFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** @typedef {{scenario:string, entities:number, storage:string, buildHeapMedianBytes:number, buildHeapP95Bytes:number, buildRssMedianBytes:number, buildRssP95Bytes:number, encodeHeapMedianBytes:number, encodeHeapP95Bytes:number, encodeRssMedianBytes:number, encodeRssP95Bytes:number, samples:number, iterations:number, warmup:number, clamped: {buildHeap:number, buildRss:number, encodeHeap:number, encodeRss:number}}} MemorySummary */

function parseArgs() {
  const args = process.argv.slice(2);
  const values = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--soa" || arg === "--main") {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      values.set(arg, next);
      i += 1;
    }
    if (arg === "--test-file") {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      values.set(arg, next);
      i += 1;
    }
  }
  const soa = values.get("--soa") ?? process.cwd();
  const main = values.get("--main");
  if (main === undefined) {
    throw new Error("Missing required --main workspace path");
  }
  return {
    soa: resolve(soa),
    main: resolve(main),
    testFile: values.get("--test-file") ?? "test/benchmark-memory.test.ts",
  };
}

function parseMemorySummaries(output) {
  const lines = output.split(/\r?\n/);
  const marker = /^\[memory-summary\]\s+(\{.*\})$/;
  const rows = [];
  for (const line of lines) {
    const match = line.match(marker);
    if (match === null || match[1] === undefined) {
      continue;
    }
    try {
      /** @type {MemorySummary} */
      const row = JSON.parse(match[1]);
      if (typeof row.entities !== "number" || typeof row.storage !== "string") {
        continue;
      }
      rows.push(row);
    } catch (_error) {
      continue;
    }
  }
  return rows;
}

function keyFor(row) {
  return `${row.storage}|${row.entities}|${row.scenario}`;
}

function clampPercent(delta, base) {
  if (base === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (delta / base) * 100;
}

function formatKib(value) {
  return `${Math.round(value / 1024)} KiB`;
}

function formatDelta(delta, base) {
  if (!Number.isFinite(delta)) {
    return "n/a";
  }
  const sign = delta >= 0 ? "+" : "-";
  const absPercent = clampPercent(Math.abs(delta), Math.abs(base));
  if (!Number.isFinite(absPercent)) {
    return `${sign}${formatKib(Math.abs(delta))}`;
  }
  return `${sign}${formatKib(Math.abs(delta))} (${sign}${absPercent.toFixed(1)}%)`;
}

function runWorkspace(name, cwd, sourceTestFile, fallbackTestFile) {
  if (!existsSync(cwd)) {
    throw new Error(`${name} workspace path not found: ${cwd}`);
  }

  const workspaceTestFile = resolve(cwd, sourceTestFile);
  let shouldRemove = false;
  if (!existsSync(workspaceTestFile) && fallbackTestFile !== undefined) {
    copyFileSync(fallbackTestFile, workspaceTestFile);
    shouldRemove = true;
  }

  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  const withGc = nodeOptions.includes("--expose-gc")
    ? nodeOptions
    : `${nodeOptions} --expose-gc`.trim();
  const env = {
    ...process.env,
    NODE_OPTIONS: withGc,
    BENCH_MEMORY_ITERATIONS: process.env.BENCH_MEMORY_ITERATIONS ?? "5",
    BENCH_MEMORY_WARMUP: process.env.BENCH_MEMORY_WARMUP ?? "2",
    BENCH_MEMORY_GC_ROUNDS: process.env.BENCH_MEMORY_GC_ROUNDS ?? "2",
  };

  const command = "pnpm exec vitest run test/benchmark-memory.test.ts --reporter=verbose";
  const isWindows = process.platform === "win32";
  const result = spawnSync(
    isWindows ? "cmd" : "pnpm",
    isWindows
      ? ["/d", "/c", command]
      : ["exec", "vitest", "run", "test/benchmark-memory.test.ts", "--reporter=verbose"],
    {
      cwd,
      env,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (shouldRemove) {
    try {
      // keep workspace clean after temporary injection
      rmSync(workspaceTestFile);
    } catch (_error) {
      // best-effort cleanup only
    }
  }

  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stderr.length > 0) {
    console.log(`--- ${name} stderr ---`);
    console.log(stderr.trim());
  }

  const rows = parseMemorySummaries(stdout);
  if (rows.length === 0) {
    throw new Error(`No memory-summary output found in ${name}`);
  }
  return { rows, stdout };
}

function buildIndex(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(keyFor(row), row);
  }
  return map;
}

function printRow(label, soaValue, mainValue) {
  const delta = soaValue - mainValue;
  const direction = delta <= 0 ? "better" : "worse";
  console.log(
    `${label}: main=${formatKib(mainValue)} soa=${formatKib(soaValue)} ` +
      `delta=${formatDelta(delta, mainValue)} => ${direction}`,
  );
}

function compare(soaRows, mainRows) {
  const soaMap = buildIndex(soaRows);
  const mainMap = buildIndex(mainRows);
  const keys = new Set([...soaMap.keys(), ...mainMap.keys()]);
  const ordered = [...keys].sort();

  let missingInSoa = 0;
  let missingInMain = 0;
  let matchedRows = 0;
  const buildHeapDeltas = [];
  const encodeHeapDeltas = [];
  const buildRssDeltas = [];
  const encodeRssDeltas = [];

  for (const key of ordered) {
    const mainRow = mainMap.get(key);
    const soaRow = soaMap.get(key);

    console.log("");
    console.log(`-- ${key} --`);

    if (soaRow === undefined) {
      console.log(`main only: ${mainRow?.entities} ${mainRow?.storage} ${mainRow?.scenario}`);
      missingInSoa += 1;
      continue;
    }
    if (mainRow === undefined) {
      console.log(`soa only: ${soaRow.entities} ${soaRow.storage} ${soaRow.scenario}`);
      missingInMain += 1;
      continue;
    }

    printRow("build.heap.p50", soaRow.buildHeapMedianBytes, mainRow.buildHeapMedianBytes);
    printRow("build.heap.p95", soaRow.buildHeapP95Bytes, mainRow.buildHeapP95Bytes);
    printRow("build.rss.p50", soaRow.buildRssMedianBytes, mainRow.buildRssMedianBytes);
    printRow("build.rss.p95", soaRow.buildRssP95Bytes, mainRow.buildRssP95Bytes);
    printRow("encode.heap.p50", soaRow.encodeHeapMedianBytes, mainRow.encodeHeapMedianBytes);
    printRow("encode.heap.p95", soaRow.encodeHeapP95Bytes, mainRow.encodeHeapP95Bytes);
    printRow("encode.rss.p50", soaRow.encodeRssMedianBytes, mainRow.encodeRssMedianBytes);
    printRow("encode.rss.p95", soaRow.encodeRssP95Bytes, mainRow.encodeRssP95Bytes);

    const buildHeapDelta = soaRow.buildHeapMedianBytes - mainRow.buildHeapMedianBytes;
    const encodeHeapDelta = soaRow.encodeHeapMedianBytes - mainRow.encodeHeapMedianBytes;
    const buildRssDelta = soaRow.buildRssMedianBytes - mainRow.buildRssMedianBytes;
    const encodeRssDelta = soaRow.encodeRssMedianBytes - mainRow.encodeRssMedianBytes;
    buildHeapDeltas.push({
      delta: buildHeapDelta,
      base: mainRow.buildHeapMedianBytes,
    });
    encodeHeapDeltas.push({
      delta: encodeHeapDelta,
      base: mainRow.encodeHeapMedianBytes,
    });
    buildRssDeltas.push({
      delta: buildRssDelta,
      base: mainRow.buildRssMedianBytes,
    });
    encodeRssDeltas.push({
      delta: encodeRssDelta,
      base: mainRow.encodeRssMedianBytes,
    });
    matchedRows += 1;

    console.log(
      `metadata: samples=${soaRow.samples}/${mainRow.samples}, warmup=${soaRow.warmup}/${mainRow.warmup}, ` +
        `iterations=${soaRow.iterations}/${mainRow.iterations}, clamped-build=${soaRow.clamped.buildHeap}/${mainRow.clamped.buildHeap}`,
    );
  }

  if (ordered.length > 0) {
    const buildHeapSumDelta = buildHeapDeltas.reduce((sum, entry) => sum + entry.delta, 0);
    const encodeHeapSumDelta = encodeHeapDeltas.reduce((sum, entry) => sum + entry.delta, 0);
    const buildRssSumDelta = buildRssDeltas.reduce((sum, entry) => sum + entry.delta, 0);
    const encodeRssSumDelta = encodeRssDeltas.reduce((sum, entry) => sum + entry.delta, 0);
    const buildHeapMeanPercent = buildHeapDeltas
      .filter((entry) => entry.base !== 0)
      .reduce((sum, entry) => sum + (entry.delta / entry.base) * 100, 0) /
      Math.max(1, buildHeapDeltas.filter((entry) => entry.base !== 0).length);
    const encodeHeapMeanPercent = encodeHeapDeltas
      .filter((entry) => entry.base !== 0)
      .reduce((sum, entry) => sum + (entry.delta / entry.base) * 100, 0) /
      Math.max(1, encodeHeapDeltas.filter((entry) => entry.base !== 0).length);
    const buildRssMeanPercent = buildRssDeltas
      .filter((entry) => entry.base !== 0)
      .reduce((sum, entry) => sum + (entry.delta / entry.base) * 100, 0) /
      Math.max(1, buildRssDeltas.filter((entry) => entry.base !== 0).length);
    const encodeRssMeanPercent = encodeRssDeltas
      .filter((entry) => entry.base !== 0)
      .reduce((sum, entry) => sum + (entry.delta / entry.base) * 100, 0) /
      Math.max(1, encodeRssDeltas.filter((entry) => entry.base !== 0).length);

    console.log("");
    console.log("aggregate delta (sum of medians)");
    console.log(`build.heap.p50 total: ${formatKib(buildHeapSumDelta)} (${buildHeapMeanPercent.toFixed(2)}% avg from main)`);
    console.log(`encode.heap.p50 total: ${formatKib(encodeHeapSumDelta)} (${encodeHeapMeanPercent.toFixed(2)}% avg from main)`);
    console.log(`build.rss.p50 total: ${formatKib(buildRssSumDelta)} (${buildRssMeanPercent.toFixed(2)}% avg from main)`);
    console.log(`encode.rss.p50 total: ${formatKib(encodeRssSumDelta)} (${encodeRssMeanPercent.toFixed(2)}% avg from main)`);
  }
  console.log(`\nscenarios: ${ordered.length}, matched: ${matchedRows}, missingMain: ${missingInMain}, missingSoa: ${missingInSoa}`);
}

function main() {
  const { soa, main, testFile } = parseArgs();
  console.log(`[bench-compare] SOA workspace: ${soa}`);
  console.log(`[bench-compare] Main workspace: ${main}`);
  const testFileInSoa = resolve(soa, testFile);
  const testFileExistsInSoa = existsSync(testFileInSoa);
  if (!testFileExistsInSoa) {
    throw new Error(`Test file not found in SOA workspace: ${testFileInSoa}`);
  }
  const soaRun = runWorkspace("SOA", soa, testFile, undefined);
  const mainRun = runWorkspace("main", main, testFile, testFileInSoa);
  compare(soaRun.rows, mainRun.rows);
}

main();
