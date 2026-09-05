import {
  AQUA0_ARCHITECTURE,
  ARC_TESTNET,
  USDC_ERC20_INTERFACE_ADDRESS
} from "./constants.js";

export type Aqua0ServiceConfig = {
  graphEndpoint: string;
  aqua0ApiUrl?: string;
  arcRpcUrl?: string;
};

export type Aqua0Health = {
  ok: boolean;
  graphConfigured: boolean;
  network: typeof ARC_TESTNET.graphNetwork;
  chainId: typeof ARC_TESTNET.chainId;
};

export type Aqua0Info = {
  architecture: typeof AQUA0_ARCHITECTURE;
  chain: typeof ARC_TESTNET;
  usdcErc20Interface: typeof USDC_ERC20_INTERFACE_ADDRESS;
  endpoints: {
    graphEndpoint: string;
    aqua0ApiUrl?: string;
    arcRpcUrl: string;
  };
};

export class Aqua0Service {
  readonly #config: Aqua0ServiceConfig;

  constructor(config: Aqua0ServiceConfig) {
    if (config.graphEndpoint.trim().length === 0) {
      throw new Error("GRAPH_ENDPOINT is required");
    }

    this.#config = config;
  }

  health(): Aqua0Health {
    return {
      ok: true,
      graphConfigured: this.#config.graphEndpoint.length > 0,
      network: ARC_TESTNET.graphNetwork,
      chainId: ARC_TESTNET.chainId
    };
  }

  info(): Aqua0Info {
    return {
      architecture: AQUA0_ARCHITECTURE,
      chain: ARC_TESTNET,
      usdcErc20Interface: USDC_ERC20_INTERFACE_ADDRESS,
      endpoints: {
        graphEndpoint: this.#config.graphEndpoint,
        ...(this.#config.aqua0ApiUrl ? { aqua0ApiUrl: this.#config.aqua0ApiUrl } : {}),
        arcRpcUrl: this.#config.arcRpcUrl ?? ARC_TESTNET.rpcUrl
      }
    };
  }
}

export function createAqua0Service(config: Aqua0ServiceConfig): Aqua0Service {
  return new Aqua0Service(config);
}
