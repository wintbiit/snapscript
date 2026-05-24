import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSnap, generateSnap } from "../packages/snapscript-cli/src/idl/index";

describe("snap idl", () => {
  it("checks and generates the example protocol", () => {
    const source = readFileSync("examples/protocol/game.snap", "utf8");
    const files = generateSnap(source, {
      inputPath: "examples/protocol/game.snap",
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
    expect(protocol).toContain("sendTo(world: ServerWorld, peerId: PeerId");
    expect(manifest.components.Position!.fields).toEqual({ x: 0, y: 1, hidden: 2 });
    expect(manifest.commands["Movement.Move"]!.fields).toEqual({ dx: 0, dy: 1 });
    expect(manifest.commands["Movement.Move"]!.id).toBe(1);
    expect(manifest.events["Movement.MoveDisabled"]!.fields).toEqual({ disabled: 0 });
    expect(manifest.events["Movement.MoveDisabled"]!.id).toBe(2);
    expect(files.some((file) => file.path.endsWith("snapscript.lock.json"))).toBe(false);
  });

  it("derives ids from declaration and field order", () => {
    const source = `syntax = "v1"
component Stats {
  a: u8(0)
  b: u8(0)
}
component Other {
  c: u8(0)
}
`;
    const reordered = `syntax = "v1"
component Stats {
  b: u8(0)
  a: u8(0)
  c: u8(0)
}
`;
    const firstManifest = JSON.parse(
      generateSnap(source, { inputPath: "schema.snap" }).find((file) => file.path.endsWith("manifest.json"))!.content,
    ) as {
      readonly components: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
    };
    const reorderedManifest = JSON.parse(
      generateSnap(reordered, { inputPath: "schema.snap" }).find((file) => file.path.endsWith("manifest.json"))!
        .content,
    ) as {
      readonly components: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
    };

    expect(firstManifest.components.Stats).toEqual({ id: 1, fields: { a: 0, b: 1 } });
    expect(firstManifest.components.Other).toEqual({ id: 2, fields: { c: 0 } });
    expect(reorderedManifest.components.Stats).toEqual({ id: 1, fields: { b: 0, a: 1, c: 2 } });
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
