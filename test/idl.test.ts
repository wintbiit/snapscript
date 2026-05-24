import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSnap, generateSnap } from "../packages/snapscript-cli/src/idl/index";

describe("snap idl", () => {
  it("checks and generates the example protocol", () => {
    const source = readFileSync("examples/protocol/example.snap", "utf8");
    const files = generateSnap(source, {
      inputPath: "examples/protocol/example.snap",
      lockPath: join(tmpdir(), `snapscript-${Date.now()}-example.lock.json`),
    });
    const protocol = files.find((file) => file.path.endsWith("protocol.ts"))?.content ?? "";
    const manifest = JSON.parse(files.find((file) => file.path.endsWith("manifest.json"))!.content) as {
      readonly components: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
      readonly commands: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
      readonly events: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
    };

    expect(checkSnap(source).syntax).toBe("v1");
    expect(protocol).toContain('defineComponent("Position"');
    expect(protocol).toContain("hidden: bool(false)");
    expect(protocol).toContain('defineCommand("Movement.Move"');
    expect(protocol).toContain('defineEvent("Movement.MoveDisabled"');
    expect(protocol).toContain("sendTo(world: HostWorld, peerId: PeerId");
    expect(manifest.components.Position!.fields).toEqual({ x: 0, y: 1, hidden: 2 });
    expect(manifest.commands["Movement.Move"]!.fields).toEqual({ dx: 0, dy: 1 });
    expect(manifest.events["Movement.MoveDisabled"]!.fields).toEqual({ disabled: 0 });
  });

  it("keeps field ids stable through lock files", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapscript-idl-"));
    try {
      const lockPath = join(dir, "snapscript.lock.json");
      const inputPath = join(dir, "schema.snap");
      const first = `syntax = "v1"
component Stats {
  a: u8(0)
  b: u8(0)
}
`;
      const reordered = `syntax = "v1"
component Stats {
  b: u8(0)
  a: u8(0)
  c: u8(0)
}
`;
      generateSnap(first, { inputPath, lockPath, write: true });
      generateSnap(reordered, { inputPath, lockPath, write: true });
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        readonly components: Record<string, { readonly fields: Record<string, number> }>;
      };

      expect(lock.components.Stats!.fields).toEqual({ a: 0, b: 1, c: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports schema authoring errors clearly", () => {
    expect(() => checkSnap('syntax = "v1"\ncomponent A { bad: missing(0) }\n')).toThrow(
      /unknown field type "missing"/,
    );
    expect(() => checkSnap('syntax = "v1"\nstruct A { A }\ncomponent C { A }\n')).toThrow(
      /Recursive struct use/,
    );
    expect(() => checkSnap('syntax = "v1"\ncomponent A {}\ncomponent A {}\n')).toThrow(
      /Duplicate definition "A"/,
    );
    expect(() => checkSnap('syntax = "v1"\nservice S { event Done(ok: bool) ordered }\n')).toThrow();
  });
});
