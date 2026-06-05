import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSnap, generateSnap, generateSnapFile } from "../packages/snapscript-cli/src/idl/index";

describe("snap idl", () => {
  it("checks and generates the example protocol", () => {
    const source = readFileSync("examples/protocol/game.snap", "utf8");
    const files = generateSnap(source, {
      inputPath: "examples/protocol/game.snap",
    });
    const protocol = files.find((file) => file.path.endsWith("protocol.ts"))?.content ?? "";
    const manifest = JSON.parse(files.find((file) => file.path.endsWith("manifest.json"))!.content) as {
      readonly components: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
      readonly endpoints: Record<string, { readonly components: Record<string, string> }>;
      readonly commands: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
      readonly events: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
    };

    expect(checkSnap(source).syntax).toBe("v1");
    expect(protocol).toContain('defineComponent("Position"');
    expect(protocol).toContain('defineComponent("MatchState"');
    expect(protocol).toContain("hidden: bool(false)");
    expect(protocol).toContain('defineCommand("World.StartGame"');
    expect(protocol).toContain('defineCommand("Peer.Ready"');
    expect(protocol).toContain('defineCommand("Player.Move"');
    expect(protocol).toContain('defineEvent("Player.MoveDisabled"');
    expect(protocol).toContain('export const Peer = defineEntity("Peer", { peerState: PeerState, connectionInfo: ConnectionInfo }, { id: 0 });');
    expect(protocol).toContain("validateEndpointCtx(world, ctx");
    expect(protocol).toContain("return world.onCommand(PlayerMove, handler,");
    expect(protocol).toContain("return world.onEvent(PlayerMoveDisabled, handler,");
    expect(protocol).toContain("export const internal =");
    expect(protocol).not.toContain("export const rpc =");
    expect(protocol).toContain("export const protocolHash =");
    expect(protocol).toContain("sendTo(world: ServerWorld, targets: ReadonlyEntityRef | readonly ReadonlyEntityRef[]");
    expect(files.some((file) => file.path.endsWith("world.ts"))).toBe(false);
    expect(manifest.components.Position!.fields).toEqual({ x: 0, y: 1, hidden: 2 });
    expect(manifest.components.MatchState!.fields).toEqual({ phase: 0, timeLeftMs: 1 });
    expect(manifest.endpoints.World!.components).toEqual({ state: "MatchState" });
    expect(manifest.endpoints.Peer!.components).toEqual({ connectionInfo: "ConnectionInfo" });
    expect(manifest.commands["Player.Move"]!.fields).toEqual({ dx: 0, dy: 1 });
    expect(manifest.commands["Player.Move"]!.id).toBe(5);
    expect(manifest.events["Player.MoveDisabled"]!.fields).toEqual({ disabled: 0 });
    expect(manifest.events["Player.MoveDisabled"]!.id).toBe(6);
    expect(files.some((file) => file.path.endsWith("snapscript.lock.json"))).toBe(false);
  });

  it("generates imports, enums, strings, bytes, and arrays", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapscript-idl-"));
    try {
      writeFileSync(
        join(dir, "common.snap"),
        `syntax = "v1"
enum Team { red blue }
`,
      );
      writeFileSync(
        join(dir, "game.snap"),
        `syntax = "v1"
import "./common.snap"
component PlayerInfo {
  name: string(default: "", maxBytes: 32)
  blob: bytes(maxBytes: 16)
  scores: array(u16(0), maxItems: 4)
  team: Team(default: red)
}
`,
      );

      const files = generateSnapFile({ inputPath: join(dir, "game.snap") });
      const protocol = files.find((file) => file.path.endsWith("protocol.ts"))?.content ?? "";
      const manifest = JSON.parse(files.find((file) => file.path.endsWith("manifest.json"))!.content) as {
        readonly enums: Record<string, { readonly values: readonly string[] }>;
      };

      expect(protocol).toContain('export const TeamValues = ["red","blue"] as const;');
      expect(protocol).toContain('name: stringOf("", { maxBytes: 32 })');
      expect(protocol).toContain("blob: bytesOf(new Uint8Array(), { maxBytes: 16 })");
      expect(protocol).toContain("scores: arrayOf(u16(0), [], { maxItems: 4 })");
      expect(protocol).toContain('team: enumOf(TeamValues, "red")');
      expect(manifest.enums.Team!.values).toEqual(["red", "blue"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports duplicate and circular imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapscript-idl-"));
    try {
      writeFileSync(join(dir, "common.snap"), 'syntax = "v1"\ncomponent C { x: u8(0) }\n');
      writeFileSync(
        join(dir, "duplicate.snap"),
        'syntax = "v1"\nimport "./common.snap"\nimport "./common.snap"\n',
      );
      writeFileSync(join(dir, "a.snap"), 'syntax = "v1"\nimport "./b.snap"\n');
      writeFileSync(join(dir, "b.snap"), 'syntax = "v1"\nimport "./a.snap"\n');

      expect(() => generateSnapFile({ inputPath: join(dir, "duplicate.snap") })).toThrow(/Duplicate .snap import/);
      expect(() => generateSnapFile({ inputPath: join(dir, "a.snap") })).toThrow(/Circular .snap import/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes protocol hash when schema order changes", () => {
    const first = generateSnap('syntax = "v1"\ncomponent A { x: u8(0) }\n', { inputPath: "a.snap" })
      .find((file) => file.path.endsWith("protocol.ts"))!.content;
    const second = generateSnap('syntax = "v1"\ncomponent A { y: u8(0) }\n', { inputPath: "a.snap" })
      .find((file) => file.path.endsWith("protocol.ts"))!.content;

    expect(first.match(/protocolHash = "([^"]+)"/)?.[1]).not.toBe(second.match(/protocolHash = "([^"]+)"/)?.[1]);
  });

  it("changes protocol hash when field type options change", () => {
    const first = generateSnap('syntax = "v1"\ncomponent A { name: string(default: "", maxBytes: 8) }\n', { inputPath: "a.snap" })
      .find((file) => file.path.endsWith("protocol.ts"))!.content;
    const second = generateSnap('syntax = "v1"\ncomponent A { name: string(default: "", maxBytes: 16) }\n', { inputPath: "a.snap" })
      .find((file) => file.path.endsWith("protocol.ts"))!.content;

    expect(first.match(/protocolHash = "([^"]+)"/)?.[1]).not.toBe(second.match(/protocolHash = "([^"]+)"/)?.[1]);
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
world {
  other: Other
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
      readonly endpoints: Record<string, { readonly components: Record<string, string> }>;
    };
    const reorderedManifest = JSON.parse(
      generateSnap(reordered, { inputPath: "schema.snap" }).find((file) => file.path.endsWith("manifest.json"))!
        .content,
    ) as {
      readonly components: Record<string, { readonly id: number; readonly fields: Record<string, number> }>;
    };

    expect(firstManifest.components.Stats).toMatchObject({ id: 1, fields: { a: 0, b: 1 } });
    expect(firstManifest.components.Other).toMatchObject({ id: 2, fields: { c: 0 } });
    expect(firstManifest.endpoints.World!.components).toEqual({ other: "Other" });
    expect(reorderedManifest.components.Stats).toMatchObject({ id: 1, fields: { b: 0, a: 1, c: 2 } });
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
    expect(() => checkSnap('syntax = "v1"\nworld { a: A }\n')).toThrow(/unknown component "A"/);
    expect(() => checkSnap('syntax = "v1"\nservice S { event Done(ok: bool) ordered }\n')).toThrow();
  });
});
