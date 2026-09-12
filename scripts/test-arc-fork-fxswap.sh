#!/usr/bin/env bash
# Arc Testnet FORK integration test for FXSwap strategies through the Aqua0 CLI (the same @aqua0/shared service
# functions as the MCP tools), in MCP_WRITE_MODE=execute. Not run in CI.
#
# Starts anvil forking Arc on 127.0.0.1:8579 and brings up an FXSwap venue on the fork:
#   FX_VENUE=fresh     (default) deploy ARS/USD + BRL/USD ManualFxOracle feeds and an AquaFXSwapVMRouter with
#                      packages/contracts/script/DeployFXVenue.s.sol, then an AquaAdapter bound to that router
#   FX_VENUE=deployed  use the FXSwap venue already deployed on Arc Testnet (deployments/arc-testnet.json); the
#                      feed owner hands feed ownership to the throwaway signer on the fork
# then wires the adapter as the impersonated core admin (fork only) and runs:
#   deposit 2 USDC -> create USDC/ARS + USDC/BRL with --opcode fxswap -> quote + swap 0.1 USDC on each
#   -> non-owner set-fx-price is refused -> owner moves ARS/USD +5% -> the ARS quote follows the oracle
#   -> create without --opcode is idempotent and resolves to fxswap -> shared-backing shows the same USDC
#   committed to both FXSwap classes.
#
# Safety: every RPC call goes to the local fork. Keys are throwaway, generated per run, never printed.
# Env: ARC_FORK_URL (default https://rpc.testnet.arc.network), FX_VENUE (fresh|deployed), REUSE_ANVIL=1 to use an
# already running fork on port 8579.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/packages/contracts"
DEPLOYMENT="$ROOT/deployments/arc-testnet.json"
PORT=8579
RPC_URL="http://127.0.0.1:${PORT}"
FORK_URL="${ARC_FORK_URL:-https://rpc.testnet.arc.network}"
ARC_CHAIN_ID=5042002
FX_VENUE="${FX_VENUE:-fresh}"
FX_ADAPTER_ADMIN_DEPLOYED=0x7E61A5EbCCd26d9D91690C6037d7224F5384730D

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

[[ "$FX_VENUE" == "fresh" || "$FX_VENUE" == "deployed" ]] || fail "FX_VENUE must be fresh or deployed"

CORE_ADMIN="$(json deployer)"
REGISTRY="$(json contracts.vaultRegistry)"
COMPOSER="$(json contracts.composer)"
AQUA="$(json contracts.aqua)"
USDC="$(json assets.usdc)"
ARGT="$(json assets.argt)"
VAULTS=("$(json vaults.usdc)" "$(json vaults.argt)" "$(json vaults.brat)")

# Fresh keys: not anvil's dev account 0, which carries an EIP-7702 delegation on Arc (its ship signature would be
# checked via ERC-1271 and rejected).
w="$(new_wallet)"; SIGNER="$(wallet_field "$w" address)"; SIGNER_KEY="$(wallet_field "$w" private_key)"
w="$(new_wallet)"; OTHER_KEY="$(wallet_field "$w" private_key)"
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
for account in "$CORE_ADMIN" "$FX_ADAPTER_ADMIN_DEPLOYED" "$SIGNER" "$DEPLOYER"; do
  rpc anvil_setBalance "$account" 0x3635C9ADC5DEA00000
done
OPERATOR_ROLE="$(cast keccak OPERATOR_ROLE)"
VENUE_SETTLER_ROLE="$(cast keccak VENUE_SETTLER_ROLE)"

