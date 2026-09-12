import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  benchmarkFxStrategy,
  computePoolMetrics,
  resolveBenchmarkChains,
  resolveBenchmarkCurrency,
  type BenchmarkFxStrategyOptions,
  type FetchLike
} from "../src/index.js";

type Fixtures = {
  gateway: Record<string, Record<string, unknown>>;
  aqua0: unknown;
};

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/graph-benchmark-responses.json", import.meta.url), "utf8")
) as Fixtures;

const KEY = "gw-test-key-7c1d9e2f4a";
// 2026-09-12T18:30:00Z: today's UTC day starts at 1789171200, a 7-day lookback at 1788566400.
const NOW = 1_789_240_200_000;

type Call = { subgraphId: string; operation: string; query: string; authorization: string | null; url: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function gatewayMock(overrides: Record<string, (call: Call, attempt: number) => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const fetchMock: FetchLike = async (input, init) => {
    const url = String(input);
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    const call: Call = {
      url,
      subgraphId: url.split("/").at(-1) ?? "",
      operation: /query (\w+)/.exec(query)?.[1] ?? "",
      query,
      authorization: new Headers(init?.headers).get("authorization")
    };
    calls.push(call);
    const attemptKey = `${call.subgraphId}:${call.operation}`;
    const attempt = (attempts.get(attemptKey) ?? 0) + 1;
    attempts.set(attemptKey, attempt);
    const override = overrides[call.subgraphId];
    if (override) {
      return override(call, attempt);
    }
    const entry = fixtures.gateway[call.subgraphId]?.[call.operation];
    if (entry === undefined) {
      return json({ errors: [{ message: `no fixture for ${call.subgraphId} ${call.operation}` }] });
    }
    if (entry === "bad-indexers") {
      return json({
        errors: [{ message: "bad indexers: {0xf92f430dd8567b0d466358c79594ab58d919a6d4: BadResponse(expected value at line 1 column 1)}" }]
      });
    }
    return json(entry);
  };
  return { fetchMock, calls };
}

function options(fetchMock: FetchLike, extra: Partial<BenchmarkFxStrategyOptions> = {}): BenchmarkFxStrategyOptions {
  return {
    apiKey: KEY,
    fetch: fetchMock,
    now: () => NOW,
    aqua0Graph: {
      endpointOrigin: "https://api.studio.thegraph.com",
      query: async <T>() => fixtures.aqua0 as T
    },
    ...extra
  };
}

test("resolves loose pair phrasing and chains", () => {
  assert.equal(resolveBenchmarkCurrency("USDC/EUR"), "EUR");
  assert.equal(resolveBenchmarkCurrency("eurc"), "EUR");
  assert.equal(resolveBenchmarkCurrency("usdc to brl"), "BRL");
  assert.equal(resolveBenchmarkCurrency("reais"), "BRL");
  assert.equal(resolveBenchmarkCurrency("MXN"), "MXN");
  assert.equal(resolveBenchmarkCurrency("pesos"), "ARS");
  assert.equal(resolveBenchmarkCurrency("XSGD/USDC"), "SGD");
  assert.equal(resolveBenchmarkCurrency("cad"), "CAD");
  assert.throws(() => resolveBenchmarkCurrency("USDC/JPY"), /Unsupported pair/);

  assert.deepEqual(resolveBenchmarkChains(undefined, "MXN"), ["base", "polygon"]);
  assert.deepEqual(resolveBenchmarkChains("eth, matic", "EUR"), ["ethereum", "polygon"]);
  assert.throws(() => resolveBenchmarkChains(["solana"], "EUR"), /Unsupported chain/);
});

test("EUR: one standardized query to every standardized subgraph, across protocols, composed with Aqua0", async () => {
  const { fetchMock, calls } = gatewayMock();
  const result = await benchmarkFxStrategy({ pair: "USDC/EUR", chains: ["ethereum"] }, options(fetchMock));

  // The same pool query goes unchanged to Uniswap v3, Curve and SushiSwap.
  const listCalls = calls.filter((call) => call.operation === "Aqua0BenchmarkStandardPools");
  assert.deepEqual(
    listCalls.map((call) => call.subgraphId).sort(),
    [
      "3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF",
      "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6",
      "77jZ9KWeyi3CJ96zkkj5s1CojKPHt6XJKjLFzsDCd8Fd"
    ]
  );
  assert.equal(new Set(listCalls.map((call) => call.query)).size, 1);
  const listQuery = listCalls[0]?.query ?? "";
  assert.match(listQuery, /inputTokens_contains: \["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c"\]/);
  assert.match(listQuery, /0xdb25f211ab05b1c97d595516f45794528a807ad8/);
  // Ethereum answered with pools, so no non-standardized fallback ran.
  assert.equal(calls.filter((call) => call.operation.startsWith("Aqua0BenchmarkUniswap")).length, 0);

  assert.equal(result.standardized.subgraphsQueried, 3);
  assert.equal(result.standardized.subgraphsAnswered, 3);
  assert.deepEqual([...result.standardized.protocols].sort(), ["curve-finance", "sushiswap", "uniswap-v3"]);

  const euroc = result.pools.find((pool) => pool.id === "0x95dbb3c7546f22bce375900abfdd64a4e5bd73d6");
  assert.ok(euroc);
  assert.equal(euroc.standardized, true);
  assert.equal(euroc.protocol, "uniswap-v3");
  assert.equal(euroc.feeTierBps, 5);
  // Four complete days inside the window; revenue / volume in USD is the 5 bps tier.
  assert.equal(euroc.volumeUsdLookback, 5_496_607.23);
  assert.equal(euroc.avgDailyVolumeUsd, 785_229.6);
  assert.equal(euroc.realizedFeeBps, 5);
  assert.equal(euroc.range24hBasis, "hourly volume-weighted prices");
  assert.ok(euroc.range24hBps !== null && euroc.range24hBps > 9 && euroc.range24hBps < 11);
  assert.equal(euroc.lastActivityAt, new Date(1789231667 * 1000).toISOString());

  const curve = result.pools.find((pool) => pool.protocol === "curve-finance");
  assert.ok(curve);
  assert.equal(curve.pair, "EURS/USDC");
  assert.equal(curve.feeTierBps, 45);
  // Today's snapshot (1789205027) is outside the complete-day window.
  assert.equal(curve.volumeUsdLookback, 385.95);

  // The 0.01% pool and the SushiSwap pool are dust.
  assert.equal(result.ignoredDustPoolCount, 2);

  assert.equal(result.verdict.level, "liquid");
  assert.match(result.verdict.summary, /not competitive on price here: takers already pay 5 bps/);

  assert.equal(result.aqua0.costAtTradeSizes[2]?.aqua0FeeUsd, 300);
  assert.equal(result.aqua0.costAtTradeSizes[2]?.lowestPoolFeeTierBps, 5);
  const aqua0Source = result.sources.find((source) => source.kind === "aqua0");
  assert.equal(aqua0Source?.status, "ok");
  assert.equal(aqua0Source?.meta?.blockNumber, 61776607);
  assert.match(String(result.aqua0.arcTestnet.note), /there is no EUR strategy/);
});

test("BRL: a failed standardized subgraph falls back to the non-standardized one and volume uses the USDC leg", async () => {
  const { fetchMock, calls } = gatewayMock();
  const quoted: string[] = [];
  const result = await benchmarkFxStrategy(
    { pair: "BRL", chains: "polygon" },
    options(fetchMock, {
      arcQuote: async (pair, amount) => {
        quoted.push(`${pair} ${amount}`);
        return {
          pair,
          opcode: "forex",
          amountIn: { amount: "0.1", symbol: "USDC" },
          amountOut: { amount: "0.5136", symbol: "BRAt" },
          pricing: { effectiveSpreadBps: "30.00" },
          internalDetail: "not passed through"
        };
      }
    })
  );

  const uniswap = result.sources.find((source) => source.subgraphId === "BvYimJ6vCLkk63oWZy7WB5cVDTVVMugUAF35RAUZpQXE");
  assert.equal(uniswap?.status, "failed");
  assert.equal(uniswap?.attempts, 2, "a bad-indexers error is retried once");
  assert.match(uniswap?.error ?? "", /bad indexers/);
  assert.equal(calls.filter((call) => call.subgraphId === "BvYimJ6vCLkk63oWZy7WB5cVDTVVMugUAF35RAUZpQXE").length, 2);

  const fallback = result.sources.find((source) => source.subgraphId === "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm");
  assert.equal(fallback?.kind, "non-standardized");
  assert.equal(fallback?.status, "ok");
  assert.deepEqual(result.standardized.nonStandardizedFallbackChains, ["polygon"]);

  const pool = result.pools[0];
  assert.ok(pool);
  assert.equal(pool.standardized, false);
  assert.equal(pool.pair, "BRLA/USDC");
  // volumeUSD is 0 in this subgraph; the USDC leg over the 7 complete days is what traded.
  assert.equal(pool.volumeUsdLookback, 1_475_575.06);
  assert.equal(pool.realizedFeeBps, null);
  assert.ok(pool.notes?.some((note) => /does not price this pool's volume in USD/.test(note)));
  assert.equal(pool.fxPerUsdc, 5.16051);
  assert.ok(pool.tvlUsdEstimate > 190_000 && pool.tvlUsdEstimate < 210_000);

  assert.equal(result.verdict.level, "thin");
  assert.match(result.verdict.summary, /Not fully checked: uniswap-v3 on polygon \(bad indexers/);

  assert.deepEqual(quoted, ["USDC/BRL 0.1"]);
  const arc = result.aqua0.arcTestnet as {
    indexed: { runsThisPair: boolean; fills: { count: number; usdcVolume: number }; liveForexStrategies: Array<{ feeBps: number }> };
    liveQuote: Record<string, unknown>;
  };
  assert.equal(arc.indexed.runsThisPair, true);
  assert.equal(arc.indexed.fills.count, 2);
  assert.equal(arc.indexed.fills.usdcVolume, 0.199404);
  assert.equal(arc.indexed.liveForexStrategies[0]?.feeBps, 30);
  assert.equal(arc.liveQuote.opcode, "forex");
  assert.equal(arc.liveQuote.internalDetail, undefined);
});

test("MXN: no meaningful liquidity, reported with the numbers found", async () => {
  const { fetchMock } = gatewayMock();
  const result = await benchmarkFxStrategy({ pair: "mxn", chains: ["base"] }, options(fetchMock));

  const aerodrome = result.sources.find((source) => source.protocol === "aerodrome");
  assert.equal(aerodrome?.kind, "non-standardized");
  assert.equal(aerodrome?.schema, "Uniswap v3 style (not standardized)");
  assert.equal(result.ignoredDustPoolCount, 1);

  const pool = result.pools[0];
  assert.ok(pool);
  assert.equal(pool.feeTierBps, 100);
  assert.equal(pool.volumeUsdLookback, 9.13);
  assert.equal(pool.lastActivityAt, new Date(1789130869 * 1000).toISOString());

  assert.equal(result.verdict.level, "none");
  assert.match(result.verdict.summary, /^No meaningful onchain liquidity: the deepest MXN\/USDC pool is aerodrome on base, MXNe\/USDC 100 bps, \$11,6\d\d TVL, \$9\.13\/week/);
  assert.match(result.verdict.summary, /gap Aqua0's LatAm FX strategies target/);
});

test("every source failing gives an unknown verdict that names the failures", async () => {
  const { fetchMock } = gatewayMock({
    FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS: () => json({ errors: [{ message: "subgraph not found: no allocations" }] }),
    GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM: () => json({ errors: [{ message: "subgraph not found: no allocations" }] })
  });
  const result = await benchmarkFxStrategy({ pair: "MXN", chains: "base", includeArcQuote: false }, options(fetchMock));
  assert.equal(result.verdict.level, "unknown");
  assert.match(result.verdict.summary, /every source failed/);
  assert.match(result.verdict.summary, /aerodrome on base \(subgraph not found: no allocations\)/);
});

test("the gateway key is sent only as a bearer header and never appears in output or errors", async () => {
  const { fetchMock, calls } = gatewayMock({
    // A transport error that echoes a URL with the key in it.
    FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS: () => {
      throw new Error(`connect ECONNREFUSED https://gateway.thegraph.com/api/${KEY}/subgraphs/id/x`);
    },
    GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM: () => json({ errors: [{ message: `auth error: invalid key ${KEY}` }] }, 401)
  });
  const result = await benchmarkFxStrategy(
    { pair: "ARS", chains: ["base"] },
    options(fetchMock, {
      arcQuote: async () => {
        throw new Error(`rpc failed for ${KEY}`);
      },
      aqua0Graph: {
        endpointOrigin: "https://api.studio.thegraph.com",
        query: async () => {
          throw new Error(`studio rejected ${KEY}`);
        }
      }
    })
  );

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${KEY}`);
    assert.ok(!call.url.includes(KEY));
  }
  const output = JSON.stringify(result);
  assert.ok(!output.includes(KEY), "the key must not appear anywhere in the result");
  assert.match(output, /<redacted>/);
  assert.equal(result.verdict.level, "unknown");

  await assert.rejects(
    () => benchmarkFxStrategy({ pair: "EUR" }, { apiKey: "  ", fetch: fetchMock }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /GRAPH_GATEWAY_API_KEY is required/);
      return true;
    }
  );
});

test("a bad-indexers answer succeeds on the retry", async () => {
  const listed = fixtures.gateway["4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6"] as Record<string, unknown>;
  let failedOnce = false;
  const { fetchMock } = gatewayMock({
    "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6": (call) => {
      if (!failedOnce) {
        failedOnce = true;
        return json({ errors: [{ message: "bad indexers: {0xabc: Timeout}" }] });
      }
      return json(listed[call.operation]);
    }
  });
  const result = await benchmarkFxStrategy({ pair: "EUR", chains: "ethereum", feeBps: 2 }, options(fetchMock));
  const uniswap = result.sources.find((source) => source.subgraphId === "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6");
  assert.equal(uniswap?.status, "ok");
  assert.equal(uniswap?.attempts, 3, "two list attempts plus the snapshots query");
  assert.match(result.verdict.summary, /A 2 bps Aqua0 strategy matches or beats the 5 bps pool fee/);
});

test("pool metrics: complete days only, fee rate, volume-weighted price, and 24h high/low range", () => {
  const window = {
    nowSeconds: 1_789_240_200,
    todayStart: 1_789_171_200,
    dayStart: 1_789_171_200 - 7 * 86_400,
    hourStart: 1_789_240_200 - 86_400,
    lookbackDays: 7
  };
  const metrics = computePoolMetrics(
    {
      days: [
        // Today: excluded.
        { timestamp: 1_789_200_000, usdcVolume: 1_000_000, fxVolume: 900_000, volumeUsd: 1_000_000, feesUsd: 500 },
        { timestamp: 1_789_100_000, usdcVolume: 200_000, fxVolume: 172_000, volumeUsd: 200_000, feesUsd: 100 },
        { timestamp: 1_788_600_000, usdcVolume: 100_000, fxVolume: 86_000, volumeUsd: 100_000, feesUsd: 50 },
        // Before the window: excluded.
        { timestamp: 1_788_500_000, usdcVolume: 5_000_000, fxVolume: 1, volumeUsd: 5_000_000, feesUsd: 1 }
      ],
      hours: [
        { timestamp: 1_789_230_000, usdcVolume: 0, fxVolume: 0, high: 0.8640, low: 0.8600 },
        { timestamp: 1_789_200_000, usdcVolume: 0, fxVolume: 0, high: 0.8620, low: 0.8610 },
        // Older than 24h: excluded.
        { timestamp: 1_789_100_000, usdcVolume: 0, fxVolume: 0, high: 2, low: 0.1 }
      ],
      lastActivity: 1_789_230_500
    },
    window
  );
  assert.equal(metrics.volumeUsd, 300_000);
  assert.equal(metrics.daysWithSwaps, 2);
  assert.equal(metrics.realizedFeeBps, 5);
  assert.ok(Math.abs((metrics.vwapFxPerUsdc ?? 0) - 0.86) < 1e-9);
  assert.equal(metrics.range24hBasis, "hourly high and low");
  assert.ok(Math.abs((metrics.range24hBps ?? 0) - ((0.864 - 0.86) / 0.862) * 10_000) < 1e-6);
  assert.equal(metrics.hoursWithSwaps, 2);

  // Standardized snapshots have no high and low: the range comes from hourly volume-weighted prices, minus outliers.
  const vwap = computePoolMetrics(
    {
      days: [],
      hours: [
        { timestamp: 1_789_230_000, usdcVolume: 1_000, fxVolume: 862, high: null, low: null },
        { timestamp: 1_789_220_000, usdcVolume: 1_000, fxVolume: 860, high: null, low: null },
        { timestamp: 1_789_210_000, usdcVolume: 1_000, fxVolume: 861, high: null, low: null },
        // About 7% from the median: left out.
        { timestamp: 1_789_200_000, usdcVolume: 1_000, fxVolume: 922, high: null, low: null }
      ],
      lastActivity: null
    },
    window
  );
  assert.equal(vwap.range24hBasis, "hourly volume-weighted prices");
  assert.equal(vwap.hoursExcluded, 1);
  assert.equal(vwap.hoursWithSwaps, 3);
  assert.ok(Math.abs((vwap.range24hBps ?? 0) - ((0.862 - 0.86) / 0.861) * 10_000) < 1e-6);
});
