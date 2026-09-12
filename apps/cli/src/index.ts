#!/usr/bin/env node
import { createAqua0Service, type AmountUnit, type StrategyParamsInput } from "@aqua0/shared";

import { readCliConfig } from "./config.js";

const [command = "help", ...args] = process.argv.slice(2);

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Aqua0 Continuity CLI

Usage:
  aqua0 health
  aqua0 info
  aqua0 login                  Sign in with Privy; your Circle wallet on Arc Testnet is created or reused
  aqua0 whoami
  aqua0 logout
  aqua0 balance <address>
  aqua0 strategies <address>
  aqua0 fees <address> [seconds]
  aqua0 opportunities
  aqua0 snapshot
  aqua0 create-strategy --pair USDC/ARS [--opcode fxswap|pegged] [strategy params] [--label <text>] [--dry-run true]
  aqua0 create-strategy --strategist <addr> --token0 <addr> --token1 <addr> --label <text> --vault <addr>...
  aqua0 authorize --vault <addr> --strategy-id <id> --backing true|false
  aqua0 deposit --token USDC --amount 2 [--unit human|raw] [--receiver <addr>] [--dry-run true]
  aqua0 quote --pair USDC/ARS --amount 0.1 [--opcode fxswap|pegged] [--token-in USDC] [--strategy-id <bytes32>]
  aqua0 swap --pair USDC/ARS --amount 0.1 [--opcode fxswap|pegged] [--token-in USDC] [--slippage-bps 50] [--dry-run true]
  aqua0 shared-backing [address]
  aqua0 fx-prices [--pair ARS]
  aqua0 set-fx-price --pair ARS (--price 1470 | --change-percent 5) [--feed <addr>] [--dry-run true]

Opcodes:
  fxswap   FXSwap oracle-anchored curve on AquaFXSwapVMRouter (default when the FXSwap venue is configured)
  pegged   fixed-price PeggedSwap on the stock AquaSwapVMRouter

Strategy params (shared):  --fee-bps --fee-percent --fee-ppb --usdc-amount --fx-amount --amount-unit human|raw --label
  FXSwap:  --a 100 --gamma 0.1 --out-fee-bps 100 --out-fee-percent --fee-gamma 0.03 --flat-fee-bps
           --band-percent 20 | --min-price 700 --max-price 2800   --max-staleness 7d   --oracle-decimals 0
  Pegged:  --price 1400 --price-e2 140000 --linear-width 1e28

set-fx-price moves an owner-set ManualFxOracle feed: only the feed owner can send it (checked before sending).

