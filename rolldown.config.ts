import { defineConfig } from "rolldown";

export default defineConfig({
  input: "index.ts",
  output: {
    file: "dist/index.js",
    format: "esm",
  },
  platform: "node",
  // Keep npm packages external (provided by host/installed separately);
  // bundle local relative imports.
  external: /^(?!\.\/|\.\.\/|\/).+/,
});