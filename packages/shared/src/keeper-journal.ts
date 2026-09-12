/**
 * The FX book keeper's journal: one JSON line per event (start, tick, stop, setup). The keeper appends; the CLI and
 * the MCP `keeper_status` tool read it, so status works while the keeper runs in another process.
 *
 * Default path: ~/.aqua0/keeper/journal.jsonl, or AQUA0_KEEPER_JOURNAL. The journal never holds secrets.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ARCSCAN_TX_URL = "https://testnet.arcscan.app/tx/";

export type KeeperTxRef = { stage: string; hash: string; url: string };

export type KeeperLlmUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
  /** Why the rules policy decided instead (invalid output, timeout, cap...), when it did. */
  fallback?: string;
};

export type KeeperStep = {
  decision: { action: string; reason: string } & Record<string, unknown>;
  by: string;
  llm?: KeeperLlmUsage;
  guard: { allowed: boolean; reason?: string };
  spendUsdc?: number;
  result?: string;
  receipt?: { route: string; amountUsdc: string; settlement: string | null; ms: number };
};

export type KeeperSignalLine = {
  pair: string;
  strategyId: string;
  spreadBps: number | null;
  side: string | null;
  oracleAgeSeconds: number | null;
  oracleStatus: string | null;
};

export type KeeperJournalEntry = {
  v: 1;
  type: "start" | "tick" | "stop" | "setup" | "error";
  ts: string;
  tick?: number;
  mode?: "live" | "dry-run";
  policy?: string;
  model?: string | null;
  keeper?: { address: string; walletId?: string; usdc?: number | null; gatewayUsdc?: number | null; agentId?: string | null };
  wake?: { kind: string; detail?: string };
  signals?: KeeperSignalLine[];
  steps?: KeeperStep[];
  outcome?: {
    action: string;
    reason: string;
    by: string;
    pair?: string;
    blocked?: string;
    dryRun?: boolean;
    txs: KeeperTxRef[];
    spreadBeforeBps?: number | null;
    spreadAfterBps?: number | null;
    detail?: Record<string, unknown>;
  };
  spend?: {
    tickUsdc: number;
    hourUsdc: number;
    totalUsdc: number;
    budgetHourUsdc: number;
    llmTickUsd: number;
    llmDayUsd: number;
    llmTotalUsd: number;
    llmCapDayUsd: number;
  };
  errors?: string[];
  note?: string;
  data?: Record<string, unknown>;
};

export function keeperJournalPath(file?: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = file?.trim() || env.AQUA0_KEEPER_JOURNAL?.trim();
  return configured || join(homedir(), ".aqua0", "keeper", "journal.jsonl");
}

export function txRef(stage: string, hash: string): KeeperTxRef {
  return { stage, hash, url: `${ARCSCAN_TX_URL}${hash}` };
}

export function appendKeeperJournal(entry: KeeperJournalEntry, file?: string): void {
  const path = keeperJournalPath(file);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

const TAIL_BYTES = 4 * 1024 * 1024;

/** Entries from the end of the journal (the last `last`, default all within the final 4 MB); bad lines are skipped. */
export function readKeeperJournal(options: { file?: string; last?: number } = {}): KeeperJournalEntry[] {
  const path = keeperJournalPath(options.file);
  if (!existsSync(path)) {
    return [];
  }
  const fd = openSync(path, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString("utf8");
    if (start > 0) {
      text = text.slice(text.indexOf("\n") + 1);
    }
  } finally {
    closeSync(fd);
  }
  const entries: KeeperJournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as KeeperJournalEntry;
      if (parsed && parsed.v === 1 && typeof parsed.type === "string") {
        entries.push(parsed);
      }
    } catch {
      // A partially written last line or a hand edit; skip it.
    }
  }
  return options.last === undefined ? entries : entries.slice(-Math.max(0, options.last));
}

export type KeeperStatus = {
  journal: string;
  running: boolean;
  runningNote: string;
  lastEventAt: string | null;
  keeper: KeeperJournalEntry["keeper"] | null;
  mode: string | null;
  policy: string | null;
  model: string | null;
  summary: string;
  lastRebalance: KeeperActionView | null;
  actions: KeeperActionView[];
  recentTicks: Array<{
    at: string;
    tick: number | null;
    wake: string;
    books: string;
    decision: string;
    reason: string;
    by: string;
    spentUsdc: number;
    llmUsd: number;
    txs: string[];
  }>;
  spend: {
    nanopaymentsUsdcTotal: number;
    nanopaymentsUsdcLastHour: number;
    dataBudgetUsdcPerHour: number | null;
    signalsBought: number;
    llmUsdTotal: number;
    llmUsdToday: number;
    llmCapUsdPerDay: number | null;
  };
};

export type KeeperActionView = {
  at: string;
  action: string;
  pair: string | null;
  reason: string;
  by: string;
  dryRun: boolean;
  blocked: string | null;
  spreadBeforeBps: number | null;
  spreadAfterBps: number | null;
  txs: KeeperTxRef[];
};

const ACTION_KINDS = new Set(["rebalance", "recommend_dock", "top_up_usdc", "top_up_gateway"]);

