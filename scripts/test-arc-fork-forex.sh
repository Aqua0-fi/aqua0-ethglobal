#!/usr/bin/env bash
# Arc Testnet FORK integration test for forex-curve strategies (ForexCurve, opcode 34: Tomás's Shell v1 / DFX curve)
# through the Aqua0 CLI (the same @aqua0/shared service functions as the MCP tools), in MCP_WRITE_MODE=execute.
# Not run in CI.
#
# Starts anvil forking Arc on 127.0.0.1:8580, deploys an AquaForexSwapVMRouter with
# packages/contracts/script/DeployForexVenue.s.sol and an AquaAdapter bound to it, wires the adapter as the
# impersonated core admin (fork only), hands the deployed ARS ManualFxOracle to a throwaway signer, and runs:
#   deposit 2 USDC -> create USDC/ARS + USDC/BRL (default opcode: forex) -> quote + swap a small trade on each
#   -> a trade past the flat band pays the inventory fee -> a trade past the halt band reverts
#   -> owner moves ARS/USD +5% -> the ARS quote follows the oracle -> create again is idempotent
#   -> shared-backing shows the same USDC committed to both forex classes.
# USDC/BRL reads the deployed RedStone BRL feed: quotes apply the latest signed payload as an eth_call state
# override, and swap pushes a signed payload on-chain before swapping.
#
# Safety: every RPC call goes to the local fork. Keys are throwaway, generated per run, never printed.
# Env: ARC_FORK_URL (default https://rpc.testnet.arc.network), REUSE_ANVIL=1 to use a fork already on port 8580.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/packages/contracts"
DEPLOYMENT="$ROOT/deployments/arc-testnet.json"
PORT=8580
RPC_URL="http://127.0.0.1:${PORT}"
FORK_URL="${ARC_FORK_URL:-https://rpc.testnet.arc.network}"
ARC_CHAIN_ID=5042002

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; }
json() {
  node -e '
    const value = process.argv[2].split(".").reduce((o, k) => o?.[k], require(process.argv[1]));
    if (value === undefined || value === null) process.exit(3);
    console.log(value);
  ' "$DEPLOYMENT" "$1"
}
new_wallet() { cast wallet new --json; }
wallet_field() { node -e 'console.log(JSON.parse(process.argv[1])[0][process.argv[2]])' "$1" "$2"; }

CORE_ADMIN="$(json deployer)"
REGISTRY="$(json contracts.vaultRegistry)"
COMPOSER="$(json contracts.composer)"
AQUA="$(json contracts.aqua)"
USDC="$(json assets.usdc)"
ARGT="$(json assets.argt)"
ARS_FEED="$(json contracts.fxOracles.arsUsd)"
FEED_OWNER="$(json contracts.fxOracles.owner)"
VAULTS=("$(json vaults.usdc)" "$(json vaults.argt)" "$(json vaults.brat)")

# Fresh keys: not anvil's dev account 0, which carries an EIP-7702 delegation on Arc (its ship signature would be
# checked via ERC-1271 and rejected).
w="$(new_wallet)"; SIGNER="$(wallet_field "$w" address)"; SIGNER_KEY="$(wallet_field "$w" private_key)"
w="$(new_wallet)"; DEPLOYER="$(wallet_field "$w" address)"
unset w

OUT="$(mktemp -d)"
ANVIL_PID=""
cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

if port_open; then
  [[ "${REUSE_ANVIL:-0}" == "1" ]] || fail "port ${PORT} is already in use; stop that process or set REUSE_ANVIL=1"
  log "reusing the Arc fork already listening on ${RPC_URL}"
else
  log "starting anvil fork of ${FORK_URL} on ${RPC_URL}"
  anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
  ANVIL_PID=$!
  for _ in $(seq 1 60); do
    port_open && break
    sleep 0.5
  done
fi
chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
[[ "$chain_id" == "$ARC_CHAIN_ID" ]] || fail "expected Arc fork chain id ${ARC_CHAIN_ID}, got ${chain_id}"

rpc() { cast rpc --rpc-url "$RPC_URL" "$@" >/dev/null; }
send_as() {
  local from="$1"
  shift
  rpc anvil_impersonateAccount "$from"
  cast send --rpc-url "$RPC_URL" --unlocked --from "$from" "$@" >/dev/null
  rpc anvil_stopImpersonatingAccount "$from"
}
call() { cast call --rpc-url "$RPC_URL" "$@"; }
lower() { tr '[:upper:]' '[:lower:]'; }

