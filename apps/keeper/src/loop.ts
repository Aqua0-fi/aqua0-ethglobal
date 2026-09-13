/**
 * The keeper agent loop. It wakes on a swap against a watched strategy (router Swapped logs, polled every few seconds)
 * or on a slow heartbeat, buys the signals its policy asks for with Circle Nanopayments, lets the policy choose one
 * action, checks it against the guardrails, executes it with its own Circle wallet (or only reports it in dry-run),
 * and appends the whole tick to the journal.
 */
import OpenAI from "openai";

import {
  appendKeeperJournal,
  ARC_TESTNET_DEPLOYMENT,
  createCircleClient,
  createCircleSigner,
  createExecutionClients,
  describeStrategySignal,
  readKeeperJournal,
  resolveCircleWallet,
  txRef,
  type KeeperJournalEntry,
  type KeeperSignalLine,
  type KeeperStep,
  type SignalName,
  type SignalsSnapshot,
  type WriteConfig
} from "@aqua0/shared";

import type { KeeperConfig } from "./config.js";
import { giveAgentFeedback, readKeeperIdentity } from "./erc8004.js";
import {
  executeGatewayTopUp,
  executeRebalance,
  executeTopUpUsdc,
  readUsdcBalance,
  type ActionResult,
  type ExecContext
} from "./executor.js";
import { formatTickLine } from "./format.js";
import { checkDecision } from "./guard.js";
import { LlmPolicy, type ResponsesClient } from "./llm-policy.js";
import { batchSignerFor, createNanopayBuyer, readGatewayBalance, type NanopayBuyer } from "./nanopay.js";
import { RulesPolicy, round6, strategyViews, type Budget, type Observation, type Policy, type SwapEvent, type WakeKind } from "./policy.js";
import { deriveKeeperState } from "./state.js";
import { SwapWatcher } from "./watcher.js";

export type KeeperIo = {
  log(line: string): void;
  error(line: string): void;
  signal?: AbortSignal;
};

export type KeeperRuntime = {
  config: KeeperConfig;
  keeperWrite: WriteConfig;
  exec: ExecContext;
  buyer: NanopayBuyer;
  policy: Policy;
  walletId: string;
  address: string;
  agentId: string | null;
  tick: number;
};

export function baseWriteConfig(config: KeeperConfig): WriteConfig {
  if (!config.circleApiKey || !config.circleEntitySecret) {
    throw new Error("The keeper signs with a Circle wallet: set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET");
  }
  return {
    signer: "circle",
    circleApiKey: config.circleApiKey,
    circleEntitySecret: config.circleEntitySecret,
    writeRpcUrl: config.rpcUrl,
    writeChainId: config.chainId,
    mcpWriteMode: "execute"
  };
}

/** Resolve the keeper's Circle wallet (created on first use from CIRCLE_WALLET_SET_ID + refId) and its signer. */
export async function resolveKeeperWallet(config: KeeperConfig): Promise<{ walletId: string; address: string; provisioned: boolean }> {
  const identity = readKeeperIdentity(config.identityFile);
  const walletId = config.keeperWalletId ?? identity?.walletId;
  const client = createCircleClient({ apiKey: config.circleApiKey, entitySecret: config.circleEntitySecret });
  const wallet = await resolveCircleWallet(client, {
    walletId,
    walletSetId: config.walletSetId,
    userRef: config.keeperUserRef
  });
  return { walletId: wallet.walletId, address: wallet.address, provisioned: wallet.provisioned };
}

export function createPolicy(config: KeeperConfig, spentTodayUsd: number, client?: ResponsesClient): Policy {
  if (config.policy === "rules") {
    return new RulesPolicy();
  }
  const openai = client ?? (new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 0 }) as unknown as ResponsesClient);
  return new LlmPolicy({
    client: openai,
    model: config.openaiModel,
    timeoutMs: config.llmTimeoutMs,
    capDayUsd: config.llmCapDayUsd,
    spentTodayUsd,
    ...(config.openaiApiKey ? { secret: config.openaiApiKey } : {})
  });
}

