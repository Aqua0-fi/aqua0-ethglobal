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
    missingFromManifest.push(`subgraph.base.yaml: ${signature}`);
  }
}

const assetVaultTemplateHasEventsAbi =
  /templates:[\s\S]*name:\s*AssetVault[\s\S]*abis:[\s\S]*-\s*name:\s*Events\s*\n\s*file:\s*\.\/abis\/Events\.json/.test(
    manifest
  );

// Aqua venues (pegged + FXSwap).
// - Adapter lifecycle events must be handled in the Base manifest; router fills in the Arc-only router template.
// - Every adapter/router data source declared in the generated Arc manifest must carry its handlers and the
//   `venue` context the mappings stamp on adapters, strategies and fills.
// - Base must not declare any Arc-only venue data source.
const adapterEvents = [
  "AdapterStrategyShipped",
  "AdapterStrategyDocked",
  "AdapterStrategyEmergencyDocked",
  "AdapterStrategyReshipped",
  "AdapterStrategyReconciled",
  "AdapterStrategyForceCleared",
  "AdapterOneStrategyPerTokenSet"
];
const routerEvents = ["Swapped"];

function venueSignatures(abiFile, names) {
  const venueAbi = JSON.parse(fs.readFileSync(path.join(subgraphDir, "abis", abiFile), "utf8"));
  const venueEvents = new Map(venueAbi.filter((item) => item.type === "event").map((event) => [event.name, event]));
  const signatures = [];
  for (const name of names) {
    const event = venueEvents.get(name);
    if (event) signatures.push(eventSignature(event));
    else missingFromAbi.push(`${abiFile}:${name}`);
  }
  requiredEvents.push(...names);
  return signatures;
}

function requireHandlers(label, text, signatures) {
  for (const signature of signatures) {
    if (!text.includes(`- event: ${signature}`)) missingFromManifest.push(`${label}: ${signature}`);
  }
}

function dataSourceBlock(text, name) {
  const match = text.match(
    new RegExp(
      `  - kind: ethereum/contract\\n    name: ${name}\\n[\\s\\S]*?(?=  - kind: ethereum/contract\\n    name:|templates:)`
    )
  );
  return match ? match[0] : null;
}

const adapterSignatures = venueSignatures("AquaAdapter.json", adapterEvents);
const routerSignatures = venueSignatures("AquaSwapVMRouter.json", routerEvents);

const routerTemplateLabel = "manifests/aqua-swapvm-router.arc.yaml";
const routerTemplate = fs.readFileSync(path.join(subgraphDir, routerTemplateLabel), "utf8");
requireHandlers("subgraph.base.yaml AquaAdapter", dataSourceBlock(manifest, "AquaAdapter") ?? "", adapterSignatures);
requireHandlers(routerTemplateLabel, routerTemplate, routerSignatures);

const arcVenueSources = [
  { name: "AquaAdapter", venue: "pegged", signatures: adapterSignatures, arcOnly: false },
  { name: "AquaSwapVMRouter", venue: "pegged", signatures: routerSignatures, arcOnly: true },
  { name: "FXAquaAdapter", venue: "fxswap", signatures: adapterSignatures, arcOnly: true },
  { name: "AquaFXSwapVMRouter", venue: "fxswap", signatures: routerSignatures, arcOnly: true }
];

const baseArcOnly = arcVenueSources.filter((s) => s.arcOnly && dataSourceBlock(manifest, s.name) !== null);
if (baseArcOnly.length > 0) {
  console.error(
    `subgraph.base.yaml must not declare Arc-only venue data sources: ${baseArcOnly.map((s) => s.name).join(", ")}.`
  );
  process.exit(1);
}

const arcManifestPath = path.join(subgraphDir, "subgraph.arc.yaml");
const arcManifest = fs.existsSync(arcManifestPath) ? fs.readFileSync(arcManifestPath, "utf8") : "";
const arcChecked = [];
for (const source of arcVenueSources) {
  const block = dataSourceBlock(arcManifest, source.name);
  if (block === null) continue;
  arcChecked.push(`${source.name} (${source.venue})`);
  requireHandlers(`subgraph.arc.yaml ${source.name}`, block, source.signatures);
  const context = `\n    context:\n      venue:\n        type: String\n        data: ${source.venue}\n`;
  if (!block.includes(context)) {
    missingFromManifest.push(`subgraph.arc.yaml ${source.name}: venue context "${source.venue}"`);
  }
}

if (missingFromAbi.length > 0 || missingFromManifest.length > 0 || !assetVaultTemplateHasEventsAbi) {
  if (missingFromAbi.length > 0) {
    console.error(`Missing required events from ABIs: ${missingFromAbi.join(", ")}`);
  }
  if (missingFromManifest.length > 0) {
    console.error("Missing required event handlers:");
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
console.log(`Arc venue data sources checked: ${arcChecked.length ? arcChecked.join(", ") : "none declared"}`);
