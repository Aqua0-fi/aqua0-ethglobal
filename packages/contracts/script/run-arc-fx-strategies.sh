#!/usr/bin/env bash
# Runs ArcFxStrategies: one USDC deposit backing a USDC/ARGt and a USDC/BRAt strategy, each shipped through the
# Aqua0 AquaAdapter and filled once through the AquaSwapVMRouter.
#
#   MODE=fork  against a local anvil fork of Arc that already ran `deploy-arc-aqua-venue.sh` with MODE=fork
#              (pass AQUA_ADAPTER and AQUA_SWAPVM_ROUTER as that run printed them)
#   MODE=arc   against Arc Testnet, after the venue is deployed, recorded in deployments/arc-testnet.json,
#              and wired by the core admin
set -euo pipefail

contracts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$contracts_dir/../.." && pwd)"
deployment_json="$repo_dir/deployments/arc-testnet.json"

MODE="${MODE:-fork}"
DEPLOYER="${DEPLOYER:?set DEPLOYER to the signing address}"
KEYSTORE_ACCOUNT="${KEYSTORE_ACCOUNT:?set KEYSTORE_ACCOUNT}"
KEYSTORE_PASSWORD_FILE="${KEYSTORE_PASSWORD_FILE:?set KEYSTORE_PASSWORD_FILE}"

read_json() {
  node -e 'const d = require(process.argv[1]); const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), d); console.log(v ?? "")' \
    "$deployment_json" "$1"
}

export VAULT_REGISTRY="$(read_json contracts.vaultRegistry)"
export USDC="$(read_json assets.usdc)"
export ARGT="$(read_json assets.argt)"
export BRAT="$(read_json assets.brat)"
export USDC_VAULT="$(read_json vaults.usdc)"
export ARGT_VAULT="$(read_json vaults.argt)"
export BRAT_VAULT="$(read_json vaults.brat)"

case "$MODE" in
  fork)
    RPC_URL="${RPC_URL:-http://127.0.0.1:8577}"
    export FOUNDRY_BROADCAST="$contracts_dir/cache/fork-broadcast"
    export AQUA_ADAPTER="${AQUA_ADAPTER:?on a fork, pass the AquaAdapter the fork deploy printed}"
    export AQUA_SWAPVM_ROUTER="${AQUA_SWAPVM_ROUTER:?on a fork, pass the AquaSwapVMRouter the fork deploy printed}"
    cast rpc --rpc-url "$RPC_URL" anvil_setBalance "$DEPLOYER" 0x56BC75E2D63100000 >/dev/null
    cast rpc --rpc-url "$RPC_URL" anvil_impersonateAccount "$DEPLOYER" >/dev/null
    # Arc's USDC ERC-20 interface calls native precompiles (e.g. a blocklist check at 0x1800…0001) that anvil
    # does not implement, so every USDC transfer reverts on a fork. For the fork only, stand the demo token's
    # plain ERC-20 code in at the USDC address and mint the signer some USDC. Real Arc runs never do this.
    cast rpc --rpc-url "$RPC_URL" anvil_setCode "$USDC" "$(cast code --rpc-url "$RPC_URL" "$ARGT")" >/dev/null
    cast send --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" "$USDC" 'mint(address,uint256)' "$DEPLOYER" 100000000 >/dev/null
    ;;
  arc)
    RPC_URL="${RPC_URL:-https://rpc.testnet.arc.network}"
    export AQUA_ADAPTER="$(read_json contracts.aquaAdapter)"
    export AQUA_SWAPVM_ROUTER="$(read_json contracts.aquaSwapVMRouter)"
    if [ -z "$AQUA_ADAPTER" ] || [ -z "$AQUA_SWAPVM_ROUTER" ]; then
      echo "deployments/arc-testnet.json has no aquaAdapter/aquaSwapVMRouter; run deploy-arc-aqua-venue.sh with MODE=arc first" >&2
      exit 1
    fi
    ;;
  *)
    echo "MODE must be fork or arc" >&2
    exit 1
    ;;
esac

chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [ "$chain_id" != "5042002" ]; then
  echo "Refusing to run: RPC chain id $chain_id is not Arc Testnet (5042002)" >&2
  exit 1
fi

cd "$contracts_dir"
forge script script/ArcFxStrategies.s.sol:ArcFxStrategies \
  --rpc-url "$RPC_URL" --account "$KEYSTORE_ACCOUNT" --password-file "$KEYSTORE_PASSWORD_FILE" --sender "$DEPLOYER" \
  --broadcast --slow