export async function createKeeperRuntime(config: KeeperConfig): Promise<KeeperRuntime> {
  const wallet = await resolveKeeperWallet(config);
  const keeperWrite: WriteConfig = { ...baseWriteConfig(config), circleWalletId: wallet.walletId };
  const { publicClient, signer } = await createExecutionClients(keeperWrite);
  const journal = readKeeperJournal({ file: config.journalFile, last: 2000 });
  const derived = deriveKeeperState(journal, Date.now());
  const identity = readKeeperIdentity(config.identityFile);
  const lastTick = [...journal].reverse().find((entry) => entry.type === "tick" && entry.tick !== undefined);
  return {
    config,
    keeperWrite,
    exec: {
      keeperWrite,
      signer,
      client: publicClient,
      limits: config.limits,
      strategies: config.strategies,
      slippageBps: config.slippageBps,
      dryRun: config.dryRun,
      operatorWalletId: config.operatorWalletId
    },
    buyer: createNanopayBuyer(batchSignerFor(signer)),
    policy: createPolicy(config, derived.llmDayUsd),
    walletId: wallet.walletId,
    address: wallet.address,
    agentId: identity?.address === wallet.address ? (identity.agentId ?? null) : null,
    tick: lastTick?.tick ?? 0
  };
}

export async function runTick(
  runtime: KeeperRuntime,
  wake: { kind: WakeKind; swaps: SwapEvent[] },
  io: KeeperIo
): Promise<KeeperJournalEntry> {
  const { config, exec } = runtime;
  runtime.tick += 1;
  const nowMs = Date.now();
  const journal = readKeeperJournal({ file: config.journalFile, last: 2000 });
  const derived = deriveKeeperState(journal, nowMs);
  const errors: string[] = [];
  const [usdc, gateway] = await Promise.all([
    readUsdcBalance(exec.client, runtime.address).catch((error: unknown) => {
      errors.push(`USDC balance: ${short(error)}`);
      return null;
    }),
    readGatewayBalance(runtime.address).catch((error: unknown) => {
      errors.push(`Gateway balance: ${short(error)}`);
      return null;
    })
  ]);
  const ageOf = (at: number | null) => (at === null ? null : Math.max(0, Math.round((nowMs - at) / 1000)));
  const cooldownSeconds: Record<string, number> = {};
  const dockRecommendedAgeSeconds: Record<string, number> = {};
  for (const strategy of config.strategies) {
    const last = derived.lastRebalanceAt[strategy.strategyId];
    if (last !== undefined) {
      const left = Math.ceil((last + config.limits.cooldownSeconds * 1000 - nowMs) / 1000);
      if (left > 0) {
        cooldownSeconds[strategy.strategyId] = left;
      }
    }
    const dock = derived.lastDockAt[strategy.strategyId];
    if (dock !== undefined) {
      dockRecommendedAgeSeconds[strategy.strategyId] = Math.round((nowMs - dock) / 1000);
    }
  }
  const observation: Observation = {
    now: new Date(nowMs).toISOString(),
    tick: runtime.tick,
    wake,
    keeper: { address: runtime.address, usdc: usdc === null ? null : round6(usdc), gatewayUsdc: gateway ? Number(gateway.formattedAvailable) : null },
    strategies: config.strategies.map((strategy) => ({ pair: strategy.pair, strategyId: strategy.strategyId })),
    bought: {},
    signalAgeSeconds: {
      oracle: ageOf(derived.signalBoughtAt.oracle),
      book: ageOf(derived.signalBoughtAt.book),
      vault: ageOf(derived.signalBoughtAt.vault)
    },
    lastKnown: derived.lastSignals,
    cooldownSeconds,
    dockRecommendedAgeSeconds,
    limits: config.limits
  };

  const steps: KeeperStep[] = [];
  let tickUsdc = 0;
  let llmTickUsd = 0;
  let outcome: KeeperJournalEntry["outcome"];
  const minBlock = wake.swaps.reduce((max, swap) => (BigInt(swap.blockNumber) > max ? BigInt(swap.blockNumber) : max), 0n);

  for (let index = 0; index < config.maxStepsPerTick && !outcome; index += 1) {
    const dataSpentHourUsdc = derived.dataSpentHourUsdc + tickUsdc;
    const budget: Budget = {
      dataSpentHourUsdc: round6(dataSpentHourUsdc),
      dataBudgetHourUsdc: config.dataBudgetHourUsdc,
      dataRemainingUsdc: round6(Math.max(0, config.dataBudgetHourUsdc - dataSpentHourUsdc)),
      topUpsTodayUsdc: derived.topUpsTodayUsdc,
      topUpCapDayUsdc: config.topUpCapDayUsdc,
      gatewayDepositsTodayUsdc: derived.gatewayDepositsTodayUsdc,
      gatewayCapDayUsdc: config.gatewayCapDayUsdc,
      llmSpentDayUsd: round6(derived.llmDayUsd + llmTickUsd),
      llmCapDayUsd: config.llmCapDayUsd
    };
    let decided;
    try {
      decided = await runtime.policy.decide(observation, budget, journal.slice(-20));
    } catch (error) {
      errors.push(`policy: ${short(error)}`);
      decided = await new RulesPolicy().decide(observation, budget);
    }
    const { decision } = decided;
    const guard = checkDecision(decision, observation, budget);
    const step: KeeperStep = { decision: { ...decision }, by: decided.by, guard };
    if (decided.llm) {
      step.llm = decided.llm;
      llmTickUsd += decided.llm.costUsd;
    }
    steps.push(step);
    if (!guard.allowed) {
      outcome = { action: decision.action, reason: decision.reason, by: decided.by, blocked: guard.reason, txs: [], ...pairOf(decision) };
      break;
    }
    if (decision.action === "buy_signal") {
      try {
        const url = `${config.signalsUrl}/v1/${decision.which}${minBlock > 0n ? `?minBlock=${minBlock}` : ""}`;
        const { data, receipt } = await runtime.buyer.getJson<SignalsSnapshot>(url);
        const spent = Number(receipt.amountUsdc);
        tickUsdc += spent;
        observation.bought[decision.which] = { at: receipt.at, blockNumber: data.blockNumber, snapshot: data, spentUsdc: spent };
        step.spendUsdc = spent;
        step.receipt = { route: receipt.route, amountUsdc: receipt.amountUsdc, settlement: receipt.settlement, ms: receipt.ms };
        step.result = `paid ${receipt.amountUsdc} USDC via Circle Gateway (settlement ${receipt.settlement ?? "n/a"}) at block ${data.blockNumber}`;
      } catch (error) {
        step.result = `purchase failed: ${short(error)}`;
        errors.push(`buy ${decision.which}: ${short(error)}`);
        outcome = { action: "wait", reason: `could not buy the ${decision.which} signal: ${short(error)}`, by: decided.by, txs: [] };
      }
      continue;
    }
    const result = await executeDecision(runtime, decision).catch(
      (error: unknown): ActionResult => ({ status: "failed", note: short(error, 300), txs: [] })
    );
    step.result = `${result.status}: ${result.note}`;
    if (result.status === "failed") {
      errors.push(`${decision.action}: ${result.note}`);
    }
    outcome = {
      action: decision.action,
      reason: decision.reason,
      by: decided.by,
      ...pairOf(decision),
      ...(result.status === "dry-run" ? { dryRun: true } : {}),
      ...(result.status === "skipped" || result.status === "failed" ? { blocked: `${result.status}: ${result.note}` } : {}),
      txs: result.txs,
      ...(result.spreadBeforeBps !== undefined ? { spreadBeforeBps: result.spreadBeforeBps } : {}),
      ...(result.spreadAfterBps !== undefined ? { spreadAfterBps: result.spreadAfterBps } : {}),
      detail: { ...(result.detail ?? {}), ...strategyOf(decision), note: result.note }
    };
  }
  outcome ??= { action: "wait", reason: "step limit reached this tick", by: "executor", txs: [] };

  if (outcome.action === "rebalance" && !outcome.dryRun && !outcome.blocked && outcome.txs.length > 0 && config.feedback) {
    const swapTx = outcome.txs.at(-1)!;
    const feedback = await recordFeedback(runtime, outcome.pair ?? "", swapTx.hash, swapTx.url).catch((error: unknown) => ({ error: short(error) }));
    if ("hash" in feedback) {
      outcome.txs.push(txRef("ERC-8004 giveFeedback (operator rates the keeper)", feedback.hash));
    } else if (feedback.error) {
      errors.push(`ERC-8004 feedback skipped: ${feedback.error}`);
    }
  }

  const bought = observation.bought;
  // A rebalance re-quotes its book, so the spread bought before it no longer describes that book.
  const rebalancedId =
    outcome.action === "rebalance" && !outcome.dryRun && !outcome.blocked && outcome.spreadAfterBps !== undefined
      ? outcome.detail?.strategyId
      : undefined;
  const signals: KeeperSignalLine[] = strategyViews(observation).map((view) => {
    const previous = derived.lastSignals.find((line) => line.strategyId === view.strategyId);
    const oracleAgeSeconds = view.oracle?.ageSeconds ?? (bought.oracle ? null : (previous?.oracleAgeSeconds ?? null));
    const oracleStatus = view.oracle?.status ?? (bought.oracle ? null : (previous?.oracleStatus ?? null));
    if (typeof rebalancedId === "string" && rebalancedId === view.strategyId) {
      return { pair: view.pair, strategyId: view.strategyId, spreadBps: outcome.spreadAfterBps ?? null, side: null, oracleAgeSeconds, oracleStatus };
    }
    const cached = view.book === null && !bought.book && previous !== undefined && previous.spreadBps !== null;
    return {
      pair: view.pair,
      strategyId: view.strategyId,
      spreadBps: view.book?.spreadBps ?? (bought.book ? null : (previous?.spreadBps ?? null)),
      side: view.book?.side ?? (bought.book ? null : (previous?.side ?? null)),
      oracleAgeSeconds,
      oracleStatus,
      ...(cached ? { bookCached: true } : {})
    };
  });
  const entry: KeeperJournalEntry = {
    v: 1,
    type: "tick",
    ts: new Date().toISOString(),
    tick: runtime.tick,
    mode: config.dryRun ? "dry-run" : "live",
    policy: runtime.policy.name,
    model: runtime.policy.model,
    keeper: { address: runtime.address, walletId: runtime.walletId, usdc: observation.keeper.usdc, gatewayUsdc: observation.keeper.gatewayUsdc, agentId: runtime.agentId },
    wake: { kind: wake.kind, ...(wake.swaps.length > 0 ? { detail: describeSwaps(wake.swaps) } : {}) },
    signals,
    steps,
    outcome,
    spend: {
      tickUsdc: round6(tickUsdc),
      hourUsdc: round6(derived.dataSpentHourUsdc + tickUsdc),
      totalUsdc: round6(derived.dataSpentTotalUsdc + tickUsdc),
      budgetHourUsdc: config.dataBudgetHourUsdc,
      llmTickUsd: Number(llmTickUsd.toFixed(9)),
      llmDayUsd: Number((derived.llmDayUsd + llmTickUsd).toFixed(9)),
      llmTotalUsd: Number((derived.llmTotalUsd + llmTickUsd).toFixed(9)),
      llmCapDayUsd: config.llmCapDayUsd
    },
    ...(errors.length > 0 ? { errors } : {})
  };
  appendKeeperJournal(entry, config.journalFile);
  io.log(formatTickLine(entry));
  for (const line of strategyLines(observation)) {
    io.log(`           ${line}`);
  }
  return entry;
}

