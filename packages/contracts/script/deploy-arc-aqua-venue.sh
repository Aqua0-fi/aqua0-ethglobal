#!/usr/bin/env bash
# Deploys the 1inch Aqua + AquaSwapVMRouter venue (swap-vm v1.0.2) and the Aqua0 AquaAdapter on Arc Testnet,
# then wires the adapter into the live Shape-C core: registry allowlist + VENUE_SETTLER_ROLE on every vault.
#
#   MODE=fork  deploy and wire against a local anvil fork of Arc, impersonating the core admin
#   MODE=arc   deploy with a keystore signer, then print the admin-only wiring calldata
#
# The wiring calls need DEFAULT_ADMIN_ROLE on the registry and CAPITAL_ADMIN_ROLE on the vaults, which only
# the core deployer holds, so MODE=arc never sends them.
set -euo pipefail

contracts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$contracts_dir/../.." && pwd)"
deployment_json="$repo_dir/deployments/arc-testnet.json"

MODE="${MODE:-fork}"
AQUA0_CONTRACTS_DIR="${AQUA0_CONTRACTS_DIR:?set AQUA0_CONTRACTS_DIR to the Aqua0 contracts checkout}"
DEPLOYER="${DEPLOYER:?set DEPLOYER to the deploying address}"
ADAPTER_DOMAIN_VERSION="${ADAPTER_DOMAIN_VERSION:-1}"

read_json() {
  node -e 'const d = require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o, k) => o[k], d))' \
    "$deployment_json" "$1"
}

lower() { tr '[:upper:]' '[:lower:]'; }

REGISTRY="$(read_json contracts.vaultRegistry)"
COMPOSER="$(read_json contracts.composer)"
CORE_ADMIN="$(read_json deployer)"
VAULTS=("$(read_json vaults.usdc)" "$(read_json vaults.argt)" "$(read_json vaults.brat)")

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
    echo "MODE must be fork or arc" >&2
    exit 1
    ;;
esac

chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [ "$chain_id" != "5042002" ]; then
  echo "Refusing to deploy: RPC chain id $chain_id is not Arc Testnet (5042002)" >&2
  exit 1
fi

echo "==> Deploying Aqua + AquaSwapVMRouter ($MODE)"
(
  cd "$contracts_dir"
  ROUTER_OWNER="$DEPLOYER" forge script script/DeployAquaVenue.s.sol:DeployAquaVenue \
    --rpc-url "$RPC_URL" "${script_signer[@]}" --broadcast --slow
)
run_json="${FOUNDRY_BROADCAST:-$contracts_dir/broadcast}/DeployAquaVenue.s.sol/5042002/run-latest.json"
aqua="$(node -e 'console.log(require(process.argv[1]).returns.aqua.value)' "$run_json")"
router="$(node -e 'console.log(require(process.argv[1]).returns.router.value)' "$run_json")"
echo "Aqua:             $aqua"
echo "AquaSwapVMRouter: $router"

echo "==> Deploying AquaAdapter from $AQUA0_CONTRACTS_DIR"
adapter="$(
  cd "$AQUA0_CONTRACTS_DIR"
  forge create src/aqua/AquaAdapter.sol:AquaAdapter \
    --remappings "@uniswap/v4-core/src/=lib/v4-core/src/" \
    --remappings "@uniswap/v4-core/=lib/v4-core/src/" \
    --out "$contracts_dir/cache/aqua0-out" --cache-path "$contracts_dir/cache/aqua0-cache" \
    --rpc-url "$RPC_URL" "${tx_signer[@]}" --broadcast --json \
    --constructor-args "$DEPLOYER" "$DEPLOYER" "$DEPLOYER" "$REGISTRY" "$COMPOSER" "$aqua" "$router" \
    "$ADAPTER_DOMAIN_VERSION" |
    grep -oE '"deployedTo": *"0x[0-9a-fA-F]{40}"' | grep -oE '0x[0-9a-fA-F]{40}'
)"
[ -n "$adapter" ] || fail "AquaAdapter deployment did not report an address"
echo "AquaAdapter:      $adapter"

