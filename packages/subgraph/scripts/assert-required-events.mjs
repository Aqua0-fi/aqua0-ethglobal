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

console.log(`Required Shape-C events present: ${requiredEvents.length}`);
