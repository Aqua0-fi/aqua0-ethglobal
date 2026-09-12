---
name: aqua0
description: Use when a user wants to work with Aqua0 on Arc Testnet through the Aqua0 MCP server. That covers checking an LP's vault capital and whether one USDC deposit backs several strategies, creating USDC/ARS or USDC/BRL market-making strategies (the oracle-priced forex curve, or pegged fixed-price) on 1inch Aqua and SwapVM, quoting or executing swaps, reading the RedStone BRL and MXN prices or moving the hand-set ARS demo feed and re-quoting, and reading Aqua0 vaults, strategies and fees from The Graph. Trigger on Aqua0, AssetVault, shared backing, forex curve, FXSwap, ARGt, BRAt, or peso and real FX strategies on Arc.
---

# Aqua0 MCP

## What Aqua0 is

Aqua0 is shared liquidity for 1inch SwapVM. An LP deposits once into a per-asset `AssetVault` on Arc Testnet (chain `5042002`), and that one principal backs several SwapVM strategies at the same time. Each strategy is shipped into 1inch Aqua by an Aqua0 `AquaAdapter`. Commitments are non-subtractive: 2 USDC committed to a USDC/ARS and a USDC/BRL class shows 2 USDC of backing on both, and outflow is bounded when a swap settles. Every fill has one liquidity path: the vaults, just in time. On a USDC → BRL swap the adapter's `preTransferOut` hook sources the BRL from the BRL `AssetVault` (`settleVenueOut`), and `postTransferIn` sweeps the taker's USDC into the USDC `AssetVault` and credits the LPs who sold (`settleVenueCredit`). Aqua only records each strategy's virtual balances; no liquidity sits in Aqua or the adapter. Strategies differ only in their pricing program and the router that runs it, and all of them draw from the same vaults. **Pegged** strategies (`[FlatFeeAmountIn][PeggedSwap]` at a fixed price, on the stock `AquaSwapVMRouter`) are live on Arc. **Forex** strategies run the forex curve (Shell v1 / DFX) on `AquaForexSwapVMRouter`: the oracle price while the book stays near an even split, an inventory fee as it tips, a halt past a set imbalance, and a proportional fee on every swap. The forex router and its adapter are live on Arc, and `create_strategy` ships forex strategies by default. Forex USDC/BRL prices from **RedStone**: a BRL feed on Arc holding prices signed by 3 of RedStone's 5 primary-prod signers. `quote_swap` applies the latest signed price without sending anything, and `swap` pushes it on-chain first. USDC/ARS prices from a hand-set `ManualFxOracle`, because RedStone has no ARS feed. ARGt and BRAt are open-mint **testnet demo tokens** standing in for ARS and BRL stablecoins. They are not real money.

## Connect

**Public HTTP endpoint.** No install, no signer. It runs the earlier build: 12 tools, reads plus `prepare_*` only, with Graph data from Subgraph Studio.

```bash
claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp
```

**Local stdio.** This is the full 19-tool build, including `create_strategy`, `quote_swap`, `swap`, `get_shared_backing`, `get_fx_prices` and `set_fx_price`. Run `pnpm install && pnpm build` in the repo, then:

```bash
claude mcp add aqua0 \
  -e GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest \
  -e WRITE_RPC_URL=https://rpc.testnet.arc.network \
  -e WRITE_CHAIN_ID=5042002 \
  -e MCP_WRITE_MODE=prepare \
  -- node <repo>/apps/mcp/dist/index.js
```

