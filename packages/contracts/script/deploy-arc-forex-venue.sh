#!/usr/bin/env bash
# Deploys the forex venue on Arc Testnet next to the live Aqua:
#   - an AquaForexSwapVMRouter (ForexCurve = opcode 34, Tomás's Shell v1 / DFX forex curve; other swap-vm v1.0.2
#     indices unchanged),
#   - an Aqua0 AquaAdapter bound to that router (an adapter binds exactly one router).
# No feeds are deployed: forex strategies read the live RedStone BRL feed and the ARS ManualFxOracle.
# The adapter needs the same admin wiring as the pegged venue: registry allowlist + VENUE_SETTLER_ROLE per vault.
#
#   MODE=fork  deploy and wire against a local anvil fork of Arc, impersonating the core admin
#   MODE=arc   deploy with a keystore signer, record addresses, and print the admin-only wiring calldata
#
# OPERATOR, if set, gets OPERATOR_ROLE on the new adapter (the shared Circle operator that sends ships users sign).
set -euo pipefail

contracts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$contracts_dir/../.." && pwd)"
deployment_json="$repo_dir/deployments/arc-testnet.json"

fail() {
  echo "FAILED: $1" >&2
  exit 1
}
lower() { tr '[:upper:]' '[:lower:]'; }
expect_eq() {
  [ "$(printf '%s' "$2" | lower)" = "$(printf '%s' "$3" | lower)" ] || fail "$1 (got $2, want $3)"
  echo "  ok  $1"
}
read_json() {
  node -e 'const d = require(process.argv[1]); const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), d); console.log(v ?? "")' \
    "$deployment_json" "$1"
}

MODE="${MODE:-fork}"
AQUA0_CONTRACTS_DIR="${AQUA0_CONTRACTS_DIR:?set AQUA0_CONTRACTS_DIR to the Aqua0 contracts checkout}"
DEPLOYER="${DEPLOYER:?set DEPLOYER to the deploying address}"
OPERATOR="${OPERATOR:-}"
ADAPTER_DOMAIN_VERSION="${ADAPTER_DOMAIN_VERSION:-1}"

AQUA="$(read_json contracts.aqua)"
REGISTRY="$(read_json contracts.vaultRegistry)"
COMPOSER="$(read_json contracts.composer)"
CORE_ADMIN="$(read_json deployer)"
VAULTS=("$(read_json vaults.usdc)" "$(read_json vaults.argt)" "$(read_json vaults.brat)")
[ -n "$AQUA" ] || fail "deployments/arc-testnet.json has no contracts.aqua; deploy the Aqua venue first"

case "$MODE" in
  fork)
    RPC_URL="${RPC_URL:-http://127.0.0.1:8577}"
    export FOUNDRY_BROADCAST="$contracts_dir/cache/fork-broadcast"
    script_signer=(--unlocked --sender "$DEPLOYER")
    tx_signer=(--unlocked --from "$DEPLOYER")
    for account in "$DEPLOYER" "$CORE_ADMIN"; do
      cast rpc --rpc-url "$RPC_URL" anvil_setBalance "$account" 0x56BC75E2D63100000 >/dev/null
      cast rpc --rpc-url "$RPC_URL" anvil_impersonateAccount "$account" >/dev/null
    done
    ;;
  arc)
    RPC_URL="${RPC_URL:-https://rpc.testnet.arc.network}"
    KEYSTORE_ACCOUNT="${KEYSTORE_ACCOUNT:?set KEYSTORE_ACCOUNT}"
    KEYSTORE_PASSWORD_FILE="${KEYSTORE_PASSWORD_FILE:?set KEYSTORE_PASSWORD_FILE}"
    script_signer=(--account "$KEYSTORE_ACCOUNT" --password-file "$KEYSTORE_PASSWORD_FILE" --sender "$DEPLOYER")
    tx_signer=(--account "$KEYSTORE_ACCOUNT" --password-file "$KEYSTORE_PASSWORD_FILE")
    ;;
  *)
    fail "MODE must be fork or arc"
    ;;
esac

chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
[ "$chain_id" = "5042002" ] || fail "RPC chain id $chain_id is not Arc Testnet (5042002)"

echo "==> Deploying AquaForexSwapVMRouter ($MODE)"
(
  cd "$contracts_dir"
  AQUA="$AQUA" ROUTER_OWNER="$DEPLOYER" \
    forge script script/DeployForexVenue.s.sol:DeployForexVenue --rpc-url "$RPC_URL" "${script_signer[@]}" --broadcast --slow
)
run_json="${FOUNDRY_BROADCAST:-$contracts_dir/broadcast}/DeployForexVenue.s.sol/5042002/run-latest.json"
forex_router="$(node -e 'console.log(require(process.argv[1]).returns.router.value)' "$run_json")"
[ -n "$forex_router" ] || fail "DeployForexVenue did not return a router address"
echo "AquaForexSwapVMRouter: $forex_router"

