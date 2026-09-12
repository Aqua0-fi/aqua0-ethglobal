/**
 * An OpenAI model as the keeper's decision policy, behind the same Policy seam as the rules.
 *
 * The model is asked only when something happened (a swap, a tilted book, an oracle problem, a balance floor) and only
 * once the tick's signals are bought; signal purchases and quiet heartbeats stay with the rules, so the model is not
 * paid for them. It gets a compact observation and must answer with one action from the closed set as schema-checked
 * JSON. Invalid output, an API error, a timeout, a guardrail violation or the daily spend cap all fall back to the
 * rules policy, and the journal says so. Every limit is still enforced again by the executor.
 */
import type { KeeperJournalEntry, KeeperLlmUsage, SignalName } from "@aqua0/shared";

import { checkDecision } from "./guard.js";
import {
  ACTIONS,
  RulesPolicy,
  round6,
  strategyViews,
  tiltedStrategies,
  type Budget,
  type Decision,
  type Observation,
  type Policy,
  type PolicyOutcome
} from "./policy.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5-nano";

/** Standard-tier USD per 1M tokens (developers.openai.com/api/docs/pricing, checked 2026-09-12). */
export const OPENAI_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 }
};
const UNKNOWN_MODEL_PRICE = { input: 1.25, output: 10 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(OPENAI_PRICES_PER_MTOK)
    .sort((a, b) => b.length - a.length)
    .find((name) => model === name || model.startsWith(`${name}-`));
  const price = key ? OPENAI_PRICES_PER_MTOK[key]! : UNKNOWN_MODEL_PRICE;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** The subset of the `openai` client the policy calls; tests pass a mock. */
export type ResponsesClient = {
  responses: {
    create(
      body: Record<string, unknown>,
      options?: { timeout?: number; maxRetries?: number }
    ): Promise<{ output_text?: string; status?: string; usage?: { input_tokens?: number; output_tokens?: number } | null }>;
  };
};

export const DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    strategyId: { type: ["string", "null"] },
    direction: { type: ["string", "null"], enum: ["fx-in", "usdc-in", null] },
    sizeUsdc: { type: ["number", "null"] },
    which: { type: ["string", "null"], enum: ["oracle", "book", "vault", null] },
    amountUsdc: { type: ["number", "null"] },
    reason: { type: "string" }
  },
  required: ["action", "strategyId", "direction", "sizeUsdc", "which", "amountUsdc", "reason"]
} as const;

const INSTRUCTIONS = `You are the Aqua0 FX book keeper, an autonomous agent on Arc Testnet. You keep two USDC/FX forex books (1inch Aqua strategies priced from an FX oracle) near an even split so traders get the flat oracle price (about 30 bps).
Choose exactly one action from allowedActions:
- rebalance: only for a strategy in this tick's signals whose spreadBps is above limits.tiltThresholdBps, whose oracleStatus is "ok" and whose cooldown is 0. direction must equal its suggested direction. sizeUsdc must be at most limits.maxTradeUsdc and at most the suggested size.
- recommend_dock: when a strategy's oracle is stale or out of band (the keeper cannot dock; the strategist must).
- top_up_usdc / top_up_gateway: when a balance is under its floor, within the amounts in limits and the remaining daily caps.
- wait: when nothing needs doing, or when acting would break a limit.
Never invent strategies or amounts. The executor re-checks every limit and ignores invalid choices. Reply with the JSON object only. reason: one sentence under 30 words citing the numbers you used.`;

export type LlmPolicyOptions = {
  client: ResponsesClient;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  capDayUsd: number;
  /** LLM spend already recorded today (from the journal). */
  spentTodayUsd?: number;
  fallback?: Policy;
  now?: () => number;
  /** Redacts the API key from any error text that reaches the journal. */
  secret?: string;
};

export class LlmPolicy implements Policy {
  readonly name = "llm";
  readonly model: string;
  readonly #client: ResponsesClient;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #capDayUsd: number;
  readonly #fallback: Policy;
  readonly #now: () => number;
  readonly #secret: string | undefined;
  #spentTodayUsd: number;
  #totalUsd = 0;
  #day: string;

  constructor(options: LlmPolicyOptions) {
    this.#client = options.client;
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxOutputTokens = options.maxOutputTokens ?? 600;
    this.#capDayUsd = options.capDayUsd;
    this.#fallback = options.fallback ?? new RulesPolicy();
    this.#now = options.now ?? Date.now;
    this.#secret = options.secret;
    this.#spentTodayUsd = options.spentTodayUsd ?? 0;
    this.#day = utcDay(this.#now());
  }

