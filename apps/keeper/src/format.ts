import type { KeeperJournalEntry } from "@aqua0/shared";
import { painter, type Painter } from "./color.js";

/** One readable line per tick for the terminal. */
export function formatTickLine(entry: KeeperJournalEntry): string {
  const time = entry.ts.slice(11, 19);
  const wake = entry.wake ? `${entry.wake.kind}${entry.wake.detail ? ` ${entry.wake.detail}` : ""}` : "?";
  const receipts = (entry.steps ?? []).filter((step) => step.receipt);
  const bought = receipts.length > 0 ? receipts.map((step) => step.receipt?.route.split("/").pop()).join("+") : "none";
  const spend = entry.spend;
  const spendText = spend
    ? `bought ${bought} ${fmt(spend.tickUsdc)} USDC (hour ${fmt(spend.hourUsdc)}/${spend.budgetHourUsdc})`
    : `bought ${bought}`;
  const books = (entry.signals ?? [])
    .map((line) => {
      const name = line.pair.replace("USDC/", "");
      const spread =
        line.spreadBps === null
          ? "n/a"
          : `${line.spreadBps >= 0 ? "+" : ""}${line.spreadBps.toFixed(1)}bps${line.bookCached ? " (cached)" : ""}`;
      const oracle = line.oracleAgeSeconds === null ? "" : ` oracle ${line.oracleAgeSeconds}s ${line.oracleStatus ?? ""}`.trimEnd();
      return `${name} ${spread}${oracle}`;
    })
    .join(", ");
  const outcome = entry.outcome;
  const decision = outcome
    ? `${outcome.by}: ${outcome.action}${outcome.pair ? ` ${outcome.pair}` : ""}${outcome.dryRun ? " (dry run)" : ""}${outcome.blocked ? ` BLOCKED (${outcome.blocked})` : ""} - ${outcome.reason}`
    : "no decision";
  const llmSteps = (entry.steps ?? []).filter((step) => step.llm);
  const llm = llmSteps
    .map((step) => {
      const usage = step.llm!;
      return `model ${usage.model} ${usage.inputTokens}/${usage.outputTokens} tok $${usage.costUsd.toFixed(6)}${usage.fallback ? ` fallback: ${usage.fallback}` : ""}`;
    })
    .join("; ");
  const llmText = llm ? ` | ${llm} (day $${(spend?.llmDayUsd ?? 0).toFixed(6)})` : "";
  const result =
    outcome && (outcome.spreadBeforeBps !== undefined || outcome.spreadAfterBps !== undefined)
      ? ` | spread ${outcome.spreadBeforeBps ?? "?"} -> ${outcome.spreadAfterBps ?? "?"} bps`
      : "";
  const detailNote = typeof outcome?.detail?.note === "string" ? ` | ${outcome.detail.note}` : "";
  const txs = (outcome?.txs ?? []).map((tx) => tx.url).join(" ");
  const errors = entry.errors && entry.errors.length > 0 ? ` | errors: ${entry.errors.join("; ")}` : "";
  return `${time} #${entry.tick ?? "?"} wake=${wake} | ${spendText} | ${books || "no signals"} | ${decision}${llmText}${result}${detailNote}${txs ? ` | ${txs}` : ""}${errors}`;
}