Environment:
  GRAPH_ENDPOINT               Required Graph endpoint
  GRAPH_AUTH_TOKEN             Optional Graph bearer token
  WRITE_RPC_URL                RPC used for write preparation/execution reads
  WRITE_CHAIN_ID               Chain id for Aqua0 vault write preparation
  VAULT_REGISTRY_ADDRESS       Aqua0 vault registry address (Arc default for pair commands)
  AQUA_ADAPTER_ADDRESS         Pegged-venue AquaAdapter (Arc default)
  AQUA_SWAPVM_ROUTER_ADDRESS   Pegged-venue AquaSwapVMRouter (Arc default)
  FXSWAP_ROUTER_ADDRESS        AquaFXSwapVMRouter (Arc default)
  FXSWAP_AQUA_ADAPTER_ADDRESS  AquaAdapter bound to the FXSwap router (Arc default)
  FX_ORACLE_ARS_USD            ARS per USD feed (Arc default)
  FX_ORACLE_BRL_USD            BRL per USD feed override (Arc default: RedStone BRL feed)
  MCP_WRITE_MODE               prepare|execute, defaults to prepare
  WRITE_PRIVATE_KEY            Local signer key for guarded execute mode
  SIGNER                       local|circle, defaults to local
  CIRCLE_API_KEY               Circle API key (SIGNER=circle)
  CIRCLE_ENTITY_SECRET         Circle entity secret (SIGNER=circle; ENTITY_SECRET also accepted)
  CIRCLE_WALLET_ID             Circle ARC-TESTNET EOA wallet to sign with
  CIRCLE_WALLET_SET_ID         Without a wallet id: wallet set holding one wallet per user ref
  CIRCLE_USER_REF              Without a wallet id: refId of the user's wallet, created on first use
  CIRCLE_OPERATOR_WALLET_ID    Shared Circle operator wallet (OPERATOR_ROLE): sends ships users sign, tops up new users
  AQUA0_ONBOARD_USDC           Testnet USDC sent to a signed-in wallet holding under 1 USDC, default 5 (0 disables)
  AQUA0_ONBOARD_DAILY_CAP_USDC Top-ups are once per wallet and user, and stay under this per 24 hours, default 50
  AQUA0_ONBOARD_LEDGER         Top-up ledger file, default ~/.aqua0/onboarding-topups.json
  PRIVY_APP_ID                 Privy app for login (SIGNER=circle with CIRCLE_WALLET_SET_ID; the Privy user id is the refId)
  PRIVY_CLIENT_ID              Optional Privy app client for the sign-in page (e.g. one allowing localhost)
  PRIVY_LOGIN_PORT             Local sign-in page port, default 8787 (allow http://localhost:<port> in Privy)
  AQUA0_SESSION_FILE           Saved sign-in, default ~/.aqua0/session.json`);
}

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  const aqua0 = createAqua0Service(readCliConfig());

  switch (command) {
    case "health":
      printJson(await aqua0.health());
      break;
    case "info":
      printJson(await aqua0.info());
      break;
    case "login": {
      const { url, completed } = await aqua0.startLogin();
      console.error(`Open this page to sign in with Privy (expires in 10 minutes):\n\n  ${url}\n`);
      printJson(await completed);
      process.exit(0);
    }
    case "whoami":
      printJson(await aqua0.whoami());
      break;
    case "logout":
      printJson(aqua0.logout());
      break;
    case "balance":
      printJson(await aqua0.getBalance(requireArg(args[0], "address")));
      break;
    case "strategies":
      printJson(await aqua0.getStrategies(requireArg(args[0], "address")));
      break;
    case "fees":
      printJson(
        await aqua0.getFees(
          requireArg(args[0], "address"),
          args[1] === undefined ? undefined : parsePositiveInt(args[1], "seconds")
        )
      );
      break;
    case "opportunities":
      printJson(await aqua0.listOpportunities());
      break;
    case "snapshot":
      printJson(await aqua0.getProtocolSnapshot());
      break;
    case "create-strategy": {
      const parsed = parseFlags(args);
      const pair = optionalFlag(parsed, "pair");
      if (pair) {
        printJson(
          await aqua0.createFxStrategy({
            pair,
            chain: optionalFlag(parsed, "chain"),
            opcode: optionalFlag(parsed, "opcode"),
            strategist: optionalFlag(parsed, "strategist"),
            params: readStrategyParams(parsed),
            fundFxLeg: optionalBoolean(parsed, "fund-fx-leg"),
            dryRun: optionalBoolean(parsed, "dry-run")
          })
        );
        break;
      }
      const input = {
        strategist: requireFlag(parsed, "strategist"),
        token0: requireFlag(parsed, "token0"),
        token1: requireFlag(parsed, "token1"),
        label: requireFlag(parsed, "label"),
        vaults: requireFlags(parsed, "vault")
      };
      const mode = process.env.MCP_WRITE_MODE === "execute" ? "execute" : "prepare";
      printJson(
        mode === "execute"
          ? await aqua0.executeCreateStrategy(input)
          : await aqua0.prepareCreateStrategy(input)
      );
      break;
    }
    case "authorize": {
      const parsed = parseFlags(args);
      const input = {
        vault: requireFlag(parsed, "vault"),
        strategyId: requireFlag(parsed, "strategy-id"),
        backing: parseBoolean(requireFlag(parsed, "backing"), "backing")
      };
      const mode = process.env.MCP_WRITE_MODE === "execute" ? "execute" : "prepare";
      printJson(
        mode === "execute"
          ? await aqua0.executeAuthorizeStrategy(input)
          : aqua0.prepareAuthorizeStrategy(input)
      );
      break;
    }
    case "deposit": {
      const parsed = parseFlags(args);
      printJson(
        await aqua0.deposit({
          token: optionalFlag(parsed, "token"),
          vault: optionalFlag(parsed, "vault"),
          amount: requireFlag(parsed, "amount"),
          unit: optionalUnit(parsed, "unit"),
          receiver: optionalFlag(parsed, "receiver"),
          dryRun: optionalBoolean(parsed, "dry-run")
        })
      );
      break;
    }
    case "quote":
    case "swap": {
      const parsed = parseFlags(args);
      const input = {
        pair: optionalFlag(parsed, "pair"),
        strategyId: optionalFlag(parsed, "strategy-id"),
        opcode: optionalFlag(parsed, "opcode"),
        tokenIn: optionalFlag(parsed, "token-in"),
        amount: requireFlag(parsed, "amount"),
        unit: optionalUnit(parsed, "unit"),
        taker: optionalFlag(parsed, "taker"),
        params: readStrategyParams(parsed)
      };
      if (command === "quote") {
        printJson(await aqua0.quoteSwap(input));
      } else {
        const slippage = optionalFlag(parsed, "slippage-bps");
        printJson(
          await aqua0.swap({
            ...input,
            slippageBps: slippage === undefined ? undefined : Number(slippage),
            minAmountOut: optionalFlag(parsed, "min-amount-out"),
            dryRun: optionalBoolean(parsed, "dry-run")
          })
        );
      }
      break;
    }
    case "shared-backing":
      printJson(await aqua0.getSharedBacking({ address: args[0] }));
      break;
    case "fx-prices": {
      const parsed = parseFlags(args);
      printJson(await aqua0.getFxPrices({ pair: optionalFlag(parsed, "pair") }));
      break;
    }
    case "set-fx-price": {
      const parsed = parseFlags(args);
      printJson(
        await aqua0.setFxPrice({
          pair: optionalFlag(parsed, "pair"),
          feed: optionalFlag(parsed, "feed"),
          price: optionalFlag(parsed, "price"),
          changePercent: optionalFlag(parsed, "change-percent"),
          dryRun: optionalBoolean(parsed, "dry-run")
        })
      );
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function parseFlags(values: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Expected flag, got ${flag ?? "<empty>"}`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    const key = flag.slice(2);
    flags.set(key, [...(flags.get(key) ?? []), value]);
    index += 1;
  }
  return flags;
}

