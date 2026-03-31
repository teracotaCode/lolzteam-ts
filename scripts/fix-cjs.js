/**
 * Post-build script that writes a package.json with {"type":"commonjs"}
 * into dist/cjs/ so Node.js treats .js files there as CommonJS modules.
 *
 * This is required because the root package.json has "type": "module",
 * which makes Node.js treat all .js files as ESM by default.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cjsDir = join(__dirname, "..", "dist", "cjs");

mkdirSync(cjsDir, { recursive: true });

writeFileSync(
  join(cjsDir, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
);

console.log("✓ wrote dist/cjs/package.json with {\"type\":\"commonjs\"}");
