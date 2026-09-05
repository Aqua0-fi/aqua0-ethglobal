import {
  AQUA0_ARCHITECTURE,
  ARC_TESTNET,
  USDC_ERC20_INTERFACE_ADDRESS
} from "./constants.js";
import {
  addBigIntStrings,
  GraphClient,
  GraphRequestError,
  normalizeAddress,
  type FetchLike
} from "./graph.js";
import {
  assertExecutionAllowed,
  executeAuthorizeStrategy,
  executeCreateStrategy,
  isExecutionAllowedByConfig,
  prepareAuthorizeStrategy,
  prepareCreateStrategy,
  prepareDeposit,
  prepareWithdraw,
  type CreateStrategyInput,
  type ExecutionResult,
  type PreparedCreateStrategy,
  type PreparedTransaction,
  type WriteConfig,
  type WriteMode
} from "./write.js";

export type Aqua0ServiceConfig = WriteConfig & {
  graphEndpoint: string;
  graphAuthToken?: string;
  graphTimeoutMs?: number;
  graphNetwork?: string;
  fetch?: FetchLike;
};

export type Aqua0Health = {
  ok: boolean;
  graphConfigured: boolean;
  graphReachable: boolean;
  graphError?: string;
  graphBlockNumber?: string;
  network: string;
  chainId?: number;
};

export type Aqua0Info = {
  architecture: typeof AQUA0_ARCHITECTURE;
  chain: typeof ARC_TESTNET;
  usdcErc20Interface: typeof USDC_ERC20_INTERFACE_ADDRESS;
  endpoints: {
    graphEndpoint: string;
    writeRpcUrl?: string;
  };
  write: {
    mode: WriteMode;
    chainId?: number;
    vaultRegistryAddress?: Lowercase<string>;
    executionConfigured: boolean;
  };
};

