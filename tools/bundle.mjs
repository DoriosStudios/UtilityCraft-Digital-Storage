import { build } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  absWorkingDir: projectRoot,
  entryPoints: ["BP/scripts/main.js"],
  outfile: "dist/scripts/main.js",
  bundle: true,
  format: "esm",
  target: "es2020",
  logLevel: "warning",
  preserveSymlinks: true,
  alias: {
    DoriosCore: "./BP/scripts/DoriosCore",
    DoriosLib: "./BP/scripts/DoriosLib",
    Config: "./BP/scripts/Config",
    Machinery: "./BP/scripts/Machinery",
    DigitalStorageCore: "./BP/scripts/DigitalStorageCore",
  },
  external: [
    "@minecraft/server",
    "@minecraft/server-ui",
    "@minecraft/server-*",
    "@minecraft/common",
    "@minecraft/debug-utilities",
  ],
});

console.log("Bundled BP/scripts/main.js -> dist/scripts/main.js");