Codex takes the same variables with `codex mcp add aqua0 --env KEY=value ... -- node <repo>/apps/mcp/dist/index.js`. `GRAPH_ENDPOINT` is required or the server will not start. The venue and feed addresses default to the Arc deployment. Override them only for a fork with `AQUA_ADAPTER_ADDRESS`, `AQUA_SWAPVM_ROUTER_ADDRESS`, `FXSWAP_ROUTER_ADDRESS`, `FXSWAP_AQUA_ADAPTER_ADDRESS`, `FX_ORACLE_ARS_USD` and `FX_ORACLE_BRL_USD`. To send transactions, the person running the server sets `MCP_WRITE_MODE=execute` and `WRITE_PRIVATE_KEY` in the server's environment. To sign with a Circle developer-controlled wallet instead, they set `SIGNER=circle`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, and either `CIRCLE_WALLET_ID` or `CIRCLE_WALLET_SET_ID` plus `CIRCLE_USER_REF`. With a user ref, the server signs with that user's Arc Testnet EOA and creates it on first use. With `PRIVY_APP_ID` (and `CIRCLE_WALLET_SET_ID`, no fixed wallet), the user signs in instead: `login` returns a localhost URL, and the Privy user id becomes the user ref. With `CIRCLE_OPERATOR_WALLET_ID`, a shared operator sends the strategy ships the user signs and tops up a new wallet with testnet USDC, so a new user needs no role. See Safety.

## Tool map

| Job | Call in this order | Source and notes |
| --- | --- | --- |
| Sign in and get a wallet | `login` → give the user the URL → `whoami` once they say they're done | Local server only. Report `signer.address` (their Circle wallet on Arc Testnet) and `funding` from the login result if shown. `logout` forgets the sign-in. |
| Check capital and backing | `health` → `get_balance {address}` → `get_shared_backing {address}` | `health` and `get_balance` read The Graph. `get_shared_backing` reads the chain and lists the principal counted once, each committed class, and its strategies (pegged and forex), all drawing on the same vaults. |
| Create an FX strategy | `deposit {token:"USDC", amount}` (if no principal) → `create_strategy {pair, opcode?, params?}` | Idempotent: finished steps come back as `skipped`. Read `opcodeNote` and `live` in the response. |
| Quote and swap | `quote_swap {pair, amount}` → confirm with the user → `swap {pair, amount, slippageBps?}` | `swap` re-quotes and enforces a minimum output on-chain. Report `pricing.oraclePrice` (or `fixedPrice`), `executionPrice` and `effectiveSpreadBps`. |
| Read live FX prices | `get_fx_prices {pair?}` | BRL: the latest signed RedStone price (signing time, the 3 signer values) and the value on-chain. ARS: the hand-set feed and its owner. With no pair it also lists RedStone MXNe, which no Aqua0 vault trades yet. |
| Move the ARS demo feed and re-quote | `get_fx_prices {"pair":"ARS"}` → confirm → `set_fx_price {"pair":"ARS", price or changePercent}` → `quote_swap {pair, amount}` | ARS only: the RedStone BRL feed is market data and `set_fx_price` refuses it. Only forex strategies reprice; pegged ones do not. Only the feed owner can send. |
| Read fees and strategies from The Graph | `get_strategies {address}`, `get_fees {address, periodSeconds?}`, `list_opportunities`, `protocol_snapshot`, `graph_query {query}` | Say that these came from The Graph. They return raw integer units as strings. |
| Prepare for an external wallet | `prepare_create_strategy`, `prepare_authorize_strategy`, `prepare_deposit`, `prepare_withdraw` | Calldata only. Deposit and withdraw take raw units. |
| Inspect configuration | `info {includeConfig:true}` | Shows the write mode, chain and `write.signer` (`local` or `circle` plus its address), with secrets redacted. |

## Natural language → tool calls

