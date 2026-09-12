import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subgraphDir = path.resolve(__dirname, "..");
const eventsAbiPath = path.join(subgraphDir, "abis", "Events.json");
const manifestPath = path.join(subgraphDir, "subgraph.base.yaml");

const requiredEvents = [
  "PausedAll",
  "Paused",
  "Unpaused",
  "VaultWithdraw",
  "StrategyCommitmentSet",
  "StrategyCapitalSourced",
  "StrategyCapitalReturned",
  "StrategyDeployShortfall",
  "StrategyReturnLoss",
  "StrategyPrincipalSold",
  "StrategyFeeAccrued",
  "ClassPnLReported",
  "ClassGuardianVeto",
  "ClassClampHit",
  "ClassReconciliationMismatch",
  "ClassBridgeSettled",
  "ClassSettlementRequested",
  "ClassSettlementClaimed",
  "FrontLocked",
  "FrontCommitted",
  "FrontReleased",
  "FrontCancelled",
  "FrontAborted",
  "FrontObligationOpened",
  "FrontObligationSettled",
  "FrontObligationAborted",
  "FrontLandingUnderpaid",
  "FrontLandingCredited"
];

const abi = JSON.parse(fs.readFileSync(eventsAbiPath, "utf8"));
const manifest = fs.readFileSync(manifestPath, "utf8");

function eventSignature(event) {
  const inputs = event.inputs
    .map((input) => `${input.indexed ? "indexed " : ""}${input.type}`)
    .join(",");
  return `${event.name}(${inputs})`;
}

const abiEvents = new Map(
  abi.filter((item) => item.type === "event").map((event) => [event.name, event])
);

const missingFromAbi = [];
const missingFromManifest = [];

for (const name of requiredEvents) {
  const event = abiEvents.get(name);
  if (!event) {
    missingFromAbi.push(name);
    continue;
  }

  const signature = eventSignature(event);
  if (!manifest.includes(`- event: ${signature}`)) {
    missingFromManifest.push(signature);
  }
}

const assetVaultTemplateHasEventsAbi =
  /templates:[\s\S]*name:\s*AssetVault[\s\S]*abis:[\s\S]*-\s*name:\s*Events\s*\n\s*file:\s*\.\/abis\/Events\.json/.test(
    manifest
  );

// Aqua venue: adapter strategy lifecycle (Base manifest) and router fills (Arc-only router fragment, plus the
// generated Arc manifest when it declares the router) must stay wired to their source ABIs.
const arcRouterFragmentPath = path.join(subgraphDir, "manifests", "aqua-swapvm-router.arc.yaml");
const arcManifestPath = path.join(subgraphDir, "subgraph.arc.yaml");
const arcManifest = fs.existsSync(arcManifestPath) ? fs.readFileSync(arcManifestPath, "utf8") : "";
const venueRequirements = [
  {
    abiFile: "AquaAdapter.json",
    events: [
      "AdapterStrategyShipped",
      "AdapterStrategyDocked",
      "AdapterStrategyEmergencyDocked",
      "AdapterStrategyReshipped",
      "AdapterStrategyReconciled",
      "AdapterStrategyForceCleared",
      "AdapterOneStrategyPerTokenSet"
    ],
    manifests: [["subgraph.base.yaml", manifest]]
  },
  {
    abiFile: "AquaSwapVMRouter.json",
    events: ["Swapped"],
    manifests: [
      ["manifests/aqua-swapvm-router.arc.yaml", fs.readFileSync(arcRouterFragmentPath, "utf8")],
      ...(/\n    name: AquaSwapVMRouter\n/.test(arcManifest) ? [["subgraph.arc.yaml", arcManifest]] : [])
    ]
  }
];
for (const { abiFile, events, manifests } of venueRequirements) {
  const venueAbi = JSON.parse(fs.readFileSync(path.join(subgraphDir, "abis", abiFile), "utf8"));
  const venueEvents = new Map(venueAbi.filter((item) => item.type === "event").map((event) => [event.name, event]));
  for (const name of events) {
    const event = venueEvents.get(name);
    if (!event) {
      missingFromAbi.push(`${abiFile}:${name}`);
      continue;
    }
    const signature = eventSignature(event);
    for (const [label, text] of manifests) {
      if (!text.includes(`- event: ${signature}`)) missingFromManifest.push(`${label}: ${signature}`);
    }
  }
  requiredEvents.push(...events);
}

// Base must not index 1inch's shared router; the router data source is Arc-only.
const baseDeclaresRouter = /\n    name: AquaSwapVMRouter\n/.test(manifest);
if (baseDeclaresRouter) {
  console.error("subgraph.base.yaml must not declare the AquaSwapVMRouter data source (Arc-only).");
  process.exit(1);
}

if (missingFromAbi.length > 0 || missingFromManifest.length > 0 || !assetVaultTemplateHasEventsAbi) {
  if (missingFromAbi.length > 0) {
    console.error(`Missing required events from Events.json: ${missingFromAbi.join(", ")}`);
  }
  if (missingFromManifest.length > 0) {
    console.error("Missing required event handlers from subgraph.base.yaml:");
    for (const signature of missingFromManifest) {
      console.error(`  - ${signature}`);
    }
  }
  if (!assetVaultTemplateHasEventsAbi) {
    console.error("AssetVault template must include the Events ABI.");
  }
  process.exit(1);
}

console.log(`Required vault and Aqua venue events present: ${requiredEvents.length}`);
