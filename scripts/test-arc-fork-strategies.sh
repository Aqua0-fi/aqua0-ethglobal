#!/usr/bin/env bash
# Arc Testnet FORK integration test for the Aqua0 SwapVM terminal flow. Not run in CI.
#
# Starts anvil forking Arc on 127.0.0.1:8579, sends the adapter wiring the core/adapter admins have
# not sent on the real chain yet (impersonated, fork only), then drives the ETHGlobal demo through the
# CLI, which calls the same @aqua0/shared service functions as the MCP tools, in MCP_WRITE_MODE=execute:
#   deposit 2 USDC -> create USDC/ARS + USDC/BRL strategies -> quote + swap 0.1 USDC on each
#   -> shared-backing read shows the same 2 USDC committed to both classes.
#
# Safety: every RPC call goes to the local fork. The signer is a throwaway key generated per run and
# never printed.
# Env: ARC_FORK_URL (default https://rpc.testnet.arc.network), REUSE_ANVIL=1 to use an already
# running fork on port 8579 instead of starting one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8579
RPC_URL="http://127.0.0.1:${PORT}"
FORK_URL="${ARC_FORK_URL:-https://rpc.testnet.arc.network}"
ARC_CHAIN_ID=5042002

CORE_ADMIN=0xBaA361817C8676b4A8a8C5e6fd050253f81f407C
ADAPTER_ADMIN=0x7E61A5EbCCd26d9D91690C6037d7224F5384730D
REGISTRY=0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf
ADAPTER=0xbF72D34b804636496c3308796908152b82624Ca5
USDC=0x3600000000000000000000000000000000000000
ARGT=0xd8dE250970842A581f89E885dA0F5165037714Ef
VAULTS=(0x99c2ab427b29dB1Cc14D228d970596015d1C4429 0x8a3d6188C58d7877499592E179DfE3bd80c4F460 0xEcB132648B781ec5742b582c526243Eeef900785)
ARS_STRATEGY_ID=0x5e8668583f2e4a8e23680ebc5bb687c35769d977be9b5e115d13b01ecca3a2e4
BRL_STRATEGY_ID=0xe16591490b549dd816c0d4cd2df92cfedbc0680eb295f4550cb47bd5f6d94be1
# Not anvil's dev account 0: on Arc Testnet that address carries an EIP-7702 delegation, so the
# AquaAdapter checks its ship signature via ERC-1271 and rejects it (NotStrategist).
wallet_json="$(cast wallet new --json)"
SIGNER="$(node -e 'console.log(JSON.parse(process.argv[1])[0].address)' "$wallet_json")"
SIGNER_KEY="$(node -e 'console.log(JSON.parse(process.argv[1])[0].private_key)' "$wallet_json")"
unset wallet_json

log() { printf '\n==> %s\n' "$*"; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; }

if port_open; then
  if [[ "${REUSE_ANVIL:-0}" != "1" ]]; then
    echo "port ${PORT} is already in use; stop that process or set REUSE_ANVIL=1 to reuse a running Arc fork" >&2
    exit 2
  fi
  log "reusing the Arc fork already listening on ${RPC_URL}"
else
  log "starting anvil fork of ${FORK_URL} on ${RPC_URL}"
  anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
  ANVIL_PID=$!
  trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do
    port_open && break
    sleep 0.5
  done
fi

chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
[[ "$chain_id" == "$ARC_CHAIN_ID" ]] || { echo "expected Arc fork chain id ${ARC_CHAIN_ID}, got ${chain_id}" >&2; exit 2; }

rpc() { cast rpc --rpc-url "$RPC_URL" "$@" >/dev/null; }
send_as() {
  local from="$1"
  shift
  rpc anvil_impersonateAccount "$from"
  cast send --rpc-url "$RPC_URL" --unlocked --from "$from" "$@" >/dev/null
  rpc anvil_stopImpersonatingAccount "$from"
}

log "funding gas and wiring the AquaAdapter (fork only)"
for account in "$CORE_ADMIN" "$ADAPTER_ADMIN" "$SIGNER"; do
  rpc anvil_setBalance "$account" 0x3635C9ADC5DEA00000
done
send_as "$CORE_ADMIN" "$REGISTRY" 'setAdapterAllowed(address,bool)' "$ADAPTER" true
venue_settler_role="$(cast keccak VENUE_SETTLER_ROLE)"
for vault in "${VAULTS[@]}"; do
  send_as "$CORE_ADMIN" "$vault" 'grantRole(bytes32,address)' "$venue_settler_role" "$ADAPTER"
done
send_as "$ADAPTER_ADMIN" "$ADAPTER" 'grantRole(bytes32,address)' "$(cast keccak OPERATOR_ROLE)" "$SIGNER"

log "replacing Arc's USDC (native precompile-backed) with ARGt's open-mint ERC-20 code and minting 10 USDC"
rpc anvil_setCode "$USDC" "$(cast code "$ARGT" --rpc-url "$RPC_URL")"
send_as "$SIGNER" "$USDC" 'mint(address,uint256)' "$SIGNER" 10000000

log "building @aqua0/shared and @aqua0/cli"
(cd "$ROOT" && pnpm --filter @aqua0/shared build >/dev/null && pnpm --filter @aqua0/cli build >/dev/null)

export GRAPH_ENDPOINT="http://127.0.0.1:9/graph-not-used-by-these-commands"
export WRITE_RPC_URL="$RPC_URL" WRITE_CHAIN_ID="$ARC_CHAIN_ID" MCP_WRITE_MODE=execute WRITE_PRIVATE_KEY="$SIGNER_KEY"
unset VAULT_REGISTRY_ADDRESS AQUA_ADAPTER_ADDRESS AQUA_SWAPVM_ROUTER_ADDRESS FXSWAP_ROUTER_ADDRESS

