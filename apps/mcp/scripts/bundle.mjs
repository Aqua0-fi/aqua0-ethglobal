// Bundles the MCP server and @aqua0/shared into one Node ESM file (dist/npm/aqua0-mcp.js) for the npm package.
// The Privy login page (built by packages/shared/scripts/build-login.mjs) is copied next to it, because privy.ts
// reads it from new URL("./login-page.js", import.meta.url), which resolves to the bundle's own directory.
import { build } from "esbuild";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const outdir = at("../dist/npm/");
const outfile = at("../dist/npm/aqua0-mcp.js");
const loginPage = at("../../../packages/shared/dist/login-page.js");

if (!existsSync(loginPage)) {
  throw new Error("packages/shared/dist/login-page.js is missing; run pnpm --filter @aqua0/shared build first");
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [at("../src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Bundled CommonJS dependencies call require() for Node built-ins, which an ESM file does not define.
  banner: { js: 'import { createRequire as __aqua0CreateRequire } from "node:module";\nconst require = __aqua0CreateRequire(import.meta.url);' },
  legalComments: "eof",
  logLevel: "warning"
});

copyFileSync(loginPage, at("../dist/npm/login-page.js"));
chmodSync(outfile, 0o755);

const kb = (file) => `${(statSync(file).size / 1024).toFixed(0)} KB`;
console.log(`bundled ${outfile} (${kb(outfile)}) and login-page.js (${kb(loginPage)})`);