log "funding gas (fork only)"
for account in "$CORE_ADMIN" "$FEED_OWNER" "$SIGNER" "$DEPLOYER"; do
  rpc anvil_setBalance "$account" 0x3635C9ADC5DEA00000
done
OPERATOR_ROLE="$(cast keccak OPERATOR_ROLE)"
VENUE_SETTLER_ROLE="$(cast keccak VENUE_SETTLER_ROLE)"

log "deploying AquaForexSwapVMRouter with DeployForexVenue.s.sol (fork)"
rpc anvil_impersonateAccount "$DEPLOYER"
(
  cd "$CONTRACTS"
  FOUNDRY_BROADCAST="$OUT/broadcast" AQUA="$AQUA" ROUTER_OWNER="$DEPLOYER" \
    forge script script/DeployForexVenue.s.sol:DeployForexVenue --rpc-url "$RPC_URL" --unlocked --sender "$DEPLOYER" \
    --broadcast --slow
) >"$OUT/deploy-forex-venue.log" 2>&1 || { tail -40 "$OUT/deploy-forex-venue.log" >&2; fail "DeployForexVenue failed"; }
FOREX_ROUTER="$(node -e 'console.log(require(process.argv[1]).returns.router.value)' \
  "$OUT/broadcast/DeployForexVenue.s.sol/${ARC_CHAIN_ID}/run-latest.json")"
grep -E "AquaForexSwapVMRouter:|runtime bytes" "$OUT/deploy-forex-venue.log" | sed 's/^/   /' || true

log "deploying an AquaAdapter bound to the forex router (fork)"
artifact="$CONTRACTS/cache/aqua0-out/AquaAdapter.sol/AquaAdapter.json"
bytecode="$(node -e '
  const artifact = require(process.argv[1]);
  const code = artifact.bytecode?.object ?? artifact.bytecode;
  if (!code || code.includes("__$")) { console.error("AquaAdapter artifact has no linked bytecode"); process.exit(1); }
  console.log(code);
' "$artifact")"
ctor="$(cast abi-encode 'constructor(address,address,address,address,address,address,address,string)' \
  "$DEPLOYER" "$DEPLOYER" "$DEPLOYER" "$REGISTRY" "$COMPOSER" "$AQUA" "$FOREX_ROUTER" "1")"
FOREX_ADAPTER="$(cast send --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" --create "${bytecode}${ctor#0x}" --json |
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const r = JSON.parse(s);
    if (!["0x1", 1, "1"].includes(r.status) || !r.contractAddress) process.exit(1);
    console.log(r.contractAddress);
  })')" || fail "AquaAdapter deployment failed"
rpc anvil_stopImpersonatingAccount "$DEPLOYER"
send_as "$DEPLOYER" "$FOREX_ADAPTER" 'setOneStrategyPerToken(bool)' false

log "checking the venue binding"
[[ "$(call "$FOREX_ADAPTER" 'aquaSwapVMRouter()(address)' | lower)" == "$(echo "$FOREX_ROUTER" | lower)" ]] || fail "adapter is not bound to the forex router"
[[ "$(call "$FOREX_ROUTER" 'AQUA()(address)' | lower)" == "$(echo "$AQUA" | lower)" ]] || fail "forex router is bound to another Aqua"
echo "   AquaForexSwapVMRouter $FOREX_ROUTER | AquaAdapter $FOREX_ADAPTER | ARS feed $ARS_FEED"

log "wiring the forex AquaAdapter into Aqua0 core as the impersonated core admin, operator role to the signer (fork only)"
send_as "$CORE_ADMIN" "$REGISTRY" 'setAdapterAllowed(address,bool)' "$FOREX_ADAPTER" true
for vault in "${VAULTS[@]}"; do
  send_as "$CORE_ADMIN" "$vault" 'grantRole(bytes32,address)' "$VENUE_SETTLER_ROLE" "$FOREX_ADAPTER"
done
send_as "$DEPLOYER" "$FOREX_ADAPTER" 'grantRole(bytes32,address)' "$OPERATOR_ROLE" "$SIGNER"

