/**
 * `aqua0 keeper ...` and `aqua0 signals ...`: the autonomous FX book keeper and its Nanopayments signals seller.
 * Loaded only for these commands, so the rest of the CLI keeps its startup cost.
 */
import {
  ARC_TESTNET,
  createCircleClient,
  describeStrategySignal,
  keeperJournalPath,
  readKeeperJournal,
  readSignalsSnapshot,
  resolveCircleWallet,
  summarizeKeeperStatus,
  type SignalName
} from "@aqua0/shared";
import { readKeeperConfig, runKeeper, setupKeeper, type Flags } from "@aqua0/keeper";
import { DEFAULT_SIGNALS_PORT, startSignalsServer } from "@aqua0/signals";

const BOOLEAN_FLAGS = new Set(["once", "dry-run", "json", "no-feedback", "no-register"]);

export function parseAgentFlags(values: string[]): Flags {
  const flags: Flags = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Expected flag, got ${flag ?? "<empty>"}`);
    }
    const key = flag.slice(2);
    const next = values[index + 1];
    if (BOOLEAN_FLAGS.has(key) && (next === undefined || next.startsWith("--") || (next !== "true" && next !== "false"))) {
      flags.set(key, true);
      continue;
    }
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    flags.set(key, BOOLEAN_FLAGS.has(key) ? (next === "true" ? true : "false") : next);
    index += 1;
  }
  return flags;
}

export async function runAgentCommand(command: string, args: string[]): Promise<number> {
  const [sub = "help", ...rest] = args;
  const flags = parseAgentFlags(rest);
  try {
    if (command === "signals") {
      return await signalsCommand(sub, flags);
    }
    return await keeperCommand(sub, flags);
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

async function keeperCommand(sub: string, flags: Flags): Promise<number> {
  switch (sub) {
    case "run":
    case "demo": {
      const config = readKeeperConfig(process.env, flags);
      const controller = stopOnSignal();
      let close: (() => Promise<void>) | undefined;
      if (sub === "demo") {
        const server = await startSeller(flags);
        close = server.close;
        config.signalsUrl = server.url;
      }
      try {
        await runKeeper(config, { log: (line) => console.log(redact(line)), error: (line) => console.error(redact(line)), signal: controller.signal });
      } finally {
        await close?.();
      }
      return 0;
    }
    case "setup": {
      const config = readKeeperConfig(process.env, flags);
      const result = await setupKeeper(
        config,
        {
          fundUsdc: numberFlag(flags, "fund", 3),
          gatewayUsdc: numberFlag(flags, "gateway", 0.5),
          register: flags.get("no-register") !== true
        },
        (line) => console.log(redact(line))
      );
      console.log(JSON.stringify({ wallet: result.wallet, identity: { ...result.identity, agentURI: result.identity.agentURI ? "data:application/json;base64,..." : undefined }, txs: result.txs, notes: result.notes }, null, 2));
      return 0;
    }
    case "status": {
      const file = typeof flags.get("journal") === "string" ? (flags.get("journal") as string) : undefined;
      const last = numberFlag(flags, "last", 10);
      const status = summarizeKeeperStatus(readKeeperJournal({ ...(file ? { file } : {}), last: 2000 }), { last, ...(file ? { journal: file } : {}) });
      if (flags.get("json") === true) {
        console.log(JSON.stringify(status, null, 2));
        return 0;
      }
      console.log(`${status.summary}\njournal ${status.journal}\n`);
      for (const tick of status.recentTicks) {
        console.log(`${tick.at.slice(11, 19)} #${tick.tick ?? "?"} ${tick.wake} | ${tick.books || "no signals"} | ${tick.by}: ${tick.decision} - ${tick.reason} | ${tick.spentUsdc} USDC${tick.llmUsd ? `, model $${tick.llmUsd}` : ""}${tick.txs.length ? ` | ${tick.txs.join(" ")}` : ""}`);
      }
      return 0;
    }
    default:
      console.log(`aqua0 keeper: autonomous FX book keeper on Arc Testnet

  aqua0 keeper setup [--fund 3] [--gateway 0.5] [--no-register]   keeper Circle wallet, App Kit funding, Gateway deposit, ERC-8004 identity
  aqua0 keeper run [--interval 90] [--poll 4] [--once] [--dry-run] [--policy rules|llm] [--signals-url ${`http://127.0.0.1:${DEFAULT_SIGNALS_PORT}`}]
  aqua0 keeper demo [run flags] [--port ${DEFAULT_SIGNALS_PORT}]   start the signals seller in-process, then run the keeper
  aqua0 keeper status [--last 10] [--json]
  aqua0 signals serve [--port ${DEFAULT_SIGNALS_PORT}] [--host 127.0.0.1]
  aqua0 signals get [--vault]                                         unpaid read of the same signals

The keeper wakes on router Swapped events for the live forex strategies (polled every --poll seconds) and on a
--interval heartbeat. Journal: ${keeperJournalPath()} (AQUA0_KEEPER_JOURNAL).
Limits: KEEPER_TILT_BPS 150, KEEPER_MAX_TRADE_USDC 0.25, KEEPER_COOLDOWN_SECONDS 90, KEEPER_DATA_BUDGET_USDC_PER_HOUR 0.5,
KEEPER_LLM_CAP_USD_PER_DAY 0.5, KEEPER_ALLOWED_ACTIONS (all). Policy: llm when OPENAI_API_KEY is set (OPENAI_MODEL, default gpt-5-nano), else rules.`);
      return sub === "help" ? 0 : 1;
  }
}

async function signalsCommand(sub: string, flags: Flags): Promise<number> {
  switch (sub) {
    case "serve": {
      const controller = stopOnSignal();
      const server = await startSeller(flags);
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      await server.close();
      return 0;
    }
    case "get": {
      const include: SignalName[] = flags.has("vault") ? ["oracle", "book", "vault"] : ["oracle", "book"];
      const snapshot = await readSignalsSnapshot(readConfig(), { include });
      console.log(JSON.stringify({ summary: snapshot.strategies.map(describeStrategySignal), ...snapshot }, null, 2));
      return 0;
    }
    default:
      console.log("aqua0 signals serve [--port 8402] [--host 127.0.0.1] | aqua0 signals get [--vault true]");
      return sub === "help" ? 0 : 1;
  }
}

async function startSeller(flags: Flags) {
  const sellerAddress = await resolveSellerAddress();
  const port = numberFlag(flags, "port", Number(process.env.SIGNALS_PORT ?? DEFAULT_SIGNALS_PORT));
  const host = typeof flags.get("host") === "string" ? (flags.get("host") as string) : (process.env.SIGNALS_HOST ?? "127.0.0.1");
  const server = await startSignalsServer({
    config: readConfig(),
    sellerAddress,
    port,
    host,
    log: (line) => console.log(`[signals] ${line}`)
  });
  console.log(`[signals] selling oracle $0.0005, book $0.001, vault $0.0005 at ${server.url}/v1/{oracle,book,vault} to ${server.seller} (Circle Gateway, Arc Testnet)`);
  return server;
}

async function resolveSellerAddress(): Promise<string> {
  if (process.env.SIGNALS_SELLER_ADDRESS?.trim()) {
    return process.env.SIGNALS_SELLER_ADDRESS.trim();
  }
  const walletId = process.env.CIRCLE_OPERATOR_WALLET_ID?.trim();
  const apiKey = process.env.CIRCLE_API_KEY?.trim();
  const entitySecret = (process.env.CIRCLE_ENTITY_SECRET || process.env.ENTITY_SECRET)?.trim();
  if (!walletId || !apiKey || !entitySecret) {
    throw new Error("Set SIGNALS_SELLER_ADDRESS, or CIRCLE_OPERATOR_WALLET_ID with CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET, for the address that receives signal payments");
  }
  return (await resolveCircleWallet(createCircleClient({ apiKey, entitySecret }), { walletId })).address;
}

function readConfig() {
  return {
    writeRpcUrl: process.env.WRITE_RPC_URL?.trim() || ARC_TESTNET.rpcUrl,
    writeChainId: process.env.WRITE_CHAIN_ID ? Number(process.env.WRITE_CHAIN_ID) : ARC_TESTNET.chainId
  };
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const value = flags.get(name);
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return parsed;
}

function stopOnSignal(): AbortController {
  const controller = new AbortController();
  let stops = 0;
  const stop = () => {
    stops += 1;
    if (stops > 1) {
      process.exit(130);
    }
    console.error("stopping after the current tick (Ctrl+C again to quit now)");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return controller;
}

function redact(text: string): string {
  const env = process.env;
  const secrets = [env.CIRCLE_API_KEY, env.CIRCLE_ENTITY_SECRET, env.ENTITY_SECRET, env.OPENAI_API_KEY, env.WRITE_PRIVATE_KEY]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value && value.length >= 8));
  const parts = (env.CIRCLE_API_KEY ?? "").split(":").filter((part) => part.length >= 16);
  let result = text;
  for (const secret of [...secrets, ...parts].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[redacted]");
  }
  return result;
}
