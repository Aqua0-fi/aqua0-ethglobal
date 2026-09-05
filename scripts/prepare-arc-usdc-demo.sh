#!/usr/bin/env bash
# Print (never broadcast) the three Arc Testnet transactions for a 1 USDC demo deposit
# and commitment to the already-live ARS strategy class.
set -euo pipefail

USDC=0x3600000000000000000000000000000000000000
USDC_VAULT=0x99c2ab427b29dB1Cc14D228d970596015d1C4429
DEFAULT_OWNER=0xBaA361817C8676b4A8a8C5e6fd050253f81f407C
OWNER="${OWNER:-$DEFAULT_OWNER}"
AMOUNT="${AMOUNT:-1000000}" # 1 USDC, 6 decimals
STRATEGY_ID="${STRATEGY_ID:-1}"

case "$OWNER" in
  0x????????????????????????????????????????) ;;
  *) echo "OWNER must be a 20-byte EVM address" >&2; exit 2 ;;
esac
[[ "$AMOUNT" =~ ^[0-9]+$ ]] || { echo "AMOUNT must be raw integer units" >&2; exit 2; }
[[ "$STRATEGY_ID" =~ ^[0-9]+$ ]] || { echo "STRATEGY_ID must be an integer" >&2; exit 2; }

approve_data="$(cast calldata 'approve(address,uint256)' "$USDC_VAULT" "$AMOUNT")"
deposit_data="$(cast calldata 'deposit(uint256,address)' "$AMOUNT" "$OWNER")"
commit_data="$(cast calldata 'setCommitment(uint256,bool)' "$STRATEGY_ID" true)"

cat <<OUT
Arc Testnet demo transaction plan (PREPARE ONLY; nothing broadcast)
1. USDC approve
   to:   $USDC
   data: $approve_data
2. Shape-C deposit
   to:   $USDC_VAULT
   data: $deposit_data
3. Commit the same principal to ARS class $STRATEGY_ID
   to:   $USDC_VAULT
   data: $commit_data

Owner: $OWNER
Raw USDC amount: $AMOUNT
OUT