OUT="$(mktemp -d)"
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
    if (r.summary) {
      console.log(`   source: ${r.source} - ${r.sourceNote}`);
      console.log(`   USDC principal (counted once): ${amt(r.usdc.principal)} | free: ${amt(r.usdc.freePrincipal)}`);
      for (const c of r.classes) {
        console.log(`   class ${c.classId} ${c.pair}: lpCommittedUsdc=${c.lpCommittedUsdc} USDC classCommittedBacking=${amt(c.usdcVault.classCommittedBacking)} classAvailableFor=${amt(c.usdcVault.classAvailableFor)} | ${c.fxVault ? `${c.fxVault.token} committed=${amt(c.fxVault.classCommittedBacking)} available=${amt(c.fxVault.classAvailableFor)}` : "no FX leg"}`);
        for (const s of c.strategies) console.log(`     strategy ${s.strategyId} live=${s.live} feePpb=${s.feePpb} amounts=${s.strategyAmounts ? `${amt(s.strategyAmounts.usdc)} + ${amt(s.strategyAmounts.fx)}` : "n/a"}`);
      }
      console.log(`   sharedBacking=${r.summary.sharedBacking}: ${r.summary.explanation}`);
    } else if (r.program) {
      console.log(`   ${r.pair} class ${r.classId} strategyId ${r.strategyId} live=${r.live}`);
      console.log(`   program: ${r.program.price}, fee ${r.program.feeBps} bps, ships ${amt(r.program.usdcShip)} + ${amt(r.program.fxShip)}`);
      steps(r.steps);
      if (r.backing) console.log(`   USDC leg: lpPrincipal=${amt(r.backing.usdc.lpPrincipal)} classCommittedBacking=${amt(r.backing.usdc.classCommittedBacking)} classAvailableFor=${amt(r.backing.usdc.classAvailableFor)}`);
    } else if (r.received) {
      console.log(`   ${r.pair} ${r.strategyId}: in ${amt(r.amountIn)}, quoted ${amt(r.quotedAmountOut)}, min ${amt(r.minAmountOut)}, received ${amt(r.received)} (${r.rate})`);
      steps(r.steps);
    } else if (r.amountOut) {
      console.log(`   ${r.pair} ${r.strategyId}: ${amt(r.amountIn)} -> ${amt(r.amountOut)} (${r.rate})`);
    } else {
      console.log(`   deposited ${amt(r.amount)} to ${r.vault} for ${r.receiver}; principal now ${amt(r.position?.principal)}`);
      steps(r.steps);
    }
  ' "$1"
}
field() { node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2].split(".").reduce((v,k)=>v?.[k], r))' "$@"; }

run deposit deposit --token USDC --amount 2
run create_ars create-strategy --pair USDC/ARS --chain arc-testnet --opcode pegged
run create_brl create-strategy --pair "usdc to brl" --chain arc-testnet --opcode pegged
run quote_ars quote --pair USDC/ARS --amount 0.1
run swap_ars swap --pair USDC/ARS --amount 0.1
run quote_brl quote --pair USDC/BRL --amount 0.1
run swap_brl swap --pair USDC/BRL --amount 0.1
run create_ars_again create-strategy --pair USDC/ARS
run shared shared-backing "$SIGNER"

log "assertions"
fail() { echo "FAIL: $*" >&2; exit 1; }
[[ "$(field "$OUT/create_ars.json" strategyId)" == "$ARS_STRATEGY_ID" ]] || fail "ARS strategyId mismatch"
[[ "$(field "$OUT/create_brl.json" strategyId)" == "$BRL_STRATEGY_ID" ]] || fail "BRL strategyId mismatch"
[[ "$(field "$OUT/swap_ars.json" received.raw)" != "0" ]] || fail "ARS swap received nothing"
[[ "$(field "$OUT/swap_brl.json" received.raw)" != "0" ]] || fail "BRL swap received nothing"
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (r.steps.some((s) => s.status === "sent")) { console.error("re-running create_strategy sent transactions"); process.exit(1); }
' "$OUT/create_ars_again.json" || fail "create_strategy is not idempotent"
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const [ars, brl] = [process.argv[2], process.argv[3]];
  const classes = r.classes.filter((c) => c.lpCommittedUsdc);
  const byStrategy = (id) => classes.find((c) => c.strategies.some((s) => s.strategyId === id && s.live));
  const problems = [];
  if (r.usdc.principal.raw !== "2000000") problems.push(`USDC principal ${r.usdc.principal.raw} != 2000000`);
  if (!r.summary.sharedBacking) problems.push("sharedBacking is false");
  const arsClass = byStrategy(ars), brlClass = byStrategy(brl);
  if (!arsClass || !brlClass) problems.push("live ARS/BRL strategies not found under committed classes");
  if (arsClass && brlClass && arsClass.classId === brlClass.classId) problems.push("ARS and BRL share a class");
  for (const c of [arsClass, brlClass].filter(Boolean)) {
    if (BigInt(c.usdcVault.classCommittedBacking.raw) < 2000000n) problems.push(`class ${c.classId} committed USDC backing ${c.usdcVault.classCommittedBacking.raw} < 2000000`);
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
' "$OUT/shared.json" "$ARS_STRATEGY_ID" "$BRL_STRATEGY_ID" || fail "shared backing check"

log "PASS: one 2 USDC deposit backs live USDC/ARS and USDC/BRL SwapVM strategies; both swaps filled (outputs in $OUT)"
