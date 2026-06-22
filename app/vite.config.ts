import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { swCacheVersionPlugin } from "./sw-cache-version";

export default defineConfig({
  // Relative asset URLs so the built dist/ can be served from any mount path
  // (the OpenClaw gateway serves it under /voice by default, not the site root).
  base: "./",
  plugins: [react(), swCacheVersionPlugin()],
});