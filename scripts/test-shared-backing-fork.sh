#!/usr/bin/env bash
# Proves the ETHGlobal demo's core Shape-C invariant on a LOCAL Base mainnet fork:
# one USDC principal deposit can consent to/back both an ARS and a BRL strategy
# without splitting the principal between them.
#
# Safety: this script refuses non-local RPC URLs and uses an unlocked Anvil account.
set -euo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:9545}"
case "$RPC_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refusing non-local RPC_URL: $RPC_URL" >&2; exit 2 ;;
esac

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
[[ "$CHAIN_ID" == "8453" ]] || { echo "expected Base fork chainId 8453, got $CHAIN_ID" >&2; exit 2; }

LP="${LP:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"
REGISTRY=0xd3AdBaFb6C59614C6F6a46F1E7346b9629Dd847C
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_VAULT=0xb367A4306087d3981B38C032464cD7E3A7a03A4E
ARGT=0xf016413834E6D1A14F3D628B11D6Ef725a6bdbDD
ARGT_VAULT=0x1D19926a9d1c26fE9551741B6b723d2E38b274A3
BRAT=0xFEE29845569570F8e0119291dff77B7b93283aaB
BRAT_VAULT=0x10949494A4aB52d4935ad10E9c9B0282cCE1DE10
ZERO=0x0000000000000000000000000000000000000000
DEPOSIT=100000000 # 100 USDC, 6 decimals

send_unlocked() {
  cast send "$@" --from "$LP" --unlocked --rpc-url "$RPC_URL" >/dev/null
}

# Find the USDC balance mapping slot from a known live holder instead of silently
# baking an implementation detail into the test fixture.
known_balance="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$USDC_VAULT" --rpc-url "$RPC_URL" | awk '{print $1}')"
balance_slot=""
expected_balance_hex="$(printf '0x%064x' "$known_balance")"
for slot in $(seq 0 32); do
  key="$(cast index address "$USDC_VAULT" "$slot")"
  raw="$(cast storage "$USDC" "$key" --rpc-url "$RPC_URL")"
  if [[ "$raw" == "$expected_balance_hex" ]]; then
    balance_slot="$slot"
    break
  fi
done
[[ -n "$balance_slot" ]] || { echo "could not discover Base USDC balance slot" >&2; exit 1; }

# Give only the local Anvil LP test funds. No live-chain state can be touched.
lp_key="$(cast index address "$LP" "$balance_slot")"
lp_value="$(printf '0x%064x' 1000000000)" # 1,000 USDC
cast rpc --rpc-url "$RPC_URL" anvil_setStorageAt "$USDC" "$lp_key" "$lp_value" >/dev/null

sort_pair() {
  local original_a="$1" original_b="$2" a b
  a="$(printf '%s' "$original_a" | tr '[:upper:]' '[:lower:]')"
  b="$(printf '%s' "$original_b" | tr '[:upper:]' '[:lower:]')"
  if [[ "$a" < "$b" ]]; then printf '%s %s\n' "$original_a" "$original_b"; else printf '%s %s\n' "$original_b" "$original_a"; fi
}

derive_key() {
  local token_a="$1" token_b="$2" label="$3" lo hi label_hash encoded
  read -r lo hi < <(sort_pair "$token_a" "$token_b")
  label_hash="$(cast keccak "$label")"
  encoded="$(cast abi-encode 'f(address,uint256,address,address,bytes32)' "$LP" 8453 "$lo" "$hi" "$label_hash")"
  cast keccak "$encoded"
}

register_class() {
  local key="$1" current
  current="$(cast call "$REGISTRY" 'classForStrategy(bytes32)(uint256)' "$key" --rpc-url "$RPC_URL" | awk '{print $1}')"
  if [[ "$current" == "0" ]]; then
    send_unlocked "$REGISTRY" 'registerStrategyClass(bytes32)' "$key"
    current="$(cast call "$REGISTRY" 'classForStrategy(bytes32)(uint256)' "$key" --rpc-url "$RPC_URL" | awk '{print $1}')"
  fi
  printf '%s\n' "$current"
}

