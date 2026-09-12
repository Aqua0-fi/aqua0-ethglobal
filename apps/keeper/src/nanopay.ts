/**
 * Circle Nanopayments (Gateway batched x402) for the keeper: the buyer side.
 *
 * The keeper pays for signals with EIP-3009 authorizations signed by its Circle developer-controlled wallet (an EOA),
 * wrapped as an x402 batch-scheme signer. Circle Gateway verifies each authorization against the buyer's Gateway
 * balance and settles them in batches, so a paid request costs no gas. The Gateway balance is funded with an ordinary
 * approve + GatewayWallet.deposit sent through Circle's contract-execution API.
 */
import { registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { erc20Abi, formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";

import { assertReceiptSuccess, USDC_ERC20_INTERFACE_ADDRESS, type ReadClient, type WriteSigner } from "@aqua0/shared";

/** Circle Gateway on Arc Testnet (from @circle-fin/x402-batching CHAIN_CONFIGS.arcTestnet). */
export const ARC_GATEWAY = {
  network: "eip155:5042002",
  domain: 26,
  wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  balancesApi: "https://gateway-api-testnet.circle.com/v1/balances"
} as const;

const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
] as const;

export type BatchSigner = {
  address: Address;
  signTypedData: (params: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
};

/** An x402 batch-scheme signer backed by an Aqua0 write signer (a Circle wallet, or a local key). */
export function batchSignerFor(signer: Pick<WriteSigner, "address" | "signTypedData">): BatchSigner {
  return {
    address: getAddress(signer.address),
    signTypedData: (params) =>
      signer.signTypedData({
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message
      })
  };
}

export type NanopaymentReceipt = {
  route: string;
  /** USDC atomic units (6 decimals). */
  amount: string;
  amountUsdc: string;
  payer: string;
  network: string;
  /** Gateway settlement reference returned by the seller (a batched transfer id, not an on-chain tx). */
  settlement: string | null;
  at: string;
  ms: number;
};

export type NanopayBuyer = {
  address: Address;
  /** GET a paid JSON resource: 402 -> sign an authorization -> retry with the payment header. */
  getJson<T>(url: string): Promise<{ data: T; receipt: NanopaymentReceipt }>;
};

export function createNanopayBuyer(
  signer: BatchSigner,
  options: { fetch?: typeof fetch; maxAtomicPerPayment?: bigint } = {}
): NanopayBuyer {
  const fetchImpl = options.fetch ?? fetch;
  const maxAtomic = options.maxAtomicPerPayment ?? 10_000n; // 0.01 USDC per request, a hard ceiling
  const client = new x402Client();
  // Arc Testnet USDC is not one of x402's default assets: allow exactly it, capped per payment.
  client.setSpendControls({
    maxAmountPerPayment: false,
    allowedAssets: [
      { network: ARC_GATEWAY.network, asset: getAddress(USDC_ERC20_INTERFACE_ADDRESS), maxAmountPerPayment: maxAtomic.toString() }
    ]
  });
  registerBatchScheme(client as never, { signer, networks: [ARC_GATEWAY.network] });
  const http = new x402HTTPClient(client);

  return {
    address: signer.address,
    async getJson<T>(url: string) {
      const started = Date.now();
      const first = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (first.status !== 402) {
        if (!first.ok) {
          throw new Error(`GET ${url} failed with HTTP ${first.status}`);
        }
        throw new Error(`GET ${url} did not ask for payment (HTTP ${first.status}); refusing to treat it as a paid signal`);
      }
      const body = await first.json().catch(() => undefined);
      const paymentRequired = http.getPaymentRequiredResponse((name) => first.headers.get(name), body);
      const batched = paymentRequired.accepts.find(
        (option) =>
          option.network === ARC_GATEWAY.network &&
          (option.extra as { name?: unknown } | undefined)?.name === "GatewayWalletBatched"
      );
      if (!batched) {
        throw new Error(`GET ${url}: the seller offers no Circle Gateway batched payment on Arc Testnet`);
      }
      if (BigInt(batched.amount) > maxAtomic) {
        throw new Error(`GET ${url} asks ${formatUnits(BigInt(batched.amount), 6)} USDC, above the per-request ceiling`);
      }
      const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [batched] });
      const paid = await fetchImpl(url, {
        headers: { accept: "application/json", ...http.encodePaymentSignatureHeader(payload) }
      });
      if (!paid.ok) {
        const detail = await paid.text().catch(() => "");
        throw new Error(`GET ${url} payment was not accepted (HTTP ${paid.status}) ${detail.slice(0, 200)}`);
      }
      let settlement: { transaction?: string; payer?: string; network?: string } | undefined;
      try {
        settlement = http.getPaymentSettleResponse((name) => paid.headers.get(name));
      } catch {
        settlement = undefined;
      }
      const data = (await paid.json()) as T;
      return {
        data,
        receipt: {
          route: new URL(url).pathname,
          amount: batched.amount,
          amountUsdc: formatUnits(BigInt(batched.amount), 6),
          payer: settlement?.payer ?? signer.address,
          network: settlement?.network ?? batched.network,
          settlement: settlement?.transaction || null,
          at: new Date().toISOString(),
          ms: Date.now() - started
        }
      };
    }
  };
}

export type GatewayBalance = { available: bigint; withdrawing: bigint; formattedAvailable: string };

/** The depositor's Gateway USDC balance on Arc Testnet (Circle Gateway API, no key needed). */
export async function readGatewayBalance(depositor: string, fetchImpl: typeof fetch = fetch): Promise<GatewayBalance> {
  const response = await fetchImpl(ARC_GATEWAY.balancesApi, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor: getAddress(depositor), domain: ARC_GATEWAY.domain }] })
  });
  const data = (await response.json().catch(() => ({}))) as {
    message?: string;
    balances?: Array<{ balance?: string; withdrawing?: string }>;
  };
  if (!response.ok) {
    throw new Error(`Gateway balance read failed: HTTP ${response.status} ${data.message ?? ""}`.trim());
  }
  const row = data.balances?.[0];
  const available = parseUnits(row?.balance ?? "0", 6);
  const withdrawing = parseUnits(row?.withdrawing ?? "0", 6);
  return { available, withdrawing, formattedAvailable: formatUnits(available, 6) };
}

/** approve (when needed) + GatewayWallet.deposit from the signer, each waited to a successful receipt. */
export async function depositToGateway(
  signer: WriteSigner,
  client: ReadClient,
  amount: bigint
): Promise<{ approvalTxHash?: Hex; depositTxHash: Hex; amountUsdc: string }> {
  const usdc = getAddress(USDC_ERC20_INTERFACE_ADDRESS);
  const owner = getAddress(signer.address);
  const allowance = await client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, getAddress(ARC_GATEWAY.wallet)]
  });
  let approvalTxHash: Hex | undefined;
  if (allowance < amount) {
    approvalTxHash = await signer.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [getAddress(ARC_GATEWAY.wallet), amount]
    });
    assertReceiptSuccess(await client.waitForTransactionReceipt({ hash: approvalTxHash }), "approve Gateway", approvalTxHash);
  }
  const depositTxHash = await signer.writeContract({
    address: getAddress(ARC_GATEWAY.wallet),
    abi: gatewayWalletAbi,
    functionName: "deposit",
    args: [usdc, amount]
  });
  assertReceiptSuccess(await client.waitForTransactionReceipt({ hash: depositTxHash }), "Gateway deposit", depositTxHash);
  return { ...(approvalTxHash ? { approvalTxHash } : {}), depositTxHash, amountUsdc: formatUnits(amount, 6) };
}