log "handing the ARS ManualFxOracle to the throwaway signer as the impersonated feed owner (fork only)"
send_as "$FEED_OWNER" "$ARS_FEED" 'transferOwnership(address)' "$SIGNER"

log "replacing Arc's USDC (native precompile-backed) with ARGt's open-mint ERC-20 code and minting 10 USDC"
rpc anvil_setCode "$USDC" "$(cast code "$ARGT" --rpc-url "$RPC_URL")"
send_as "$SIGNER" "$USDC" 'mint(address,uint256)' "$SIGNER" 10000000

log "building @aqua0/shared and @aqua0/cli"
(cd "$ROOT" && pnpm --filter @aqua0/shared build >/dev/null && pnpm --filter @aqua0/cli build >/dev/null)

export GRAPH_ENDPOINT="http://127.0.0.1:9/graph-not-used-by-these-commands"
export WRITE_RPC_URL="$RPC_URL" WRITE_CHAIN_ID="$ARC_CHAIN_ID" MCP_WRITE_MODE=execute WRITE_PRIVATE_KEY="$SIGNER_KEY"
unset VAULT_REGISTRY_ADDRESS AQUA_ADAPTER_ADDRESS AQUA_SWAPVM_ROUTER_ADDRESS FX_ORACLE_ARS_USD FX_ORACLE_BRL_USD
export FXSWAP_ROUTER_ADDRESS="$FOREX_ROUTER" FXSWAP_AQUA_ADAPTER_ADDRESS="$FOREX_ADAPTER"

aqua0() { node "$ROOT/apps/cli/dist/index.js" "$@"; }
run() {
  local name="$1"
  shift
  log "aqua0 $*"
  aqua0 "$@" >"$OUT/$name.json"
  summarize "$OUT/$name.json"
}
summarize() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const r = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const amt = (a) => (a ? `${a.formatted} ${a.symbol}` : "n/a");
    const steps = (list = []) => list.forEach((s) => console.log(`   ${s.status === "sent" ? "sent   " : "skipped"} ${s.stage}${s.hash ? ` ${s.hash}` : ""}${s.note ? ` (${s.note})` : ""}`));
    const pricing = (x) => {
      if (!x.pricing) return;
      const p = x.pricing;
      console.log(`   oracle ${p.oraclePrice} | execution ${p.executionPrice} | effective spread ${p.effectiveSpreadBps} bps${x.oracle ? ` | feed age ${x.oracle.ageSeconds}s, fresh=${x.oracle.fresh}` : ""}`);
    };
    if (r.before && r.after) {
      console.log(`   ${r.pair} feed ${r.feed}: ${r.before.price} -> ${r.after.price} (${r.change}); owner ${r.owner}`);
      steps(r.steps);
    } else if (r.summary) {
      console.log(`   USDC principal (counted once): ${amt(r.usdc.principal)} | free: ${amt(r.usdc.freePrincipal)}`);
      for (const c of r.classes) {
        console.log(`   class ${c.classId} ${c.pair}: classCommittedBacking=${amt(c.usdcVault.classCommittedBacking)}`);
        for (const s of c.strategies) console.log(`     [${s.opcode}] ${s.strategyId} live=${s.live} feePpb=${s.feePpb} ${s.instructions ?? ""}`);
      }
      console.log(`   sharedBacking=${r.summary.sharedBacking}: ${r.summary.explanation}`);
    } else if (r.program) {
      const g = r.program;
      console.log(`   ${r.pair} opcode=${r.opcode} (${r.opcodeSource}) class ${r.classId} strategyId ${r.strategyId} live=${r.live}`);
      console.log(`   program: ${g.instructions}; alpha ${g.alpha} beta ${g.beta} delta ${g.delta} maxFee ${g.maxFee} lambda ${g.lambda} epsilon ${g.epsilonBps} bps, invert=${g.invertPrice}, band ${g.priceBand?.min} .. ${g.priceBand?.max}, max feed age ${g.maxStalenessSeconds}s`);
      console.log(`   ships ${amt(g.usdcShip)} + ${amt(g.fxShip)} at oracle ${r.oracle?.price}`);
      steps(r.steps);
    } else if (r.received) {
      console.log(`   ${r.pair} [${r.opcode}] ${r.strategyId}: in ${amt(r.amountIn)}, quoted ${amt(r.quotedAmountOut)}, min ${amt(r.minAmountOut)}, received ${amt(r.received)}`);
      pricing(r);
      steps(r.steps);
    } else if (r.amountOut) {
      console.log(`   ${r.pair} [${r.opcode}] ${r.strategyId}: ${amt(r.amountIn)} -> ${amt(r.amountOut)}`);
      pricing(r);
    } else {
      console.log(`   deposited ${amt(r.amount)} to ${r.vault} for ${r.receiver}; principal now ${amt(r.position?.principal)}`);
      steps(r.steps);
    }
  ' "$1"
}

