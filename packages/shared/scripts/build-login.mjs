// Bundles the Privy sign-in page (login/page.ts) into dist/login-page.js, served by startPrivyLogin.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("../login/page.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/login-page.js", import.meta.url)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "warning"
});