async function executeDecision(runtime: KeeperRuntime, decision: Observation extends never ? never : Parameters<typeof checkDecision>[0]): Promise<ActionResult> {
  const { exec, config } = runtime;
  switch (decision.action) {
    case "wait":
      return { status: "done", note: "no action", txs: [] };
    case "recommend_dock":
      return {
        status: "done",
        note: `recommended docking ${decision.pair}: docking needs the strategist's signature, which the keeper does not hold`,
        txs: [],
        detail: { strategyId: decision.strategyId }
      };
    case "rebalance":
      return executeRebalance(exec, decision);
    case "top_up_usdc":
      return executeTopUpUsdc(exec, decision.amountUsdc, { apiKey: config.circleApiKey, entitySecret: config.circleEntitySecret });
    case "top_up_gateway":
      return executeGatewayTopUp(exec, decision.amountUsdc);
    case "buy_signal":
      return { status: "skipped", note: "signal purchases are handled in the loop", txs: [] };
  }
}

async function recordFeedback(runtime: KeeperRuntime, pair: string, swapHash: string, url: string): Promise<{ hash: `0x${string}` } | { error: string }> {
  if (!runtime.agentId) {
    return { error: "the keeper has no ERC-8004 agent id (run aqua0 keeper setup)" };
  }
  if (!runtime.config.operatorWalletId) {
    return { error: "no CIRCLE_OPERATOR_WALLET_ID to rate the keeper from" };
  }
  const rater = await createCircleSigner({ ...runtime.keeperWrite, circleWalletId: runtime.config.operatorWalletId });
  if (rater.address === runtime.address) {
    return { error: "the operator is the keeper's owner; ERC-8004 forbids self-feedback" };
  }
  const hash = await giveAgentFeedback(rater, runtime.exec.client, {
    agentId: runtime.agentId,
    score: 100,
    tag1: "rebalance",
    tag2: pair,
    feedbackURI: url,
    evidence: swapHash
  });
  return { hash };
}

