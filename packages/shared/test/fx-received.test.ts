import assert from "node:assert/strict";
import test from "node:test";

import { keccak256, padHex, toBytes, toHex } from "viem";

import { receivedFromTransferLogs } from "../src/fx.js";

const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
const USDC = "0x3600000000000000000000000000000000000000";
const ARGT = "0xd8dE250970842A581f89E885dA0F5165037714Ef";
const TAKER = "0xB0C0687EB013A5FFDE4D23A89398A11BC424D952";
const VAULT = "0x99c2ab427b29dB1Cc14D228d970596015d1C4429";

function transfer(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: [TRANSFER, padHex(from.toLowerCase() as `0x${string}`, { size: 32 }), padHex(to.toLowerCase() as `0x${string}`, { size: 32 })],
    data: toHex(amount, { size: 32 })
  };
}

test("swap output comes from the token's Transfer logs to the taker, not the balance change", () => {
  // The rebalance swap on Arc: 0.0994 USDC reached the taker, while the balance change was 0.071514 USDC
  // because USDC also paid the transaction's gas.
  const logs = [
    transfer(ARGT, TAKER, VAULT, 139_580_000_000_000_000_000n),
    transfer(USDC, VAULT, TAKER, 99_400n),
    { address: USDC, topics: [keccak256(toBytes("Approval(address,address,uint256)")), padHex(TAKER.toLowerCase() as `0x${string}`, { size: 32 })], data: toHex(1n, { size: 32 }) }
  ];
  assert.equal(receivedFromTransferLogs(logs, USDC, TAKER), 99_400n);
  assert.equal(receivedFromTransferLogs(logs, USDC.toUpperCase().replace("0X", "0x"), TAKER.toLowerCase()), 99_400n);
});

test("several transfers of the output token to the taker are summed; other tokens and recipients are ignored", () => {
  const logs = [transfer(USDC, VAULT, TAKER, 60_000n), transfer(USDC, VAULT, TAKER, 39_400n), transfer(USDC, TAKER, VAULT, 5_000n), transfer(ARGT, VAULT, TAKER, 7n)];
  assert.equal(receivedFromTransferLogs(logs, USDC, TAKER), 99_400n);
});

test("no matching Transfer log returns undefined so the caller can fall back to the balance change", () => {
  assert.equal(receivedFromTransferLogs([transfer(ARGT, VAULT, TAKER, 1n)], USDC, TAKER), undefined);
  assert.equal(receivedFromTransferLogs([], USDC, TAKER), undefined);
});
