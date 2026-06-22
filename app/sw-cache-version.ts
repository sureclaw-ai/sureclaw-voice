import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

// Vite plugin: computes a content hash over the built JS/CSS in `dist/assets`
// and rewrites `__BUILD_HASH__` in the copied `public/sw.js` to that hash.
// This means the service-worker cache name always reflects the current build
// content — no manual version bump required.
//
// Runs at the `writeBundle` hook so it fires after assets are emitted and
// after `public/` is copied to `dist/`.
export function swCacheVersionPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "sw-cache-version",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      const assetsDir = join(outDir, "assets");
      const hash = createHash("sha1");
      const files = readdirSync(assetsDir).sort();
      for (const file of files) {
        const full = join(assetsDir, file);
        if (!statSync(full).isFile()) continue;
        hash.update(file).update("\0");
        hash.update(readFileSync(full));
      }
      const version = hash.digest("hex").slice(0, 12);
      const swPath = join(outDir, "sw.js");
      let sw = readFileSync(swPath, "utf8");
      sw = sw.replace(/__BUILD_HASH__/g, version);
      writeFileSync(swPath, sw);
      console.log(`[sw-cache-version] cache version: ${version}`);
    },
  };
}