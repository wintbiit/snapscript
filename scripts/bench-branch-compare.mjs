import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** @typedef {{name:string, entities:number, rows?:number, bytes?:number, medianMs:number, minMs:number, maxMs:number, samples:number, iterations:number}} BranchBenchRow */

function parseArgs() {
  const args = process.argv.slice(2);
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--soa" || arg === "--main" || arg === "--test-file") {
      const next = args[index + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      values.set(arg, next);
      index += 1;
    }
  }

  const main = values.get("--main");
  if (main === undefined) {
    throw new Error("Missing required --main workspace path");
  }

  return {
    soa: resolve(values.get("--soa") ?? process.cwd()),
    main: resolve(main),
    testFile: values.get("--test-file") ?? "test/benchmark-branch-compare.test.ts",
  };
}

function parseRows(output) {
  const rows = [];
  const marker = /^\[branch-bench-summary\]\s+(\{.*\})$/;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(marker);
    if (match === null || match[1] === undefined) {
      continue;
    }
    try {
      /** @type {BranchBenchRow} */
      const row = JSON.parse(match[1]);
      if (typeof row.name === "string" && typeof row.medianMs === "number") {
        rows.push(row);
      }
    } catch (_error) {
      // Ignore non-summary lines from the test reporter.
    }
  }
  return rows;
}

function keyFor(row) {
  return `${row.name}|${row.entities}`;
}

function run(command, cwd, env = process.env) {
  const isWindows = process.platform === "win32";
  const result = spawnSync(
    isWindows ? "cmd" : "sh",
    isWindows ? ["/d", "/c", command] : ["-lc", command],
    {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed in ${cwd}: ${command}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function prepareWorkspace(name, cwd, testFile, sourceTestFile) {
  if (!existsSync(cwd)) {
    throw new Error(`${name} workspace path not found: ${cwd}`);
  }

  const packagePath = resolve(cwd, "package.json");
  const lockPath = resolve(cwd, "pnpm-lock.yaml");
  const originalPackage = readFileSync(packagePath, "utf8");
  const originalLock = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : undefined;

  const workspaceTestFile = resolve(cwd, testFile);
  const shouldRemoveTestFile = !existsSync(workspaceTestFile);
  if (shouldRemoveTestFile) {
    copyFileSync(sourceTestFile, workspaceTestFile);
  }

  const packageJson = JSON.parse(originalPackage);
  const hasTinybench =
    packageJson.devDependencies !== undefined &&
    Object.prototype.hasOwnProperty.call(packageJson.devDependencies, "tinybench");
  if (!hasTinybench) {
    run("pnpm add -Dw tinybench@2.9.0", cwd);
  }

  return () => {
    if (shouldRemoveTestFile) {
      rmSync(workspaceTestFile, { force: true });
    }
    writeFileSync(packagePath, originalPackage);
    if (originalLock !== undefined) {
      writeFileSync(lockPath, originalLock);
    }
  };
}

function runWorkspace(name, cwd, testFile) {
  console.log(`[bench-compare] running ${name}: ${cwd}`);
  const env = {
    ...process.env,
    BENCH_TIME_MS: process.env.BENCH_TIME_MS ?? "20",
    BENCH_WARMUP_TIME_MS: process.env.BENCH_WARMUP_TIME_MS ?? "5",
  };
  const output = run(`pnpm exec vitest run ${testFile} --reporter=verbose`, cwd, env);
  const rows = parseRows(output);
  if (rows.length === 0) {
    throw new Error(`No branch-bench-summary output found in ${name}`);
  }
  return rows;
}

function formatMs(value) {
  return `${value.toFixed(value < 1 ? 3 : 2)} ms`;
}

function formatPercent(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function compare(soaRows, mainRows) {
  const soaMap = new Map(soaRows.map((row) => [keyFor(row), row]));
  const mainMap = new Map(mainRows.map((row) => [keyFor(row), row]));
  const keys = [...new Set([...soaMap.keys(), ...mainMap.keys()])].sort();
  const matched = [];

  for (const key of keys) {
    const main = mainMap.get(key);
    const soa = soaMap.get(key);
    if (main === undefined || soa === undefined) {
      console.log(`${key}: ${main === undefined ? "SOA only" : "main only"}`);
      continue;
    }

    const delta = soa.medianMs - main.medianMs;
    const percent = main.medianMs === 0 ? Number.NaN : (delta / main.medianMs) * 100;
    const speedup = soa.medianMs === 0 ? Number.POSITIVE_INFINITY : main.medianMs / soa.medianMs;
    matched.push({ key, main, soa, percent, speedup });
    console.log(
      `${key}: main=${formatMs(main.medianMs)} soa=${formatMs(soa.medianMs)} ` +
        `delta=${formatPercent(percent)} speedup=${speedup.toFixed(2)}x ` +
        `samples=${soa.samples}/${main.samples}`,
    );
  }

  const finite = matched.filter((row) => Number.isFinite(row.percent));
  const improved = finite.filter((row) => row.percent < 0).length;
  const regressed = finite.filter((row) => row.percent > 0).length;
  const meanPercent =
    finite.reduce((sum, row) => sum + row.percent, 0) / Math.max(1, finite.length);
  const geometricSpeedup = Math.exp(
    finite.reduce((sum, row) => sum + Math.log(row.speedup), 0) / Math.max(1, finite.length),
  );

  console.log("");
  console.log(
    `matched=${matched.length} improved=${improved} regressed=${regressed} ` +
      `meanDelta=${formatPercent(meanPercent)} geometricSpeedup=${geometricSpeedup.toFixed(2)}x`,
  );
}

function main() {
  const { soa, main: mainWorkspace, testFile } = parseArgs();
  const sourceTestFile = resolve(soa, testFile);
  if (!existsSync(sourceTestFile)) {
    throw new Error(`SOA benchmark test file not found: ${sourceTestFile}`);
  }

  const cleanupSoa = prepareWorkspace("SOA", soa, testFile, sourceTestFile);
  const cleanupMain = prepareWorkspace("main", mainWorkspace, testFile, sourceTestFile);
  try {
    const soaRows = runWorkspace("SOA", soa, testFile);
    const mainRows = runWorkspace("main", mainWorkspace, testFile);
    compare(soaRows, mainRows);
  } finally {
    cleanupMain();
    cleanupSoa();
  }
}

main();
