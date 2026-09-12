export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.network",
  graphNetwork: "arc-testnet"
} as const;

export const USDC_ERC20_INTERFACE_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;

/**
 * Public Arc Testnet deployment addresses (mirrors `deployments/arc-testnet.json`; a unit test
 * keeps the two in sync). Used only as defaults when `WRITE_CHAIN_ID` is Arc Testnet; every
 * address can be overridden with its env var.
 */
export const ARC_TESTNET_DEPLOYMENT = {
  chainId: 5042002,
  contracts: {
    vaultRegistry: "0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf",
    aqua: "0x490d2eceD9aCF99e1db6090f820775bFa70020D4",
    /** Pegged venue: stock swap-vm v1.0.2 AquaSwapVMRouter and the AquaAdapter bound to it. */
    aquaSwapVMRouter: "0xb20bc70b485eC1352C190d26fCaB1959d219F763",
    aquaAdapter: "0xbF72D34b804636496c3308796908152b82624Ca5"
  },
  /**
   * Forex venue (optional keys `contracts.forexRouter`, `contracts.forexAquaAdapter`,
   * `contracts.fxOracles.*` in the deployment file): AquaForexSwapVMRouter (ForexCurve, opcode 34) on the same
   * Aqua, a second AquaAdapter bound to it (an adapter binds one router immutably), and owner-set ManualFxOracle
   * feeds quoting FX units per 1 USD. It supersedes the FXSwap venue (`contracts.fxswapRouter`), which stays in
   * the deployment file as a record. `null` means not deployed; env vars override each address.
   *
   * `redstone` (`contracts.redstone` in the deployment file): RedStone `redstone-primary-prod` pull feeds, one
   * AquaRedStoneMultiFeedAdapter and one Chainlink-style AquaRedStonePriceFeed per symbol. `BRL` quotes USD per
   * 1 BRL, `MXNe` quotes MXN per 1 USD; both have 8 decimals and are refreshed by pushing a signed payload.
   */
  fxVenue: {
    forexRouter: "0x475d0E487779743Fb52c8E7729A1718934D4187e",
    forexAquaAdapter: "0xc9cD056FCF2EF46116259fb094BD897c7E7C0EfB",
    fxOracles: {
      arsUsd: "0xc05A3Fb016f973C82b0232EF50336d4C0466E70C",
      brlUsd: "0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71",
      owner: "0xAFF7Da673820fAA38289de8B03984A9cf20fb02c"
    },
    redstone: {
      multiFeedAdapter: "0x1a3fff65628048e4188C40dd5cf55A27Fb513ea0",
      feeds: {
        BRL: "0xac4D10eE7FF790c2E505fBBD6A72d15D7Cbc1796",
        MXNe: "0xc7cDEfF4e7534dAdeEBFc701c80d8C65b91807ad"
      }
    }
  } as {
    forexRouter: string | null;
    forexAquaAdapter: string | null;
    fxOracles: { arsUsd: string | null; brlUsd: string | null; owner: string | null };
    redstone: { multiFeedAdapter: string | null; feeds: { BRL: string | null; MXNe: string | null } };
  },
  /** First block to scan for Aqua `Shipped` events (Aqua deployment block). */
  startBlocks: {
    aqua: 61679218
  },
  tokens: {
    USDC: {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
      vault: "0x99c2ab427b29dB1Cc14D228d970596015d1C4429",
      fiat: "USD",
      openMint: false
    },
    ARGt: {
      symbol: "ARGt",
      address: "0xd8dE250970842A581f89E885dA0F5165037714Ef",
      decimals: 18,
      vault: "0x8a3d6188C58d7877499592E179DfE3bd80c4F460",
      fiat: "ARS",
      openMint: true
    },
    BRAt: {
      symbol: "BRAt",
      address: "0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E",
      decimals: 18,
      vault: "0xEcB132648B781ec5742b582c526243Eeef900785",
      fiat: "BRL",
      openMint: true
    }
  }
} as const;

export const AQUA0_ARCHITECTURE = {
  name: "Aqua0 shared-pool AssetVault fleet",
  contractSource: "pre-existing Aqua0 contracts and ABIs",
  hackathonScope: "The Graph indexer, MCP server, CLI, and terminal workflow"
} as const;
