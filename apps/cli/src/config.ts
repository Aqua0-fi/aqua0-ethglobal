import { type Aqua0ServiceConfig, type WriteMode } from "@aqua0/shared";

export function readCliConfig(env: NodeJS.ProcessEnv = process.env): Aqua0ServiceConfig {
  const graphEndpoint = env.GRAPH_ENDPOINT;
  if (!graphEndpoint) {
    throw new Error("GRAPH_ENDPOINT is required");
  }

  return {
    graphEndpoint,
    ...(env.GRAPH_AUTH_TOKEN ? { graphAuthToken: env.GRAPH_AUTH_TOKEN } : {}),
    ...(env.WRITE_RPC_URL ? { writeRpcUrl: env.WRITE_RPC_URL } : {}),
    ...(env.WRITE_CHAIN_ID ? { writeChainId: parsePositiveInt(env.WRITE_CHAIN_ID, "WRITE_CHAIN_ID") } : {}),
    ...(env.VAULT_REGISTRY_ADDRESS ? { vaultRegistryAddress: env.VAULT_REGISTRY_ADDRESS } : {}),
    ...(env.WRITE_PRIVATE_KEY ? { writePrivateKey: env.WRITE_PRIVATE_KEY } : {}),
    mcpWriteMode: readWriteMode(env.MCP_WRITE_MODE)
  };
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