if [[ "$FX_VENUE" == "fresh" ]]; then
  log "deploying ManualFxOracle ARS/USD + BRL/USD and AquaFXSwapVMRouter with DeployFXVenue.s.sol (fork)"
  rpc anvil_impersonateAccount "$DEPLOYER"
  (
    cd "$CONTRACTS"
    FOUNDRY_BROADCAST="$OUT/broadcast" AQUA="$AQUA" ROUTER_OWNER="$DEPLOYER" ORACLE_OWNER="$SIGNER" \
      forge script script/DeployFXVenue.s.sol:DeployFXVenue --rpc-url "$RPC_URL" --unlocked --sender "$DEPLOYER" \
      --broadcast --slow --out "$OUT/forge-out" --cache-path "$OUT/forge-cache"
  ) >"$OUT/deploy-fx-venue.log" 2>&1 || { tail -40 "$OUT/deploy-fx-venue.log" >&2; fail "DeployFXVenue failed"; }
  run_json="$OUT/broadcast/DeployFXVenue.s.sol/${ARC_CHAIN_ID}/run-latest.json"
  returned() { node -e 'console.log(require(process.argv[1]).returns[process.argv[2]].value)' "$run_json" "$1"; }
  FX_ROUTER="$(returned router)"
  ARS_FEED="$(returned arsFeed)"
  BRL_FEED="$(returned brlFeed)"
  grep -E "AquaFXSwapVMRouter:|runtime bytes|ManualFxOracle" "$OUT/deploy-fx-venue.log" | sed 's/^/   /' || true

  log "deploying an AquaAdapter bound to the FXSwap router (fork)"
  artifact="$CONTRACTS/cache/aqua0-out/AquaAdapter.sol/AquaAdapter.json"
  bytecode="$(node -e '
    const artifact = require(process.argv[1]);
    const code = artifact.bytecode?.object ?? artifact.bytecode;
    if (!code || code.includes("__$")) { console.error("AquaAdapter artifact has no linked bytecode"); process.exit(1); }
    console.log(code);
  ' "$artifact")"
  ctor="$(cast abi-encode 'constructor(address,address,address,address,address,address,address,string)' \
    "$DEPLOYER" "$DEPLOYER" "$DEPLOYER" "$REGISTRY" "$COMPOSER" "$AQUA" "$FX_ROUTER" "1")"
  rpc anvil_impersonateAccount "$DEPLOYER"
  FX_ADAPTER="$(cast send --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" --create "${bytecode}${ctor#0x}" --json |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const r = JSON.parse(s);
      if (!["0x1", 1, "1"].includes(r.status) || !r.contractAddress) process.exit(1);
      console.log(r.contractAddress);
    })')" || fail "AquaAdapter deployment failed"
  rpc anvil_stopImpersonatingAccount "$DEPLOYER"
  FX_ADAPTER_ADMIN="$DEPLOYER"
  send_as "$FX_ADAPTER_ADMIN" "$FX_ADAPTER" 'setOneStrategyPerToken(bool)' false
else
  log "using the FXSwap venue deployed on Arc Testnet (deployments/arc-testnet.json)"
  FX_ROUTER="$(json contracts.fxswapRouter)" || fail "deployments file has no contracts.fxswapRouter"
  FX_ADAPTER="$(json contracts.fxAquaAdapter)" || fail "deployments file has no contracts.fxAquaAdapter"
  ARS_FEED="$(json contracts.fxOracles.arsUsd)"
  BRL_FEED="$(json contracts.fxOracles.brlUsd)"
  FEED_OWNER="$(json contracts.fxOracles.owner)"
  FX_ADAPTER_ADMIN="$FX_ADAPTER_ADMIN_DEPLOYED"
  for contract in "$FX_ROUTER" "$FX_ADAPTER" "$ARS_FEED" "$BRL_FEED"; do
    [[ "$(cast code "$contract" --rpc-url "$RPC_URL")" != "0x" ]] || fail "no code at $contract on the fork"
  done
  rpc anvil_setBalance "$FEED_OWNER" 0x3635C9ADC5DEA00000
  log "handing both feeds to the throwaway signer as the impersonated feed owner (fork only)"
  for feed in "$ARS_FEED" "$BRL_FEED"; do
    send_as "$FEED_OWNER" "$feed" 'transferOwnership(address)' "$SIGNER"
  done
  if [[ "$(call "$FX_ADAPTER" 'oneStrategyPerToken()(bool)')" != "false" ]]; then
    send_as "$FX_ADAPTER_ADMIN" "$FX_ADAPTER" 'setOneStrategyPerToken(bool)' false
  fi
fi

