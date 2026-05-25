import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts", "src/project.ts"],
  format: ["esm"],
  external: ["eta", "snapscript-cli/project"],
  dts: true,
  clean: true,
  sourcemap: true,
});
