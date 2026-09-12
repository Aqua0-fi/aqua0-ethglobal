import { ARC_TESTNET, readPrivyEnv, readSignerEnv, type Aqua0ServiceConfig, type WriteMode } from "@aqua0/shared";

export type McpConfig = Aqua0ServiceConfig & {
  transport: "stdio" | "http";
  host: string;
  port: number;
};

/** Public Subgraph Studio query URL of the Aqua0 Arc Testnet subgraph (rate limited); GRAPH_ENDPOINT overrides it. */
export const DEFAULT_GRAPH_ENDPOINT =
  "https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest";

export function readMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): McpConfig {
  const graphEndpoint = env.GRAPH_ENDPOINT?.trim() || DEFAULT_GRAPH_ENDPOINT;

  const transport = readTransport(env, argv);
  return {
    graphEndpoint,
    ...(env.GRAPH_NETWORK ? { graphNetwork: env.GRAPH_NETWORK } : {}),
    ...(env.GRAPH_AUTH_TOKEN ? { graphAuthToken: env.GRAPH_AUTH_TOKEN } : {}),
    ...(env.GRAPH_GATEWAY_API_KEY ? { graphGatewayApiKey: env.GRAPH_GATEWAY_API_KEY } : {}),
    // Arc Testnet by default, so `npx -y @aqua0/mcp` reads the chain with no variables. Execution still needs
    // MCP_WRITE_MODE=execute and a signer, and stays limited to Arc Testnet or a local fork.
    writeRpcUrl: env.WRITE_RPC_URL?.trim() || ARC_TESTNET.rpcUrl,
    writeChainId: env.WRITE_CHAIN_ID?.trim()
      ? parsePositiveInt(env.WRITE_CHAIN_ID, "WRITE_CHAIN_ID")
      : ARC_TESTNET.chainId,
    ...(env.VAULT_REGISTRY_ADDRESS ? { vaultRegistryAddress: env.VAULT_REGISTRY_ADDRESS } : {}),
    ...(env.WRITE_PRIVATE_KEY ? { writePrivateKey: env.WRITE_PRIVATE_KEY } : {}),
    ...readSignerEnv(env),
    ...readPrivyEnv(env),
    ...(env.AQUA_ADAPTER_ADDRESS ? { aquaAdapterAddress: env.AQUA_ADAPTER_ADDRESS } : {}),
    ...(env.AQUA_SWAPVM_ROUTER_ADDRESS
      ? { aquaSwapVMRouterAddress: env.AQUA_SWAPVM_ROUTER_ADDRESS }
      : {}),
    ...(env.FXSWAP_ROUTER_ADDRESS ? { fxswapRouterAddress: env.FXSWAP_ROUTER_ADDRESS } : {}),
    ...(env.FXSWAP_AQUA_ADAPTER_ADDRESS
      ? { fxswapAquaAdapterAddress: env.FXSWAP_AQUA_ADAPTER_ADDRESS }
      : {}),
    ...(env.FX_ORACLE_ARS_USD ? { fxOracleArsUsdAddress: env.FX_ORACLE_ARS_USD } : {}),
    ...(env.FX_ORACLE_BRL_USD ? { fxOracleBrlUsdAddress: env.FX_ORACLE_BRL_USD } : {}),
    mcpWriteMode: readWriteMode(env.MCP_WRITE_MODE),
    transport,
    host: env.HOST ?? "0.0.0.0",
    port: env.PORT ? parsePositiveInt(env.PORT, "PORT") : 3000
  };
}

function readTransport(env: NodeJS.ProcessEnv, argv: string[]): "stdio" | "http" {
  const flag = argv.find((arg) => arg.startsWith("--transport="));
  const value = flag?.split("=", 2)[1] ?? env.MCP_TRANSPORT ?? "stdio";
  if (value === "stdio" || value === "http") {
    return value;
  }
  throw new Error("MCP transport must be stdio or http");
}

function readWriteMode(value: string | undefined): WriteMode {
  if (value === undefined || value === "") {
    return "prepare";
  }
  if (value === "prepare" || value === "execute") {
    return value;
  }
  throw new Error("MCP_WRITE_MODE must be prepare or execute");
}

function parsePositiveInt(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}
