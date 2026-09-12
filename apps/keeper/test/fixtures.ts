import { computeBook, type OracleSignal, type SignalsSnapshot, type StrategySignal } from "@aqua0/shared";

import { SIGNAL_PRICES_USDC } from "../src/config.js";
import { ACTIONS, type Budget, type Limits, type Observation } from "../src/policy.js";

export const ARS = "0xc39dd71deb079e2cd3b725f31562a74cea0e5266244170df4974739402f58597";
export const BRL = "0x87e021d4a0a607f009dbb4689b593ce816c6d13fde885282ce385888290f2aa1";

export const limits: Limits = {
  tiltThresholdBps: 150,
  maxTradeUsdc: 0.25,
  minTradeUsdc: 0.01,
  cooldownSeconds: 90,
  keeperUsdcFloor: 0.5,
  keeperTopUpUsdc: 1,
  gatewayFloorUsdc: 0.05,
  gatewayTopUpUsdc: 0.25,
  oracleMaxAgeForTradeSeconds: 120,
  bookRefreshSeconds: 600,
  vaultRefreshSeconds: 3600,
  dockRepeatSeconds: 3600,
  allowedActions: [...ACTIONS],
  prices: SIGNAL_PRICES_USDC
};

export function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    dataSpentHourUsdc: 0,
    dataBudgetHourUsdc: 0.5,
    dataRemainingUsdc: 0.5,
    topUpsTodayUsdc: 0,
    topUpCapDayUsdc: 3,
    gatewayDepositsTodayUsdc: 0,
    gatewayCapDayUsdc: 1,
    llmSpentDayUsd: 0,
    llmCapDayUsd: 0.5,
    ...overrides
  };
}

export function oracle(status: OracleSignal["status"] = "ok", overrides: Partial<OracleSignal> = {}): OracleSignal {
  return {
    source: "RedStone",
    price: "0.194117 USD per 1 BRL",
    fxPerUsdc: 5.15,
    ageSeconds: status === "stale" ? 7200 : 3,
    maxStalenessSeconds: 3600,
    fresh: status !== "stale",
    inBand: status !== "out-of-band",
    status,
    updatedAt: null,
    ...overrides
  };
}

export const flatBook = computeBook({ usdcBalance: 1.0006, fxBalance: 5.1516, fxPerUsdc: 5.15, usdcInSpreadBps: 30, fxInSpreadBps: 30 });
export const tiltedBook = computeBook({ usdcBalance: 1.1006, fxBalance: 4.638, fxPerUsdc: 5.15, usdcInSpreadBps: 263.6, fxInSpreadBps: -12 });

export function snapshot(rows: Array<Partial<StrategySignal> & { strategyId: `0x${string}`; pair: string }>, blockNumber = "61780000"): SignalsSnapshot {
  return {
    source: "test",
    chainId: 5042002,
    blockNumber,
    at: "2026-09-12T20:00:00.000Z",
    strategies: rows.map((row) => ({ live: true, oracle: null, book: null, errors: [], ...row }))
  };
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    now: "2026-09-12T20:00:00.000Z",
    tick: 1,
    wake: { kind: "heartbeat", swaps: [] },
    keeper: { address: "0x5214daeb80b07340bac9060559d660e905564d87", usdc: 2.4, gatewayUsdc: 0.49 },
    strategies: [
      { pair: "USDC/ARS", strategyId: ARS },
      { pair: "USDC/BRL", strategyId: BRL }
    ],
    bought: {},
    signalAgeSeconds: { oracle: null, book: null, vault: null },
    lastKnown: [],
    cooldownSeconds: {},
    dockRecommendedAgeSeconds: {},
    limits,
    ...overrides
  };
}

export const brlSwap = {
  pair: "USDC/BRL",
  strategyId: BRL,
  txHash: "0xe28f401465a86dd8557ddd8de548366b0ad5e1fe20db74f71e56cd4a6bcc172a",
  blockNumber: "61780000",
  taker: "0xb0c0687eb013a5ffde4d23a89398a11bc424d952",
  direction: "usdc-in" as const,
  amountIn: "100000",
  amountOut: "513597612703509834"
};

/** A swap wake where the book and oracle were bought this tick: BRL tilted, ARS flat. */
export function tiltedAfterSwap(overrides: Partial<Observation> = {}): Observation {
  return observation({
    wake: { kind: "swap", swaps: [brlSwap] },
    bought: {
      book: {
        at: "2026-09-12T20:00:01.000Z",
        blockNumber: "61780000",
        spentUsdc: 0.001,
        snapshot: snapshot([
          { pair: "USDC/ARS", strategyId: ARS, book: flatBook },
          { pair: "USDC/BRL", strategyId: BRL, book: tiltedBook }
        ])
      },
      oracle: {
        at: "2026-09-12T20:00:02.000Z",
        blockNumber: "61780000",
        spentUsdc: 0.0005,
        snapshot: snapshot([
          { pair: "USDC/ARS", strategyId: ARS, oracle: oracle("ok", { fxPerUsdc: 1400, price: "1400 ARS per 1 USD" }) },
          { pair: "USDC/BRL", strategyId: BRL, oracle: oracle("ok") }
        ])
      }
    },
    ...overrides
  });
}