/** A plain-terms view of the journal: is it running, what it saw and did lately, what it spent. */
export function summarizeKeeperStatus(
  entries: KeeperJournalEntry[],
  options: { journal?: string; last?: number; now?: number; staleAfterSeconds?: number } = {}
): KeeperStatus {
  const now = options.now ?? Date.now();
  const last = options.last ?? 10;
  const staleAfter = (options.staleAfterSeconds ?? 300) * 1000;
  const ticks = entries.filter((entry) => entry.type === "tick");
  const lastEntry = entries.at(-1);
  const lastStart = [...entries].reverse().find((entry) => entry.type === "start");
  const lastTick = ticks.at(-1);
  const lastEventMs = lastEntry ? Date.parse(lastEntry.ts) : Number.NaN;
  const running = Boolean(lastEntry && lastEntry.type !== "stop" && now - lastEventMs < staleAfter);
  const runningNote = !lastEntry
    ? "No journal entries yet: the keeper has not run with this journal path."
    : lastEntry.type === "stop"
      ? `Stopped at ${lastEntry.ts}.`
      : running
        ? `Running: last event ${Math.round((now - lastEventMs) / 1000)}s ago.`
        : `No event for ${Math.round((now - lastEventMs) / 1000)}s: probably not running.`;

  const actions: KeeperActionView[] = ticks
    .filter((entry) => entry.outcome && ACTION_KINDS.has(entry.outcome.action))
    .map((entry) => {
      const outcome = entry.outcome!;
      return {
        at: entry.ts,
        action: outcome.action,
        pair: outcome.pair ?? null,
        reason: outcome.reason,
        by: outcome.by,
        dryRun: Boolean(outcome.dryRun),
        blocked: outcome.blocked ?? null,
        spreadBeforeBps: outcome.spreadBeforeBps ?? null,
        spreadAfterBps: outcome.spreadAfterBps ?? null,
        txs: outcome.txs
      };
    });
  const executedRebalances = actions.filter((item) => item.action === "rebalance" && !item.dryRun && !item.blocked && item.txs.length > 0);
  const lastRebalance = executedRebalances.at(-1) ?? null;

  const hourAgo = now - 3_600_000;
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  let nanoTotal = 0;
  let nanoHour = 0;
  let bought = 0;
  let llmTotal = 0;
  let llmToday = 0;
  for (const entry of ticks) {
    const at = Date.parse(entry.ts);
    for (const step of entry.steps ?? []) {
      if (step.receipt) {
        bought += 1;
        const amount = Number(step.receipt.amountUsdc);
        nanoTotal += amount;
        if (at >= hourAgo) {
          nanoHour += amount;
        }
      }
      if (step.llm) {
        llmTotal += step.llm.costUsd;
        if (at >= dayStart.getTime()) {
          llmToday += step.llm.costUsd;
        }
      }
    }
  }

  const recentTicks = ticks.slice(-last).map((entry) => ({
    at: entry.ts,
    tick: entry.tick ?? null,
    wake: entry.wake ? `${entry.wake.kind}${entry.wake.detail ? `: ${entry.wake.detail}` : ""}` : "unknown",
    books: (entry.signals ?? [])
      .map((line) => `${line.pair} ${line.spreadBps === null ? "n/a" : `${line.spreadBps.toFixed(2)} bps`}${line.side && line.side !== "balanced" ? ` (${line.side})` : ""}`)
      .join(", "),
    decision: entry.outcome ? `${entry.outcome.action}${entry.outcome.pair ? ` ${entry.outcome.pair}` : ""}${entry.outcome.dryRun ? " (dry run)" : ""}${entry.outcome.blocked ? " (blocked)" : ""}` : "none",
    reason: entry.outcome?.blocked ? `${entry.outcome.reason} [blocked: ${entry.outcome.blocked}]` : (entry.outcome?.reason ?? ""),
    by: entry.outcome?.by ?? "",
    spentUsdc: round6(entry.spend?.tickUsdc ?? 0),
    llmUsd: round6(entry.spend?.llmTickUsd ?? 0),
    txs: (entry.outcome?.txs ?? []).map((tx) => tx.url)
  }));

  const summary = !lastEntry
    ? runningNote
    : [
        runningNote,
        lastRebalance
          ? `Last rebalance: ${lastRebalance.pair ?? "a book"} at ${lastRebalance.at}${
              lastRebalance.spreadBeforeBps !== null ? `, spread ${lastRebalance.spreadBeforeBps.toFixed(2)} bps` : ""
            }${lastRebalance.spreadAfterBps !== null ? ` -> ${lastRebalance.spreadAfterBps.toFixed(2)} bps` : ""} (${lastRebalance.txs.at(-1)?.url ?? "no tx"}). Reason: ${lastRebalance.reason}`
          : "No rebalance executed yet in this journal.",
        lastTick?.outcome ? `Latest decision: ${lastTick.outcome.action} (${lastTick.outcome.reason}).` : "",
        `Spent ${round6(nanoTotal)} USDC on ${bought} paid signals (${round6(nanoHour)} in the last hour) and $${round6(llmTotal)} on model calls.`
      ]
        .filter(Boolean)
        .join(" ");

  return {
    journal: keeperJournalPath(options.journal),
    running,
    runningNote,
    lastEventAt: lastEntry?.ts ?? null,
    keeper: lastTick?.keeper ?? lastStart?.keeper ?? null,
    mode: lastTick?.mode ?? lastStart?.mode ?? null,
    policy: lastTick?.policy ?? lastStart?.policy ?? null,
    model: lastTick?.model ?? lastStart?.model ?? null,
    summary,
    lastRebalance,
    actions: actions.slice(-last),
    recentTicks,
    spend: {
      nanopaymentsUsdcTotal: round6(nanoTotal),
      nanopaymentsUsdcLastHour: round6(nanoHour),
      dataBudgetUsdcPerHour: lastTick?.spend?.budgetHourUsdc ?? null,
      signalsBought: bought,
      llmUsdTotal: round6(llmTotal),
      llmUsdToday: round6(llmToday),
      llmCapUsdPerDay: lastTick?.spend?.llmCapDayUsd ?? null
    }
  };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
