import assert from "node:assert/strict";
import test from "node:test";

import { encodeFunctionData, getAddress, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { assetVaultAbi } from "../src/abis.js";
import {
  executeCircleContractCall,
  provisioningIdempotencyKey,
  resolveCircleWallet,
  serializeTypedDataForCircle,
  signTypedDataWithCircle,
  type CircleWalletsApi
} from "../src/circle.js";
import { Aqua0Service } from "../src/service.js";
import { readSignerEnv, resolveSignerAddress } from "../src/signer.js";
import { buildShipTypedData } from "../src/swapvm.js";
import { assertExecutionAllowed, createWriteSigner, isExecutionAllowedByConfig } from "../src/write.js";

const signerAccount = privateKeyToAccount(`0x${"11".repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${"22".repeat(32)}`);
const signerAddress = signerAccount.address.toLowerCase();
const API_KEY = "TEST_API_KEY:0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210";
const ENTITY_SECRET = "ab".repeat(32);
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const VAULT = getAddress(`0x${"12".repeat(20)}`);

const circleExecute = {
  mcpWriteMode: "execute" as const,
  writeRpcUrl: "https://rpc.testnet.arc.network",
  writeChainId: 5042002,
  signer: "circle" as const,
  circleApiKey: API_KEY,
  circleEntitySecret: ENTITY_SECRET,
  circleWalletId: "wallet-1"
};

type CircleCall = { method: string; input: Record<string, unknown> };

function mockCircle(handlers: Record<string, (input: any) => unknown>) {
  const calls: CircleCall[] = [];
  const api = new Proxy(
    {},
    {
      get: (_target, method) => async (input: Record<string, unknown>) => {
        calls.push({ method: String(method), input });
        const handler = handlers[String(method)];
        if (!handler) {
          throw new Error(`unexpected Circle call ${String(method)}`);
        }
        return handler(input);
      }
    }
  );
  return { api: api as unknown as CircleWalletsApi, calls };
}

function wallet(overrides: Record<string, unknown> = {}) {
  return {
    id: "wallet-1",
    address: signerAccount.address,
    blockchain: "ARC-TESTNET",
    accountType: "EOA",
    state: "LIVE",
    refId: "user-1",
    createDate: "2026-09-01T00:00:00Z",
    ...overrides
  };
}

function shipTypedData() {
  return buildShipTypedData({
    chainId: 5042002,
    adapter: "0xbF72D34b804636496c3308796908152b82624Ca5",
    classId: 42n,
    strategyId: `0x${"cd".repeat(32)}`,
    tokens: ["0x3600000000000000000000000000000000000000", "0x1111111111111111111111111111111111111111"],
    amounts: [2_000_000n, 2_800n * 10n ** 18n],
    feePpb: 500_000,
    nonce: 3n,
    deadline: 1_790_000_000n
  });
}

test("readSignerEnv defaults to local and reads Circle settings only for SIGNER=circle", () => {
  assert.deepEqual(readSignerEnv({ CIRCLE_API_KEY: API_KEY, ENTITY_SECRET }), { signer: "local" });
  assert.deepEqual(
    readSignerEnv({
      SIGNER: "circle",
      CIRCLE_API_KEY: API_KEY,
      ENTITY_SECRET,
      CIRCLE_WALLET_SET_ID: "set-1",
      CIRCLE_USER_REF: "user-1"
    }),
    {
      signer: "circle",
      circleApiKey: API_KEY,
      circleEntitySecret: ENTITY_SECRET,
      circleWalletSetId: "set-1",
      circleUserRef: "user-1"
    }
  );
  assert.equal(
    readSignerEnv({ SIGNER: "circle", CIRCLE_ENTITY_SECRET: "preferred", ENTITY_SECRET: "fallback" }).circleEntitySecret,
    "preferred"
  );
  assert.throws(() => readSignerEnv({ SIGNER: "privy" }), /SIGNER must be local or circle/);
});

test("execution guard accepts a configured Circle signer without WRITE_PRIVATE_KEY and keeps the chain guard", async () => {
  assert.doesNotThrow(() => assertExecutionAllowed(circleExecute));
  assert.equal(isExecutionAllowedByConfig(circleExecute), true);

  const { circleWalletId: _walletId, ...noWallet } = circleExecute;
  assert.throws(
    () => assertExecutionAllowed(noWallet),
    /SIGNER=circle requires CIRCLE_WALLET_ID, or CIRCLE_WALLET_SET_ID with CIRCLE_USER_REF or a Privy sign-in/
  );
  assert.equal(isExecutionAllowedByConfig(noWallet), false);
  assert.throws(() => assertExecutionAllowed({ ...circleExecute, mcpWriteMode: "prepare" }), /MCP_WRITE_MODE must be execute/);
  assert.throws(
    () => assertExecutionAllowed({ ...circleExecute, writeChainId: 8453, writeRpcUrl: "https://mainnet.base.org" }),
    /mainnet\/Base writes are not allowed/
  );

  // Circle credentials never stand in for a local key: SIGNER defaults to local.
  const { signer: _signer, ...local } = circleExecute;
  assert.throws(() => assertExecutionAllowed(local), /WRITE_PRIVATE_KEY is required/);

  // Circle broadcasts to Arc Testnet itself, so a local fork RPC is refused before any Circle call.
  const mock = mockCircle({});
  await assert.rejects(
    createWriteSigner({ ...circleExecute, circleClient: mock.api, writeRpcUrl: "http://127.0.0.1:8545" }, undefined as never),
    /SIGNER=circle sends through Circle on Arc Testnet/
  );
  assert.equal(mock.calls.length, 0);
});

test("Circle wallet resolution uses CIRCLE_WALLET_ID, then the refId match, then provisions an EOA", async () => {
  const byId = mockCircle({ getWallet: () => ({ data: { wallet: wallet() } }) });
  assert.deepEqual(await resolveCircleWallet(byId.api, { walletId: "wallet-1", walletSetId: "set-1", userRef: "user-1" }), {
    walletId: "wallet-1",
    address: signerAddress,
    provisioned: false
  });
  assert.deepEqual(byId.calls, [{ method: "getWallet", input: { id: "wallet-1" } }]);

  const existing = mockCircle({
    listWallets: () => ({
      data: {
        wallets: [
          wallet({ id: "someone-else", refId: "user-10" }),
          wallet({ id: "newer", createDate: "2026-09-02T00:00:00Z" }),
          wallet()
        ]
      }
    })
  });
  const found = await resolveCircleWallet(existing.api, { walletSetId: "set-1", userRef: "user-1" });
  assert.equal(found.walletId, "wallet-1");
  assert.equal(found.provisioned, false);
  assert.deepEqual(existing.calls, [
    { method: "listWallets", input: { walletSetId: "set-1", refId: "user-1", blockchain: "ARC-TESTNET", pageSize: 50 } }
  ]);

  const fresh = mockCircle({
    listWallets: () => ({ data: { wallets: [] } }),
    createWallets: () => ({ data: { wallets: [wallet({ id: "created" })] } })
  });
  assert.deepEqual(await resolveCircleWallet(fresh.api, { walletSetId: "set-1", userRef: "user-1" }), {
    walletId: "created",
    address: signerAddress,
    provisioned: true
  });
  assert.deepEqual(fresh.calls[1], {
    method: "createWallets",
    input: {
      walletSetId: "set-1",
      blockchains: ["ARC-TESTNET"],
      count: 1,
      accountType: "EOA",
      metadata: [{ name: "user-1", refId: "user-1" }],
      idempotencyKey: provisioningIdempotencyKey("set-1", "user-1")
    }
  });
  assert.match(
    provisioningIdempotencyKey("set-1", "user-1"),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.notEqual(provisioningIdempotencyKey("set-1", "user-1"), provisioningIdempotencyKey("set-1", "user-2"));

  const sca = mockCircle({ getWallet: () => ({ data: { wallet: wallet({ accountType: "SCA" }) } }) });
  await assert.rejects(resolveCircleWallet(sca.api, { walletId: "wallet-1" }), /signer must be an EOA/);
  const frozen = mockCircle({ listWallets: () => ({ data: { wallets: [wallet({ state: "FROZEN" })] } }) });
  await assert.rejects(resolveCircleWallet(frozen.api, { walletSetId: "set-1", userRef: "user-1" }), /FROZEN, not LIVE/);
  assert.ok(!frozen.calls.some((call) => call.method === "createWallets"));
});

test("the Circle signer address resolves once per wallet selector; failures are redacted and retried", async () => {
  const mock = mockCircle({ listWallets: () => ({ data: { wallets: [wallet()] } }) });
  const config = {
    signer: "circle" as const,
    circleClient: mock.api,
    circleApiKey: API_KEY,
    circleEntitySecret: ENTITY_SECRET,
    circleWalletSetId: "set-1",
    circleUserRef: "user-1"
  };
  assert.equal(await resolveSignerAddress(config), signerAddress);
  assert.equal(await resolveSignerAddress({ ...config }), signerAddress);
  assert.equal(mock.calls.length, 1);

  let attempts = 0;
  const flaky = mockCircle({
    listWallets: () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(`rejected credentials ${API_KEY} / ${ENTITY_SECRET}`);
      }
      return { data: { wallets: [wallet()] } };
    }
  });
  const flakyConfig = { ...config, circleClient: flaky.api };
  await assert.rejects(resolveSignerAddress(flakyConfig), (error: Error) => {
    assert.match(error.message, /Circle listWallets failed: rejected credentials \[redacted\] \/ \[redacted\]/);
    assert.ok(!error.message.includes(API_KEY.split(":")[2] ?? "missing"));
    assert.ok(!error.message.includes(ENTITY_SECRET));
    return true;
  });
  assert.equal(await resolveSignerAddress(flakyConfig), signerAddress);

  assert.equal(await resolveSignerAddress({ signer: "circle" }), undefined);
  assert.equal(await resolveSignerAddress({ writePrivateKey: `0x${"11".repeat(32)}`, circleClient: mock.api }), signerAddress);
});

