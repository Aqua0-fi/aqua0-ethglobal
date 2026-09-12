/**
 * ERC-8004 agent identity and reputation on Arc Testnet. The keeper registers itself once (IdentityRegistry.register
 * with a data: URI agent card) from its own wallet; after an executed rebalance another wallet (the Aqua0 operator,
 * since ERC-8004 forbids an agent owner rating its own agent) can record feedback on the ReputationRegistry.
 */
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { decodeEventLog, getAddress, keccak256, parseAbi, toBytes, type Hex } from "viem";

import { assertReceiptSuccess, type ReadClient, type WriteSigner } from "@aqua0/shared";

export const ERC8004_ARC_TESTNET = {
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713"
} as const;

const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
]);

const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
]);

export type KeeperIdentity = {
  version: 1;
  walletId: string;
  address: string;
  agentId?: string;
  registrationTx?: string;
  agentURI?: string;
  registeredAt?: string;
};

export function keeperIdentityPath(file?: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return file?.trim() || env.AQUA0_KEEPER_IDENTITY?.trim() || join(homedir(), ".aqua0", "keeper", "identity.json");
}

export function readKeeperIdentity(file?: string): KeeperIdentity | undefined {
  const path = keeperIdentityPath(file);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as KeeperIdentity;
  } catch {
    return undefined;
  }
}

export function writeKeeperIdentity(identity: KeeperIdentity, file?: string): void {
  const path = keeperIdentityPath(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

/** The committed agent card (apps/keeper/agent-card.json) with this keeper's wallet filled in, as a data: URI. */
export function agentCardDataUri(address: string, extra: Record<string, unknown> = {}): string {
  const template = JSON.parse(readFileSync(new URL("../agent-card.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const card = { ...template, ...extra, wallet: { chain: "eip155:5042002", address: getAddress(address) } };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;
}

export async function registerAgent(
  signer: WriteSigner,
  client: ReadClient,
  agentURI: string
): Promise<{ agentId: string; txHash: Hex }> {
  const txHash = await signer.writeContract({
    address: getAddress(ERC8004_ARC_TESTNET.identityRegistry),
    abi: identityAbi,
    functionName: "register",
    args: [agentURI]
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  assertReceiptSuccess(receipt, "ERC-8004 register", txHash);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ERC8004_ARC_TESTNET.identityRegistry.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({ abi: identityAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Transfer" && decoded.args.to.toLowerCase() === signer.address) {
        return { agentId: decoded.args.tokenId.toString(), txHash };
      }
    } catch {
      // other IdentityRegistry events
    }
  }
  throw new Error(`ERC-8004 register ${txHash} succeeded but no Transfer to ${signer.address} was found`);
}

export async function giveAgentFeedback(
  rater: WriteSigner,
  client: ReadClient,
  input: { agentId: string; score: number; tag1: string; tag2: string; feedbackURI: string; evidence: string }
): Promise<Hex> {
  const txHash = await rater.writeContract({
    address: getAddress(ERC8004_ARC_TESTNET.reputationRegistry),
    abi: reputationAbi,
    functionName: "giveFeedback",
    args: [BigInt(input.agentId), BigInt(input.score), 0, input.tag1, input.tag2, "", input.feedbackURI, keccak256(toBytes(input.evidence))]
  });
  assertReceiptSuccess(await client.waitForTransactionReceipt({ hash: txHash }), "ERC-8004 giveFeedback", txHash);
  return txHash;
}
