/**
 * Aqua0 signals seller: oracle, book and vault signals for the forex strategies, sold per request with Circle
 * Nanopayments (Circle Gateway batched x402 on Arc Testnet). Buyers pay gas-free from a Gateway USDC balance; the
 * seller (the Aqua0 operator wallet by default) receives batched settlements.
 */
import type { Server } from "node:http";

import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import express, { type Request, type RequestHandler, type Response } from "express";
import { getAddress } from "viem";

import {
  LIVE_FOREX_STRATEGIES,
  LIVE_FOREX_STRATEGIST,
  readSignalsSnapshot,
  type KeeperStrategyRef,
  type SignalName,
  type SignalsSnapshot,
  type WriteConfig
} from "@aqua0/shared";

export const DEFAULT_SIGNALS_PORT = 8402;
export const ARC_TESTNET_NETWORK = "eip155:5042002";
/** Circle's testnet x402 facilitator; the SDK default (mainnet) does not list Arc Testnet. */
export const GATEWAY_TESTNET_FACILITATOR = "https://gateway-api-testnet.circle.com";
export const DEFAULT_SIGNAL_PRICES: Record<SignalName, string> = { oracle: "$0.0005", book: "$0.001", vault: "$0.0005" };

const DESCRIPTIONS: Record<SignalName, string> = {
  oracle: "Per forex strategy: oracle price, age, staleness window, freshness and band check",
  book: "Per forex strategy: 0.1 USDC probe spreads both ways, Aqua book balances, tilt side and the trade that restores an even split",
  vault: "The strategist's USDC principal, free principal and committed backing per strategy class"
};

export type SignalsSale = { at: string; route: string; amountUsdc: string; payer: string; settlement: string | null };

export type SignalsServerOptions = {
  config: WriteConfig;
  sellerAddress: string;
  prices?: Partial<Record<SignalName, string>>;
  facilitatorUrl?: string;
  strategies?: readonly KeeperStrategyRef[];
  vaultAddress?: string;
  /** Reuse a snapshot for this long unless a buyer asks for a newer block (?minBlock=). Default 2000 ms. */
  cacheMs?: number;
  log?: (line: string) => void;
  /** Test seam: replaces the RPC read. */
  readSnapshot?: (include: SignalName[]) => Promise<SignalsSnapshot>;
};

export function createSignalsApp(options: SignalsServerOptions): {
  app: import("express").Express;
  sales: SignalsSale[];
  prices: Record<SignalName, string>;
  seller: string;
} {
  const prices = { ...DEFAULT_SIGNAL_PRICES, ...options.prices };
  const seller = getAddress(options.sellerAddress);
  const log = options.log ?? ((line: string) => console.log(line));
  const cacheMs = options.cacheMs ?? 2_000;
  const read =
    options.readSnapshot ??
    ((include: SignalName[]) =>
      readSignalsSnapshot(options.config, {
        include,
        ...(options.strategies ? { strategies: options.strategies } : {}),
        vaultAddress: options.vaultAddress ?? LIVE_FOREX_STRATEGIST
      }));
  const sales: SignalsSale[] = [];
  const cache = new Map<"market" | "vault", { at: number; snapshot: Promise<SignalsSnapshot> }>();

  async function snapshotFor(kind: "market" | "vault", minBlock: bigint): Promise<SignalsSnapshot> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const cached = cache.get(kind);
      let promise = cached && Date.now() - cached.at < cacheMs ? cached.snapshot : undefined;
      if (!promise) {
        promise = read(kind === "vault" ? ["vault"] : ["oracle", "book"]);
        cache.set(kind, { at: Date.now(), snapshot: promise });
        promise.catch(() => cache.delete(kind));
      }
      const snapshot = await promise;
      if (BigInt(snapshot.blockNumber) >= minBlock) {
        return snapshot;
      }
      cache.delete(kind);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`the RPC has not reached block ${minBlock} yet`);
  }

  const gateway = createGatewayMiddleware({
    sellerAddress: seller,
    networks: [ARC_TESTNET_NETWORK],
    facilitatorUrl: options.facilitatorUrl ?? GATEWAY_TESTNET_FACILITATOR
  });

  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ ok: true, seller, network: ARC_TESTNET_NETWORK, prices, sold: sales.length });
  });
  app.get("/v1/catalog", (_req, res) => {
    res.json({
      seller,
      network: ARC_TESTNET_NETWORK,
      payment: "Circle Nanopayments: x402 exact scheme, GatewayWalletBatched (Circle Gateway on Arc Testnet)",
      facilitator: options.facilitatorUrl ?? GATEWAY_TESTNET_FACILITATOR,
      routes: (Object.keys(DESCRIPTIONS) as SignalName[]).map((name) => ({ path: `/v1/${name}`, price: prices[name], description: DESCRIPTIONS[name] })),
      query: "?minBlock=<n> waits until the signal is read at or after block n"
    });
  });
  app.get("/v1/sales", (_req, res) => {
    res.json({ seller, count: sales.length, sales: sales.slice(-50) });
  });

  for (const name of Object.keys(DESCRIPTIONS) as SignalName[]) {
    app.get(`/v1/${name}`, gateway.require(prices[name]) as unknown as RequestHandler, (req: Request, res: Response) => {
      void (async () => {
        const minBlock = parseMinBlock(req.query.minBlock);
        const payment = (req as unknown as { payment?: { payer?: string; amount?: string; transaction?: string } }).payment;
        const sale: SignalsSale = {
          at: new Date().toISOString(),
          route: `/v1/${name}`,
          amountUsdc: payment?.amount ? (Number(payment.amount) / 1e6).toString() : prices[name].replace("$", ""),
          payer: payment?.payer ?? "unknown",
          settlement: payment?.transaction ?? null
        };
        sales.push(sale);
        log(`${sale.at.slice(11, 19)} sold ${sale.route} ${sale.amountUsdc} USDC to ${sale.payer} (Gateway settlement ${sale.settlement ?? "n/a"})`);
        try {
          const snapshot = await snapshotFor(name === "vault" ? "vault" : "market", minBlock);
          res.json(sliceSnapshot(snapshot, name));
        } catch (error) {
          res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  }

  return { app, sales, prices, seller };
}

/** One signal's view of a snapshot: oracle rows, book rows, or the vault. */
export function sliceSnapshot(snapshot: SignalsSnapshot, name: SignalName): SignalsSnapshot & { signal: SignalName } {
  const base = { signal: name, source: snapshot.source, chainId: snapshot.chainId, blockNumber: snapshot.blockNumber, at: snapshot.at };
  if (name === "vault") {
    return { ...base, strategies: [], ...(snapshot.vault ? { vault: snapshot.vault } : {}) };
  }
  return {
    ...base,
    strategies: snapshot.strategies.map((row) => ({
      ...row,
      oracle: name === "oracle" ? row.oracle : null,
      book: name === "book" ? row.book : null
    }))
  };
}

export async function startSignalsServer(
  options: SignalsServerOptions & { port?: number; host?: string }
): Promise<{ url: string; close(): Promise<void>; sales: SignalsSale[]; seller: string }> {
  const { app, sales, seller } = createSignalsApp(options);
  const port = options.port ?? DEFAULT_SIGNALS_PORT;
  const host = options.host ?? "127.0.0.1";
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening));
    listening.on("error", reject);
  });
  return {
    url: `http://${host}:${port}`,
    seller,
    sales,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function parseMinBlock(value: unknown): bigint {
  return typeof value === "string" && /^\d{1,12}$/.test(value) ? BigInt(value) : 0n;
}

export { LIVE_FOREX_STRATEGIES };