test("Circle contract execution polls to COMPLETE and returns the txHash", async () => {
  const states = ["INITIATED", "QUEUED", "SENT", "CONFIRMED", "COMPLETE"];
  const mock = mockCircle({
    createContractExecutionTransaction: () => ({ data: { id: "tx-1", state: "INITIATED" } }),
    getTransaction: () => {
      const state = states.shift() ?? "COMPLETE";
      return { data: { transaction: { id: "tx-1", state, ...(state === "INITIATED" || state === "QUEUED" ? {} : { txHash: TX_HASH }) } } };
    }
  });
  const callData = encodeFunctionData({ abi: assetVaultAbi, functionName: "setCommitment", args: [7n, true] });
  const sleeps: number[] = [];
  const hash = await executeCircleContractCall(
    mock.api,
    { walletId: "wallet-1", contractAddress: VAULT, callData },
    { pollIntervalMs: 10, sleep: async (ms) => void sleeps.push(ms) }
  );
  assert.equal(hash, TX_HASH);
  assert.deepEqual(mock.calls[0], {
    method: "createContractExecutionTransaction",
    input: { walletId: "wallet-1", contractAddress: VAULT, callData, fee: { type: "level", config: { feeLevel: "MEDIUM" } } }
  });
  assert.equal(mock.calls.filter((call) => call.method === "getTransaction").length, 5);
  assert.deepEqual(sleeps, [10, 10, 10, 10]);

  const payable = mockCircle({
    createContractExecutionTransaction: () => ({ data: { id: "tx-2" } }),
    getTransaction: () => ({ data: { transaction: { id: "tx-2", state: "COMPLETE", txHash: TX_HASH } } })
  });
  await executeCircleContractCall(payable.api, {
    walletId: "wallet-1",
    contractAddress: VAULT,
    callData,
    value: 1_500_000_000_000_000_000n
  });
  assert.equal(payable.calls[0]?.input.amount, "1.5");
});

