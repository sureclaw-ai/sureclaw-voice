import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Plugin, transformWithOxc } from "vite";

// Vite plugin: compiles the TypeScript service worker (`src/sw.ts`) to plain JS,
// computes a content hash over the built JS/CSS in `dist/assets`, and writes the
// result to `dist/sw.js` with `__BUILD_HASH__` replaced by that hash.
//
// The SW lives in `src/` (so it is type-checked and authored in TS) rather than
// `public/`, which Vite would copy verbatim without transpiling. This plugin is
// what bridges that gap: oxc strips the types, then the same content hash that
// would have busted a `public/sw.js` cache is stamped in.
//
// Runs at the `writeBundle` hook so it fires after the app's assets are emitted.
export function serviceWorkerPlugin(): Plugin {
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    async writeBundle() {
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

      const srcPath = join(root, "src", "sw.ts");
      const { code } = await transformWithOxc(readFileSync(srcPath, "utf8"), srcPath, {
        lang: "ts",
      });
      const sw = code.replace(/__BUILD_HASH__/g, version);
      writeFileSync(join(outDir, "sw.js"), sw);
      console.log(`[service-worker] cache version: ${version}`);
    },
  };
}
