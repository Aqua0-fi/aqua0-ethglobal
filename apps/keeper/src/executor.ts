/**
 * Executes allowed decisions with the keeper's Circle wallet through the existing Aqua0 service functions. Dry-run
 * never sends. A rebalance re-reads the book right before sending (mined state, unpaid RPC) and aborts if the tilt is
 * gone or reversed; executeFxSwap then quotes again and enforces a minimum output on-chain.
 */
import { erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from "viem";

import {
  ARC_TESTNET_DEPLOYMENT,
  assertReceiptSuccess,
  createCircleSigner,
  executeFxSwap,
  mintableErc20Abi,
  readStrategySignal,
  txRef,
  USDC_ERC20_INTERFACE_ADDRESS,
  type KeeperStrategyRef,
  type KeeperTxRef,
  type ReadClient,
  type WriteConfig,
  type WriteSigner
} from "@aqua0/shared";

import { depositToGateway } from "./nanopay.js";
import type { Decision, Limits } from "./policy.js";

export type ActionResult = {
  status: "done" | "skipped" | "dry-run" | "failed";
  note: string;
  txs: KeeperTxRef[];
  spreadBeforeBps?: number | null;
  spreadAfterBps?: number | null;
  detail?: Record<string, unknown>;
};

export type ExecContext = {
  keeperWrite: WriteConfig;
  signer: WriteSigner;
  client: ReadClient;
  limits: Limits;
  strategies: readonly KeeperStrategyRef[];
  slippageBps: number;
  dryRun: boolean;
  operatorWalletId?: string | undefined;
};

export async function readUsdcBalance(client: ReadClient, address: string): Promise<number> {
  const raw = await client.readContract({
    address: getAddress(USDC_ERC20_INTERFACE_ADDRESS),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)]
  });
  return Number(formatUnits(raw, 6));
}

export async function executeRebalance(
  ctx: ExecContext,
  decision: Extract<Decision, { action: "rebalance" }>
): Promise<ActionResult> {
  const ref = ctx.strategies.find((strategy) => strategy.strategyId === decision.strategyId);
  if (!ref) {
    return { status: "skipped", note: `unknown strategy ${decision.strategyId}`, txs: [] };
  }
  const before = await readStrategySignal(ctx.keeperWrite, ref);
  const book = before.book;
  const detail = { strategyId: ref.strategyId, direction: decision.direction };
  if (!before.live || !book || book.spreadBps === null || !book.rebalance) {
    return { status: "skipped", note: "pre-trade re-read: the book is not readable or already even", txs: [], detail };
  }
  if (book.spreadBps <= ctx.limits.tiltThresholdBps) {
    return {
      status: "skipped",
      note: `pre-trade re-read: spread is now ${book.spreadBps} bps, within ${ctx.limits.tiltThresholdBps}; nothing to do`,
      txs: [],
      spreadBeforeBps: book.spreadBps,
      detail
    };
  }
  if (book.rebalance.direction !== decision.direction) {
    return { status: "skipped", note: `pre-trade re-read: the book now needs ${book.rebalance.direction}`, txs: [], spreadBeforeBps: book.spreadBps, detail };
  }
  if (before.oracle?.status !== "ok" || !before.oracle.fxPerUsdc) {
    return { status: "skipped", note: `pre-trade re-read: oracle ${before.oracle?.status ?? "unreadable"}`, txs: [], spreadBeforeBps: book.spreadBps, detail };
  }
  const sizeUsdc = Math.min(decision.sizeUsdc, book.rebalance.sizeUsdc, ctx.limits.maxTradeUsdc);
  const fxToken = ARC_TESTNET_DEPLOYMENT.tokens[ref.fxSymbol];
  const fxAmount = parseUnits((sizeUsdc * before.oracle.fxPerUsdc).toFixed(6), fxToken.decimals);
  const plan =
    decision.direction === "fx-in"
      ? `swap ${formatUnits(fxAmount, fxToken.decimals)} ${fxToken.symbol} -> USDC (worth ${sizeUsdc.toFixed(6)} USDC)`
      : `swap ${sizeUsdc.toFixed(6)} USDC -> ${fxToken.symbol}`;
  if (ctx.dryRun) {
    return { status: "dry-run", note: `dry run: would ${plan}`, txs: [], spreadBeforeBps: book.spreadBps, detail: { ...detail, sizeUsdc } };
  }
  const txs: KeeperTxRef[] = [];
  let result: Awaited<ReturnType<typeof executeFxSwap>>;
  if (decision.direction === "fx-in") {
    const balance = await ctx.client.readContract({
      address: getAddress(fxToken.address),
      abi: mintableErc20Abi,
      functionName: "balanceOf",
      args: [getAddress(ctx.signer.address)]
    });
    if (balance < fxAmount) {
      const mintHash = await ctx.signer.writeContract({
        address: getAddress(fxToken.address),
        abi: mintableErc20Abi,
        functionName: "mint",
        args: [getAddress(ctx.signer.address), fxAmount - balance]
      });
      assertReceiptSuccess(await ctx.client.waitForTransactionReceipt({ hash: mintHash }), `mint ${fxToken.symbol}`, mintHash);
      txs.push(txRef(`mint ${fxToken.symbol} (open-mint demo token)`, mintHash));
    }
    result = await executeFxSwap(ctx.keeperWrite, {
      strategyId: ref.strategyId,
      tokenIn: ref.fxSymbol,
      amount: formatUnits(fxAmount, fxToken.decimals),
      slippageBps: ctx.slippageBps
    });
  } else {
    result = await executeFxSwap(ctx.keeperWrite, {
      strategyId: ref.strategyId,
      amount: sizeUsdc.toFixed(6),
      slippageBps: ctx.slippageBps
    });
  }
  for (const step of result.steps) {
    if (step.hash) {
      txs.push(txRef(step.stage, step.hash));
    }
  }
  const after = await readStrategySignal(ctx.keeperWrite, ref).catch(() => undefined);
  return {
    status: "done",
    note: `${plan}: received ${result.received.formatted}, min out ${result.minAmountOut.formatted}`,
    txs,
    spreadBeforeBps: book.spreadBps,
    spreadAfterBps: after?.book?.spreadBps ?? null,
    detail: { ...detail, sizeUsdc, amountIn: result.amountIn.formatted, received: result.received.formatted, minAmountOut: result.minAmountOut.formatted }
  };
}

