import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = fileURLToPath(new URL("../BP/scripts/", import.meta.url));
const excludedRoots = new Set(["DoriosCore", "DoriosLib"]);
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(scriptsRoot, path).replaceAll("\\", "/");
    const topDirectory = relativePath.split("/")[0];
    if (excludedRoots.has(topDirectory)) continue;
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (extname(entry.name) !== ".js") continue;

    const source = await readFile(path, "utf8");
    const imports = source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g);
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith("DoriosCore/") && specifier !== "DoriosCore/index.js") {
        violations.push(`${relativePath}: private DoriosCore subpath ${specifier}`);
      }
      if (/^(?:\.\.\/)+DoriosCore\//.test(specifier)) {
        violations.push(`${relativePath}: relative DoriosCore import ${specifier}`);
      }
    }
  }
}

await visit(scriptsRoot);

if (violations.length > 0) {
  console.error("Public import verification failed:\n" + violations.map((value) => `- ${value}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log('Verified: addon code imports DoriosCore only from "DoriosCore/index.js".');
}

