import { ARC_TESTNET, type Aqua0ServiceConfig } from "@aqua0/shared";

export type McpConfig = Aqua0ServiceConfig;

export function readMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const graphEndpoint = env.GRAPH_ENDPOINT;

  if (!graphEndpoint) {
    throw new Error("GRAPH_ENDPOINT is required");
  }

  return {
    graphEndpoint,
    ...(env.AQUA0_API_URL ? { aqua0ApiUrl: env.AQUA0_API_URL } : {}),
    arcRpcUrl: env.ARC_RPC_URL ?? ARC_TESTNET.rpcUrl
  };
}