test("Circle contract execution throws on FAILED, DENIED or CANCELLED with Circle's reason, and times out", async () => {
  const input = { walletId: "wallet-1", contractAddress: VAULT, callData: "0x12345678" as Hex };
  const failed = mockCircle({
    createContractExecutionTransaction: () => ({ data: { id: "tx-3" } }),
    getTransaction: () => ({
      data: {
        transaction: { id: "tx-3", state: "FAILED", errorReason: "INSUFFICIENT_NATIVE_TOKEN", errorDetails: "no USDC for gas" }
      }
    })
  });
  await assert.rejects(
    executeCircleContractCall(failed.api, input, { sleep: async () => {} }),
    /Circle transaction tx-3 FAILED: INSUFFICIENT_NATIVE_TOKEN \(no USDC for gas\)/
  );
  for (const state of ["DENIED", "CANCELLED"]) {
    const final = mockCircle({
      createContractExecutionTransaction: () => ({ data: { id: "tx-4" } }),
      getTransaction: () => ({ data: { transaction: { id: "tx-4", state } } })
    });
    await assert.rejects(executeCircleContractCall(final.api, input), new RegExp(`Circle transaction tx-4 ${state}$`));
  }

  let clock = 0;
  let polls = 0;
  const stuck = mockCircle({
    createContractExecutionTransaction: () => ({ data: { id: "tx-5" } }),
    getTransaction: () => {
      polls += 1;
      if (polls === 2) {
        throw new Error("502 Bad Gateway");
      }
      return { data: { transaction: { id: "tx-5", state: "STUCK" } } };
    }
  });
  await assert.rejects(
    executeCircleContractCall(stuck.api, input, {
      timeoutMs: 30_000,
      pollIntervalMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      }
    }),
    /Circle transaction tx-5 did not reach COMPLETE within 30s \(last state STUCK\)/
  );
  assert.equal(polls, 7);
});