log "checking the venue binding"
[[ "$(call "$FX_ADAPTER" 'aquaSwapVMRouter()(address)' | lower)" == "$(echo "$FX_ROUTER" | lower)" ]] || fail "adapter is not bound to the FX router"
[[ "$(call "$FX_ROUTER" 'AQUA()(address)' | lower)" == "$(echo "$AQUA" | lower)" ]] || fail "FX router is bound to another Aqua"
echo "   AquaFXSwapVMRouter $FX_ROUTER | AquaAdapter $FX_ADAPTER | ARS/USD $ARS_FEED | BRL/USD $BRL_FEED"

log "wiring the FXSwap AquaAdapter into Aqua0 core as the impersonated core admin, operator role to the signer (fork only)"
send_as "$CORE_ADMIN" "$REGISTRY" 'setAdapterAllowed(address,bool)' "$FX_ADAPTER" true
for vault in "${VAULTS[@]}"; do
  send_as "$CORE_ADMIN" "$vault" 'grantRole(bytes32,address)' "$VENUE_SETTLER_ROLE" "$FX_ADAPTER"
done
send_as "$FX_ADAPTER_ADMIN" "$FX_ADAPTER" 'grantRole(bytes32,address)' "$OPERATOR_ROLE" "$SIGNER"

log "replacing Arc's USDC (native precompile-backed) with ARGt's open-mint ERC-20 code and minting 10 USDC"
rpc anvil_setCode "$USDC" "$(cast code "$ARGT" --rpc-url "$RPC_URL")"
send_as "$SIGNER" "$USDC" 'mint(address,uint256)' "$SIGNER" 10000000

log "building @aqua0/shared and @aqua0/cli"
(cd "$ROOT" && pnpm --filter @aqua0/shared build >/dev/null && pnpm --filter @aqua0/cli build >/dev/null)

export GRAPH_ENDPOINT="http://127.0.0.1:9/graph-not-used-by-these-commands"
export WRITE_RPC_URL="$RPC_URL" WRITE_CHAIN_ID="$ARC_CHAIN_ID" MCP_WRITE_MODE=execute WRITE_PRIVATE_KEY="$SIGNER_KEY"
unset VAULT_REGISTRY_ADDRESS AQUA_ADAPTER_ADDRESS AQUA_SWAPVM_ROUTER_ADDRESS
if [[ "$FX_VENUE" == "fresh" ]]; then
  export FXSWAP_ROUTER_ADDRESS="$FX_ROUTER" FXSWAP_AQUA_ADAPTER_ADDRESS="$FX_ADAPTER"
  export FX_ORACLE_ARS_USD="$ARS_FEED" FX_ORACLE_BRL_USD="$BRL_FEED"
else
  # Prove the Arc defaults in @aqua0/shared point at the deployed venue.
  unset FXSWAP_ROUTER_ADDRESS FXSWAP_AQUA_ADAPTER_ADDRESS FX_ORACLE_ARS_USD FX_ORACLE_BRL_USD
