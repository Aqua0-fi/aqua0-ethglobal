import assert from "node:assert/strict";
import test from "node:test";

import { assertExecutionAllowed, deriveStrategyKey } from "../src/write.js";

test("deriveStrategyKey matches the current Aqua0 frontend/cast vector", () => {
  const result = deriveStrategyKey({
    strategist: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    chainId: 5042002,
    token0: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    token1: "0x3600000000000000000000000000000000000000",
    label: "  ETHGlobal FXSwap ARS proof  "
  });

  assert.equal(
    result.strategyKey,
    "0xd8ab2e5831a3ea2e67602d13dcd3d770519aad59c722496ced68ae4c3c12e7e6"
  );
  assert.equal(result.sortedToken0, "0x3600000000000000000000000000000000000000");
  assert.equal(result.sortedToken1, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(result.label, "ETHGlobal FXSwap ARS proof");
});

test("execution guard refuses mainnet and Base even with execute mode credentials", () => {
  const baseConfig = {
    mcpWriteMode: "execute" as const,
    writeRpcUrl: "https://mainnet.base.org",
    writeChainId: 8453,
    writePrivateKey: `0x${"11".repeat(32)}`
  };
  assert.throws(() => assertExecutionAllowed(baseConfig), /mainnet\/Base writes are not allowed/);

  const mainnetConfig = {
    ...baseConfig,
    writeRpcUrl: "https://ethereum-rpc.publicnode.com",
    writeChainId: 1
  };
  assert.throws(() => assertExecutionAllowed(mainnetConfig), /mainnet\/Base writes are not allowed/);
});