run deposit deposit --token USDC --amount 2
run create_ars create-strategy --pair USDC/ARS --chain arc-testnet
run create_brl create-strategy --pair "usdc to brl" --chain arc-testnet

# Trade sizes relative to the USDC ship: 10% stays inside the 15% flat band, 30% crosses it (inventory fee),
# 80% pushes the book past the 50% halt band.
usdc_ship="$(node -e 'console.log(require(process.argv[1]).program.usdcShip.formatted)' "$OUT/create_ars.json")"
size() { node -e 'console.log((Number(process.argv[1]) * Number(process.argv[2])).toFixed(6))' "$usdc_ship" "$1"; }
SMALL="$(size 0.1)"; FEE="$(size 0.3)"; HALT="$(size 0.8)"

# Curve regimes and the oracle move are measured on the balanced book, before any ARS swap tilts it.
run quote_ars_small quote --pair USDC/ARS --amount "$SMALL"
run quote_ars_fee quote --pair USDC/ARS --amount "$FEE"

log "aqua0 quote --pair USDC/ARS --amount $HALT (past the halt band, must revert)"
if aqua0 quote --pair USDC/ARS --amount "$HALT" >"$OUT/quote_ars_halt.json" 2>"$OUT/quote_ars_halt.err"; then
  fail "a trade past the halt band quoted successfully"
fi
grep -q "Halt" "$OUT/quote_ars_halt.err" || { cat "$OUT/quote_ars_halt.err" >&2; fail "halt quote failed for another reason"; }
sed 's/^/   reverted: /' "$OUT/quote_ars_halt.err" | head -3

run set_ars_price set-fx-price --pair ARS --change-percent 5
run quote_ars_after_move quote --pair USDC/ARS --amount "$SMALL"

run swap_ars swap --pair USDC/ARS --amount "$SMALL"
run quote_brl quote --pair USDC/BRL --amount "$SMALL"
run swap_brl swap --pair USDC/BRL --amount "$SMALL"
# The ARS swap tilted the book by about 10% of its ideal; another 10% crosses the 15% flat band and pays the fee.
run quote_ars_tilted quote --pair USDC/ARS --amount "$SMALL"
run create_ars_again create-strategy --pair USDC/ARS
run shared shared-backing "$SIGNER"