/** Operator -> keeper USDC with Circle App Kit `send`; falls back to a Circle contract-execution transfer. */
export async function executeTopUpUsdc(
  ctx: ExecContext,
  amountUsdc: number,
  credentials: { apiKey: string; entitySecret: string }
): Promise<ActionResult> {
  const detail = { amountUsdc };
  if (!ctx.operatorWalletId) {
    return { status: "skipped", note: "no CIRCLE_OPERATOR_WALLET_ID to top up from", txs: [], detail };
  }
  if (ctx.dryRun) {
    return { status: "dry-run", note: `dry run: would send ${amountUsdc} USDC from the operator with App Kit`, txs: [], detail };
  }
  const operator = await createCircleSigner({ ...ctx.keeperWrite, circleWalletId: ctx.operatorWalletId });
  const sent = await appKitSendUsdc(credentials, operator.address, ctx.signer.address, amountUsdc).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error)
  }));
  if ("txHash" in sent) {
    return { status: "done", note: `App Kit send ${amountUsdc} USDC operator -> keeper`, txs: [txRef("App Kit send USDC (operator -> keeper)", sent.txHash)], detail };
  }
  const hash = await operator.writeContract({
    address: getAddress(USDC_ERC20_INTERFACE_ADDRESS),
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(ctx.signer.address), parseUnits(amountUsdc.toFixed(6), 6)]
  });
  assertReceiptSuccess(await ctx.client.waitForTransactionReceipt({ hash }), "USDC top-up", hash);
  return {
    status: "done",
    note: `App Kit send failed (${sent.error.slice(0, 120)}); sent ${amountUsdc} USDC with a Circle contract-execution transfer instead`,
    txs: [txRef("USDC transfer (operator -> keeper, Circle contract execution)", hash)],
    detail
  };
}

export async function appKitSendUsdc(
  credentials: { apiKey: string; entitySecret: string },
  from: string,
  to: string,
  amountUsdc: number
): Promise<{ txHash: Hex; explorerUrl?: string }> {
  const [{ AppKit }, { createCircleWalletsAdapter }] = await Promise.all([
    import("@circle-fin/app-kit"),
    import("@circle-fin/adapter-circle-wallets")
  ]);
  const adapter = createCircleWalletsAdapter({ apiKey: credentials.apiKey, entitySecret: credentials.entitySecret });
  const kit = new AppKit();
  const step = await kit.send({
    from: { adapter, chain: "Arc_Testnet", address: getAddress(from) } as never,
    to: getAddress(to),
    amount: amountUsdc.toFixed(6),
    token: "USDC"
  });
  if (step.state !== "success" || !step.txHash) {
    throw new Error(`App Kit send ended in state ${step.state}`);
  }
  return { txHash: step.txHash as Hex, ...(step.explorerUrl ? { explorerUrl: step.explorerUrl } : {}) };
}

export async function executeGatewayTopUp(ctx: ExecContext, amountUsdc: number): Promise<ActionResult> {
  const detail = { amountUsdc };
  if (ctx.dryRun) {
    return { status: "dry-run", note: `dry run: would deposit ${amountUsdc} USDC into Circle Gateway`, txs: [], detail };
  }
  const result = await depositToGateway(ctx.signer, ctx.client, parseUnits(amountUsdc.toFixed(6), 6));
  return {
    status: "done",
    note: `deposited ${result.amountUsdc} USDC into Circle Gateway`,
    txs: [
      ...(result.approvalTxHash ? [txRef("approve USDC for GatewayWallet", result.approvalTxHash)] : []),
      txRef("GatewayWallet.deposit", result.depositTxHash)
    ],
    detail
  };
}