/** Long-running loop: swap-triggered ticks plus a heartbeat, backoff on errors, clean stop on abort. */
export async function runKeeper(config: KeeperConfig, io: KeeperIo): Promise<void> {
  const runtime = await createKeeperRuntime(config);
  const header = `keeper ${runtime.address} (Circle wallet ${runtime.walletId})${runtime.agentId ? ` ERC-8004 agent #${runtime.agentId}` : ""} | policy ${runtime.policy.name}${runtime.policy.model ? ` ${runtime.policy.model}` : ""} | ${config.dryRun ? "DRY RUN" : "live"} | signals ${config.signalsUrl} | journal ${config.journalFile}`;
  io.log(header);
  if (config.once) {
    await runTick(runtime, { kind: "manual", swaps: [] }, io);
    return;
  }
  appendKeeperJournal(
    {
      v: 1,
      type: "start",
      ts: new Date().toISOString(),
      mode: config.dryRun ? "dry-run" : "live",
      policy: runtime.policy.name,
      model: runtime.policy.model,
      keeper: { address: runtime.address, walletId: runtime.walletId, agentId: runtime.agentId },
      note: `heartbeat ${config.heartbeatSeconds}s, swap poll ${config.pollSeconds}s, tilt ${config.limits.tiltThresholdBps} bps, max trade ${config.limits.maxTradeUsdc} USDC, data budget ${config.dataBudgetHourUsdc} USDC/h, model cap $${config.llmCapDayUsd}/day`
    },
    config.journalFile
  );
  io.log(`watching Swapped on ${ARC_TESTNET_DEPLOYMENT.fxVenue.forexRouter} every ${config.pollSeconds}s, heartbeat every ${config.heartbeatSeconds}s (Ctrl+C to stop)`);
  const watcher = new SwapWatcher({
    client: runtime.exec.client,
    router: ARC_TESTNET_DEPLOYMENT.fxVenue.forexRouter ?? "",
    strategies: config.strategies,
    ignoreTaker: runtime.address
  });
  let backoffMs = 0;
  let lastTickAt = 0;
  let pending: SwapEvent[] = [];
  let first = true;
  while (!io.signal?.aborted) {
    try {
      if (first) {
        await watcher.poll();
        first = false;
        await runTick(runtime, { kind: "startup", swaps: [] }, io);
        lastTickAt = Date.now();
      } else {
        pending = [...pending, ...(await watcher.poll())];
        if (pending.length > 0) {
          const swaps = pending;
          pending = [];
          await runTick(runtime, { kind: "swap", swaps }, io);
          lastTickAt = Date.now();
        } else if (Date.now() - lastTickAt >= config.heartbeatSeconds * 1000) {
          await runTick(runtime, { kind: "heartbeat", swaps: [] }, io);
          lastTickAt = Date.now();
        }
      }
      backoffMs = 0;
    } catch (error) {
      backoffMs = Math.min(backoffMs === 0 ? 5_000 : backoffMs * 2, 60_000);
      const message = short(error, 300);
      io.error(`${new Date().toISOString().slice(11, 19)} tick error (retry in ${backoffMs / 1000}s): ${message}`);
      appendKeeperJournal({ v: 1, type: "error", ts: new Date().toISOString(), errors: [message] }, config.journalFile);
      lastTickAt = Date.now();
    }
    await sleep(backoffMs || config.pollSeconds * 1000, io.signal);
  }
  appendKeeperJournal({ v: 1, type: "stop", ts: new Date().toISOString(), keeper: { address: runtime.address } }, config.journalFile);
  io.log("keeper stopped");
}