register_leg() {
  local vault="$1" strategy_id="$2" owner
  owner="$(cast call "$vault" 'classStrategist(uint256)(address)' "$strategy_id" --rpc-url "$RPC_URL")"
  owner_lc="$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')"
  lp_lc="$(printf '%s' "$LP" | tr '[:upper:]' '[:lower:]')"
  if [[ "$owner_lc" == "$ZERO" ]]; then
    send_unlocked "$vault" 'registerStrategy(uint256,address)' "$strategy_id" "$LP"
  elif [[ "$owner_lc" != "$lp_lc" ]]; then
    echo "strategy $strategy_id on $vault belongs to unexpected strategist $owner" >&2
    exit 1
  fi
}

ars_key="$(derive_key "$USDC" "$ARGT" 'ETHGlobal FXSwap ARS proof')"
brl_key="$(derive_key "$USDC" "$BRAT" 'ETHGlobal FXSwap BRL proof')"
ars_id="$(register_class "$ars_key")"
brl_id="$(register_class "$brl_key")"
[[ "$ars_id" != "$brl_id" ]] || { echo "strategy ids unexpectedly collide" >&2; exit 1; }

register_leg "$USDC_VAULT" "$ars_id"
register_leg "$ARGT_VAULT" "$ars_id"
register_leg "$USDC_VAULT" "$brl_id"
register_leg "$BRAT_VAULT" "$brl_id"

principal_before="$(cast call "$USDC_VAULT" 'principal(address)(uint256)' "$LP" --rpc-url "$RPC_URL" | awk '{print $1}')"
send_unlocked "$USDC" 'approve(address,uint256)' "$USDC_VAULT" "$DEPOSIT"
send_unlocked "$USDC_VAULT" 'deposit(uint256,address)' "$DEPOSIT" "$LP"
send_unlocked "$USDC_VAULT" 'setCommitment(uint256,bool)' "$ars_id" true
send_unlocked "$USDC_VAULT" 'setCommitment(uint256,bool)' "$brl_id" true

principal="$(cast call "$USDC_VAULT" 'principal(address)(uint256)' "$LP" --rpc-url "$RPC_URL" | awk '{print $1}')"
ars_backing="$(cast call "$USDC_VAULT" 'committedBacking(uint256)(uint256)' "$ars_id" --rpc-url "$RPC_URL" | awk '{print $1}')"
brl_backing="$(cast call "$USDC_VAULT" 'committedBacking(uint256)(uint256)' "$brl_id" --rpc-url "$RPC_URL" | awk '{print $1}')"
ars_available="$(cast call "$USDC_VAULT" 'availableFor(uint256)(uint256)' "$ars_id" --rpc-url "$RPC_URL" | awk '{print $1}')"
brl_available="$(cast call "$USDC_VAULT" 'availableFor(uint256)(uint256)' "$brl_id" --rpc-url "$RPC_URL" | awk '{print $1}')"

expected_principal=$((principal_before + DEPOSIT))
[[ "$principal" == "$expected_principal" ]] || { echo "principal mismatch: got $principal expected $expected_principal" >&2; exit 1; }
[[ "$ars_backing" == "$principal" ]] || { echo "ARS backing mismatch: $ars_backing vs principal $principal" >&2; exit 1; }
[[ "$brl_backing" == "$principal" ]] || { echo "BRL backing mismatch: $brl_backing vs principal $principal" >&2; exit 1; }
[[ "$ars_available" == "$principal" ]] || { echo "ARS available mismatch: $ars_available vs principal $principal" >&2; exit 1; }
[[ "$brl_available" == "$principal" ]] || { echo "BRL available mismatch: $brl_available vs principal $principal" >&2; exit 1; }

cat <<OUT
Shape-C shared backing proof: PASS
LP: $LP
USDC principal deposited: $principal
ARS strategyId: $ars_id | backing: $ars_backing | available: $ars_available
BRL strategyId: $brl_id | backing: $brl_backing | available: $brl_available
Invariant: the same $principal USDC principal backs both strategies; no split occurred.
OUT
