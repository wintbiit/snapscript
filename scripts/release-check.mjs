import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirs = {
  snapscript: join(rootDir, "packages", "snapscript"),
  "snapscript-cli": join(rootDir, "packages", "snapscript-cli"),
  "create-snapscript": join(rootDir, "packages", "create-snapscript"),
};
const childEnv = cleanNpmEnv();

const packOnly = process.argv.includes("--pack-only");

function main() {
  if (packOnly) {
    for (const packageDir of Object.values(packageDirs)) {
      packDryRun(packageDir);
    }
    return;
  }

  run("pnpm", ["build"], rootDir);
  run("pnpm", ["typecheck"], rootDir);
  run("pnpm", ["test"], rootDir);
  run("pnpm", ["test:examples"], rootDir);

  const tempDir = mkdtempSync(join(tmpdir(), "snapscript-release-"));
  try {
    const tarballs = packTarballs(tempDir);
    smokeInstall(tempDir, tarballs);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function packDryRun(packageDir) {
  const files = pack(packageDir, ["--dry-run", "--json"])[0]?.files ?? [];
  const paths = new Set(files.map((file) => file.path));
  const packageName = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).name;
  if (!paths.has("README.md")) {
    throw new Error(`${packageName} tarball is missing README.md`);
  }
  if (!paths.has("LICENSE")) {
    throw new Error(`${packageName} tarball is missing LICENSE`);
  }
  const manifest = readFileSync(join(packageDir, "package.json"), "utf8");
  if (manifest.includes("workspace:")) {
    throw new Error(`${packageName} package.json contains workspace: dependency`);
  }
  console.log(`pack dry-run OK ${packageName}`);
}

function packTarballs(destination) {
  const tarballs = {};
  for (const [packageName, packageDir] of Object.entries(packageDirs)) {
    packDryRun(packageDir);
    const packed = pack(packageDir, ["--json", "--pack-destination", posixPath(destination)])[0];
    if (packed === undefined) throw new Error(`npm pack returned no result for ${packageName}`);
    tarballs[packageName] = join(destination, packed.filename);
  }
  return tarballs;
}

function smokeInstall(tempDir, tarballs) {
  const smokeDir = join(tempDir, "consumer");
  writeFileSync(
    join(tempDir, "schema.snap"),
    `syntax = "v1"

component MatchState {
  phase: u8(0)
}

world {
  state: MatchState
  command StartGame() reliable
  event GameStarted() reliable
}
`,
  );
  writeFileSync(
    join(tempDir, "package.json"),
    `${JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        snapscript: fileSpec(tarballs.snapscript),
        "snapscript-cli": fileSpec(tarballs["snapscript-cli"]),
        "create-snapscript": fileSpec(tarballs["create-snapscript"]),
      },
    }, null, 2)}\n`,
  );

  run("npm", ["install", "--ignore-scripts"], tempDir);
  run("node", ["-e", "import('snapscript').then((m) => { if (typeof m.createServerWorld !== 'function') throw new Error('missing createServerWorld'); })"], tempDir);
  run("npx", ["snapscript", "check", "schema.snap"], tempDir);
  run("npx", ["snapscript", "generate", "schema.snap", "--out", "generated"], tempDir);
  run("npx", ["create-snapscript", "consumer"], tempDir);

  const generatedPackagePath = join(smokeDir, "package.json");
  const generatedPackage = JSON.parse(readFileSync(generatedPackagePath, "utf8"));
  generatedPackage.dependencies.snapscript = fileSpec(tarballs.snapscript);
  generatedPackage.devDependencies["snapscript-cli"] = fileSpec(tarballs["snapscript-cli"]);
  writeFileSync(generatedPackagePath, `${JSON.stringify(generatedPackage, null, 2)}\n`);

  run("pnpm", ["install"], smokeDir);
  run("pnpm", ["build"], smokeDir);
}

function pack(packageDir, args) {
  const invocation = commandInvocation("npm", ["pack", ...args]);
  const output = execFileSync(invocation.file, invocation.args, {
    cwd: packageDir,
    encoding: "utf8",
    env: childEnv,
  });
  return JSON.parse(output);
}

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function fileSpec(path) {
  return `file:${posixPath(path)}`;
}

function posixPath(path) {
  return path.replaceAll("\\", "/");
}

function commandInvocation(command, args) {
  if (process.platform !== "win32" || (command !== "npm" && command !== "npx" && command !== "pnpm")) {
    return { file: command, args };
  }
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args.map(quoteCmdArg)].join(" ")],
  };
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function cleanNpmEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_config_")) {
      delete env[key];
    }
  }
  return env;
}

main();
