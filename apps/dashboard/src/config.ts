import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Aqua0ServiceConfig } from "@aqua0/shared";

type ArcDeploymentFile = {
  network: string;
  chainId: number;
  rpcUrl?: string;
  deployedAt?: string;
  startBlock?: number;
  contracts?: Record<string, string | null>;
  assets?: Record<string, string>;
  vaults?: Record<string, string>;
  verification?: Record<string, unknown>;
};

type ArcStrategiesFile = {
  network: string;
  chainId: number;
  strategist?: string;
  strategies?: Array<{
    label?: string;
    status?: string;
    strategyKey?: string;
    classId?: string;
    currentClassId?: string;
    token0?: string;
    token1?: string;
    vaults?: string[];
    nextTransaction?: {
      to?: string;
      functionName?: string;
      data?: string;
    };
  }>;
};

export type PublicDashboardConfig = {
  app: {
    title: string;
    subtitle: string;
  };
  graph: {
    network: string;
    endpointConfigured: boolean;
  };
  deployment: {
    network: string;
    chainId: number;
    deployedAt?: string;
    startBlock?: number;
    contracts: Record<string, string | null>;
    assets: Record<string, string>;
    vaults: Record<string, string>;
    verification?: Record<string, unknown>;
  };
  write: {
    mode: "prepare";
    chainId: number;
    vaultRegistryAddress?: string;
    rpcConfigured: boolean;
  };
  presets: Array<{
    id: string;
    label: string;
    status: string;
    strategist: string;
    token0: string;
    token1: string;
    vaults: string[];
    strategyKey?: string;
    classId?: string;
    currentClassId?: string;
    nextTransaction?: {
      to?: string;
      functionName?: string;
      data?: string;
    };
  }>;
};

export type DashboardRuntimeConfig = {
  host: string;
  port: number;
  service: Aqua0ServiceConfig;
  publicConfig: PublicDashboardConfig;
  publicDir: string;
  docsDir: string;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(moduleDir, "../../..");

export async function readDashboardConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<DashboardRuntimeConfig> {
  const workspaceRoot = env.AQUA0_WORKSPACE_ROOT
    ? resolve(env.AQUA0_WORKSPACE_ROOT)
    : defaultWorkspaceRoot;
  const [deployment, strategyDeployment] = await Promise.all([
    readJsonFile<ArcDeploymentFile>(resolve(workspaceRoot, "deployments/arc-testnet.json")),
    readJsonFile<ArcStrategiesFile>(resolve(workspaceRoot, "deployments/arc-testnet-strategies.json"))
  ]);

  if (!env.GRAPH_ENDPOINT) {
    throw new Error("GRAPH_ENDPOINT is required");
  }
  if (env.MCP_WRITE_MODE && env.MCP_WRITE_MODE !== "prepare") {
    throw new Error("Dashboard only supports MCP_WRITE_MODE=prepare");
  }

  const writeChainId = env.WRITE_CHAIN_ID
    ? parsePositiveInt(env.WRITE_CHAIN_ID, "WRITE_CHAIN_ID")
    : deployment.chainId;
  const vaultRegistryAddress =
    env.VAULT_REGISTRY_ADDRESS ?? deployment.contracts?.vaultRegistry ?? undefined;
  const writeRpcUrl = env.WRITE_RPC_URL ?? deployment.rpcUrl;

  const service: Aqua0ServiceConfig = {
    graphEndpoint: env.GRAPH_ENDPOINT,
    ...(env.GRAPH_NETWORK ? { graphNetwork: env.GRAPH_NETWORK } : { graphNetwork: deployment.network }),
    ...(env.GRAPH_AUTH_TOKEN ? { graphAuthToken: env.GRAPH_AUTH_TOKEN } : {}),
    ...(writeRpcUrl ? { writeRpcUrl } : {}),
    writeChainId,
    ...(vaultRegistryAddress ? { vaultRegistryAddress } : {}),
    mcpWriteMode: "prepare"
  };

  return {
    host: env.HOST ?? "0.0.0.0",
    port: env.PORT ? parsePositiveInt(env.PORT, "PORT") : 3000,
    service,
    publicConfig: makePublicConfig({
      deployment,
      strategyDeployment,
      graphNetwork: service.graphNetwork ?? deployment.network,
      graphEndpointConfigured: env.GRAPH_ENDPOINT.trim().length > 0,
      writeChainId,
      vaultRegistryAddress,
      rpcConfigured: Boolean(writeRpcUrl)
    }),
    publicDir: resolve(workspaceRoot, "apps/dashboard/public"),
    docsDir: resolve(workspaceRoot, "docs")
  };
}

function makePublicConfig(input: {
  deployment: ArcDeploymentFile;
  strategyDeployment: ArcStrategiesFile;
  graphNetwork: string;
  graphEndpointConfigured: boolean;
  writeChainId: number;
  vaultRegistryAddress: string | undefined;
  rpcConfigured: boolean;
}): PublicDashboardConfig {
  const contracts = input.deployment.contracts ?? {};
  const assets = input.deployment.assets ?? {};
  const vaults = input.deployment.vaults ?? {};
  const strategist = input.strategyDeployment.strategist ?? "";

  return {
    app: {
      title: "Aqua0 Shape-C / Arc Testnet",
      subtitle: "Judge dashboard for live indexed vaults, shared backing, and prepare-only strategy setup."
    },
    graph: {
      network: input.graphNetwork,
      endpointConfigured: input.graphEndpointConfigured
    },
    deployment: {
      network: input.deployment.network,
      chainId: input.deployment.chainId,
      ...(input.deployment.deployedAt ? { deployedAt: input.deployment.deployedAt } : {}),
      ...(input.deployment.startBlock ? { startBlock: input.deployment.startBlock } : {}),
      contracts,
      assets,
      vaults,
      ...(input.deployment.verification ? { verification: input.deployment.verification } : {})
    },
    write: {
      mode: "prepare",
      chainId: input.writeChainId,
      ...(input.vaultRegistryAddress ? { vaultRegistryAddress: input.vaultRegistryAddress } : {}),
      rpcConfigured: input.rpcConfigured
    },
    presets: (input.strategyDeployment.strategies ?? []).map((strategy, index) => ({
      id: presetId(strategy.label, index),
      label: strategy.label ?? `Strategy ${index + 1}`,
      status: strategy.status ?? "unknown",
      strategist,
      token0: strategy.token0 ?? "",
      token1: strategy.token1 ?? "",
      vaults: strategy.vaults ?? [],
      ...(strategy.strategyKey ? { strategyKey: strategy.strategyKey } : {}),
      ...(strategy.classId ? { classId: strategy.classId } : {}),
      ...(strategy.currentClassId ? { currentClassId: strategy.currentClassId } : {}),
      ...(strategy.nextTransaction ? { nextTransaction: strategy.nextTransaction } : {})
    }))
  };
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function parsePositiveInt(value: string, field: string): number {
  const parsed = Number(value);
  const max = field === "PORT" ? 65535 : Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(
      field === "PORT" ? "PORT must be an integer from 1 to 65535" : `${field} must be a positive integer`
    );
  }
  return parsed;
}

function presetId(label: string | undefined, index: number): string {
  const normalized = label
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized && normalized.length > 0 ? normalized : `strategy-${index + 1}`;
}
