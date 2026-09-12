import { readFileSync, writeFileSync } from "node:fs";

// Generates subgraph.arc.yaml from the canonical Base manifest.
//
// Core sources (required): VaultFactory, VaultRegistry, Composer, FillerRegistry + PUBLIC_ARC_START_BLOCK.
// Optional sources are dropped when their address env is unset.
// Every source may override its start block with `<ADDRESS_ENV>_START_BLOCK`; otherwise PUBLIC_ARC_START_BLOCK applies.
const sources = [
  { name: "VaultFactory", env: "PUBLIC_ARC_VAULT_FACTORY", required: true },
  { name: "VaultRegistry", env: "PUBLIC_ARC_VAULT_REGISTRY", required: true },
  { name: "Composer", env: "PUBLIC_ARC_COMPOSER", required: true },
  { name: "FillerRegistry", env: "PUBLIC_ARC_FILLER_REGISTRY", required: true },
  { name: "AquaAdapter", env: "PUBLIC_ARC_AQUA_ADAPTER", required: false },
  { name: "AquaSwapVMRouter", env: "PUBLIC_ARC_AQUA_SWAPVM_ROUTER", required: false },
  { name: "V4Adapter", env: "PUBLIC_ARC_V4_ADAPTER", required: false }
];

const env = (name) => process.env[name]?.trim() || undefined;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const missing = [...sources.filter((s) => s.required).map((s) => s.env), "PUBLIC_ARC_START_BLOCK"].filter(
  (name) => !env(name)
);
if (missing.length > 0) {
  fail(
    `Missing Arc manifest environment variables: ${missing.join(", ")}.\n` +
      "Set the public Arc core deployment addresses and PUBLIC_ARC_START_BLOCK; adapter and router addresses are optional."
  );
}

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const blockPattern = /^[0-9]+$/;

const coreStartBlock = env("PUBLIC_ARC_START_BLOCK");
if (!blockPattern.test(coreStartBlock)) {
  fail(`PUBLIC_ARC_START_BLOCK must be a non-negative integer, received: ${coreStartBlock}`);
}

const resolved = new Map();
for (const source of sources) {
  const address = env(source.env);
  const startEnv = `${source.env}_START_BLOCK`;
  const startOverride = env(startEnv);
  if (!address) {
    if (startOverride) console.warn(`Ignoring ${startEnv}: ${source.env} is not set.`);
    continue;
  }
  if (!addressPattern.test(address)) {
    fail(`${source.env} for ${source.name} must be a 20-byte EVM address, received: ${address}`);
  }
  if (startOverride && !blockPattern.test(startOverride)) {
    fail(`${startEnv} must be a non-negative integer, received: ${startOverride}`);
  }
  resolved.set(source.name, { address, startBlock: startOverride ?? coreStartBlock });
}

if (resolved.has("AquaSwapVMRouter") && !resolved.has("AquaAdapter")) {
  console.warn(
    "PUBLIC_ARC_AQUA_SWAPVM_ROUTER is set without PUBLIC_ARC_AQUA_ADAPTER: fills will be indexed but never linked to Aqua0 strategies."
  );
}

let manifest = readFileSync(new URL("../subgraph.base.yaml", import.meta.url), "utf8");

function sourceBlockRegex(name) {
  return new RegExp(
    `  - kind: ethereum/contract\\n    name: ${name}\\n[\\s\\S]*?(?=  - kind: ethereum/contract\\n    name:|templates:)`
  );
}

for (const source of sources) {
  const re = sourceBlockRegex(source.name);
  const match = manifest.match(re);
  if (!match) fail(`Could not find ${source.name} data source in subgraph.base.yaml`);

  const target = resolved.get(source.name);
  if (!target) {
    manifest = manifest.replace(re, "");
    continue;
  }
  const block = match[0]
    .replace(/network: base/g, "network: arc-testnet")
    .replace(/address: "0x[a-fA-F0-9]{40}"/, `address: "${target.address}"`)
    .replace(/startBlock: [0-9]+/, `startBlock: ${target.startBlock}`);
  manifest = manifest.replace(re, block);
}

// Dynamic AssetVaults created by the Arc factory must be indexed on Arc too.
manifest = manifest.replace(/network: base/g, "network: arc-testnet");
// Keep the short-lived hackathon/testnet history intact; this also makes Arc deployments independent from the Base pruning policy.
manifest = manifest.replace("  prune: auto", "  prune: never");
writeFileSync(new URL("../subgraph.arc.yaml", import.meta.url), manifest);

const summary = [...resolved].map(([name, { address, startBlock }]) => `  ${name} ${address} @ ${startBlock}`);
const skipped = sources.filter((s) => !resolved.has(s.name)).map((s) => s.name);
console.log(
  "Wrote packages/subgraph/subgraph.arc.yaml for Arc testnet (network arc-testnet, chainId 5042002):\n" +
    summary.join("\n") +
    (skipped.length ? `\nSkipped undeployed optional data sources: ${skipped.join(", ")}.` : "")
);