function requireFlag(flags: Map<string, string[]>, name: string): string {
  const value = flags.get(name)?.[0];
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function optionalFlag(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

function optionalBoolean(flags: Map<string, string[]>, name: string): boolean | undefined {
  const value = optionalFlag(flags, name);
  return value === undefined ? undefined : parseBoolean(value, name);
}

function optionalUnit(flags: Map<string, string[]>, name: string): AmountUnit | undefined {
  const value = optionalFlag(flags, name);
  if (value === undefined || value === "human" || value === "raw") {
    return value;
  }
  throw new Error(`--${name} must be human or raw`);
}

function readStrategyParams(flags: Map<string, string[]>): StrategyParamsInput {
  return {
    price: optionalFlag(flags, "price"),
    priceE2: optionalFlag(flags, "price-e2"),
    feeBps: optionalFlag(flags, "fee-bps"),
    feePercent: optionalFlag(flags, "fee-percent"),
    feePpb: optionalFlag(flags, "fee-ppb"),
    usdcAmount: optionalFlag(flags, "usdc-amount"),
    fxAmount: optionalFlag(flags, "fx-amount"),
    amountUnit: optionalUnit(flags, "amount-unit"),
    linearWidth: optionalFlag(flags, "linear-width"),
    a: optionalFlag(flags, "a"),
    gamma: optionalFlag(flags, "gamma"),
    outFeeBps: optionalFlag(flags, "out-fee-bps"),
    outFeePercent: optionalFlag(flags, "out-fee-percent"),
    outFeePpb: optionalFlag(flags, "out-fee-ppb"),
    feeGamma: optionalFlag(flags, "fee-gamma"),
    flatFeeBps: optionalFlag(flags, "flat-fee-bps"),
    flatFeePercent: optionalFlag(flags, "flat-fee-percent"),
    flatFeePpb: optionalFlag(flags, "flat-fee-ppb"),
    bandPercent: optionalFlag(flags, "band-percent"),
    minPrice: optionalFlag(flags, "min-price"),
    maxPrice: optionalFlag(flags, "max-price"),
    maxStaleness: optionalFlag(flags, "max-staleness"),
    oracleDecimals: optionalFlag(flags, "oracle-decimals"),
    label: optionalFlag(flags, "label")
  };
}

function requireFlags(flags: Map<string, string[]>, name: string): string[] {
  const values = flags.get(name) ?? [];
  if (values.length === 0) {
    throw new Error(`Missing --${name}`);
  }
  return values;
}

function parseBoolean(value: string, field: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${field} must be true or false`);
}

function parsePositiveInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}