echo "==> Deploying the forex AquaAdapter from $AQUA0_CONTRACTS_DIR"
forex_adapter="$(
  cd "$AQUA0_CONTRACTS_DIR"
  forge create src/aqua/AquaAdapter.sol:AquaAdapter \
    --remappings "@uniswap/v4-core/src/=lib/v4-core/src/" \
    --remappings "@uniswap/v4-core/=lib/v4-core/src/" \
    --out "$contracts_dir/cache/aqua0-out" --cache-path "$contracts_dir/cache/aqua0-cache" \
    --rpc-url "$RPC_URL" "${tx_signer[@]}" --broadcast --json \
    --constructor-args "$DEPLOYER" "$DEPLOYER" "$DEPLOYER" "$REGISTRY" "$COMPOSER" "$AQUA" "$forex_router" \
    "$ADAPTER_DOMAIN_VERSION" |
    grep -oE '"deployedTo": *"0x[0-9a-fA-F]{40}"' | grep -oE '0x[0-9a-fA-F]{40}'
)"
[ -n "$forex_adapter" ] || fail "AquaAdapter deployment did not report an address"
echo "Forex AquaAdapter:     $forex_adapter"

# Same reason as the other venues: one USDC deposit must be able to back several strategies.
echo "==> Allowing one token to back several live strategies"
cast send --rpc-url "$RPC_URL" "${tx_signer[@]}" "$forex_adapter" 'setOneStrategyPerToken(bool)' false >/dev/null

operator_role="$(cast keccak OPERATOR_ROLE)"
if [ -n "$OPERATOR" ]; then
  echo "==> Granting OPERATOR_ROLE to $OPERATOR"
  cast send --rpc-url "$RPC_URL" "${tx_signer[@]}" "$forex_adapter" 'grantRole(bytes32,address)' "$operator_role" "$OPERATOR" >/dev/null
fi

settler_role="$(cast keccak VENUE_SETTLER_ROLE)"
wiring=("$REGISTRY|setAdapterAllowed(address,bool)|$forex_adapter true")
for vault in "${VAULTS[@]}"; do
  wiring+=("$vault|grantRole(bytes32,address)|$settler_role $forex_adapter")
done

if [ "$MODE" = "fork" ]; then
  echo "==> Wiring the forex adapter as core admin $CORE_ADMIN (impersonated)"
  for call in "${wiring[@]}"; do
    IFS='|' read -r to sig args <<<"$call"
    # shellcheck disable=SC2086
    cast send --rpc-url "$RPC_URL" --unlocked --from "$CORE_ADMIN" "$to" "$sig" $args >/dev/null
    echo "  $sig -> $to"
  done
else
  echo "==> Admin wiring for $CORE_ADMIN to send (any order; the allowlist call needs the adapter deployed):"
  for call in "${wiring[@]}"; do
    IFS='|' read -r to sig args <<<"$call"
    # shellcheck disable=SC2086
    echo "  to=$to data=$(cast calldata "$sig" $args)  # $sig"
  done
fi

echo "==> Verifying"
expect_eq "forexRouter.AQUA()" "$(cast call --rpc-url "$RPC_URL" "$forex_router" 'AQUA()(address)')" "$AQUA"
expect_eq "forexAdapter.aqua()" "$(cast call --rpc-url "$RPC_URL" "$forex_adapter" 'aqua()(address)')" "$AQUA"
expect_eq "forexAdapter.aquaSwapVMRouter()" "$(cast call --rpc-url "$RPC_URL" "$forex_adapter" 'aquaSwapVMRouter()(address)')" "$forex_router"
expect_eq "forexAdapter.registry()" "$(cast call --rpc-url "$RPC_URL" "$forex_adapter" 'registry()(address)')" "$REGISTRY"
expect_eq "forexAdapter.oneStrategyPerToken()" "$(cast call --rpc-url "$RPC_URL" "$forex_adapter" 'oneStrategyPerToken()(bool)')" "false"
if [ -n "$OPERATOR" ]; then
  expect_eq "OPERATOR_ROLE on forexAdapter" "$(cast call --rpc-url "$RPC_URL" "$forex_adapter" 'hasRole(bytes32,address)(bool)' "$operator_role" "$OPERATOR")" "true"
fi
if [ "$MODE" = "fork" ]; then
  expect_eq "registry.isAllowedAdapter(forexAdapter)" "$(cast call --rpc-url "$RPC_URL" "$REGISTRY" 'isAllowedAdapter(address)(bool)' "$forex_adapter")" "true"
  for vault in "${VAULTS[@]}"; do
    expect_eq "VENUE_SETTLER_ROLE on $vault" \
      "$(cast call --rpc-url "$RPC_URL" "$vault" 'hasRole(bytes32,address)(bool)' "$settler_role" "$forex_adapter")" "true"
  done
fi

if [ "$MODE" = "arc" ]; then
  node -e '
    const fs = require("fs");
    const [file, router, adapter] = process.argv.slice(1);
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    d.contracts.forexRouter = router;
    d.contracts.forexAquaAdapter = adapter;
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  ' "$deployment_json" "$forex_router" "$forex_adapter"
  echo "Recorded the forex venue in $deployment_json (the adapter is inert until the admin wiring lands)"
fi
