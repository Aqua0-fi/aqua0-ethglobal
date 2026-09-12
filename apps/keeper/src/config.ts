import {
  ARC_TESTNET,
  keeperJournalPath,
  LIVE_FOREX_STRATEGIES,
  type KeeperStrategyRef,
  type SignalName
} from "@aqua0/shared";

import { keeperIdentityPath } from "./erc8004.js";
import { DEFAULT_OPENAI_MODEL } from "./llm-policy.js";
import { ACTIONS, type ActionName, type Limits } from "./policy.js";

export const DEFAULT_SIGNALS_URL = "http://127.0.0.1:8402";

/** USDC per paid signal; the seller charges the same (apps/signals). */
export const SIGNAL_PRICES_USDC: Record<SignalName, number> = { oracle: 0.0005, book: 0.001, vault: 0.0005 };

export type KeeperConfig = {
  circleApiKey: string;
  circleEntitySecret: string;
  keeperWalletId?: string;
  walletSetId?: string;
  keeperUserRef: string;
  operatorWalletId?: string;
  rpcUrl: string;
  chainId: number;
  signalsUrl: string;
  journalFile: string;
  identityFile: string;
  heartbeatSeconds: number;
  pollSeconds: number;
  maxStepsPerTick: number;
  limits: Limits;
  dataBudgetHourUsdc: number;
  topUpCapDayUsdc: number;
  gatewayCapDayUsdc: number;
  policy: "rules" | "llm";
  openaiApiKey?: string;
  openaiModel: string;
  llmCapDayUsd: number;
  llmTimeoutMs: number;
  slippageBps: number;
  feedback: boolean;
  strategies: readonly KeeperStrategyRef[];
  dryRun: boolean;
  once: boolean;
};

export type Flags = Map<string, string | true>;

