/**
 * Keeper state derived from its own journal, the single source of truth: spend windows, cooldowns, top-ups and the
 * last signals. A restarted keeper (or one started twice) sees the same budgets and cooldowns.
 */
import type { KeeperJournalEntry, KeeperSignalLine, SignalName } from "@aqua0/shared";

export type DerivedKeeperState = {
  dataSpentHourUsdc: number;
  dataSpentTotalUsdc: number;
  llmDayUsd: number;
  llmTotalUsd: number;
  signalBoughtAt: Record<SignalName, number | null>;
  lastRebalanceAt: Record<string, number>;
  lastDockAt: Record<string, number>;
  topUpsTodayUsdc: number;
  gatewayDepositsTodayUsdc: number;
  lastSignals: KeeperSignalLine[];
};

export function deriveKeeperState(entries: readonly KeeperJournalEntry[], nowMs: number): DerivedKeeperState {
  const hourAgo = nowMs - 3_600_000;
  const day = new Date(nowMs);
  day.setUTCHours(0, 0, 0, 0);
  const dayStart = day.getTime();
  const state: DerivedKeeperState = {
    dataSpentHourUsdc: 0,
    dataSpentTotalUsdc: 0,
    llmDayUsd: 0,
    llmTotalUsd: 0,
    signalBoughtAt: { oracle: null, book: null, vault: null },
    lastRebalanceAt: {},
    lastDockAt: {},
    topUpsTodayUsdc: 0,
    gatewayDepositsTodayUsdc: 0,
    lastSignals: []
  };
  for (const entry of entries) {
    if (entry.type !== "tick") {
      continue;
    }
    const at = Date.parse(entry.ts);
    if (!Number.isFinite(at)) {
      continue;
    }
    for (const step of entry.steps ?? []) {
      if (step.receipt) {
        const amount = Number(step.receipt.amountUsdc) || 0;
        state.dataSpentTotalUsdc += amount;
        if (at >= hourAgo) {
          state.dataSpentHourUsdc += amount;
        }
        const name = step.receipt.route.split("/").pop() as SignalName | undefined;
        if (name && name in state.signalBoughtAt) {
          state.signalBoughtAt[name] = Math.max(state.signalBoughtAt[name] ?? 0, at);
        }
      }
      if (step.llm) {
        state.llmTotalUsd += step.llm.costUsd;
        if (at >= dayStart) {
          state.llmDayUsd += step.llm.costUsd;
        }
      }
    }
    const outcome = entry.outcome;
    if (outcome && !outcome.dryRun && !outcome.blocked) {
      const strategyId = typeof outcome.detail?.strategyId === "string" ? outcome.detail.strategyId : undefined;
      const amount = typeof outcome.detail?.amountUsdc === "number" ? outcome.detail.amountUsdc : 0;
      if (outcome.action === "rebalance" && strategyId && outcome.txs.length > 0) {
        state.lastRebalanceAt[strategyId] = at;
      }
      if (outcome.action === "recommend_dock" && strategyId) {
        state.lastDockAt[strategyId] = at;
      }
      if (outcome.action === "top_up_usdc" && outcome.txs.length > 0 && at >= dayStart) {
        state.topUpsTodayUsdc += amount;
      }
      if (outcome.action === "top_up_gateway" && outcome.txs.length > 0 && at >= dayStart) {
        state.gatewayDepositsTodayUsdc += amount;
      }
    }
    if (entry.signals && entry.signals.length > 0) {
      state.lastSignals = entry.signals;
    }
  }
  return state;
}
