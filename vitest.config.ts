import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      snapscript: new URL("./packages/snapscript/src/index.ts", import.meta.url).pathname,
      "snapscript-cli/project": new URL("./packages/snapscript-cli/src/project.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
  },
});