fi

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
      console.log(`   ${p.oraclePrice ? `oracle ${p.oraclePrice}` : `fixed ${p.fixedPrice}`} | execution ${p.executionPrice} | effective spread ${p.effectiveSpreadBps} bps${x.oracle ? ` | feed age ${x.oracle.ageSeconds}s, fresh=${x.oracle.fresh}, in band=${x.oracle.strategyBand?.inBand}` : ""}`);
    };
    if (r.feeds) {
      for (const f of r.feeds) console.log(`   ${f.pair}: ${f.price} (feed ${f.feed}, updated ${f.ageSeconds}s ago, owner ${f.owner})`);
    } else if (r.before && r.after) {
      console.log(`   ${r.pair} feed ${r.feed}: ${r.before.price} -> ${r.after.price} (${r.change}); owner ${r.owner}`);
      steps(r.steps);
    } else if (r.summary) {
      console.log(`   source: ${r.source} - ${r.sourceNote}`);
      console.log(`   USDC principal (counted once): ${amt(r.usdc.principal)} | free: ${amt(r.usdc.freePrincipal)}`);
      for (const c of r.classes) {
        console.log(`   class ${c.classId} ${c.pair}: lpCommittedUsdc=${c.lpCommittedUsdc} USDC classCommittedBacking=${amt(c.usdcVault.classCommittedBacking)} classAvailableFor=${amt(c.usdcVault.classAvailableFor)} | ${c.fxVault ? `${c.fxVault.token} committed=${amt(c.fxVault.classCommittedBacking)}` : "no FX leg"}`);
        for (const s of c.strategies) console.log(`     [${s.opcode}] ${s.strategyId} live=${s.live} feePpb=${s.feePpb} ${s.instructions ?? ""} amounts=${s.strategyAmounts ? `${amt(s.strategyAmounts.usdc)} + ${amt(s.strategyAmounts.fx)}` : "n/a"}`);
      }
      console.log(`   sharedBacking=${r.summary.sharedBacking}: ${r.summary.explanation}`);
    } else if (r.program) {
      const g = r.program;
      console.log(`   ${r.pair} opcode=${r.opcode} (${r.opcodeSource}${r.opcodeNote ? `: ${r.opcodeNote}` : ""}) class ${r.classId} strategyId ${r.strategyId} live=${r.live}`);
      if (r.opcode === "fxswap") {
        console.log(`   program: ${g.instructions}; A ${g.A}, gamma ${g.gamma}, fee ${g.midFeeBps} -> ${g.outFeeBps} bps (feeGamma ${g.feeGamma}), band ${g.priceBand.min} .. ${g.priceBand.max} (${g.priceBand.source}), max feed age ${g.maxStalenessSeconds}s, declared feePpb ${g.declaredFeePpb}`);
        console.log(`   ships ${amt(g.usdcShip)} + ${amt(g.fxShip)} at oracle ${r.oracle?.price}`);
      } else {
        console.log(`   program: ${g.price}, fee ${g.feeBps} bps, ships ${amt(g.usdcShip)} + ${amt(g.fxShip)}`);
      }
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

run fx_prices_start fx-prices
run deposit deposit --token USDC --amount 2
run create_ars create-strategy --pair USDC/ARS --chain arc-testnet --opcode fxswap
run create_brl create-strategy --pair "usdc to brl" --chain arc-testnet --opcode fxswap
run quote_ars quote --pair USDC/ARS --amount 0.1
run swap_ars swap --pair USDC/ARS --amount 0.1
run quote_brl quote --pair USDC/BRL --amount 0.1
run swap_brl swap --pair USDC/BRL --amount 0.1
run quote_ars_before_move quote --pair USDC/ARS --amount 0.1

log "aqua0 set-fx-price --pair ARS --change-percent 5 (signed by a key that does not own the feed)"
if WRITE_PRIVATE_KEY="$OTHER_KEY" aqua0 set-fx-price --pair ARS --change-percent 5 >"$OUT/set_price_non_owner.json" 2>"$OUT/set_price_non_owner.err"; then
  fail "a non-owner signer was able to set the ARS/USD feed"
fi
grep -q "is not the owner" "$OUT/set_price_non_owner.err" || { cat "$OUT/set_price_non_owner.err" >&2; fail "unexpected non-owner error"; }
sed 's/^/   refused: /' "$OUT/set_price_non_owner.err"

run set_ars_price set-fx-price --pair ARS --change-percent 5
run fx_prices_after fx-prices --pair ARS
run quote_ars_after_move quote --pair USDC/ARS --amount 0.1
run create_ars_again create-strategy --pair USDC/ARS
run shared shared-backing "$SIGNER"

log "assertions"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [out, venueMode] = process.argv.slice(1);
  const read = (name) => JSON.parse(readFileSync(`${out}/${name}.json`, "utf8"));
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };

  const ars = read("create_ars"), brl = read("create_brl");
  for (const c of [ars, brl]) {
    check(c.opcode === "fxswap", `${c.pair} opcode is ${c.opcode}`);
    check(/FXSwap \(opcode 34\)/.test(c.program?.instructions ?? ""), `${c.pair} program is not FXSwap`);
    check(c.live === true, `${c.pair} strategy not live`);
  }
  check(ars.classId !== brl.classId, "ARS and BRL share a class");

  const swaps = [[read("swap_ars"), ars], [read("swap_brl"), brl]];
  for (const [s, c] of swaps) {
    check(BigInt(s.received.raw) > 0n, `${s.pair} swap received nothing`);
    check(s.opcode === "fxswap" && s.strategyId === c.strategyId, `${s.pair} swapped on ${s.opcode} ${s.strategyId}`);
    check(s.pricing?.priceSource === "oracle", `${s.pair} swap pricing is not oracle-based`);
    check(BigInt(s.received.raw) === BigInt(read(`quote_${c.pair === "USDC/ARS" ? "ars" : "brl"}`).amountOut.raw), `${s.pair} received differs from the quote`);
  }

  const set = read("set_ars_price");
  check(BigInt(set.after.answer) * 100n === BigInt(set.before.answer) * 105n, `feed moved ${set.before.answer} -> ${set.after.answer}, not +5%`);
  const before = BigInt(read("quote_ars_before_move").amountOut.raw);
  const after = BigInt(read("quote_ars_after_move").amountOut.raw);
  const ratioPpm = (after * 1_000_000n) / before;
  check(ratioPpm >= 1_040_000n && ratioPpm <= 1_060_000n, `ARS quote moved by ${Number(ratioPpm - 1_000_000n) / 10_000}% after a +5% oracle move`);

  const again = read("create_ars_again");
  check(again.opcode === "fxswap" && again.opcodeSource === "default", `default opcode resolved to ${again.opcode} (${again.opcodeSource})`);
  check(again.strategyId === ars.strategyId, "re-run without --opcode targeted a different strategy");
  check(!again.steps.some((s) => s.status === "sent"), "re-running create_strategy sent transactions");

  const shared = read("shared");
  const committed = shared.classes.filter((c) => c.lpCommittedUsdc);
  const classFor = (id) => committed.find((c) => c.strategies.some((s) => s.strategyId === id && s.live && s.opcode === "fxswap"));
  const arsClass = classFor(ars.strategyId), brlClass = classFor(brl.strategyId);
  check(shared.usdc.principal.raw === "2000000", `USDC principal ${shared.usdc.principal.raw} != 2000000`);
  check(shared.summary.sharedBacking === true, "sharedBacking is false");
  check(arsClass && brlClass, "live FXSwap ARS/BRL strategies not found under committed classes");
  for (const c of [arsClass, brlClass].filter(Boolean)) {
    check(BigInt(c.usdcVault.classCommittedBacking.raw) >= 2_000_000n, `class ${c.classId} committed USDC ${c.usdcVault.classCommittedBacking.raw} < 2000000`);
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }

  const pct = (ppm) => `${ppm >= 1_000_000n ? "+" : "-"}${(Number(ppm >= 1_000_000n ? ppm - 1_000_000n : 1_000_000n - ppm) / 10_000).toFixed(2)}%`;
  const line = (s) => `${s.amountIn.formatted} USDC -> ${s.received.formatted} ${s.received.symbol} (oracle ${s.pricing.oraclePrice}, execution ${s.pricing.executionPrice}, spread ${s.pricing.effectiveSpreadBps} bps)`;
  console.log(`\n==> SUMMARY (FX_VENUE=${venueMode})`);
  console.log(`   venue: router ${ars.venue.router}, adapter ${ars.venue.adapter}`);
  console.log(`   feeds: ARS/USD ${ars.oracle.feed} (${ars.oracle.price}), BRL/USD ${brl.oracle.feed} (${brl.oracle.price})`);
  console.log(`   deposit: ${shared.usdc.principal.formatted} USDC principal`);
  console.log(`   USDC/ARS FXSwap class ${ars.classId} ${ars.strategyId}: ${line(read("swap_ars"))}`);
  console.log(`   USDC/BRL FXSwap class ${brl.classId} ${brl.strategyId}: ${line(read("swap_brl"))}`);
  console.log(`   ARS/USD feed ${set.before.price} -> ${set.after.price} (${set.change}); 0.1 USDC quote ${read("quote_ars_before_move").amountOut.formatted} -> ${read("quote_ars_after_move").amountOut.formatted} ARGt (${pct(ratioPpm)}); non-owner set refused`);
  console.log(`   shared backing: ${shared.summary.explanation}`);
' "$OUT" "$FX_VENUE" || fail "assertions"

log "PASS: one 2 USDC deposit backs live FXSwap USDC/ARS and USDC/BRL strategies; both swaps filled at oracle prices and quotes followed the ARS/USD move (outputs in $OUT)"