| User says | Call |
| --- | --- |
| "log me in" / "connect my wallet" | `login {}`, share the URL, then `whoami {}` |
| "which wallet am i using" | `whoami {}` |
| "whats in aqua0 on arc rn" | `health {}`, then `protocol_snapshot {}` |
| "how much usdc do i have in there? 0xAFF7Da673820fAA38289de8B03984A9cf20fb02c" | `get_balance {"address":"0xAFF7Da673820fAA38289de8B03984A9cf20fb02c"}` |
| "is my money backing both the peso and real pools??" | `get_shared_backing {}` (the signer), or pass `address` |
| "put 2 bucks in" | `deposit {"token":"USDC","amount":"2"}` |
| "deposit 2000000 raw usdc" | `deposit {"token":"USDC","amount":"2000000","unit":"raw"}` |
| "make me a peso strat that follows the oracle" | `create_strategy {"pair":"USDC/ARS","opcode":"forex"}` |
| "same usdc but reais pls" | `create_strategy {"pair":"usdc to brl"}` |
| "brl forex curve, 5bps, kill it if the feed moves 15%" | `create_strategy {"pair":"USDC/BRL","opcode":"forex","params":{"feeBps":5,"bandPercent":15}}` |
| "ars pool with a tight 10% flat band, give back half the fee on rebalancing trades" | `create_strategy {"pair":"USDC/ARS","opcode":"forex","params":{"beta":0.1,"lambda":0.5}}` |
| "cap the imbalance fee at 5%, halt at 40% off balance" | `create_strategy {"pair":"USDC/BRL","params":{"maxFee":0.05,"alpha":0.4}}` |
| "fixed rate brl pool at 5.40, 10 bps, half a usdc" | `create_strategy {"pair":"USDC/BRL","opcode":"pegged","params":{"price":5.4,"feeBps":10,"usdcAmount":"0.5"}}` |
| "dry run a usdc/ars strategy, don't send anything" | `create_strategy {"pair":"USDC/ARS","dryRun":true}` |
| "how many pesos for a dime of usdc" | `quote_swap {"pair":"USDC/ARS","amount":"0.1"}` |
| "swap 0.1 usdc → brl, max 1% slippage" | `swap {"pair":"USDC/BRL","amount":"0.1","slippageBps":100}` |
| "sell 5 reais for dollars" | `swap {"pair":"USDC/BRL","tokenIn":"BRL","amount":"5"}` |
| "quote the fixed-rate peso pool instead" | `quote_swap {"pair":"USDC/ARS","opcode":"pegged","amount":"0.1"}` |
| "are the oracles stale?" | `get_fx_prices {}` |
| "bump the ars feed 5% and requote" | `get_fx_prices {"pair":"ARS"}`, then `set_fx_price {"pair":"ARS","changePercent":5}`, then `quote_swap {"pair":"USDC/ARS","amount":"0.1"}` |
| "whats the real brl rate right now" | `get_fx_prices {"pair":"BRL"}`; report `latestSignedPrice.fxPerUsd` and `signedAt` |
| "set brl to 5.6" | Explain that BRL is RedStone market data and can't be set by hand; offer `set_fx_price {"pair":"ARS",...}` on the ARS demo feed instead |
| "what fees did 0x… make this week" | `get_fees {"address":"0x…","periodSeconds":604800}` |
| "any indexing errors? which vaults hold what" | `graph_query {"query":"{ _meta { hasIndexingErrors block { number } } vaults { symbol sharedIdle totalDeployed } }"}` |

## Safety

- **Prepare vs execute.** By default (`MCP_WRITE_MODE=prepare`) write tools send nothing and return ordered calldata and EIP-712 typed data. They send only when the server runs in execute mode and `dryRun` is not true. Before any execute-mode write, restate the pair, amounts and slippage, and get a clear yes. Use `dryRun: true` when the user is exploring.
- **Arc Testnet guard.** Execution is allowed only on Arc Testnet (`5042002`) or a local fork URL. Ethereum and Base mainnet are refused, and a reverted receipt is an error. Do not try to route around the guard.
- **Oracles.** USDC/BRL trusts RedStone: signed off-chain, verified by the on-chain adapter (3 of 5 signers, payload at most 3 minutes old), and pushed by whoever swaps. Say so when you report a BRL price.
- **Owner-only feed updates.** `set_fx_price` changes the ARS `ManualFxOracle` that only its owner can set. Name the trust assumption to the user: every forex strategy on that feed trades at whatever the feed says, bounded only by the strategy's price band and staleness window. Show the before and after price. A non-owner signer gets an error and nothing is sent.
- **Keys.** Never ask for a private key and never accept one pasted into chat. If one is pasted, tell the user to treat it as compromised. Signing keys belong only in a local server's `WRITE_PRIVATE_KEY`, and should be throwaway testnet keys. With `SIGNER=circle`, the server signs through a Circle developer-controlled wallet instead. Its `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` follow the same rule. The server checks every Circle EIP-712 signature against the wallet address. The public endpoint holds no key.
- **Honest status.** Forex and pegged strategies and swaps are live on Arc Testnet. The forex curve's inventory fee and halt band have only been shown on a fork. Say which venue you used. Do not call ARGt or BRAt real pesos or reais.