log "assertions"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [out] = process.argv.slice(1);
  const read = (name) => JSON.parse(readFileSync(`${out}/${name}.json`, "utf8"));
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };

  const ars = read("create_ars"), brl = read("create_brl");
  for (const c of [ars, brl]) {
    check(c.opcode === "forex", `${c.pair} opcode is ${c.opcode}`);
    check(/ForexCurve \(opcode 34\)/.test(c.program?.instructions ?? ""), `${c.pair} program is not ForexCurve`);
    check(c.live === true, `${c.pair} strategy not live`);
  }
  check(ars.classId !== brl.classId, "ARS and BRL share a class");
  check(ars.program.invertPrice === true, "USDC/ARS on the ManualFxOracle (ARS per USD) must set the invert flag");
  check(brl.program.invertPrice === false, "USDC/BRL on the RedStone feed (USD per BRL) must not invert");
  check(read("quote_brl").redstone?.feedId === "BRL", "the BRL quote did not use a signed RedStone payload");
  check(
    (read("swap_brl").steps ?? []).some((step) => step.stage === "push RedStone BRL price" && step.status === "sent"),
    "swap did not push the RedStone BRL price before swapping"
  );

  for (const [s, c] of [[read("swap_ars"), ars], [read("swap_brl"), brl]]) {
    check(BigInt(s.received.raw) > 0n, `${s.pair} swap received nothing`);
    check(s.opcode === "forex" && s.strategyId === c.strategyId, `${s.pair} swapped on ${s.opcode} ${s.strategyId}`);
    const pushedRedstone = (s.steps ?? []).some((step) => step.stage.startsWith("push RedStone") && step.status === "sent");
    const expected = pushedRedstone
      ? BigInt(s.quotedAmountOut.raw)
      : BigInt(read(c.pair === "USDC/ARS" ? "quote_ars_after_move" : "quote_brl").amountOut.raw);
    check(BigInt(s.received.raw) === expected, `${s.pair} received differs from the quote`);
    // Inside the flat band the price is the oracle price less epsilon (30 bps).
    const spread = Number(s.pricing?.effectiveSpreadBps);
    check(spread >= 20 && spread <= 45, `${s.pair} flat-band spread ${spread} bps is not about epsilon (30 bps)`);
  }

  const small = Number(read("quote_ars_small").pricing?.effectiveSpreadBps);
  const fee = Number(read("quote_ars_fee").pricing?.effectiveSpreadBps);
  check(fee > small + 5, `a trade past the flat band should pay the inventory fee: spread ${fee} bps vs ${small} bps inside it`);
  const tilted = Number(read("quote_ars_tilted").pricing?.effectiveSpreadBps);
  check(tilted > small + 5, `a trade that tilts an already tilted book should pay the inventory fee: spread ${tilted} bps vs ${small} bps`);

  const set = read("set_ars_price");
  check(BigInt(set.after.answer) * 100n === BigInt(set.before.answer) * 105n, `feed moved ${set.before.answer} -> ${set.after.answer}, not +5%`);
  const before = BigInt(read("quote_ars_small").amountOut.raw);
  const after = BigInt(read("quote_ars_after_move").amountOut.raw);
  const ratioPpm = (after * 1_000_000n) / before;
  check(ratioPpm >= 1_040_000n && ratioPpm <= 1_060_000n, `ARS quote moved by ${Number(ratioPpm - 1_000_000n) / 10_000}% after a +5% oracle move`);

  const again = read("create_ars_again");
  check(again.opcode === "forex" && again.opcodeSource === "default", `default opcode resolved to ${again.opcode} (${again.opcodeSource})`);
  check(again.strategyId === ars.strategyId, "re-running create-strategy targeted a different strategy");
  check(!again.steps.some((s) => s.status === "sent"), "re-running create-strategy sent transactions");

  const shared = read("shared");
  const committed = shared.classes.filter((c) => c.lpCommittedUsdc);
  const classFor = (id) => committed.find((c) => c.strategies.some((s) => s.strategyId === id && s.live && s.opcode === "forex"));
  check(shared.usdc.principal.raw === "2000000", `USDC principal ${shared.usdc.principal.raw} != 2000000`);
  check(shared.summary.sharedBacking === true, "sharedBacking is false");
  check(classFor(ars.strategyId) && classFor(brl.strategyId), "live forex ARS/BRL strategies not found under committed classes");
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }

  const line = (s) => `${s.amountIn.formatted} USDC -> ${s.received.formatted} ${s.received.symbol} (oracle ${s.pricing.oraclePrice}, execution ${s.pricing.executionPrice}, spread ${s.pricing.effectiveSpreadBps} bps)`;
  console.log("\n==> SUMMARY");
  console.log(`   venue: router ${ars.venue.router}, adapter ${ars.venue.adapter}`);
  console.log(`   USDC/ARS forex class ${ars.classId}: ${line(read("swap_ars"))}`);
  console.log(`   USDC/BRL forex class ${brl.classId}: ${line(read("swap_brl"))}`);
  console.log(`   flat band ${small} bps -> past the band ${fee} bps (inventory fee) -> past the halt band: reverted`);
  console.log(`   ARS/USD +5%: quote ${read("quote_ars_small").amountOut.formatted} -> ${read("quote_ars_after_move").amountOut.formatted} ARGt`);
  console.log(`   shared backing: ${shared.summary.explanation}`);
' "$OUT" || fail "assertions"

log "PASS: one 2 USDC deposit backs live forex-curve USDC/ARS and USDC/BRL strategies; swaps filled at the oracle price inside the flat band, the inventory fee and halt band applied, and quotes followed the ARS/USD move (outputs in $OUT)"
