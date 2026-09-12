#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAqua0Service, isExecutionAllowedByConfig } from "@aqua0/shared";
import { z } from "zod";
import {
  describeStrategySignal,
  LIVE_FOREX_STRATEGIES,
  readKeeperJournal,
  readSignalsSnapshot,
  summarizeKeeperStatus
} from "@aqua0/shared";

import { readMcpConfig, type McpConfig } from "./config.js";

const config = readMcpConfig();

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function createAqua0McpServer(config: McpConfig): McpServer {
  const aqua0 = createAqua0Service(config);
  const server = new McpServer({
    name: "aqua0-continuity",
    version: "0.1.2"
  });

  server.tool("health", {}, async () => jsonText(await aqua0.health()));
  server.tool(
    "info",
    {
      includeConfig: z
        .boolean()
        .optional()
        .describe("Include non-secret endpoint origins and write-mode configuration in the response")
    },
    async ({ includeConfig }) => {
      const info = await aqua0.info();
      return jsonText(includeConfig ? info : { ...info, endpoints: undefined });
    }
  );
  server.registerTool(
    "login",
    {
      description: `Sign in to Aqua0 with Privy, using any login method the Privy app enables (email, Google, a wallet...). The user gets a Circle developer-controlled wallet on Arc Testnet: created on first sign-in, reused afterwards. Returns a localhost URL for the user to open in their browser; after they sign in, this server verifies the Privy token and signs execute-mode writes with that user's Circle wallet. The sign-in is saved, so it survives restarts until logout. With CIRCLE_OPERATOR_WALLET_ID set, a new wallet holding under 1 USDC gets a small testnet USDC top-up from the Aqua0 operator, and the operator sends the strategy ships the user signs, so a new user can deposit, create strategies and swap right away without any role. Check progress with whoami.
Local (stdio) servers only. Needs SIGNER=circle, CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID and PRIVY_APP_ID.
Examples:
- "log me in" / "connect my wallet" -> {} then show the URL, then whoami once they say they're done`,
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async () => {
      if (config.transport === "http") {
        throw new Error("login opens a sign-in page on the machine running the server, so it is only available on a local (stdio) server");
      }
      const { url } = await aqua0.startLogin();
      return jsonText({
        url,
        next: "Ask the user to open the URL and sign in, then call whoami to confirm and show their Circle wallet.",
        expiresInSeconds: 600
      });
    }
  );
  server.registerTool(
    "whoami",
    {
      description:
        "Show who this server signs as: whether a Privy sign-in is active (Privy user id), the signer kind and Circle wallet address on Arc Testnet, and the status of a sign-in started with login. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async () => jsonText(await aqua0.whoami())
  );
  server.registerTool(
    "logout",
    {
      description:
        "Forget the Privy sign-in: deletes the saved session so this server stops signing as that user. The user's Circle wallet and funds are untouched and come back on the next sign-in.",
      inputSchema: {},
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => jsonText(aqua0.logout())
  );
  server.tool(
    "get_balance",
    {
      address: z.string().describe("LP address")
    },
    async ({ address }) => jsonText(await aqua0.getBalance(address))
  );
  server.tool(
    "get_strategies",
    {
      address: z.string().describe("LP address")
    },
    async ({ address }) => jsonText(await aqua0.getStrategies(address))
  );
  server.tool(
    "get_fees",
    {
      address: z.string().describe("LP address"),
      periodSeconds: z.number().int().positive().optional()
    },
    async ({ address, periodSeconds }) => jsonText(await aqua0.getFees(address, periodSeconds))
  );
  server.tool("list_opportunities", {}, async () => jsonText(await aqua0.listOpportunities()));
  server.tool("protocol_snapshot", {}, async () => jsonText(await aqua0.getProtocolSnapshot()));
  server.tool(
    "graph_query",
    {
      query: z.string().describe("Raw GraphQL query for advanced agents"),
      variables: z.record(z.unknown()).optional().describe("GraphQL variables")
    },
    async ({ query, variables }) => jsonText(await aqua0.rawGraphQuery(query, variables))
  );
  server.tool(
    "prepare_create_strategy",
    {
      strategist: z.string(),
      token0: z.string(),
      token1: z.string(),
      label: z.string(),
      vaults: z.array(z.string()).min(1)
    },
    async (input) => jsonText(await aqua0.prepareCreateStrategy(input))
  );
  server.tool(
    "prepare_authorize_strategy",
    {
      vault: z.string(),
      strategyId: z.string(),
      backing: z.boolean()
    },
    async (input) => jsonText(aqua0.prepareAuthorizeStrategy(input))
  );
  server.tool(
    "prepare_deposit",
    {
      vault: z.string(),
      assets: z.string().describe("Raw asset amount in vault units"),
      receiver: z.string()
    },
    async (input) => jsonText(aqua0.prepareDeposit(input))
  );
  server.tool(
    "prepare_withdraw",
    {
      vault: z.string(),
      assets: z.string().describe("Raw asset amount in vault units"),
      receiver: z.string(),
      owner: z.string()
    },
    async (input) => jsonText(aqua0.prepareWithdraw(input))
  );

  const amount = z.union([z.string(), z.number()]);
  const unit = z
    .enum(["human", "raw"])
    .optional()
    .describe('"human" (default): decimal token units like "2" or "0.1". "raw": integer base units.');
  const executionNote =
    "Sends transactions only when the server runs with MCP_WRITE_MODE=execute (Arc Testnet or a local fork) and dryRun is not true; otherwise nothing is sent and the response holds ordered calldata to sign.";
  const feedRisk =
    "Oracle risk: a forex strategy trusts its feed, bounded only by its price band and staleness window. USDC/BRL reads RedStone's BRL feed (prices signed by 3 of RedStone's 5 primary-prod signers, verified on-chain); USDC/ARS reads a ManualFxOracle its owner sets by hand (see set_fx_price), because RedStone has no ARS feed.";
  const opcode = z
    .string()
    .optional()
    .describe(
      '"forex" (default when the forex venue is configured): the forex curve (Shell v1 / DFX), priced from an FX oracle on AquaForexSwapVMRouter. "pegged": fixed-price PeggedSwap fallback on the stock AquaSwapVMRouter. Loose forms like "fxswap", "oracle", "dfx" or "fixed" work.'
    );
  const strategyParams = z
    .object({
      feeBps: amount
        .optional()
        .describe("Fee in basis points. Forex: the curve's proportional fee epsilon on every swap (default 30). Pegged: the flat fee (default 30)."),
      feePercent: amount.optional().describe("Same fee in percent, e.g. 0.3. Alternative to feeBps."),
      feePpb: amount.optional().describe("Same fee in parts per billion (3000000 = 0.30%)."),
      usdcAmount: amount
        .optional()
        .describe("USDC shipped into the strategy from vault backing; default 1 USDC."),
      fxAmount: amount
        .optional()
        .describe("FX tokens shipped; default usdcAmount x price (forex: the live oracle price, so the book starts balanced)."),
      amountUnit: unit,
      alpha: amount
        .optional()
        .describe('Forex: halt band as a decimal or "50%" (default 0.5). A swap that pushes either side past this fraction from the even split reverts.'),
      beta: amount
        .optional()
        .describe('Forex: flat band as a decimal or "15%" (default 0.15, below alpha). Within it the price is exactly the oracle price, no slippage.'),
      delta: amount
        .optional()
        .describe("Forex: slope of the inventory fee charged outside the flat band (default 0.5). Higher = the fee rises faster as the pool tips."),
      maxFee: amount
        .optional()
        .describe('Forex: cap on the inventory fee rate as a decimal or "25%" (default 0.25).'),
      maxFeePercent: amount.optional().describe("Forex: the same cap in percent, e.g. 25. Alternative to maxFee."),
      lambda: amount
        .optional()
        .describe('Forex: share of the inventory fee paid back to a trade that rebalances the pool, decimal or "30%" (default 0.3).'),
      bandPercent: amount
        .optional()
        .describe("Forex: accept feed answers within +/- this percent of the live oracle price at creation, e.g. 20."),
      minPrice: amount
        .optional()
        .describe("Forex: lowest accepted feed answer in the feed's orientation: ARS per 1 USD, or USD per 1 BRL for the RedStone BRL feed (default half of 1400 ARS / 5.5 BRL per USD)."),
      maxPrice: amount
        .optional()
        .describe("Forex: highest accepted feed answer in the feed's orientation (default double the same reference)."),
      maxStaleness: amount
        .optional()
        .describe('Forex: max feed age before swaps revert: seconds or "24h", "7d" (default 1h for RedStone BRL, which swap refreshes first; 7d for the hand-set ARS feed).'),
      oracleDecimals: amount
        .optional()
        .describe("Forex, advanced: feed decimals pinned in the program; 0 (default) reads decimals() each swap."),
      price: amount
        .optional()
        .describe("Pegged only: FX units per 1 USDC, up to 2 decimals. Defaults: 1400 for ARS, 5.5 for BRL."),
      priceE2: amount.optional().describe("Pegged only, advanced: price x 100 as an integer (1400 ARS = 140000)."),
      linearWidth: amount
        .optional()
        .describe("Pegged only: PeggedSwap flat-zone width, raw integer (default 1e28). Rarely needed."),
      label: z
        .string()
        .optional()
        .describe('Strategy class label; default "Forex ARS" (forex) or "FXSwap ARS" (pegged). A new label creates a new class.')
    })
    .passthrough()
    .optional()
    .describe(
      "Strategy parameters; omit for the demo defaults. Forex-only params (alpha, beta, delta, maxFee, lambda, band, staleness) imply opcode forex, pegged-only params (price, linearWidth) imply pegged. Quote/swap need the same program params to find a custom strategy."
    );

  server.registerTool(
    "create_strategy",
    {
      description: `Create a USDC/FX market-making strategy on Arc Testnet: a 1inch SwapVM program backed by Aqua0 vault liquidity and shipped into 1inch Aqua through an Aqua0 AquaAdapter.
Every fill draws on one liquidity path, the Aqua0 vaults, just in time: the adapter pulls the output token from its AssetVault and sweeps the input into the other, and Aqua only records virtual balances. The opcode picks the pricing program and the router (with its own AquaAdapter) that runs it:
- "forex" (default): the forex curve (Shell v1 / DFX), opcode 34 on AquaForexSwapVMRouter. Every swap reads the pair's feed (ARS/USD or BRL/USD) and rejects stale or out-of-band answers. While the book stays within the flat band (beta) of an even split it trades at exactly the oracle price; past it an inventory fee applies (slope delta, capped at maxFee, which must be below 0.5 so each quote has one solution), part of which (lambda) is paid back to trades that rebalance; a swap that would push the book past the halt band (alpha) reverts. A proportional fee epsilon (feeBps) applies to every swap. Defaults: alpha 0.5, beta 0.15, delta 0.5, maxFee 0.25, lambda 0.3, fee 30 bps, price band 0.5x-2x of 1400 ARS / 5.5 BRL per USD, max feed age 7 days (1 hour on RedStone BRL), ships 1 USDC plus its value in FX at the live oracle price. Declares epsilon as feePpb to the adapter. No SwapVM flat fee is stacked on it.
- "pegged": fixed-price fallback, [flat fee][PeggedSwap] at a price you set, on the stock AquaSwapVMRouter.
If opcode is omitted and the forex venue cannot ship yet (its adapter is not wired into the vault core, or the signer lacks OPERATOR_ROLE), the response explains why in opcodeNote and uses "pegged".
One call runs every step idempotently and reports finished steps as skipped, so re-running is safe:
1) register the strategy class, 2) register the USDC and FX vault legs, 3) fund the FX leg if short (ARGt/BRAt are open-mint demo tokens), 4) commit the signer's vault principal, 5) sign and ship the program.
One USDC deposit can back several strategies: create USDC/ARS and USDC/BRL and both commit the same USDC. Deposit USDC first with the deposit tool.
${feedRisk}
${executionNote}
Examples:
- "create a peso FX strategy that tracks the oracle" -> {"pair":"USDC/ARS","opcode":"forex"}
- "now the same USDC with Brazilian reais" -> {"pair":"usdc to brl"}
- "BRL forex curve, 5 bps fee, and stop trading if the feed moves 15% from here" -> {"pair":"USDC/BRL","opcode":"forex","params":{"feeBps":5,"bandPercent":15}}
- "ARS strategy with a tight flat band of 10%, rebate 50%, stale after a day, half a USDC" -> {"pair":"USDC/ARS","params":{"beta":0.1,"lambda":0.5,"maxStaleness":"24h","usdcAmount":"0.5"}}
- "cap the imbalance fee at 5% and halt at 40% off balance" -> {"pair":"USDC/BRL","params":{"maxFee":0.05,"alpha":0.4}}
- "fixed-rate BRL pool at 5.40 reais per dollar, 10 bps" -> {"pair":"USDC/BRL","opcode":"pegged","params":{"price":5.4,"feeBps":10}}
Legacy form without pair (strategist, token0, token1, label, vaults) only registers a class and its vault legs.`,
      inputSchema: {
        pair: z
          .string()
          .optional()
          .describe('USDC/FX pair: "USDC/ARS" (ARGt token) or "USDC/BRL" (BRAt token). Loose forms like "usdc to brl" or "pesos" work.'),
        chain: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Only "arc-testnet" (chain id 5042002) is supported; may be omitted.'),
        opcode,
        params: strategyParams,
        strategist: z
          .string()
          .optional()
          .describe("Strategist address. Defaults to the configured signer; in execute mode it must be the signer."),
        fundFxLeg: z
          .boolean()
          .optional()
          .describe("Mint, deposit and commit the demo FX token if the FX leg lacks backing (default true)."),
        dryRun: z.boolean().optional().describe("Return prepared calldata without sending, even in execute mode."),
        token0: z.string().optional().describe("Legacy class-only registration: first token address."),
        token1: z.string().optional().describe("Legacy class-only registration: second token address."),
        label: z.string().optional().describe("Legacy class-only registration: class label."),
        vaults: z.array(z.string()).optional().describe("Legacy class-only registration: vault legs.")
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (input) => {
      if (input.pair) {
        return jsonText(
          await aqua0.createFxStrategy({
            pair: input.pair,
            chain: input.chain,
            opcode: input.opcode,
            params: input.params,
            strategist: input.strategist,
            fundFxLeg: input.fundFxLeg,
            dryRun: input.dryRun
          })
        );
      }
      if (input.strategist && input.token0 && input.token1 && input.label && input.vaults?.length) {
        const legacy = {
          strategist: input.strategist,
          token0: input.token0,
          token1: input.token1,
          label: input.label,
          vaults: input.vaults
        };
        return jsonText(
          config.mcpWriteMode === "execute" && !input.dryRun
            ? await aqua0.executeCreateStrategy(legacy)
            : await aqua0.prepareCreateStrategy(legacy)
        );
      }
      throw new Error(
        'Pass pair, e.g. {"pair":"USDC/ARS"} (or the legacy strategist, token0, token1, label and vaults fields)'
      );
    }
  );

  server.registerTool(
    "deposit",
    {
      description: `Deposit tokens into an Aqua0 vault on Arc Testnet: USDC, ARS (ARGt) or BRL (BRAt). Amounts are human units by default ("2" = 2 USDC). Approves the vault when needed. The deposit becomes vault principal that can be committed to one or more strategies (create_strategy commits it for you).
${executionNote}
Examples:
- "deposit 2 USDC" -> {"token":"USDC","amount":"2"}
- "put two and a half dollars into the vault" -> {"token":"USDC","amount":2.5}
- "deposit 2000000 raw USDC units" -> {"token":"USDC","amount":"2000000","unit":"raw"}`,
      inputSchema: {
        token: z.string().optional().describe('Token symbol, fiat code or address: "USDC" (default), "ARS"/"ARGt", "BRL"/"BRAt".'),
        vault: z.string().optional().describe("Vault address, as an alternative to token."),
        amount: amount.describe('Amount to deposit, e.g. "2" or 2.5 (human units unless unit is "raw").'),
        unit,
        receiver: z.string().optional().describe("Principal owner; defaults to the configured signer."),
        dryRun: z.boolean().optional().describe("Return prepared calldata without sending, even in execute mode.")
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.deposit(input))
  );

  const swapTarget = {
    pair: z.string().optional().describe('"USDC/ARS" or "USDC/BRL" (loose forms work).'),
    strategyId: z
      .string()
      .optional()
      .describe("bytes32 strategy id from create_strategy; alternative to pair (found via Aqua Shipped events)."),
    opcode: z
      .string()
      .optional()
      .describe('"forex" or "pegged" to pick the pricing program. Default: forex first when configured, then pegged.'),
    params: strategyParams,
    tokenIn: z.string().optional().describe('Token you pay: "USDC" (default) or the FX side ("ARS", "BRL").'),
    amount: amount.describe('Exact input amount of tokenIn, e.g. "0.1" (human units unless unit is "raw").'),
    unit
  };
  const pricingNote =
    "The response shows pricing.oraclePrice (the FX-per-USDC price the forex curve reads from its feed, or fixedPrice for pegged), pricing.executionPrice and pricing.effectiveSpreadBps: the shortfall versus trading at that price. For forex that is the fee epsilon plus any inventory fee once the trade pushes the book past the flat band (negative when a rebalancing trade earns a rebate); for pegged, the flat fee plus curve slippage. Forex also shows the feed's age and band.";

  server.registerTool(
    "quote_swap",
    {
      description: `Quote an exact-input swap against a live Aqua0 SwapVM strategy on Arc Testnet. Read-only: an eth_call to the strategy's router quote (AquaForexSwapVMRouter for forex, AquaSwapVMRouter for pegged), nothing is sent. Choose the strategy by pair (defaults find the strategies create_strategy makes by default; forex is tried first) or by strategyId.
${pricingNote}
Examples:
- "how many pesos do I get for 0.1 USDC?" -> {"pair":"USDC/ARS","amount":"0.1"}
- "quote reais at today's RedStone rate" -> {"pair":"USDC/BRL","amount":"0.1"} (priced with the latest signed RedStone BRL payload, nothing sent)
- "move the ARS rate up 5% and quote again" -> set_fx_price {"pair":"ARS","changePercent":5}, then {"pair":"USDC/ARS","amount":"0.1"}
- "price 5 reais into USDC" -> {"pair":"USDC/BRL","tokenIn":"BRL","amount":"5"}
- "quote the fixed-rate peso pool instead" -> {"pair":"USDC/ARS","opcode":"pegged","amount":"0.1"}
- "quote 0.1 USDC on strategy 0x5e86..." -> {"strategyId":"0x5e86...","amount":"0.1"}`,
      inputSchema: {
        ...swapTarget,
        taker: z.string().optional().describe("Address the quote is simulated from; defaults to the configured signer.")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.quoteSwap(input))
  );

  server.registerTool(
    "swap",
    {
      description: `Swap against a live Aqua0 SwapVM strategy on Arc Testnet through its router (exact input). For a RedStone-priced forex strategy (USDC/BRL) it first pushes RedStone's latest signed price on-chain (updateDataFeedsValuesPartial), then quotes, enforces a minimum output on-chain (slippageBps, default 50 = 0.5%, or minAmountOut), approves the router if needed, swaps, and reports the amount received.
${pricingNote}
${executionNote}
Examples:
- "swap 0.1 USDC to ARS" -> {"pair":"USDC/ARS","amount":"0.1"}
- "buy some BRL with a tenth of a USDC" -> {"pair":"USDC/BRL","amount":"0.1"}
- "sell 5 reais for dollars, max 1% slippage" -> {"pair":"USDC/BRL","tokenIn":"BRL","amount":"5","slippageBps":100}`,
      inputSchema: {
        ...swapTarget,
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("Allowed shortfall versus the quote in basis points (default 50)."),
        minAmountOut: amount.optional().describe("Explicit minimum output of the other token; overrides slippageBps."),
        taker: z.string().optional().describe("Prepare mode: sender address. Execute mode: must be the signer (default)."),
        dryRun: z.boolean().optional().describe("Return prepared calldata without sending, even in execute mode.")
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.swap(input))
  );

  server.registerTool(
    "get_shared_backing",
    {
      description: `Show how one USDC deposit backs several strategies at once for an address (default: the configured signer). Returns the USDC principal counted once, every strategy class the address committed it to (e.g. USDC/ARS and USDC/BRL), each class's committed backing and available liquidity in the USDC and FX vaults, and the SwapVM strategies shipped for each class through both adapters (forex and pegged), each tagged with its opcode. Every strategy draws on the same vaults; the opcode only sets the pricing program.
Source: direct on-chain RPC reads, labelled in the response (Graph indexing for the Aqua adapters is being added separately).
Examples:
- "is my USDC backing both FX strategies?" -> {}
- "show shared backing for 0xabc..." -> {"address":"0xabc..."}`,
      inputSchema: {
        address: z.string().optional().describe("LP address; defaults to the configured signer."),
        params: strategyParams,
        maxClassScan: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many of the newest strategy class ids to scan (default 256).")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.getSharedBacking(input))
  );

  server.registerTool(
    "get_fx_prices",
    {
      description: `Read the FX feeds forex strategies price from on Arc Testnet. BRL: RedStone's BRL feed (USD per 1 BRL, also shown as BRL per USD), with the latest signed price from RedStone's gateways (signing time, the 3 signer values) and the value currently stored on-chain. ARS: the hand-set ManualFxOracle (ARS per 1 USD) with its owner. Without a pair it also lists RedStone feeds live on Arc that no Aqua0 vault trades yet (MXNe, MXN per 1 USD). Each feed shows whether it sits inside the default strategy price band. Read-only.
${feedRisk}
Examples:
- "what's the real rate right now?" -> {"pair":"BRL"}
- "what peso rate are the FX strategies using?" -> {"pair":"ARS"}
- "are the oracles fresh? any other RedStone feeds?" -> {}`,
      inputSchema: {
        pair: z.string().optional().describe('"ARS", "BRL", "USDC/ARS"...; omit for both feeds.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.getFxPrices(input))
  );

  server.registerTool(
    "benchmark_fx_strategy",
    {
      description: `Benchmark an Aqua0 forex strategy against the onchain market for the same currency, from Graph data on both sides. Read-only.
Market side: one standardized query pattern (the Messari DEX AMM schema: liquidityPools, dailySnapshots, hourlySnapshots) sent unchanged through The Graph Network gateway to every standardized DEX subgraph on the chosen chains: Uniswap v3 (Ethereum, Base, Polygon, Arbitrum, Optimism, Celo), Curve (Ethereum), SushiSwap (Ethereum, Polygon, Arbitrum, Celo) and Velodrome v2 (Optimism). It finds pools holding USDC and the currency's stablecoins by token address, then reports each pool's protocol, chain, fee tier, realized fee rate, TVL, average daily volume, 24h price range and last activity. Uniswap-v3-schema subgraphs (Aerodrome on Base, official Uniswap v3) are a labelled, non-standardized fallback for a chain the standardized ones do not cover.
Aqua0 side: the Aqua0 subgraph on Subgraph Studio (live forex strategies and their indexed fills and fees on Arc Testnet, demo tokens), the strategy's cost at each trade size (feeBps inside the flat band; an inventory fee applies past it, not evaluated here), and for USDC/ARS and USDC/BRL a live Arc Testnet router quote for 0.1 USDC.
Returns a verdict: liquid (existing pools at a few bps with $1M+ TVL, so a 30 bps strategy is not price-competitive), thin, or none (the LatAm gap Aqua0 targets), with the numbers behind it and any source that failed.
Pairs: EUR, BRL, MXN, ARS, SGD, CAD against USDC. Needs GRAPH_GATEWAY_API_KEY on the server.
Examples:
- "is a 30 bps euro strategy competitive onchain?" -> {"pair":"USDC/EUR"}
- "how deep is onchain BRL liquidity? 5 bps fee, last 30 days" -> {"pair":"BRL","feeBps":5,"lookbackDays":30}
- "compare a peso strategy with Polygon pools only, for $5k and $50k trades" -> {"pair":"ARS","chains":["polygon"],"tradeSizesUsd":[5000,50000]}`,
      inputSchema: {
        pair: z.string().describe('Currency against USDC: "USDC/EUR", "EUR", "BRL", "reais", "MXN", "ARS", "SGD", "CAD"...'),
        feeBps: amount.optional().describe("The Aqua0 strategy's proportional fee in bps (default 30)."),
        flatBandPercent: amount
          .optional()
          .describe("The forex curve's flat band (beta) in percent of an even split (default 15)."),
        tradeSizesUsd: z.array(amount).optional().describe("Trade sizes in USD to compare (default [1000, 10000, 100000])."),
        lookbackDays: amount.optional().describe("Days of volume and fees to average, 1 to 30 (default 7)."),
        chains: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("ethereum, base, polygon, arbitrum, optimism, celo; default every chain with a pinned stablecoin for the pair."),
        fallback: z
          .string()
          .optional()
          .describe(
            '"auto" (default): query the non-standardized Uniswap-v3-schema subgraphs only for a chain where no standardized subgraph answered or none found a pool. "always" or "never".'
          ),
        includeArcQuote: z
          .boolean()
          .optional()
          .describe("For ARS and BRL, add a live Arc Testnet quote for 0.1 USDC through the router (default true).")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.benchmarkFxStrategy(input))
  );

  server.registerTool(
    "set_fx_price",
    {
      description: `Move the hand-set ARS/USD demo feed (ManualFxOracle, Chainlink-compatible) so every forex strategy on it reprices on its next quote or swap. Pegged strategies do not move. The BRL feed is RedStone signed market data and cannot be set by hand; this tool refuses it.
RISK: this is an owner-set demo oracle. Only the feed owner can set it, and forex strategies on the feed trade at whatever it says, bounded only by each strategy's price band and staleness window.
Execute path: sends ManualFxOracle.setAnswer only when the server runs with MCP_WRITE_MODE=execute, dryRun is not true, and the configured signer IS the feed owner. A non-owner signer gets a clear error and nothing is sent. Otherwise returns the prepared call for the owner to send.
Give exactly one of price (absolute) or changePercent (relative).
Examples:
- "set the peso to 1470 and quote again" -> {"pair":"ARS","price":1470}, then quote_swap {"pair":"USDC/ARS","amount":"0.1"}
- "push the ARS/USD price up 5%" -> {"pair":"ARS","changePercent":5}
- "drop the peso feed by 2.5 percent" -> {"pair":"ARS","changePercent":-2.5}`,
      inputSchema: {
        pair: z.string().optional().describe('Which feed: "ARS" / "USDC/ARS" or "BRL" / "USDC/BRL".'),
        feed: z.string().optional().describe("Feed address, as an alternative to pair (must be a configured forex feed)."),
        price: amount.optional().describe("New price in FX units per 1 USD, e.g. 5.6 or 1470."),
        changePercent: amount
          .optional()
          .describe('Relative move in percent: 5 = up 5%, -2.5 or "-2.5" = down 2.5%.'),
        dryRun: z.boolean().optional().describe("Return the prepared call without sending, even in execute mode.")
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.setFxPrice(input))
  );

  server.registerTool(
    "get_signals",
    {
      description: `Current health of the live forex books on Arc Testnet (USDC/ARS and USDC/BRL): per strategy the oracle price, age, staleness window and band check, the effective spread of a 0.1 USDC probe quote in both directions, the Aqua book balances, which side is heavy, and the trade that would restore an even split. The same signals the Aqua0 keeper buys with Circle Nanopayments, read here directly from RPC for free. Read-only. A book is healthy near 30 bps; above 150 bps the keeper rebalances it.
Examples:
- "is the book healthy?" / "what are the spreads now?" -> {}
- "how tilted is the BRL book?" -> {"pair":"BRL"}`,
      inputSchema: {
        pair: z.string().optional().describe('"ARS", "BRL", "USDC/BRL"...; omit for both live forex strategies.'),
        includeVault: z.boolean().optional().describe("Also read the strategist's vault principal and committed backing (slower).")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ pair, includeVault }) => {
      const wanted = pair?.trim()
        ? LIVE_FOREX_STRATEGIES.filter((strategy) => strategy.pair.toLowerCase().endsWith(pair.trim().toLowerCase().replace(/^usdc\s*\/\s*/, "")))
        : LIVE_FOREX_STRATEGIES;
      const snapshot = await readSignalsSnapshot(config, {
        strategies: wanted.length > 0 ? wanted : LIVE_FOREX_STRATEGIES,
        include: includeVault ? ["oracle", "book", "vault"] : ["oracle", "book"]
      });
      return jsonText({ summary: snapshot.strategies.map(describeStrategySignal), keeperTiltThresholdBps: 150, ...snapshot });
    }
  );

  server.registerTool(
    "keeper_status",
    {
      description: `What the autonomous Aqua0 FX book keeper has been doing, read from its journal (AQUA0_KEEPER_JOURNAL, default ~/.aqua0/keeper/journal.jsonl), so it works while the keeper runs in another terminal. Returns a plain summary (running or not, the last rebalance with spreads before and after and its Arcscan link), the recent ticks (what woke it: a swap or a heartbeat; the books it saw; its decision, who decided it, rules or the model, and why; what it spent), the actions it took, and total spend on nanopayment signals and model calls. Read-only.
Examples:
- "did the keeper rebalance my book?" -> {}
- "show the keeper's spend" / "what did it do in the last 20 ticks?" -> {"last":20}`,
      inputSchema: {
        last: z.number().int().min(1).max(50).optional().describe("How many recent ticks and actions to list (default 10).")
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ last }) => jsonText(summarizeKeeperStatus(readKeeperJournal({ last: 2000 }), { last: last ?? 10 }))
  );

  if (config.mcpWriteMode === "execute") {
    server.tool(
      "authorize_strategy",
      {
        vault: z.string(),
        strategyId: z.string(),
        backing: z.boolean()
      },
      async (input) => jsonText(await aqua0.executeAuthorizeStrategy(input))
    );
  }

  return server;
}

async function startStdio(config: McpConfig): Promise<void> {
  const server = createAqua0McpServer(config);
  await server.connect(new StdioServerTransport());
}

async function startHttp(config: McpConfig): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const health = await createAqua0Service(config).health();
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
      return;
    }

    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const server = createAqua0McpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    try {
      await server.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(req, res, req.method === "POST" ? await readJson(req) : undefined);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Internal server error"
            },
            id: null
          })
        );
      }
    }
  });

  httpServer.listen(config.port, config.host, () => {
    const writeMode = isExecutionAllowedByConfig(config) ? "execute-enabled" : config.mcpWriteMode;
    console.error(
      `aqua0 MCP HTTP listening on http://${config.host}:${config.port}/mcp (${writeMode})`
    );
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (config.transport === "http") {
  await startHttp(config);
} else {
  await startStdio(config);
}
