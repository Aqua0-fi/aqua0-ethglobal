/**
 * One-time keeper setup: its own Circle developer-controlled wallet (refId aqua0-keeper in the wallet set), USDC from
 * the operator with App Kit send, a Circle Gateway deposit for nanopayments, and an ERC-8004 identity. Idempotent.
 */
import { parseUnits } from "viem";

import { appendKeeperJournal, createExecutionClients, txRef, type KeeperTxRef } from "@aqua0/shared";

import type { KeeperConfig } from "./config.js";
import { agentCardDataUri, readKeeperIdentity, registerAgent, writeKeeperIdentity, type KeeperIdentity } from "./erc8004.js";
import { appKitSendUsdc, executeTopUpUsdc, readUsdcBalance } from "./executor.js";
import { baseWriteConfig, resolveKeeperWallet } from "./loop.js";
import { depositToGateway, readGatewayBalance } from "./nanopay.js";

export type SetupOptions = { fundUsdc: number; gatewayUsdc: number; register: boolean };

export async function setupKeeper(config: KeeperConfig, options: SetupOptions, log: (line: string) => void) {
  const wallet = await resolveKeeperWallet(config);
  log(`keeper wallet ${wallet.address} (Circle wallet ${wallet.walletId}${wallet.provisioned ? ", created now" : ""})`);
  const keeperWrite = { ...baseWriteConfig(config), circleWalletId: wallet.walletId };
  const { publicClient, signer } = await createExecutionClients(keeperWrite);
  const txs: KeeperTxRef[] = [];
  const notes: string[] = [];

  let usdc = await readUsdcBalance(publicClient, wallet.address);
  if (options.fundUsdc > 0 && usdc < options.fundUsdc / 2) {
    const result = await executeTopUpUsdc(
      {
        keeperWrite,
        signer,
        client: publicClient,
        limits: config.limits,
        strategies: config.strategies,
        slippageBps: config.slippageBps,
        dryRun: false,
        operatorWalletId: config.operatorWalletId
      },
      options.fundUsdc,
      { apiKey: config.circleApiKey, entitySecret: config.circleEntitySecret }
    );
    txs.push(...result.txs);
    notes.push(result.note);
    log(`fund: ${result.note} ${result.txs.map((tx) => tx.url).join(" ")}`);
    usdc = await readUsdcBalance(publicClient, wallet.address);
  } else {
    log(`fund: keeper holds ${usdc} USDC, no top-up needed`);
  }

  const gateway = await readGatewayBalance(wallet.address);
  if (options.gatewayUsdc > 0 && gateway.available < parseUnits((options.gatewayUsdc / 2).toFixed(6), 6)) {
    const deposit = await depositToGateway(signer, publicClient, parseUnits(options.gatewayUsdc.toFixed(6), 6));
    const refs = [
      ...(deposit.approvalTxHash ? [txRef("approve USDC for GatewayWallet", deposit.approvalTxHash)] : []),
      txRef("GatewayWallet.deposit", deposit.depositTxHash)
    ];
    txs.push(...refs);
    log(`gateway: deposited ${deposit.amountUsdc} USDC ${refs.map((tx) => tx.url).join(" ")}`);
  } else {
    log(`gateway: ${gateway.formattedAvailable} USDC available, no deposit needed`);
  }

  let identity: KeeperIdentity = readKeeperIdentity(config.identityFile) ?? { version: 1, walletId: wallet.walletId, address: wallet.address };
  if (identity.address !== wallet.address) {
    identity = { version: 1, walletId: wallet.walletId, address: wallet.address };
  }
  if (options.register && !identity.agentId) {
    try {
      const agentURI = agentCardDataUri(wallet.address);
      const registered = await registerAgent(signer, publicClient, agentURI);
      identity = { ...identity, agentId: registered.agentId, registrationTx: registered.txHash, agentURI, registeredAt: new Date().toISOString() };
      txs.push(txRef("ERC-8004 IdentityRegistry.register", registered.txHash));
      log(`erc-8004: registered agent #${registered.agentId} ${txRef("", registered.txHash).url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`ERC-8004 registration failed: ${message}`);
      log(`erc-8004: registration failed: ${message}`);
    }
  } else if (identity.agentId) {
    log(`erc-8004: already registered as agent #${identity.agentId}`);
  }
  writeKeeperIdentity(identity, config.identityFile);
  appendKeeperJournal(
    {
      v: 1,
      type: "setup",
      ts: new Date().toISOString(),
      keeper: { address: wallet.address, walletId: wallet.walletId, usdc, gatewayUsdc: Number((await readGatewayBalance(wallet.address)).formattedAvailable), agentId: identity.agentId ?? null },
      outcome: { action: "setup", reason: "keeper wallet, funding, Gateway deposit, ERC-8004 identity", by: "setup", txs },
      ...(notes.length > 0 ? { note: notes.join("; ") } : {})
    },
    config.journalFile
  );
  return { wallet, identity, txs, notes };
}

export { appKitSendUsdc };