  get spentTodayUsd(): number {
    this.#rollDay();
    return round6(this.#spentTodayUsd);
  }

  get totalUsd(): number {
    return round6(this.#totalUsd);
  }

  async decide(observation: Observation, budget: Budget, journalTail: readonly KeeperJournalEntry[]): Promise<PolicyOutcome> {
    const baseline = await this.#fallback.decide(observation, budget, journalTail);
    if (baseline.decision.action === "buy_signal") {
      return baseline;
    }
    const trigger = notableReason(observation);
    if (!trigger) {
      return baseline;
    }
    this.#rollDay();
    if (this.#spentTodayUsd >= this.#capDayUsd) {
      return this.#fallbackOutcome(baseline, `daily model spend cap $${this.#capDayUsd} reached`, undefined);
    }
    const started = this.#now();
    let usage: KeeperLlmUsage | undefined;
    try {
      const response = await this.#client.responses.create(
        {
          model: this.model,
          instructions: INSTRUCTIONS,
          input: JSON.stringify(compactObservation(observation, budget, journalTail, trigger, baseline.decision)),
          text: { format: { type: "json_schema", name: "keeper_decision", schema: DECISION_JSON_SCHEMA, strict: true } },
          max_output_tokens: this.#maxOutputTokens,
          ...(isReasoningModel(this.model) ? { reasoning: { effort: "minimal" } } : {}),
          store: false
        },
        { timeout: this.#timeoutMs, maxRetries: 0 }
      );
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const costUsd = estimateCostUsd(this.model, inputTokens, outputTokens);
      this.#spentTodayUsd += costUsd;
      this.#totalUsd += costUsd;
      usage = { model: this.model, inputTokens, outputTokens, costUsd: Number(costUsd.toFixed(9)), ms: this.#now() - started };
      const parsed = parseModelDecision(response.output_text ?? "", observation);
      if ("error" in parsed) {
        return this.#fallbackOutcome(baseline, `invalid model output: ${parsed.error}`, usage);
      }
      const guard = checkDecision(parsed.decision, observation, budget);
      if (!guard.allowed) {
        return this.#fallbackOutcome(baseline, `model chose ${parsed.decision.action}, outside the limits: ${guard.reason}`, usage);
      }
      return { decision: parsed.decision, by: `llm:${this.model}`, llm: usage };
    } catch (error) {
      const message = this.#redact(error instanceof Error ? error.message : String(error));
      const kind = /timed? ?out|timeout|abort/i.test(message) ? "timeout" : "API error";
      return this.#fallbackOutcome(baseline, `model ${kind}: ${message.slice(0, 160)}`, usage ?? { model: this.model, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: this.#now() - started });
    }
  }

  #fallbackOutcome(baseline: PolicyOutcome, why: string, usage: KeeperLlmUsage | undefined): PolicyOutcome {
    return {
      decision: baseline.decision,
      by: "rules (llm fallback)",
      llm: { ...(usage ?? { model: this.model, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 }), fallback: why }
    };
  }

  #rollDay(): void {
    const today = utcDay(this.#now());
    if (today !== this.#day) {
      this.#day = today;
      this.#spentTodayUsd = 0;
    }
  }

  #redact(text: string): string {
    return this.#secret && this.#secret.length >= 8 ? text.split(this.#secret).join("[redacted]") : text;
  }
}

/** Why this tick is worth a model call, or null for a quiet tick. */
export function notableReason(observation: Observation): string | null {
  const limits = observation.limits;
  if (observation.wake.kind === "swap") {
    return `swap on ${[...new Set(observation.wake.swaps.map((swap) => swap.pair))].join(", ")}`;
  }
  const tilted = tiltedStrategies(observation);
  if (tilted.length > 0) {
    return `${tilted.map((view) => view.pair).join(", ")} above ${limits.tiltThresholdBps} bps`;
  }
  const badOracle = strategyViews(observation).find((view) => view.oracle && view.oracle.status !== "ok" && view.oracle.status !== "unknown");
  if (badOracle) {
    return `${badOracle.pair} oracle ${badOracle.oracle?.status}`;
  }
  if (observation.keeper.usdc !== null && observation.keeper.usdc < limits.keeperUsdcFloor) {
    return "keeper USDC under floor";
  }
  if (observation.keeper.gatewayUsdc !== null && observation.keeper.gatewayUsdc < limits.gatewayFloorUsdc) {
    return "Gateway balance under floor";
  }
  return null;
}

export function compactObservation(
  observation: Observation,
  budget: Budget,
  journalTail: readonly KeeperJournalEntry[],
  trigger: string,
  baseline: Decision
) {
  const limits = observation.limits;
  return {
    now: observation.now,
    trigger,
    wake: {
      kind: observation.wake.kind,
      swaps: observation.wake.swaps.map((swap) => ({ pair: swap.pair, direction: swap.direction, amountIn: swap.amountIn, taker: swap.taker }))
    },
    keeper: observation.keeper,
    strategies: strategyViews(observation).map((view) => ({
      pair: view.pair,
      strategyId: view.strategyId,
      spreadBps: view.book?.spreadBps ?? null,
      usdcInSpreadBps: view.book?.usdcInSpreadBps ?? null,
      fxInSpreadBps: view.book?.fxInSpreadBps ?? null,
      side: view.book?.side ?? null,
      usdcShare: view.book?.usdcShare ?? null,
      suggested: view.book?.rebalance ?? null,
      oracleStatus: view.oracleStatus,
      oracleAgeSeconds: view.oracle?.ageSeconds ?? null,
      oracleMaxStalenessSeconds: view.oracle?.maxStalenessSeconds ?? null,
      cooldownSeconds: observation.cooldownSeconds[view.strategyId] ?? 0
    })),
    budget: {
      dataRemainingUsdc: round6(budget.dataRemainingUsdc),
      topUpCapLeftUsdc: round6(budget.topUpCapDayUsdc - budget.topUpsTodayUsdc),
      gatewayCapLeftUsdc: round6(budget.gatewayCapDayUsdc - budget.gatewayDepositsTodayUsdc)
    },
    limits: {
      tiltThresholdBps: limits.tiltThresholdBps,
      maxTradeUsdc: limits.maxTradeUsdc,
      minTradeUsdc: limits.minTradeUsdc,
      keeperUsdcFloor: limits.keeperUsdcFloor,
      keeperTopUpUsdc: limits.keeperTopUpUsdc,
      gatewayFloorUsdc: limits.gatewayFloorUsdc,
      gatewayTopUpUsdc: limits.gatewayTopUpUsdc
    },
    allowedActions: limits.allowedActions.filter((action) => action !== "buy_signal"),
    rulesSuggestion: baseline,
    recentDecisions: journalTail
      .filter((entry) => entry.type === "tick" && entry.outcome)
      .slice(-5)
      .map((entry) => ({ at: entry.ts, action: entry.outcome?.action, pair: entry.outcome?.pair ?? null, reason: entry.outcome?.reason }))
  };
}

/** Parse and shape-check the model's JSON into a Decision; limits are checked separately. */
export function parseModelDecision(text: string, observation: Observation): { decision: Decision } | { error: string } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text ? "not JSON" : "empty response" };
  }
  if (!raw || typeof raw !== "object") {
    return { error: "not an object" };
  }
  const action = raw.action;
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 400) : "";
  if (!reason) {
    return { error: "missing reason" };
  }
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return { error: `unknown action ${String(action)}` };
  }
  const strategy = (id: unknown) => observation.strategies.find((item) => item.strategyId.toLowerCase() === String(id).toLowerCase());
  switch (action) {
    case "wait":
      return { decision: { action, reason } };
    case "buy_signal": {
      const which = raw.which;
      if (which !== "oracle" && which !== "book" && which !== "vault") {
        return { error: "buy_signal needs which" };
      }
      return { decision: { action, which: which as SignalName, reason } };
    }
    case "rebalance": {
      const found = strategy(raw.strategyId);
      if (!found) {
        return { error: `unknown strategyId ${String(raw.strategyId)}` };
      }
      if (raw.direction !== "fx-in" && raw.direction !== "usdc-in") {
        return { error: "rebalance needs direction" };
      }
      if (typeof raw.sizeUsdc !== "number" || !Number.isFinite(raw.sizeUsdc)) {
        return { error: "rebalance needs a numeric sizeUsdc" };
      }
      return {
        decision: { action, strategyId: found.strategyId, pair: found.pair, direction: raw.direction, sizeUsdc: round6(raw.sizeUsdc), reason }
      };
    }
    case "recommend_dock": {
      const found = strategy(raw.strategyId);
      if (!found) {
        return { error: `unknown strategyId ${String(raw.strategyId)}` };
      }
      return { decision: { action, strategyId: found.strategyId, pair: found.pair, reason } };
    }
    case "top_up_usdc":
    case "top_up_gateway": {
      if (typeof raw.amountUsdc !== "number" || !Number.isFinite(raw.amountUsdc)) {
        return { error: `${action} needs a numeric amountUsdc` };
      }
      return { decision: { action, amountUsdc: round6(raw.amountUsdc), reason } };
    }
    default:
      return { error: `unhandled action ${action}` };
  }
}

function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
