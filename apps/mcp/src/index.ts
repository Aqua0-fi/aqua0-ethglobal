#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAqua0Service, isExecutionAllowedByConfig } from "@aqua0/shared";
import { z } from "zod";

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
    version: "0.1.0"
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
      const info = aqua0.info();
      return jsonText(includeConfig ? info : { ...info, endpoints: undefined });
    }
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
    "Oracle risk: FXSwap trusts its feed. The Arc demo feeds are ManualFxOracle contracts that only their owner can set by hand (see set_fx_price); each strategy is bounded only by its price band and staleness window.";
  const opcode = z
    .string()
    .optional()
    .describe(
      '"fxswap" (default when the FXSwap venue is configured): FXSwap, the oracle-anchored CryptoSwap instruction on AquaFXSwapVMRouter. "pegged": fixed-price PeggedSwap fallback on the stock AquaSwapVMRouter. Loose forms like "oracle" or "fixed" work.'
    );
  const strategyParams = z
    .object({
      feeBps: amount
        .optional()
        .describe("Fee in basis points. FXSwap: the fee at balance (default 10). Pegged: the flat fee (default 30)."),
      feePercent: amount.optional().describe("Same fee in percent, e.g. 0.1. Alternative to feeBps."),
      feePpb: amount.optional().describe("Same fee in parts per billion (1000000 = 0.10%)."),
      usdcAmount: amount
        .optional()
        .describe("USDC shipped into the strategy from vault backing; default 1 USDC."),
      fxAmount: amount
        .optional()
        .describe("FX tokens shipped; default usdcAmount x price (FXSwap: the live oracle price)."),
      amountUnit: unit,
      a: amount
        .optional()
        .describe("FXSwap: amplification A (whitepaper units, default 100). Higher = flatter price near the oracle."),
      gamma: amount
        .optional()
        .describe("FXSwap: CryptoSwap gamma as a decimal (default 0.1). Lower = the flat zone around the oracle ends sooner."),
      outFeeBps: amount
        .optional()
        .describe("FXSwap: fee far from balance in bps (default 100 = 1%, never below the fee at balance)."),
      outFeePercent: amount.optional().describe("FXSwap: out fee in percent. Alternative to outFeeBps."),
      feeGamma: amount
        .optional()
        .describe("FXSwap: how fast the fee widens from feeBps to outFeeBps as inventory drains (default 0.03)."),
      flatFeeBps: amount
        .optional()
        .describe("FXSwap: optional flat input fee in front of the curve, in bps (default none)."),
      bandPercent: amount
        .optional()
        .describe("FXSwap: accept feed answers within +/- this percent of the live oracle price at creation, e.g. 20."),
      minPrice: amount
        .optional()
        .describe("FXSwap: lowest accepted feed answer, FX per 1 USD (default 0.5x of 1400 ARS / 5.5 BRL)."),
      maxPrice: amount
        .optional()
        .describe("FXSwap: highest accepted feed answer, FX per 1 USD (default 2x of 1400 ARS / 5.5 BRL)."),
      maxStaleness: amount
        .optional()
        .describe('FXSwap: max feed age before swaps revert: seconds or "24h", "7d" (default 7d, demo feeds are set by hand).'),
      oracleDecimals: amount
        .optional()
        .describe("FXSwap, advanced: feed decimals pinned in the program; 0 (default) reads decimals() each swap."),
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
        .describe('Strategy class label; default "FXSwap oracle ARS" (FXSwap) or "FXSwap ARS" (pegged). A new label creates a new class.')
    })
    .optional()
    .describe(
      "Strategy parameters; omit for the demo defaults. FXSwap-only params imply opcode fxswap, pegged-only params (price, linearWidth) imply pegged. Quote/swap need the same program params to find a custom strategy."
    );

  server.registerTool(
    "create_strategy",
    {
      description: `Create a USDC/FX market-making strategy on Arc Testnet: a 1inch SwapVM program backed by Aqua0 vault liquidity and shipped into 1inch Aqua through an Aqua0 AquaAdapter.
Two opcodes, two venues on the same Aqua0 vaults (each AquaAdapter is bound to one router):
- "fxswap" (default): FXSwap, the team's oracle-anchored CryptoSwap instruction (AquaFXSwapVMRouter opcode 34). Every swap reads the pair's feed (ARS/USD or BRL/USD), rejects stale or out-of-band answers, prices around the oracle and widens its fee as inventory drains. Defaults: A 100, gamma 0.1, fee 10 bps at balance rising to 1% (feeGamma 0.03), price band 0.5x-2x of 1400 ARS / 5.5 BRL per USD, max feed age 7 days, ships 1 USDC plus its value in FX at the live oracle price. Declares the mid fee as feePpb to the adapter.
- "pegged": fixed-price fallback, [flat fee][PeggedSwap] at a price you set, on the stock AquaSwapVMRouter.
If opcode is omitted and FXSwap cannot ship yet (its adapter is not wired into the vault core, or the signer lacks OPERATOR_ROLE), the response explains why in opcodeNote and uses "pegged".
One call runs every step idempotently and reports finished steps as skipped, so re-running is safe:
1) register the strategy class, 2) register the USDC and FX vault legs, 3) fund the FX leg if short (ARGt/BRAt are open-mint demo tokens), 4) commit the signer's vault principal, 5) sign and ship the program.
One USDC deposit can back several strategies: create USDC/ARS and USDC/BRL and both commit the same USDC. Deposit USDC first with the deposit tool.
${feedRisk}
${executionNote}
Examples:
- "create a peso FX strategy that tracks the oracle" -> {"pair":"USDC/ARS","opcode":"fxswap"}
- "now the same USDC with Brazilian reais" -> {"pair":"usdc to brl"}
- "BRL fxswap, 5 bps fee going up to 2%, and stop trading if the feed moves 15% from here" -> {"pair":"USDC/BRL","opcode":"fxswap","params":{"feeBps":5,"outFeeBps":200,"bandPercent":15}}
- "ARS strategy with amplification 200, gamma 0.02, stale after a day, half a USDC" -> {"pair":"USDC/ARS","params":{"a":200,"gamma":0.02,"maxStaleness":"24h","usdcAmount":"0.5"}}
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
      .describe('"fxswap" or "pegged" to pick the venue. Default: FXSwap first when configured, then pegged.'),
    params: strategyParams,
    tokenIn: z.string().optional().describe('Token you pay: "USDC" (default) or the FX side ("ARS", "BRL").'),
    amount: amount.describe('Exact input amount of tokenIn, e.g. "0.1" (human units unless unit is "raw").'),
    unit
  };
  const pricingNote =
    "The response shows pricing.oraclePrice (the feed answer FXSwap reads, or fixedPrice for pegged), pricing.executionPrice and pricing.effectiveSpreadBps (shortfall versus trading at the oracle price: fees plus curve slippage), plus the feed's age and band for FXSwap.";

  server.registerTool(
    "quote_swap",
    {
      description: `Quote an exact-input swap against a live Aqua0 SwapVM strategy on Arc Testnet. Read-only: an eth_call to the strategy's router quote (AquaFXSwapVMRouter for FXSwap, AquaSwapVMRouter for pegged), nothing is sent. Choose the strategy by pair (defaults find the strategies create_strategy makes by default; FXSwap is tried first) or by strategyId.
${pricingNote}
Examples:
- "how many pesos do I get for 0.1 USDC?" -> {"pair":"USDC/ARS","amount":"0.1"}
- "move the BRL rate to 5.6 and quote again" -> set_fx_price {"pair":"BRL","price":5.6}, then {"pair":"USDC/BRL","amount":"0.1"}
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
      description: `Swap against a live Aqua0 SwapVM strategy on Arc Testnet through its router (exact input). Quotes first, enforces a minimum output on-chain (slippageBps, default 50 = 0.5%, or minAmountOut), approves the router if needed, swaps, and reports the amount received.
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
      description: `Show how one USDC deposit backs several strategies at once for an address (default: the configured signer). Returns the USDC principal counted once, every strategy class the address committed it to (e.g. USDC/ARS and USDC/BRL), each class's committed backing and available liquidity in the USDC and FX vaults, and the SwapVM strategies shipped for each class on BOTH venues (FXSwap and pegged adapters), each tagged with its opcode.
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
      description: `Read the FX feeds FXSwap strategies price from on Arc Testnet: ARS/USD and BRL/USD. For each feed: price (FX units per 1 USD), raw answer and decimals, last update time and age in seconds, the owner who can set it, and whether it sits inside the default strategy price band. Read-only.
${feedRisk}
Examples:
- "what peso rate are the FX strategies using?" -> {"pair":"ARS"}
- "are the oracles fresh?" -> {}`,
      inputSchema: {
        pair: z.string().optional().describe('"ARS", "BRL", "USDC/ARS"...; omit for both feeds.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (input) => jsonText(await aqua0.getFxPrices(input))
  );

  server.registerTool(
    "set_fx_price",
    {
      description: `Move an FX feed (ManualFxOracle, Chainlink-compatible) so every FXSwap strategy on it reprices on its next quote or swap. Pegged strategies do not move.
RISK: this is an owner-set demo oracle. Only the feed owner can set it, and FXSwap strategies on the feed trade at whatever it says, bounded only by each strategy's price band and staleness window.
Execute path: sends ManualFxOracle.setAnswer only when the server runs with MCP_WRITE_MODE=execute, dryRun is not true, and the configured signer IS the feed owner. A non-owner signer gets a clear error and nothing is sent. Otherwise returns the prepared call for the owner to send.
Give exactly one of price (absolute) or changePercent (relative).
Examples:
- "move the BRL rate to 5.6 and quote again" -> {"pair":"BRL","price":5.6}, then quote_swap {"pair":"USDC/BRL","amount":"0.1"}
- "push the ARS/USD price up 5%" -> {"pair":"ARS","changePercent":5}
- "drop the peso feed by 2.5 percent" -> {"pair":"ARS","changePercent":-2.5}`,
      inputSchema: {
        pair: z.string().optional().describe('Which feed: "ARS" / "USDC/ARS" or "BRL" / "USDC/BRL".'),
        feed: z.string().optional().describe("Feed address, as an alternative to pair (must be a configured FXSwap feed)."),
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
