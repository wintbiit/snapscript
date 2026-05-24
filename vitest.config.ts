import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      snapscript: new URL("./packages/snapscript/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
  },
});
