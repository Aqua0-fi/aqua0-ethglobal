import { type Aqua0ServiceConfig, type WriteMode } from "@aqua0/shared";

export type McpConfig = Aqua0ServiceConfig & {
  transport: "stdio" | "http";
  host: string;
  port: number;
};

export function readMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2)
): McpConfig {
  const graphEndpoint = env.GRAPH_ENDPOINT;
  if (!graphEndpoint) {
    throw new Error("GRAPH_ENDPOINT is required");
  }

  const transport = readTransport(env, argv);
  return {
    graphEndpoint,
    ...(env.GRAPH_AUTH_TOKEN ? { graphAuthToken: env.GRAPH_AUTH_TOKEN } : {}),
    ...(env.WRITE_RPC_URL ? { writeRpcUrl: env.WRITE_RPC_URL } : {}),
    ...(env.WRITE_CHAIN_ID ? { writeChainId: parsePositiveInt(env.WRITE_CHAIN_ID, "WRITE_CHAIN_ID") } : {}),
    ...(env.VAULT_REGISTRY_ADDRESS ? { vaultRegistryAddress: env.VAULT_REGISTRY_ADDRESS } : {}),
    ...(env.WRITE_PRIVATE_KEY ? { writePrivateKey: env.WRITE_PRIVATE_KEY } : {}),
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
