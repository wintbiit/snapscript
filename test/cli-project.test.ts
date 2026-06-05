import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "../packages/create-snapscript/src/project";
import { generateProject } from "../packages/snapscript-cli/src/project";

const schema = `syntax = "v1"
component Position {
  x: qf32(min: -10, max: 10, precision: 0.01, default: 0)
  y: qf32(min: -10, max: 10, precision: 0.01, default: 0)
  hidden: bool(default: false)
}
component Health {
  hp: u16(100)
}
component MatchState {
  phase: u8(0)
}
world {
  state: MatchState
}
struct MoveInput {
  dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)
  dy: qf32(min: -1, max: 1, precision: 0.01, default: 0)
}
entity Player {
  position: Position
  health: Health

  command Move(input: MoveInput) unreliable
  event MoveDisabled(disabled: bool) reliable
}
`;

const genericSchema = `syntax = "v1"
component Score {
  value: u16(0)
}
`;

describe("snapscript project generation", () => {
  it("creates a platform-neutral core project", () => {
    usingTempDir((dir) => {
      const report = createProject({ cwd: dir, targetDir: "game-core" });
      const root = join(dir, "game-core");

      expect(readFileSync(join(root, "game.snap"), "utf8")).toContain('syntax = "v1"');
      expect(readFileSync(join(root, "README.md"), "utf8")).toContain("pnpm generate");
      expect(readFileSync(join(root, "README.md"), "utf8")).toContain("platform-neutral SnapScript game core");
      expect(readFileSync(join(root, "package.json"), "utf8")).toContain("snapscript generate game.snap --out src/generated");
      expect(readFileSync(join(root, "src/generated/register.ts"), "utf8")).toContain(
        'from "../logic/server/Player"',
      );
      expect(readFileSync(join(root, "src/generated/commands.ts"), "utf8")).toContain(
        "commands =",
      );
      expect(() => readFileSync(join(root, "src/generated/snapscript/protocol.ts"), "utf8")).toThrow();
      expect(() => readFileSync(join(root, "src/state.ts"), "utf8")).toThrow();
      expect(() => readFileSync(join(root, "src/transport/memory.ts"), "utf8")).toThrow();
      expect(readFileSync(join(root, "src/logic/server/Player.ts"), "utf8")).toContain(
        "export function Move",
      );
      expect(readFileSync(join(root, "src/generated/systems.server.ts"), "utf8")).toContain(
        'from "../systems/server/10-health.system"',
      );
      expect(report.some((item) => item.status === "created" && item.path.endsWith("game.snap"))).toBe(true);
    });
  });

  it("creates a generic project that references an external schema without copying it", () => {
    usingTempDir((dir) => {
      writeFileSync(join(dir, "external.snap"), genericSchema);
      createProject({ cwd: dir, targetDir: "core", schemaPath: "external.snap" });
      const packageJson = readFileSync(join(dir, "core", "package.json"), "utf8");
      const createServer = readFileSync(join(dir, "core", "src/create-server.ts"), "utf8");
      const readme = readFileSync(join(dir, "core", "README.md"), "utf8");
      const test = readFileSync(join(dir, "core", "test/roundtrip.test.ts"), "utf8");

      expect(packageJson).toContain("snapscript check ../external.snap");
      expect(packageJson).toContain("snapscript generate ../external.snap --out src/generated");
      expect(readme).toContain("../external.snap");
      expect(createServer).not.toContain("Player");
      expect(test).not.toContain("MovementMove");
      expect(() => readFileSync(join(dir, "core", "src/generated/snapscript/protocol.ts"), "utf8")).toThrow();
      expect(() => readFileSync(join(dir, "core", "game.snap"), "utf8")).toThrow();
    });
  });

  it("rejects non-empty or non-directory create targets", () => {
    usingTempDir((dir) => {
      mkdirSync(join(dir, "non-empty"));
      writeFileSync(join(dir, "non-empty/file.txt"), "");
      writeFileSync(join(dir, "file-target"), "");

      expect(() => createProject({ cwd: dir, targetDir: "non-empty" })).toThrow(/must be empty/);
      expect(() => createProject({ cwd: dir, targetDir: "file-target" })).toThrow(/not a directory/);
    });
  });

  it("keeps existing RPC stubs and reports stale files", () => {
    usingTempDir((dir) => {
      writeFileSync(join(dir, "game.snap"), schema);
      generateProject({ cwd: dir, schemaPath: "game.snap", outDir: "src/generated" });
      writeFileSync(join(dir, "src/logic/server/Player.ts"), "export function Move() {}\nexport function OldCommand() {}\n");

      const report = generateProject({ cwd: dir, schemaPath: "game.snap", outDir: "src/generated" });

      expect(readFileSync(join(dir, "src/logic/server/Player.ts"), "utf8")).toBe("export function Move() {}\nexport function OldCommand() {}\n");
      expect(report).toContainEqual({ status: "kept", path: "src/logic/server/Player.ts" });
      expect(report).toContainEqual({ status: "stale", path: "src/logic/server/Player.ts#OldCommand" });
    });
  });

  it("allows endpoint-scoped RPCs with the same local name", () => {
    usingTempDir((dir) => {
      writeFileSync(
        join(dir, "game.snap"),
        `syntax = "v1"
entity A {
  command Move(dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)) unreliable
}
entity B {
  command Move(dx: qf32(min: -1, max: 1, precision: 0.01, default: 0)) unreliable
}
`,
      );

      expect(() => generateProject({ cwd: dir, schemaPath: "game.snap" })).not.toThrow();
    });
  });

  it("rejects system files that do not export register", () => {
    usingTempDir((dir) => {
      writeFileSync(join(dir, "game.snap"), schema);
      generateProject({ cwd: dir, schemaPath: "game.snap", outDir: "src/generated" });
      mkdirSync(join(dir, "src/systems/server"), { recursive: true });
      writeFileSync(join(dir, "src/systems/server/20-bad.system.ts"), "export const nope = 1;\n");

      expect(() => generateProject({ cwd: dir, schemaPath: "game.snap", outDir: "src/generated" })).toThrow(
        /must export register/,
      );
    });
  });
});

function usingTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "snapscript-cli-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
