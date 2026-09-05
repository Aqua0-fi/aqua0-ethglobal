#!/usr/bin/env node
import { createAqua0Service } from "@aqua0/shared";

import { readCliConfig } from "./config.js";

const command = process.argv[2] ?? "help";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Aqua0 Continuity CLI

Usage:
  aqua0 health
  aqua0 info

Environment:
  GRAPH_ENDPOINT  Required public Graph endpoint
  AQUA0_API_URL   Optional public Aqua0 API URL
  ARC_RPC_URL     Optional Arc RPC URL`);
}

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  const aqua0 = createAqua0Service(readCliConfig());

  switch (command) {
    case "health":
      printJson(aqua0.health());
      break;
    case "info":
      printJson(aqua0.info());
      break;
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