# The adapter ships with `oneStrategyPerToken = true`, which refuses a second live strategy on a token that
# already backs one. The Arc demo is exactly that: one USDC position backing both FX strategies. The vault's own
# settle-time debit and outflow meter remain the capital bound, so the deployer (adapter admin) turns it off.
echo "==> Allowing one token to back several live strategies"
cast send --rpc-url "$RPC_URL" "${tx_signer[@]}" "$adapter" 'setOneStrategyPerToken(bool)' false >/dev/null

settler_role="$(cast keccak VENUE_SETTLER_ROLE)"
wiring=("$REGISTRY|setAdapterAllowed(address,bool)|$adapter true")
for vault in "${VAULTS[@]}"; do
  wiring+=("$vault|grantRole(bytes32,address)|$settler_role $adapter")
done

if [ "$MODE" = "fork" ]; then
  echo "==> Wiring adapter as core admin $CORE_ADMIN (impersonated)"
  for call in "${wiring[@]}"; do
    IFS='|' read -r to sig args <<<"$call"
    # shellcheck disable=SC2086
    cast send --rpc-url "$RPC_URL" --unlocked --from "$CORE_ADMIN" "$to" "$sig" $args >/dev/null
    echo "  $sig -> $to"
  done
else
  echo "==> Admin wiring for $CORE_ADMIN to send (in order):"
  for call in "${wiring[@]}"; do
    IFS='|' read -r to sig args <<<"$call"
    # shellcheck disable=SC2086
    echo "  to=$to data=$(cast calldata "$sig" $args)  # $sig"
  done
fi

echo "==> Verifying"
fail() {
  echo "FAILED: $1" >&2
  exit 1
}
expect_eq() {
  [ "$(printf '%s' "$2" | lower)" = "$(printf '%s' "$3" | lower)" ] || fail "$1 (got $2, want $3)"
  echo "  ok  $1"
}
expect_eq "router.AQUA()" "$(cast call --rpc-url "$RPC_URL" "$router" 'AQUA()(address)')" "$aqua"
expect_eq "adapter.aqua()" "$(cast call --rpc-url "$RPC_URL" "$adapter" 'aqua()(address)')" "$aqua"
expect_eq "adapter.aquaSwapVMRouter()" "$(cast call --rpc-url "$RPC_URL" "$adapter" 'aquaSwapVMRouter()(address)')" "$router"
expect_eq "adapter.registry()" "$(cast call --rpc-url "$RPC_URL" "$adapter" 'registry()(address)')" "$REGISTRY"
expect_eq "adapter.oneStrategyPerToken()" "$(cast call --rpc-url "$RPC_URL" "$adapter" 'oneStrategyPerToken()(bool)')" "false"
if [ "$MODE" = "fork" ]; then
  expect_eq "registry.isAllowedAdapter" "$(cast call --rpc-url "$RPC_URL" "$REGISTRY" 'isAllowedAdapter(address)(bool)' "$adapter")" "true"
  for vault in "${VAULTS[@]}"; do
    expect_eq "VENUE_SETTLER_ROLE on $vault" \
      "$(cast call --rpc-url "$RPC_URL" "$vault" 'hasRole(bytes32,address)(bool)' "$settler_role" "$adapter")" "true"
  done
fi

if [ "$MODE" = "arc" ]; then
  node -e '
    const fs = require("fs");
    const [file, aqua, router, adapter] = process.argv.slice(1);
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    d.contracts.aqua = aqua;
    d.contracts.aquaSwapVMRouter = router;
    d.contracts.aquaAdapter = adapter;
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  ' "$deployment_json" "$aqua" "$router" "$adapter"
  echo "Recorded venue addresses in $deployment_json (adapter is inert until the admin wiring lands)"
fi
