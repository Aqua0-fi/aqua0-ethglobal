/**
 * Guardrails, enforced by the executor on every decision whatever policy produced it. Circle's wallet spending caps
 * are mainnet-only, so these checks are the keeper's safety on Arc Testnet.
 */
import { tiltedStrategies, type Budget, type Decision, type Observation } from "./policy.js";

export type GuardResult = { allowed: true } | { allowed: false; reason: string };

export function checkDecision(decision: Decision, observation: Observation, budget: Budget): GuardResult {
  const limits = observation.limits;
  if (!limits.allowedActions.includes(decision.action)) {
    return { allowed: false, reason: `action ${decision.action} is not in the allowed actions (${limits.allowedActions.join(", ")})` };
  }
  switch (decision.action) {
    case "wait":
      return { allowed: true };
    case "buy_signal": {
      const price = limits.prices[decision.which];
      if (price === undefined) {
        return { allowed: false, reason: `unknown signal ${String(decision.which)}` };
      }
      if (observation.bought[decision.which]) {
        return { allowed: false, reason: `the ${decision.which} signal was already bought this tick` };
      }
      if (price > budget.dataRemainingUsdc + 1e-9) {
        return { allowed: false, reason: `data budget: ${budget.dataRemainingUsdc} USDC left this hour, ${decision.which} costs ${price}` };
      }
      return { allowed: true };
    }
    case "recommend_dock": {
      if (!observation.strategies.some((strategy) => strategy.strategyId === decision.strategyId)) {
        return { allowed: false, reason: `unknown strategy ${decision.strategyId}` };
      }
      return { allowed: true };
    }
    case "rebalance": {
      if (!observation.strategies.some((strategy) => strategy.strategyId === decision.strategyId)) {
        return { allowed: false, reason: `unknown strategy ${decision.strategyId}` };
      }
      if (decision.direction !== "fx-in" && decision.direction !== "usdc-in") {
        return { allowed: false, reason: `invalid direction ${String(decision.direction)}` };
      }
      if (!Number.isFinite(decision.sizeUsdc) || decision.sizeUsdc <= 0) {
        return { allowed: false, reason: `invalid size ${decision.sizeUsdc}` };
      }
      if (decision.sizeUsdc > limits.maxTradeUsdc + 1e-9) {
        return { allowed: false, reason: `size ${decision.sizeUsdc} USDC is above the max trade ${limits.maxTradeUsdc}` };
      }
      if (decision.sizeUsdc < limits.minTradeUsdc - 1e-9) {
        return { allowed: false, reason: `size ${decision.sizeUsdc} USDC is below the min trade ${limits.minTradeUsdc}` };
      }
      const cooldown = observation.cooldownSeconds[decision.strategyId] ?? 0;
      if (cooldown > 0) {
        return { allowed: false, reason: `cooldown: ${cooldown}s left on ${decision.pair}` };
      }
      const tilted = tiltedStrategies(observation).find((view) => view.strategyId === decision.strategyId);
      if (!tilted) {
        return { allowed: false, reason: `this tick's book signal does not show ${decision.pair} above ${limits.tiltThresholdBps} bps` };
      }
      if (tilted.book?.rebalance?.direction !== decision.direction) {
        return { allowed: false, reason: `direction ${decision.direction} would tilt the book further (it needs ${tilted.book?.rebalance?.direction})` };
      }
      if (tilted.oracleStatus !== "ok") {
        return { allowed: false, reason: `${decision.pair} oracle is not confirmed fresh and in band (${tilted.oracleStatus ?? "unknown"})` };
      }
      return { allowed: true };
    }
    case "top_up_usdc": {
      if (!Number.isFinite(decision.amountUsdc) || decision.amountUsdc <= 0 || decision.amountUsdc > limits.keeperTopUpUsdc + 1e-9) {
        return { allowed: false, reason: `top-up ${decision.amountUsdc} USDC must be in (0, ${limits.keeperTopUpUsdc}]` };
      }
      if (budget.topUpsTodayUsdc + decision.amountUsdc > budget.topUpCapDayUsdc + 1e-9) {
        return { allowed: false, reason: `daily top-up cap: ${budget.topUpsTodayUsdc} of ${budget.topUpCapDayUsdc} USDC used` };
      }
      return { allowed: true };
    }
    case "top_up_gateway": {
      if (!Number.isFinite(decision.amountUsdc) || decision.amountUsdc <= 0 || decision.amountUsdc > limits.gatewayTopUpUsdc + 1e-9) {
        return { allowed: false, reason: `Gateway deposit ${decision.amountUsdc} USDC must be in (0, ${limits.gatewayTopUpUsdc}]` };
      }
      if (budget.gatewayDepositsTodayUsdc + decision.amountUsdc > budget.gatewayCapDayUsdc + 1e-9) {
        return { allowed: false, reason: `daily Gateway deposit cap: ${budget.gatewayDepositsTodayUsdc} of ${budget.gatewayCapDayUsdc} USDC used` };
      }
      if (observation.keeper.usdc !== null && observation.keeper.usdc < decision.amountUsdc) {
        return { allowed: false, reason: `keeper holds ${observation.keeper.usdc} USDC, less than the deposit` };
      }
      return { allowed: true };
    }
    default:
      return { allowed: false, reason: `unknown action ${(decision as { action?: unknown }).action as string}` };
  }
}
