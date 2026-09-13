import type { KeeperJournalEntry } from "@aqua0/shared";

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