/** Keeper settings from the environment, overridden by CLI flags. Secrets come only from the environment. */
export function readKeeperConfig(env: Readonly<Record<string, string | undefined>>, flags: Flags = new Map()): KeeperConfig {
  const text = (flag: string, name: string): string | undefined => {
    const value = flags.get(flag);
    return typeof value === "string" ? value : env[name]?.trim() || undefined;
  };
  const num = (flag: string, name: string, fallback: number): number => {
    const raw = text(flag, name);
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${flag ? `--${flag}` : name} must be a non-negative number`);
    }
    return parsed;
  };
  const bool = (flag: string, name: string, fallback: boolean): boolean => {
    if (flags.get(flag) === true) {
      return true;
    }
    const raw = text(flag, name);
    return raw === undefined ? fallback : raw === "true" || raw === "1";
  };

  const openaiApiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const policyText = text("policy", "KEEPER_POLICY") ?? (openaiApiKey ? "llm" : "rules");
  if (policyText !== "rules" && policyText !== "llm") {
    throw new Error("--policy must be rules or llm");
  }
  if (policyText === "llm" && !openaiApiKey) {
    throw new Error("--policy llm needs OPENAI_API_KEY in the environment");
  }
  const allowedText = text("allow", "KEEPER_ALLOWED_ACTIONS");
  const allowedActions = allowedText
    ? allowedText.split(",").map((item) => item.trim()).filter(Boolean)
    : [...ACTIONS];
  for (const action of allowedActions) {
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`KEEPER_ALLOWED_ACTIONS: unknown action ${action}`);
    }
  }
  if (!allowedActions.includes("wait")) {
    allowedActions.push("wait");
  }

  const circleApiKey = env.CIRCLE_API_KEY?.trim() ?? "";
  const circleEntitySecret = (env.CIRCLE_ENTITY_SECRET || env.ENTITY_SECRET)?.trim() ?? "";
  const keeperWalletId = text("wallet-id", "KEEPER_CIRCLE_WALLET_ID");
  const walletSetId = env.CIRCLE_WALLET_SET_ID?.trim() || undefined;
  const operatorWalletId = env.CIRCLE_OPERATOR_WALLET_ID?.trim() || undefined;
  const openaiModel = text("model", "OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL;
  return {
    circleApiKey,
    circleEntitySecret,
    ...(keeperWalletId ? { keeperWalletId } : {}),
    ...(walletSetId ? { walletSetId } : {}),
    keeperUserRef: text("user-ref", "KEEPER_CIRCLE_USER_REF") ?? "aqua0-keeper",
    ...(operatorWalletId ? { operatorWalletId } : {}),
    rpcUrl: env.WRITE_RPC_URL?.trim() || ARC_TESTNET.rpcUrl,
    chainId: env.WRITE_CHAIN_ID ? Number(env.WRITE_CHAIN_ID) : ARC_TESTNET.chainId,
    signalsUrl: (text("signals-url", "AQUA0_SIGNALS_URL") ?? DEFAULT_SIGNALS_URL).replace(/\/$/, ""),
    journalFile: keeperJournalPath(text("journal", "AQUA0_KEEPER_JOURNAL"), {}),
    identityFile: keeperIdentityPath(env.AQUA0_KEEPER_IDENTITY, {}),
    heartbeatSeconds: Math.max(5, num("interval", "KEEPER_HEARTBEAT_SECONDS", 90)),
    pollSeconds: Math.max(1, num("poll", "KEEPER_POLL_SECONDS", 4)),
    maxStepsPerTick: 6,
    limits: {
      tiltThresholdBps: num("tilt-bps", "KEEPER_TILT_BPS", 150),
      maxTradeUsdc: num("max-trade", "KEEPER_MAX_TRADE_USDC", 0.25),
      minTradeUsdc: num("min-trade", "KEEPER_MIN_TRADE_USDC", 0.01),
      cooldownSeconds: num("cooldown", "KEEPER_COOLDOWN_SECONDS", 90),
      keeperUsdcFloor: num("usdc-floor", "KEEPER_USDC_FLOOR", 0.5),
      keeperTopUpUsdc: num("top-up", "KEEPER_TOPUP_USDC", 1),
      gatewayFloorUsdc: num("gateway-floor", "KEEPER_GATEWAY_FLOOR_USDC", 0.05),
      gatewayTopUpUsdc: num("gateway-top-up", "KEEPER_GATEWAY_TOPUP_USDC", 0.25),
      oracleMaxAgeForTradeSeconds: num("oracle-max-age", "KEEPER_ORACLE_MAX_AGE_SECONDS", 120),
      bookRefreshSeconds: num("book-refresh", "KEEPER_BOOK_REFRESH_SECONDS", 600),
      vaultRefreshSeconds: num("vault-refresh", "KEEPER_VAULT_REFRESH_SECONDS", 3600),
      dockRepeatSeconds: num("dock-repeat", "KEEPER_DOCK_REPEAT_SECONDS", 3600),
      allowedActions: allowedActions as ActionName[],
      prices: SIGNAL_PRICES_USDC
    },
    dataBudgetHourUsdc: num("budget", "KEEPER_DATA_BUDGET_USDC_PER_HOUR", 0.5),
    topUpCapDayUsdc: num("top-up-cap", "KEEPER_TOPUP_CAP_USDC_PER_DAY", 3),
    gatewayCapDayUsdc: num("gateway-cap", "KEEPER_GATEWAY_CAP_USDC_PER_DAY", 1),
    policy: policyText,
    ...(openaiApiKey ? { openaiApiKey } : {}),
    openaiModel,
    llmCapDayUsd: num("llm-cap", "KEEPER_LLM_CAP_USD_PER_DAY", 0.5),
    llmTimeoutMs: num("llm-timeout-ms", "KEEPER_LLM_TIMEOUT_MS", 10_000),
    slippageBps: num("slippage-bps", "KEEPER_SLIPPAGE_BPS", 50),
    feedback: !bool("no-feedback", "KEEPER_NO_FEEDBACK", false),
    strategies: LIVE_FOREX_STRATEGIES,
    dryRun: bool("dry-run", "KEEPER_DRY_RUN", false),
    once: bool("once", "KEEPER_ONCE", false)
  };
}