function strategyLines(observation: Observation): string[] {
  const oracle = observation.bought.oracle?.snapshot.strategies ?? [];
  const book = observation.bought.book?.snapshot.strategies ?? [];
  if (oracle.length === 0 && book.length === 0) {
    return [];
  }
  return observation.strategies.map((strategy) => {
    const o = oracle.find((row) => row.strategyId === strategy.strategyId);
    const b = book.find((row) => row.strategyId === strategy.strategyId);
    return describeStrategySignal({
      pair: strategy.pair,
      strategyId: strategy.strategyId as `0x${string}`,
      live: (o ?? b)?.live ?? true,
      oracle: o?.oracle ?? null,
      book: b?.book ?? null,
      errors: []
    });
  });
}

function describeSwaps(swaps: SwapEvent[]): string {
  return swaps
    .map((swap) => `swap ${swap.txHash.slice(0, 10)}... ${swap.direction} on ${swap.pair} by ${swap.taker.slice(0, 8)}...`)
    .join("; ");
}

function pairOf(decision: { action: string }): { pair?: string } {
  const pair = (decision as { pair?: unknown }).pair;
  return typeof pair === "string" ? { pair } : {};
}

function strategyOf(decision: { action: string }): Record<string, unknown> {
  const strategyId = (decision as { strategyId?: unknown }).strategyId;
  const amountUsdc = (decision as { amountUsdc?: unknown }).amountUsdc;
  return {
    ...(typeof strategyId === "string" ? { strategyId } : {}),
    ...(typeof amountUsdc === "number" ? { amountUsdc } : {})
  };
}

/** First line of an error plus viem's "Details:" line, without request bodies. */
function short(error: unknown, max = 200): string {
  const full = error instanceof Error ? error.message : String(error);
  const lines = full.split("\n").map((line) => line.trim()).filter(Boolean);
  const details = lines.find((line) => line.startsWith("Details:"));
  const message = [lines[0] ?? full, details].filter(Boolean).join(" ");
  return message.length > max ? `${message.slice(0, max)}...` : message;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export type { SignalName };
