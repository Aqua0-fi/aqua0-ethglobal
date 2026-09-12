import { readFileSync, writeFileSync } from "node:fs";

// Generates subgraph.arc.yaml from the canonical Base manifest.
//
// Core sources (required): VaultFactory, VaultRegistry, Composer, FillerRegistry + PUBLIC_ARC_START_BLOCK.
// Optional sources are dropped when their address env is unset.
// Every source may override its start block with `<ADDRESS_ENV>_START_BLOCK`; otherwise PUBLIC_ARC_START_BLOCK applies.
//
// Base-carried sources are rewritten from subgraph.base.yaml. Arc-only sources are never in the Base manifest:
//   - `cloneOf`: a second data source cut from a Base-carried block (same ABI + mapping, unique name);
//   - `fragment`: appended from manifests/<fragment> ({{NAME}}, {{ADDRESS}}, {{START_BLOCK}}, {{VENUE}}).
// Aqua venue sources carry a `venue` data source context ("pegged" | "fxswap") that the mappings stamp on
// AquaVenueAdapter / AquaStrategy / AquaFill. `requires` names the source whose generated types the reused mapping
// imports, so it must be present too.
const ROUTER_FRAGMENT = "aqua-swapvm-router.arc.yaml";
const sources = [
  { name: "VaultFactory", env: "PUBLIC_ARC_VAULT_FACTORY", required: true },
  { name: "VaultRegistry", env: "PUBLIC_ARC_VAULT_REGISTRY", required: true },
  { name: "Composer", env: "PUBLIC_ARC_COMPOSER", required: true },
  { name: "FillerRegistry", env: "PUBLIC_ARC_FILLER_REGISTRY", required: true },
  { name: "AquaAdapter", env: "PUBLIC_ARC_AQUA_ADAPTER", venue: "pegged" },
  { name: "V4Adapter", env: "PUBLIC_ARC_V4_ADAPTER" },
  // Arc-only. Base does not index 1inch's shared router, and the FXSwap venue exists only on Arc.
  { name: "AquaSwapVMRouter", env: "PUBLIC_ARC_AQUA_SWAPVM_ROUTER", venue: "pegged", fragment: ROUTER_FRAGMENT },
  {
    name: "FXAquaAdapter",
    env: "PUBLIC_ARC_FX_AQUA_ADAPTER",
    venue: "fxswap",
    cloneOf: "AquaAdapter",
    requires: "AquaAdapter"
  },
  {
    name: "AquaFXSwapVMRouter",
    env: "PUBLIC_ARC_FXSWAP_ROUTER",
    venue: "fxswap",
    fragment: ROUTER_FRAGMENT,
    requires: "AquaSwapVMRouter"
  }
];
// Router data source -> the adapter whose strategies its fills link to.
const routerAdapters = [
  ["AquaSwapVMRouter", "AquaAdapter"],
  ["AquaFXSwapVMRouter", "FXAquaAdapter"]
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
const seenAddresses = new Map();
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
  // Two data sources on one address would process every event twice and collide on event-entity ids.
  const key = address.toLowerCase();
  if (seenAddresses.has(key)) fail(`${source.env} repeats the ${seenAddresses.get(key)} address ${address}`);
  seenAddresses.set(key, source.name);
  resolved.set(source.name, { address, startBlock: startOverride ?? coreStartBlock });
}

for (const source of sources) {
  if (source.requires && resolved.has(source.name) && !resolved.has(source.requires)) {
    const requiredEnv = sources.find((s) => s.name === source.requires).env;
    fail(`${source.env} reuses the ${source.requires} mapping and its generated types; set ${requiredEnv} too.`);
  }
}
for (const [router, adapter] of routerAdapters) {
  if (resolved.has(router) && !resolved.has(adapter)) {
    console.warn(`${router} is set without ${adapter}: its fills will be indexed but never linked to Aqua0 strategies.`);
  }
}

