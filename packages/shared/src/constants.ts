export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.network",
  graphNetwork: "arc-testnet"
} as const;

export const USDC_ERC20_INTERFACE_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;

export const AQUA0_ARCHITECTURE = {
  name: "Shape-C shared-pool AssetVault fleet",
  contractSource: "pre-existing Aqua0 contracts and ABIs",
  hackathonScope: "The Graph indexer, MCP server, CLI, and terminal workflow"
} as const;
