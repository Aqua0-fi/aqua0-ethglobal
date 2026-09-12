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
    aquaSwapVMRouter: "0xb20bc70b485eC1352C190d26fCaB1959d219F763",
    aquaAdapter: "0xbF72D34b804636496c3308796908152b82624Ca5"
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
