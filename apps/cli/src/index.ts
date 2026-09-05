#!/usr/bin/env node
import { createAqua0Service } from "@aqua0/shared";

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
  aqua0 balance <address>
  aqua0 strategies <address>
  aqua0 fees <address> [seconds]
  aqua0 opportunities
  aqua0 snapshot
  aqua0 create-strategy --strategist <addr> --token0 <addr> --token1 <addr> --label <text> --vault <addr>...
  aqua0 authorize --vault <addr> --strategy-id <id> --backing true|false

Environment:
  GRAPH_ENDPOINT          Required Graph endpoint
  GRAPH_AUTH_TOKEN       Optional Graph bearer token
  WRITE_RPC_URL          RPC used for write preparation/execution reads
  WRITE_CHAIN_ID         Chain id for Shape-C write preparation
  VAULT_REGISTRY_ADDRESS Shape-C VaultRegistry address
  MCP_WRITE_MODE         prepare|execute, defaults to prepare
  WRITE_PRIVATE_KEY      Required only for guarded execute mode`);
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
      printJson(aqua0.info());
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
