import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const required = ["GRAPH_ENDPOINT"];
const optional = [
  "GRAPH_NETWORK",
  "GRAPH_AUTH_TOKEN",
  "WRITE_RPC_URL",
  "WRITE_CHAIN_ID",
  "VAULT_REGISTRY_ADDRESS",
  "MCP_WRITE_MODE",
  "WRITE_PRIVATE_KEY",
  "AQUA_ADAPTER_ADDRESS",
  "AQUA_SWAPVM_ROUTER_ADDRESS",
  "FXSWAP_ROUTER_ADDRESS",
  "FXSWAP_AQUA_ADAPTER_ADDRESS",
  "FX_ORACLE_ARS_USD",
  "FX_ORACLE_BRL_USD",
  "MCP_TRANSPORT",
  "HOST",
  "PORT"
];

const addressVariables = [
  "VAULT_REGISTRY_ADDRESS",
  "AQUA_ADAPTER_ADDRESS",
  "AQUA_SWAPVM_ROUTER_ADDRESS",
  "FXSWAP_ROUTER_ADDRESS",
  "FXSWAP_AQUA_ADAPTER_ADDRESS",
  "FX_ORACLE_ARS_USD",
  "FX_ORACLE_BRL_USD"
];

for (const name of addressVariables) {
  if (process.env[name] && !/^0x[0-9a-fA-F]{40}$/.test(process.env[name])) {
    console.error(`${name} must be a 20-byte hex address`);
    process.exit(1);
  }
}

if (
  process.env.FXSWAP_AQUA_ADAPTER_ADDRESS &&
  process.env.AQUA_ADAPTER_ADDRESS &&
  process.env.FXSWAP_AQUA_ADAPTER_ADDRESS.toLowerCase() === process.env.AQUA_ADAPTER_ADDRESS.toLowerCase()
) {
  console.error(
    "FXSWAP_AQUA_ADAPTER_ADDRESS must be the AquaAdapter bound to the FXSwap router, not the pegged AQUA_ADAPTER_ADDRESS"
  );
  process.exit(1);
}

const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
  console.error("Copy .env.example to .env or export the values in your shell.");
  process.exit(1);
}

for (const name of optional) {
  if (!process.env[name]) {
    console.warn(`Optional environment variable not set: ${name}`);
  }
}

if (
  process.env.MCP_WRITE_MODE &&
  process.env.MCP_WRITE_MODE !== "prepare" &&
  process.env.MCP_WRITE_MODE !== "execute"
) {
  console.error("MCP_WRITE_MODE must be prepare or execute");
  process.exit(1);
}

if (process.env.SIGNER && process.env.SIGNER !== "local" && process.env.SIGNER !== "circle") {
  console.error("SIGNER must be local or circle");
  process.exit(1);
}

if (
  process.env.MCP_TRANSPORT &&
  process.env.MCP_TRANSPORT !== "stdio" &&
  process.env.MCP_TRANSPORT !== "http"
) {
  console.error("MCP_TRANSPORT must be stdio or http");
  process.exit(1);
}

console.log("Environment check passed.");