function fmt(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** A tick as a labelled block for a live terminal, coloured when `color` is set. The journal keeps formatTickLine. */
export function formatTickBlock(entry: KeeperJournalEntry, options: { color?: boolean; tiltBps?: number } = {}): string {
  const c = painter(options.color ?? false);
  const tiltBps = options.tiltBps ?? 150;
  const label = (name: string) => `  ${c.dim(name.padEnd(9))}`;
  const lines: string[] = [];

  const kind = entry.wake?.kind ?? "?";
  const wake = kind === "swap" ? c.magentaBold(kind) : kind === "heartbeat" ? c.dim(kind) : c.cyan(kind);
  const detail = entry.wake?.detail ? ` ${c.magenta(entry.wake.detail)}` : "";
  lines.push(`${c.dim(entry.ts.slice(11, 19))} ${c.bold(`#${entry.tick ?? "?"}`)} ${wake}${detail}`);

  const bought = (entry.steps ?? [])
    .filter((step) => step.receipt)
    .map((step) => step.receipt?.route.split("/").pop())
    .join("+");
  const spend = entry.spend
    ? ` ${c.dim("·")} ${fmt(entry.spend.tickUsdc)} USDC ${c.dim(`(hour ${fmt(entry.spend.hourUsdc)}/${entry.spend.budgetHourUsdc})`)}`
    : "";
  lines.push(`${label("paid")}${bought ? `${c.green(bought)}${spend}` : c.dim("no signals bought")}`);

  const books = (entry.signals ?? []).map((line) => {
    const name = c.bold(line.pair.replace("USDC/", ""));
    const spread =
      line.spreadBps === null
        ? c.dim("spread n/a")
        : `${spreadColor(c, line.spreadBps, tiltBps)(`${line.spreadBps >= 0 ? "+" : ""}${line.spreadBps.toFixed(1)} bps`)}${line.bookCached ? c.dim(" (cached)") : ""}`;
    const oracle =
      line.oracleAgeSeconds === null
        ? ""
        : ` ${c.dim("oracle")} ${formatAge(line.oracleAgeSeconds)} ${line.oracleStatus === "ok" ? c.green("ok") : c.red(line.oracleStatus ?? "?")}`;
    return `${name} ${spread}${oracle}`;
  });
  if (books.length > 0) {
    lines.push(`${label("books")}${books.join("   ")}`);
  }

  const outcome = entry.outcome;
  if (outcome) {
    const by = outcome.by.startsWith("llm") ? c.magenta(outcome.by) : c.blue(outcome.by);
    const action =
      outcome.action === "rebalance" ? c.yellowBold(outcome.action) : outcome.action === "wait" ? outcome.action : c.yellow(outcome.action);
    const flags = `${outcome.dryRun ? c.yellow(" (dry run)") : ""}${outcome.blocked ? c.red(` BLOCKED (${outcome.blocked})`) : ""}`;
    lines.push(`${label("decision")}${by} ${action}${outcome.pair ? ` ${outcome.pair}` : ""}${flags} ${c.dim("·")} ${outcome.reason}`);
  } else {
    lines.push(`${label("decision")}${c.dim("none")}`);
  }

  for (const step of (entry.steps ?? []).filter((item) => item.llm)) {
    const usage = step.llm!;
    lines.push(
      `${label("model")}${c.magenta(usage.model)} ${usage.inputTokens}/${usage.outputTokens} tok ${c.dim(`$${usage.costUsd.toFixed(6)}`)}${usage.fallback ? c.yellow(` fallback: ${usage.fallback}`) : ""}`
    );
  }

  if (outcome && (outcome.spreadBeforeBps != null || outcome.spreadAfterBps != null)) {
    const note = typeof outcome.detail?.note === "string" ? ` ${c.dim("·")} ${outcome.detail.note}` : "";
    lines.push(`${label("result")}${c.red(`${outcome.spreadBeforeBps ?? "?"} bps`)} ${c.dim("→")} ${c.green(`${outcome.spreadAfterBps ?? "?"} bps`)}${note}`);
  }
  for (const tx of outcome?.txs ?? []) {
    lines.push(`${label("tx")}${c.dim(tx.stage)} ${c.blue(tx.url)}`);
  }
  for (const error of entry.errors ?? []) {
    lines.push(`${label("error")}${c.red(error)}`);
  }
  return lines.join("\n");
}

function spreadColor(c: Painter, bps: number, tiltBps: number): (text: string) => string {
  if (bps >= tiltBps) {
    return c.red;
  }
  return bps <= 50 ? c.green : c.yellow;
}

function formatAge(seconds: number): string {
  if (seconds < 120) {
    return `${seconds}s`;
  }
  if (seconds < 7200) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 172800) {
    return `${(seconds / 3600).toFixed(1)}h`;
  }
  return `${(seconds / 86400).toFixed(1)}d`;
}