## Troubleshooting

- **`opcodeNote` says forex was not used.** The forex venue readiness check failed for this signer, usually because it lacks `OPERATOR_ROLE` on the forex adapter and no Circle operator that holds it sends the ship, so `create_strategy` used a pegged strategy. Tell the user the strategy is fixed-price. Passing `opcode:"forex"` insists on the forex curve and fails with the reason instead.
- **Old CryptoSwap params rejected.** `a`, `gamma`, `outFeeBps`, `feeGamma` and `flatFeeBps` belonged to the retired FXSwap curve and now return an error. Use `alpha`, `beta`, `delta`, `maxFee` (or `maxFeePercent`), `lambda`, and `feeBps` for the forex curve's fee. `maxFee` must be below 0.5 (so each quote has one solution), or the strategy is rejected.
- **Forex quote reverts with `ForexCurveUpperHalt` or `ForexCurveLowerHalt`.** The trade would push the book past the halt band (`alpha`, default 50% from an even split). Quote a smaller amount or trade the other way. A large but successful spread is the inventory fee past the flat band, not an error.
- **Forex quote or swap reverts as stale or out of band.** Run `get_fx_prices`: check `ageSeconds`, whether the feed is fresh, and the band. The ARS feed is set by hand, has a default max age of 7 days, and its owner refreshes it with `set_fx_price`. RedStone BRL strategies default to 1 hour; `swap` pushes a fresh signed price before swapping. If `quote_swap` says RedStone's gateways could not be reached, retry. A strategy created with a tight `bandPercent` stops trading once the feed leaves the band.
- **`NotStrategist` on ship, or "has contract code (e.g. an EIP-7702 delegation)".** The signer's address carries code, so the adapter checks the ship signature with ERC-1271 and rejects a plain EIP-712 signature. Use a strategist key whose address has no code. A missing `OPERATOR_ROLE` on the adapter is reported separately. The adapter admin has to grant it.
- **Raw vs human units.** `deposit`, `create_strategy`, `quote_swap` and `swap` take human units by default (`"0.1"` = 0.1 USDC); add `unit:"raw"` or `amountUnit:"raw"` for base units. Graph tools and `prepare_deposit`/`prepare_withdraw` use raw integers: USDC has 6 decimals, ARGt and BRAt have 18. Convert before you speak, and never invent decimals.
- **Strategy lookup by params vs `strategyId`.** `quote_swap` and `swap` rebuild the strategy id from `pair` plus `params`. When the params do not pin the program (none given, or only `bandPercent`), they take the newest live strategy for the pair from Aqua `Shipped` events. For a custom strategy, pass the same `params` used at creation, or pass `strategyId` from `create_strategy`. If a live `strategyId` is not found in the events, pass the pair plus the original params.
- **"No live strategy" on forex.** No live forex strategy matches the pair and params. Create one with `create_strategy`, or pass the `strategyId` it returned.
- **Graph errors or missing Aqua entities.** Graph tools surface errors and never fall back to RPC. The live Studio version (`ethglobal-arc-d179c59`) indexes both Aqua venues, pegged and forex: `AquaStrategy`, `AquaOrder` and `AquaFill` (swap fills), plus the AquaAdapter lifecycle events `aquaStrategyShippedEvents`, `aquaStrategyDockedEvents`, `aquaStrategyReshippedEvents` and `aquaStrategyReconciledEvents`. For backing use `get_shared_backing`; for pricing use `quote_swap`.

More: [README](../../README.md), [demo runbook](../../docs/DEMO.md), [MCP source](../../apps/mcp/src/index.ts).
