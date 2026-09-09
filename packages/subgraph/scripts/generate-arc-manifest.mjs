import { readFileSync, writeFileSync } from "node:fs";

const required = [
  ["PUBLIC_ARC_VAULT_FACTORY", "VaultFactory"],
  ["PUBLIC_ARC_VAULT_REGISTRY", "VaultRegistry"],
  ["PUBLIC_ARC_COMPOSER", "Composer"],
  ["PUBLIC_ARC_FILLER_REGISTRY", "FillerRegistry"],
  ["PUBLIC_ARC_START_BLOCK", "start block"]
];
const optional = [
  ["PUBLIC_ARC_AQUA_ADAPTER", "AquaAdapter"],
  ["PUBLIC_ARC_V4_ADAPTER", "V4Adapter"]
];

const values = new Map();
const missing = [];
for (const [envName] of required) {
  const value = process.env[envName]?.trim();
  if (!value) missing.push(envName);
  else values.set(envName, value);
}
for (const [envName] of optional) {
  const value = process.env[envName]?.trim();
  if (value) values.set(envName, value);
}

if (missing.length > 0) {
  console.error(
    `Missing Arc manifest environment variables: ${missing.join(", ")}.\n` +
      "Set the public Arc core deployment addresses and PUBLIC_ARC_START_BLOCK; adapter addresses are optional until those deployments exist."
  );
  process.exit(1);
}

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
for (const [envName, label] of [...required.slice(0, 4), ...optional]) {
  const value = values.get(envName);
  if (value && !addressPattern.test(value)) {
    console.error(`${envName} for ${label} must be a 20-byte EVM address, received: ${value}`);
    process.exit(1);
  }
}
const startBlock = values.get("PUBLIC_ARC_START_BLOCK");
if (!/^[0-9]+$/.test(startBlock)) {
  console.error(`PUBLIC_ARC_START_BLOCK must be a non-negative integer, received: ${startBlock}`);
  process.exit(1);
}

let manifest = readFileSync(new URL("../subgraph.base.yaml", import.meta.url), "utf8");

const sources = [
  ["VaultFactory", "PUBLIC_ARC_VAULT_FACTORY"],
  ["VaultRegistry", "PUBLIC_ARC_VAULT_REGISTRY"],
  ["Composer", "PUBLIC_ARC_COMPOSER"],
  ["FillerRegistry", "PUBLIC_ARC_FILLER_REGISTRY"],
  ["AquaAdapter", "PUBLIC_ARC_AQUA_ADAPTER"],
  ["V4Adapter", "PUBLIC_ARC_V4_ADAPTER"]
];

function sourceBlockRegex(name) {
  return new RegExp(
    `  - kind: ethereum/contract\\n    name: ${name}\\n[\\s\\S]*?(?=  - kind: ethereum/contract\\n    name:|templates:)`
  );
}

for (const [name, envName] of sources) {
  const re = sourceBlockRegex(name);
  const match = manifest.match(re);
  if (!match) {
    console.error(`Could not find ${name} data source in subgraph.base.yaml`);
    process.exit(1);
  }
  const address = values.get(envName);
  if (!address) {
    manifest = manifest.replace(re, "");
    continue;
  }
  let block = match[0];
  block = block.replace(/network: base/g, "network: arc-testnet");
  block = block.replace(/address: "0x[a-fA-F0-9]{40}"/, `address: "${address}"`);
  block = block.replace(/startBlock: [0-9]+/, `startBlock: ${startBlock}`);
  manifest = manifest.replace(re, block);
}

// Dynamic AssetVaults created by the Arc factory must be indexed on Arc too.
manifest = manifest.replace(/network: base/g, "network: arc-testnet");
// Keep the short-lived hackathon/testnet history intact; this also makes Arc deployments independent from the Base pruning policy.
manifest = manifest.replace("  prune: auto", "  prune: never");
writeFileSync(new URL("../subgraph.arc.yaml", import.meta.url), manifest);

const skipped = optional.filter(([envName]) => !values.has(envName)).map(([, label]) => label);
console.log(
  `Wrote packages/subgraph/subgraph.arc.yaml for Arc testnet (chainId 5042002).` +
    (skipped.length ? ` Skipped undeployed optional data sources: ${skipped.join(", ")}.` : "")
);
