import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceWorkerPlugin } from "./sw-plugin";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

export default defineConfig({
  // Relative asset URLs so the built dist/ can be served from any mount path
  // (the OpenClaw gateway serves it under /voice by default, not the site root).
  base: "./",
  define: {
    __PLUGIN_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), serviceWorkerPlugin()],
});