type VaultEntity = {
  id: string;
  address: string;
  asset?: string | null;
  name?: string | null;
  symbol?: string | null;
  network: string;
  sharedIdle?: string | null;
  totalDeployed?: string | null;
  vaultLiveTvl?: string | null;
  frontReservedAssets?: string | null;
  segregatedFees?: string | null;
  orphanedSegregatedFees?: string | null;
  paused?: boolean | null;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

type LPVaultPositionEntity = {
  id: string;
  vault: string;
  lp: string;
  network: string;
  principal?: string | null;
  credit?: string | null;
  deployedByLp?: string | null;
  freePrincipal?: string | null;
  frontHeldPrincipal?: string | null;
  asyncHeld?: string | null;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

type LPStrategyPositionEntity = {
  id: string;
  vault: string;
  lp: string;
  strategyId: string;
  network: string;
  committed?: boolean | null;
  deployedInto?: string | null;
  composition?: string | null;
  feeCheckpointRay?: string | null;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

type StrategyVaultEntity = {
  id: string;
  vault: string;
  strategyId: string;
  network: string;
  exists?: boolean | null;
  strategist?: string | null;
  paused?: boolean | null;
  committedBacking?: string | null;
  deployedAssets?: string | null;
  availableFor?: string | null;
  sharePriceRay?: string | null;
  settlementRoute?: string | null;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

type StrategyFeeAccruedEventEntity = {
  id: string;
  txHash: string;
  blockNumber: string;
  timestamp: string;
  network: string;
  vault: string;
  strategyId: string;
  lp?: string | null;
  credited: string;
};

type V4SwapSettledEventEntity = {
  id: string;
  txHash: string;
  blockNumber: string;
  timestamp: string;
  network: string;
  adapter: string;
  strategyId: string;
  swapId: string;
  token0: string;
  delta0: string;
  token1: string;
  delta1: string;
};

type AquaLifecycleEventEntity = {
  id: string;
  txHash: string;
  blockNumber: string;
  timestamp: string;
  network: string;
  adapter: string;
  strategyId: string;
};

export type VaultMetadata = {
  address: Lowercase<string>;
  asset?: Lowercase<string>;
  name?: string;
  symbol?: string;
  network: string;
  raw: {
    sharedIdle?: string;
    totalDeployed?: string;
    vaultLiveTvl?: string;
    frontReservedAssets?: string;
    segregatedFees?: string;
    orphanedSegregatedFees?: string;
  };
  paused?: boolean;
  updatedAtBlock: string;
  updatedAtTimestamp: string;
};

export class Aqua0Service {
  readonly #config: Aqua0ServiceConfig;
  readonly #graph: GraphClient;

  constructor(config: Aqua0ServiceConfig) {
    this.#config = {
      ...config,
      mcpWriteMode: config.mcpWriteMode ?? "prepare"
    };
    this.#graph = new GraphClient({
      endpoint: config.graphEndpoint,
      ...(config.graphAuthToken ? { authToken: config.graphAuthToken } : {}),
      ...(config.graphTimeoutMs ? { timeoutMs: config.graphTimeoutMs } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {})
    });
  }

  async rawGraphQuery<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    return this.#graph.query<T>(query, variables);
  }

  async health(): Promise<Aqua0Health> {
    try {
      const data = await this.#graph.query<{ _meta?: { block?: { number?: string | number } } }>(
        `query Aqua0Health { _meta { block { number } } }`
      );
      return {
        ok: true,
        graphConfigured: this.#config.graphEndpoint.trim().length > 0,
        graphReachable: true,
        ...(data._meta?.block?.number !== undefined
          ? { graphBlockNumber: data._meta.block.number.toString() }
          : {}),
        network: this.#config.graphNetwork ?? ARC_TESTNET.graphNetwork,
        ...(this.#config.writeChainId ? { chainId: this.#config.writeChainId } : {})
      };
    } catch (error) {
      return {
        ok: false,
        graphConfigured: this.#config.graphEndpoint.trim().length > 0,
        graphReachable: false,
        graphError: graphErrorMessage(error),
        network: this.#config.graphNetwork ?? ARC_TESTNET.graphNetwork,
        ...(this.#config.writeChainId ? { chainId: this.#config.writeChainId } : {})
      };
    }
  }

  info(): Aqua0Info {
    return {
      architecture: AQUA0_ARCHITECTURE,
      chain: ARC_TESTNET,
      usdcErc20Interface: USDC_ERC20_INTERFACE_ADDRESS,
      endpoints: {
        graphEndpoint: this.#config.graphEndpoint,
        ...(this.#config.writeRpcUrl ? { writeRpcUrl: this.#config.writeRpcUrl } : {})
      },
      write: {
        mode: this.#config.mcpWriteMode ?? "prepare",
        ...(this.#config.writeChainId ? { chainId: this.#config.writeChainId } : {}),
        ...(this.#config.vaultRegistryAddress
          ? { vaultRegistryAddress: normalizeAddress(this.#config.vaultRegistryAddress) }
          : {}),
        executionConfigured: isExecutionAllowedByConfig(this.#config)
      }
    };
  }

  async getBalance(address: string) {
    const lp = normalizeAddress(address);
    const data = await this.#graph.query<{
      lpVaultPositions: LPVaultPositionEntity[];
      vaults: VaultEntity[];
    }>(
      `query Aqua0Balance($lp: Bytes!) {
        lpVaultPositions(first: 1000, where: { lp: $lp }, orderBy: updatedAtTimestamp, orderDirection: desc) {
          id vault lp network principal credit deployedByLp freePrincipal frontHeldPrincipal asyncHeld updatedAtBlock updatedAtTimestamp
        }
        vaults(first: 1000) {
          id address asset name symbol network sharedIdle totalDeployed vaultLiveTvl frontReservedAssets segregatedFees orphanedSegregatedFees paused updatedAtBlock updatedAtTimestamp
        }
      }`,
      { lp }
    );
    const vaults = mapVaults(data.vaults);
    const positions = data.lpVaultPositions.map((position) => ({
      id: position.id,
      lp,
      vault: normalizeAddress(position.vault),
      vaultMetadata: vaults.get(normalizeAddress(position.vault)),
      network: position.network,
      raw: compactRaw({
        principal: position.principal,
        credit: position.credit,
        deployedByLp: position.deployedByLp,
        freePrincipal: position.freePrincipal,
        frontHeldPrincipal: position.frontHeldPrincipal,
        asyncHeld: position.asyncHeld
      }),
      updatedAtBlock: position.updatedAtBlock,
      updatedAtTimestamp: position.updatedAtTimestamp
    }));

    return {
      source: "graph",
      address: lp,
      totals: {
        principal: addBigIntStrings(data.lpVaultPositions.map((item) => item.principal)),
        credit: addBigIntStrings(data.lpVaultPositions.map((item) => item.credit)),
        deployedByLp: addBigIntStrings(data.lpVaultPositions.map((item) => item.deployedByLp)),
        freePrincipal: addBigIntStrings(data.lpVaultPositions.map((item) => item.freePrincipal)),
        frontHeldPrincipal: addBigIntStrings(
          data.lpVaultPositions.map((item) => item.frontHeldPrincipal)
        ),
        asyncHeld: addBigIntStrings(data.lpVaultPositions.map((item) => item.asyncHeld))
      },
      positions
    };
  }

  async getStrategies(address: string) {
    const lp = normalizeAddress(address);
    const data = await this.#graph.query<{
      lpStrategyPositions: LPStrategyPositionEntity[];
      ownedStrategyVaults: StrategyVaultEntity[];
      strategyVaults: StrategyVaultEntity[];
      vaults: VaultEntity[];
    }>(
      `query Aqua0Strategies($address: Bytes!) {
        lpStrategyPositions(first: 1000, where: { lp: $address }, orderBy: updatedAtTimestamp, orderDirection: desc) {
          id vault lp strategyId network committed deployedInto composition feeCheckpointRay updatedAtBlock updatedAtTimestamp
        }
        ownedStrategyVaults: strategyVaults(first: 1000, where: { strategist: $address, exists: true }, orderBy: updatedAtTimestamp, orderDirection: desc) {
          id vault strategyId network exists strategist paused committedBacking deployedAssets availableFor sharePriceRay settlementRoute updatedAtBlock updatedAtTimestamp
        }
        strategyVaults(first: 1000, where: { exists: true }) {
          id vault strategyId network exists strategist paused committedBacking deployedAssets availableFor sharePriceRay settlementRoute updatedAtBlock updatedAtTimestamp
        }
        vaults(first: 1000) {
          id address asset name symbol network sharedIdle totalDeployed vaultLiveTvl frontReservedAssets segregatedFees orphanedSegregatedFees paused updatedAtBlock updatedAtTimestamp
        }
      }`,
      { address: lp }
    );
    const vaults = mapVaults(data.vaults);
    const strategyVaults = mapStrategyVaults(data.strategyVaults, vaults);
    const positions = data.lpStrategyPositions.map((position) => {
      const vault = normalizeAddress(position.vault);
      return {
        id: position.id,
        lp,
        vault,
        strategyId: position.strategyId,
        strategyVault: strategyVaults.get(strategyVaultKey(vault, position.strategyId)),
        vaultMetadata: vaults.get(vault),
        network: position.network,
        committed: position.committed ?? false,
        raw: compactRaw({
          deployedInto: position.deployedInto,
          composition: position.composition,
          feeCheckpointRay: position.feeCheckpointRay
        }),
        updatedAtBlock: position.updatedAtBlock,
        updatedAtTimestamp: position.updatedAtTimestamp
      };
    });

    return {
      source: "graph",
      address: lp,
      totals: {
        deployedInto: addBigIntStrings(data.lpStrategyPositions.map((item) => item.deployedInto)),
        composition: addBigIntStrings(data.lpStrategyPositions.map((item) => item.composition))
      },
      lpPositions: positions,
      strategistVaults: data.ownedStrategyVaults.map((item) => formatStrategyVault(item, vaults)),
      strategies: positions
    };
  }

  async getFees(address: string, periodSeconds?: number) {
    const lp = normalizeAddress(address);
    const now = Math.floor(Date.now() / 1000);
    const timestampGte =
      periodSeconds === undefined ? undefined : Math.max(0, now - Math.trunc(periodSeconds));
    const filter = timestampGte === undefined ? "lp: $lp" : "lp: $lp, timestamp_gte: $timestampGte";
    const data = await this.#graph.query<{
      strategyFeeAccruedEvents: StrategyFeeAccruedEventEntity[];
      vaults: VaultEntity[];
    }>(
      `query Aqua0Fees($lp: Bytes!${timestampGte === undefined ? "" : ", $timestampGte: BigInt!"}) {
        strategyFeeAccruedEvents(
          first: 1000
          where: { ${filter} }
          orderBy: timestamp
          orderDirection: desc
        ) {
          id txHash blockNumber timestamp network vault strategyId lp credited
        }
        vaults(first: 1000) {
          id address asset name symbol network sharedIdle totalDeployed vaultLiveTvl frontReservedAssets segregatedFees orphanedSegregatedFees paused updatedAtBlock updatedAtTimestamp
        }
      }`,
      timestampGte === undefined ? { lp } : { lp, timestampGte: timestampGte.toString() }
    );
    const vaults = mapVaults(data.vaults);
    const byVault: Record<string, string> = {};
    const byStrategy: Record<string, string> = {};
    for (const event of data.strategyFeeAccruedEvents) {
      const vault = normalizeAddress(event.vault);
      byVault[vault] = addBigIntStrings([byVault[vault], event.credited]);
      byStrategy[event.strategyId] = addBigIntStrings([byStrategy[event.strategyId], event.credited]);
    }

    return {
      source: "graph",
      address: lp,
      periodSeconds: periodSeconds ?? null,
      timestampGte: timestampGte?.toString() ?? null,
      totals: {
        assets: addBigIntStrings(data.strategyFeeAccruedEvents.map((item) => item.credited)),
        byVault,
        byStrategy
      },
      events: data.strategyFeeAccruedEvents.map((event) => ({
        ...event,
        vault: normalizeAddress(event.vault),
        lp: event.lp ? normalizeAddress(event.lp) : null,
        vaultMetadata: vaults.get(normalizeAddress(event.vault))
      }))
    };
  }

  async listOpportunities() {
    const data = await this.#graph.query<{
      strategyVaults: StrategyVaultEntity[];
      vaults: VaultEntity[];
      v4SwapSettledEvents: V4SwapSettledEventEntity[];
      aquaStrategyShippedEvents: AquaLifecycleEventEntity[];
      aquaStrategyDockedEvents: AquaLifecycleEventEntity[];
      aquaStrategyReshippedEvents: AquaLifecycleEventEntity[];
      aquaStrategyReconciledEvents: AquaLifecycleEventEntity[];
      aquaStrategyForceClearedEvents: AquaLifecycleEventEntity[];
    }>(
      `query Aqua0Opportunities {
        strategyVaults(first: 1000, where: { exists: true, paused: false }, orderBy: availableFor, orderDirection: desc) {
          id vault strategyId network exists strategist paused committedBacking deployedAssets availableFor sharePriceRay settlementRoute updatedAtBlock updatedAtTimestamp
        }
        vaults(first: 1000) {
          id address asset name symbol network sharedIdle totalDeployed vaultLiveTvl frontReservedAssets segregatedFees orphanedSegregatedFees paused updatedAtBlock updatedAtTimestamp
        }
        v4SwapSettledEvents(first: 20, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network adapter strategyId swapId token0 delta0 token1 delta1
        }
        aquaStrategyShippedEvents(first: 20, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network adapter strategyId
        }
        aquaStrategyDockedEvents(first: 20, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network adapter strategyId
        }
        aquaStrategyReshippedEvents(first: 20, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network adapter strategyId
        }
        aquaStrategyReconciledEvents(first: 20, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network adapter strategyId
        }
        aquaStrategyForceClearedEvents(first: 20, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network adapter strategyId
        }
      }`
    );
    const vaults = mapVaults(data.vaults);

    return {
      source: "graph",
      opportunities: data.strategyVaults.map((strategyVault) =>
        formatStrategyVault(strategyVault, vaults)
      ),
      recentV4Swaps: data.v4SwapSettledEvents.map((event) => ({
        ...event,
        adapter: normalizeAddress(event.adapter),
        token0: normalizeAddress(event.token0),
        token1: normalizeAddress(event.token1)
      })),
      aquaLifecycle: {
        shipped: data.aquaStrategyShippedEvents,
        docked: data.aquaStrategyDockedEvents,
        reshipped: data.aquaStrategyReshippedEvents,
        reconciled: data.aquaStrategyReconciledEvents,
        forceCleared: data.aquaStrategyForceClearedEvents
      }
    };
  }

  async getProtocolSnapshot() {
    const data = await this.#graph.query<{
      vaults: VaultEntity[];
      strategyVaults: StrategyVaultEntity[];
      strategyFeeAccruedEvents: StrategyFeeAccruedEventEntity[];
      v4SwapSettledEvents: V4SwapSettledEventEntity[];
      aquaStrategyShippedEvents: AquaLifecycleEventEntity[];
      aquaStrategyDockedEvents: AquaLifecycleEventEntity[];
      aquaStrategyReshippedEvents: AquaLifecycleEventEntity[];
      aquaStrategyReconciledEvents: AquaLifecycleEventEntity[];
      aquaStrategyForceClearedEvents: AquaLifecycleEventEntity[];
    }>(
      `query Aqua0ProtocolSnapshot {
        vaults(first: 1000, orderBy: updatedAtTimestamp, orderDirection: desc) {
          id address asset name symbol network sharedIdle totalDeployed vaultLiveTvl frontReservedAssets segregatedFees orphanedSegregatedFees paused updatedAtBlock updatedAtTimestamp
        }
        strategyVaults(first: 1000, where: { exists: true }, orderBy: updatedAtTimestamp, orderDirection: desc) {
          id vault strategyId network exists strategist paused committedBacking deployedAssets availableFor sharePriceRay settlementRoute updatedAtBlock updatedAtTimestamp
        }
        strategyFeeAccruedEvents(first: 1000, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network vault strategyId lp credited
        }
        v4SwapSettledEvents(first: 1000, orderBy: timestamp, orderDirection: desc) {
          id txHash blockNumber timestamp network adapter strategyId swapId token0 delta0 token1 delta1
        }
        aquaStrategyShippedEvents(first: 1000, orderBy: timestamp, orderDirection: desc) { id txHash blockNumber timestamp network adapter strategyId }
        aquaStrategyDockedEvents(first: 1000, orderBy: timestamp, orderDirection: desc) { id txHash blockNumber timestamp network adapter strategyId }
        aquaStrategyReshippedEvents(first: 1000, orderBy: timestamp, orderDirection: desc) { id txHash blockNumber timestamp network adapter strategyId }
        aquaStrategyReconciledEvents(first: 1000, orderBy: timestamp, orderDirection: desc) { id txHash blockNumber timestamp network adapter strategyId }
        aquaStrategyForceClearedEvents(first: 1000, orderBy: timestamp, orderDirection: desc) { id txHash blockNumber timestamp network adapter strategyId }
      }`
    );
    const vaults = mapVaults(data.vaults);

    return {
      source: "graph",
      counts: {
        vaults: data.vaults.length,
        activeStrategyVaults: data.strategyVaults.filter((item) => item.exists && !item.paused)
          .length,
        feeEvents: data.strategyFeeAccruedEvents.length,
        v4Swaps: data.v4SwapSettledEvents.length,
        aquaLifecycleEvents:
          data.aquaStrategyShippedEvents.length +
          data.aquaStrategyDockedEvents.length +
          data.aquaStrategyReshippedEvents.length +
          data.aquaStrategyReconciledEvents.length +
          data.aquaStrategyForceClearedEvents.length
      },
      totals: {
        vaultLiveTvl: addBigIntStrings(data.vaults.map((item) => item.vaultLiveTvl)),
        sharedIdle: addBigIntStrings(data.vaults.map((item) => item.sharedIdle)),
        totalDeployed: addBigIntStrings(data.vaults.map((item) => item.totalDeployed)),
        committedBacking: addBigIntStrings(
          data.strategyVaults.map((item) => item.committedBacking)
        ),
        availableFor: addBigIntStrings(data.strategyVaults.map((item) => item.availableFor)),
        feesAccrued: addBigIntStrings(data.strategyFeeAccruedEvents.map((item) => item.credited))
      },
      vaults: data.vaults.map(formatVault),
      strategyVaults: data.strategyVaults.map((item) => formatStrategyVault(item, vaults)),
      recentV4Swaps: data.v4SwapSettledEvents.slice(0, 20).map((event) => ({
        ...event,
        adapter: normalizeAddress(event.adapter),
        token0: normalizeAddress(event.token0),
        token1: normalizeAddress(event.token1)
      })),
      aquaLifecycle: {
        shipped: data.aquaStrategyShippedEvents.slice(0, 20),
        docked: data.aquaStrategyDockedEvents.slice(0, 20),
        reshipped: data.aquaStrategyReshippedEvents.slice(0, 20),
        reconciled: data.aquaStrategyReconciledEvents.slice(0, 20),
        forceCleared: data.aquaStrategyForceClearedEvents.slice(0, 20)
      }
    };
  }

  prepareCreateStrategy(input: CreateStrategyInput): Promise<PreparedCreateStrategy> {
    return prepareCreateStrategy(this.#config, input);
  }

  executeCreateStrategy(input: CreateStrategyInput): Promise<ExecutionResult> {
    return executeCreateStrategy(this.#config, input);
  }

  prepareAuthorizeStrategy(input: {
    vault: string;
    strategyId: string;
    backing: boolean;
  }): PreparedTransaction {
    return prepareAuthorizeStrategy(input);
  }

  executeAuthorizeStrategy(input: {
    vault: string;
    strategyId: string;
    backing: boolean;
  }): Promise<ExecutionResult> {
    return executeAuthorizeStrategy(this.#config, input);
  }

  prepareDeposit(input: { vault: string; assets: string; receiver: string }): PreparedTransaction {
    return prepareDeposit(input);
  }

  prepareWithdraw(input: {
    vault: string;
    assets: string;
    receiver: string;
    owner: string;
  }): PreparedTransaction {
    return prepareWithdraw(input);
  }

  assertExecutionAllowed(): void {
    assertExecutionAllowed(this.#config);
  }
}

export function createAqua0Service(config: Aqua0ServiceConfig): Aqua0Service {
  return new Aqua0Service(config);
}

function mapVaults(vaults: VaultEntity[]): Map<Lowercase<string>, VaultMetadata> {
  const map = new Map<Lowercase<string>, VaultMetadata>();
  for (const vault of vaults) {
    map.set(normalizeAddress(vault.address), formatVault(vault));
  }
  return map;
}

function mapStrategyVaults(
  strategyVaults: StrategyVaultEntity[],
  vaults: Map<Lowercase<string>, VaultMetadata>
) {
  const map = new Map<string, ReturnType<typeof formatStrategyVault>>();
  for (const strategyVault of strategyVaults) {
    const vault = normalizeAddress(strategyVault.vault);
    map.set(strategyVaultKey(vault, strategyVault.strategyId), formatStrategyVault(strategyVault, vaults));
  }
  return map;
}

function strategyVaultKey(vault: Lowercase<string>, strategyId: string): string {
  return `${vault}:${strategyId}`;
}

function formatVault(vault: VaultEntity): VaultMetadata {
  return {
    address: normalizeAddress(vault.address),
    ...(vault.asset ? { asset: normalizeAddress(vault.asset) } : {}),
    ...(vault.name ? { name: vault.name } : {}),
    ...(vault.symbol ? { symbol: vault.symbol } : {}),
    network: vault.network,
    raw: compactRaw({
      sharedIdle: vault.sharedIdle,
      totalDeployed: vault.totalDeployed,
      vaultLiveTvl: vault.vaultLiveTvl,
      frontReservedAssets: vault.frontReservedAssets,
      segregatedFees: vault.segregatedFees,
      orphanedSegregatedFees: vault.orphanedSegregatedFees
    }),
    ...(vault.paused === null || vault.paused === undefined ? {} : { paused: vault.paused }),
    updatedAtBlock: vault.updatedAtBlock,
    updatedAtTimestamp: vault.updatedAtTimestamp
  };
}

function formatStrategyVault(
  strategyVault: StrategyVaultEntity,
  vaults: Map<Lowercase<string>, VaultMetadata>
) {
  const vault = normalizeAddress(strategyVault.vault);
  return {
    id: strategyVault.id,
    vault,
    vaultMetadata: vaults.get(vault),
    strategyId: strategyVault.strategyId,
    network: strategyVault.network,
    exists: strategyVault.exists ?? false,
    strategist: strategyVault.strategist ? normalizeAddress(strategyVault.strategist) : null,
    paused: strategyVault.paused ?? false,
    settlementRoute: strategyVault.settlementRoute ?? null,
    raw: compactRaw({
      committedBacking: strategyVault.committedBacking,
      deployedAssets: strategyVault.deployedAssets,
      availableFor: strategyVault.availableFor,
      sharePriceRay: strategyVault.sharePriceRay
    }),
    updatedAtBlock: strategyVault.updatedAtBlock,
    updatedAtTimestamp: strategyVault.updatedAtTimestamp
  };
}

function compactRaw(input: Record<string, string | null | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) {
      if (!/^-?\d+$/.test(value)) {
        throw new Error(`Invalid BigInt string from Graph: ${value}`);
      }
      output[key] = value;
    }
  }
  return output;
}

function graphErrorMessage(error: unknown): string {
  if (error instanceof GraphRequestError && error.graphErrors) {
    return `${error.message}: ${JSON.stringify(error.graphErrors)}`;
  }
  return error instanceof Error ? error.message : "Unknown Graph error";
}