test("Circle typed data JSON adds EIP712Domain for the domain fields present and writes bigints as decimal strings", () => {
  const typedData = shipTypedData();
  const parsed = JSON.parse(serializeTypedDataForCircle(typedData));
  assert.deepEqual(parsed.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" }
  ]);
  assert.deepEqual(parsed.types.ShipStrategy, typedData.types.ShipStrategy);
  assert.equal(parsed.primaryType, "ShipStrategy");
  assert.deepEqual(parsed.domain, typedData.domain);
  assert.equal(parsed.message.classId, "42");
  assert.deepEqual(parsed.message.amounts, ["2000000", "2800000000000000000000"]);
  assert.equal(parsed.message.nonce, "3");
  assert.equal(parsed.message.deadline, "1790000000");
  assert.equal(parsed.message.feePpb, 500_000);

  const salted = JSON.parse(
    serializeTypedDataForCircle({
      domain: { name: "Salted", salt: `0x${"00".repeat(32)}` },
      types: { Mail: [{ name: "value", type: "uint256" }] },
      primaryType: "Mail",
      message: { value: 1n }
    })
  );
  assert.deepEqual(salted.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "salt", type: "bytes32" }
  ]);
  assert.equal(salted.message.value, "1");
});

test("Circle EIP-712 signatures are used only when they recover to the wallet address", async () => {
  const typedData = shipTypedData();
  const circleSigningWith = (account: PrivateKeyAccount) =>
    mockCircle({
      signTypedData: async (input: { walletId: string; data: string }) => {
        assert.equal(JSON.parse(input.data).types.EIP712Domain.length, 4);
        return { data: { signature: await account.signTypedData(typedData) } };
      }
    });

  const good = circleSigningWith(signerAccount);
  const signature = await signTypedDataWithCircle(good.api, { walletId: "wallet-1", address: signerAccount.address }, typedData);
  assert.equal(signature, await signerAccount.signTypedData(typedData));
  assert.equal(good.calls[0]?.input.walletId, "wallet-1");
  assert.equal(good.calls[0]?.input.data, serializeTypedDataForCircle(typedData));

  const wrongKey = circleSigningWith(otherAccount);
  await assert.rejects(
    signTypedDataWithCircle(wrongKey.api, { walletId: "wallet-1", address: signerAccount.address }, typedData),
    new RegExp(`recovers to ${otherAccount.address.toLowerCase()}, not the wallet address ${signerAddress}`)
  );
  const garbage = mockCircle({ signTypedData: () => ({ data: { signature: "not-a-signature" } }) });
  await assert.rejects(
    signTypedDataWithCircle(garbage.api, { walletId: "wallet-1", address: signerAccount.address }, typedData),
    /returned no hex signature/
  );
});