const baseManifest = readFileSync(new URL("../subgraph.base.yaml", import.meta.url), "utf8");
let manifest = baseManifest;

function sourceBlockRegex(name) {
  return new RegExp(
    `  - kind: ethereum/contract\\n    name: ${name}\\n[\\s\\S]*?(?=  - kind: ethereum/contract\\n    name:|templates:)`
  );
}

function venueContext(venue) {
  return `    context:\n      venue:\n        type: String\n        data: ${venue}\n`;
}

function retarget(block, target, venue) {
  let out = block
    .replace(/network: base/g, "network: arc-testnet")
    .replace(/address: "0x[a-fA-F0-9]{40}"/, `address: "${target.address}"`)
    .replace(/startBlock: [0-9]+/, `startBlock: ${target.startBlock}`);
  if (venue) out = out.replace("    network: arc-testnet\n", `    network: arc-testnet\n${venueContext(venue)}`);
  return out;
}

const arcOnlyBlocks = [];
for (const source of sources) {
  const target = resolved.get(source.name);

  if (source.fragment || source.cloneOf) {
    if (sourceBlockRegex(source.name).test(baseManifest)) {
      fail(`${source.name} is Arc-only and must not be declared in subgraph.base.yaml`);
    }
    if (!target) continue;
    if (source.fragment) {
      const fragment = readFileSync(new URL(`../manifests/${source.fragment}`, import.meta.url), "utf8");
      arcOnlyBlocks.push(
        fragment
          .replace(/\{\{NAME\}\}/g, source.name)
          .replace(/\{\{ADDRESS\}\}/g, target.address)
          .replace(/\{\{START_BLOCK\}\}/g, target.startBlock)
          .replace(/\{\{VENUE\}\}/g, source.venue)
      );
    } else {
      const match = baseManifest.match(sourceBlockRegex(source.cloneOf));
      if (!match) fail(`Could not find ${source.cloneOf} data source in subgraph.base.yaml to clone for ${source.name}`);
      arcOnlyBlocks.push(
        retarget(match[0], target, source.venue).replace(`    name: ${source.cloneOf}\n`, `    name: ${source.name}\n`)
      );
    }
    continue;
  }

  const re = sourceBlockRegex(source.name);
  const match = manifest.match(re);
  if (!match) fail(`Could not find ${source.name} data source in subgraph.base.yaml`);
  if (!target) {
    manifest = manifest.replace(re, "");
    continue;
  }
  manifest = manifest.replace(re, retarget(match[0], target, source.venue));
}

if (arcOnlyBlocks.length > 0) {
  if (!/\ntemplates:/.test(manifest)) fail("Could not find templates: section in subgraph.base.yaml");
  manifest = manifest.replace(/\ntemplates:/, `\n${arcOnlyBlocks.join("")}templates:`);
}

// Dynamic AssetVaults created by the Arc factory must be indexed on Arc too.
manifest = manifest.replace(/network: base/g, "network: arc-testnet");
// Keep the short-lived hackathon/testnet history intact; this also makes Arc deployments independent from the Base pruning policy.
manifest = manifest.replace("  prune: auto", "  prune: never");
writeFileSync(new URL("../subgraph.arc.yaml", import.meta.url), manifest);

const summary = sources
  .filter((s) => resolved.has(s.name))
  .map((s) => {
    const { address, startBlock } = resolved.get(s.name);
    return `  ${s.name} ${address} @ ${startBlock}${s.venue ? ` (venue ${s.venue})` : ""}`;
  });
const skipped = sources.filter((s) => !resolved.has(s.name)).map((s) => s.name);
console.log(
  "Wrote packages/subgraph/subgraph.arc.yaml for Arc testnet (network arc-testnet, chainId 5042002):\n" +
    summary.join("\n") +
    (skipped.length ? `\nSkipped undeployed optional data sources: ${skipped.join(", ")}.` : "")
);