test("the Circle write signer simulates from the wallet address and sends encoded calldata", async () => {
  const mock = mockCircle({
    getWallet: () => ({ data: { wallet: wallet() } }),
    createContractExecutionTransaction: () => ({ data: { id: "tx-6" } }),
    getTransaction: () => ({ data: { transaction: { id: "tx-6", state: "COMPLETE", txHash: TX_HASH } } })
  });
  const signer = await createWriteSigner({ ...circleExecute, circleClient: mock.api }, undefined as never);
  assert.equal(signer.kind, "circle");
  assert.equal(signer.address, signerAddress);
  assert.equal(signer.account, signerAccount.address);

  const hash = await signer.writeContract({
    abi: assetVaultAbi,
    address: VAULT,
    functionName: "setCommitment",
    args: [7n, true]
  });
  assert.equal(hash, TX_HASH);
  const sent = mock.calls.find((call) => call.method === "createContractExecutionTransaction")?.input;
  assert.equal(sent?.contractAddress, VAULT);
  assert.equal(sent?.callData, encodeFunctionData({ abi: assetVaultAbi, functionName: "setCommitment", args: [7n, true] }));
  assert.equal(sent?.amount, undefined);
});

test("the Circle write signer keeps a simulated request's dataSuffix and value", async () => {
  const mock = mockCircle({
    getWallet: () => ({ data: { wallet: wallet() } }),
    createContractExecutionTransaction: () => ({ data: { id: "tx-7" } }),
    getTransaction: () => ({ data: { transaction: { id: "tx-7", state: "COMPLETE", txHash: TX_HASH } } })
  });
  const signer = await createWriteSigner({ ...circleExecute, circleClient: mock.api }, undefined as never);
  // e.g. a signed RedStone payload appended after the ABI-encoded args by simulateContract({ dataSuffix }).
  const payload = `0x${"5e".repeat(40)}000002ed57011e0000` as Hex;
  await signer.writeContract({
    abi: assetVaultAbi,
    address: VAULT,
    functionName: "setCommitment",
    args: [7n, true],
    dataSuffix: payload,
    value: 2n * 10n ** 18n
  });
  const sent = mock.calls.find((call) => call.method === "createContractExecutionTransaction")?.input;
  const encoded = encodeFunctionData({ abi: assetVaultAbi, functionName: "setCommitment", args: [7n, true] });
  assert.equal(sent?.callData, `${encoded}${payload.slice(2)}`);
  assert.equal(sent?.amount, "2");
});

test("info reports the signer kind and address and never the signer secrets", async () => {
  const graphEndpoint = "https://graph.example/subgraphs/name/aqua0";
  const mock = mockCircle({ listWallets: () => ({ data: { wallets: [wallet()] } }) });
  const circle = new Aqua0Service({
    graphEndpoint,
    writeChainId: 5042002,
    signer: "circle",
    circleClient: mock.api,
    circleApiKey: API_KEY,
    circleEntitySecret: ENTITY_SECRET,
    circleWalletSetId: "set-1",
    circleUserRef: "user-1"
  });
  const info = await circle.info();
  assert.deepEqual(info.write.signer, { kind: "circle", address: signerAddress });
  assert.ok(!JSON.stringify(info).includes(API_KEY.split(":")[2] ?? "missing"));
  assert.ok(!JSON.stringify(info).includes(ENTITY_SECRET));

  const localKey = `0x${"11".repeat(32)}`;
  const local = await new Aqua0Service({ graphEndpoint, writePrivateKey: localKey }).info();
  assert.deepEqual(local.write.signer, { kind: "local", address: signerAddress });
  assert.ok(!JSON.stringify(local).includes("11".repeat(32)));
  assert.deepEqual((await new Aqua0Service({ graphEndpoint }).info()).write.signer, { kind: "local", address: null });

  const failing = mockCircle({
    listWallets: () => {
      throw new Error(`unauthorized ${API_KEY}`);
    }
  });
  const failed = await new Aqua0Service({
    graphEndpoint,
    signer: "circle",
    circleClient: failing.api,
    circleApiKey: API_KEY,
    circleEntitySecret: ENTITY_SECRET,
    circleWalletSetId: "set-1",
    circleUserRef: "user-1"
  }).info();
  assert.equal(failed.write.signer.kind, "circle");
  assert.equal(failed.write.signer.address, null);
  assert.match(failed.write.signer.error ?? "", /unauthorized \[redacted\]/);
});
