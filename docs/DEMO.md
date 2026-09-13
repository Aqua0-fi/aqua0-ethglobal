# ETHGlobal demo runbook

The demo is a conversation in an agentic terminal (Claude Code, Codex or any MCP client) and needs no web UI. It shows only the new `ForexCurve` SwapVM opcode; the pegged venue is also live but stays out of the video (see the [appendix](#appendix-pegged-venue-not-in-the-demo)). This runbook keeps live and fork-only work apart, so the demo never shows fake state. Agents can load [`skills/aqua0/SKILL.md`](../skills/aqua0/SKILL.md) for the tool map and safety rules.

| Part | Status |
| --- | --- |
| RedStone BRL and MXNe price feeds on Arc, read with `get_fx_prices` | **Live** |
| Forex flow on Arc Testnet: two forex strategies by default on one USDC, one swap each with a RedStone price push, shared-backing read | **Live** |
| Forex curve regimes past the flat band: inventory fee fills, halt band, `set_fx_price` → `quote_swap` on ARS | On an Arc fork |
| Graph reads from Subgraph Studio, including Aqua strategies and fills | **Live** |
| Hosted MCP endpoint (25 tools, prepare-only) and dashboard | **Live** |
| Autonomous keeper: swap wake, signals bought with Nanopayments, model decision, rebalance | **Live** (keeper runs locally) |

## Setup

### Local MCP (25 tools, 26 in execute mode)

```bash
claude mcp add aqua0 -- npx -y @aqua0/mcp
```

Any MCP client:

```json
{ "mcpServers": { "aqua0": { "command": "npx", "args": ["-y", "@aqua0/mcp"] } } }
```

It starts in prepare mode on Arc Testnet with the public Studio subgraph and needs no variables. From a clone, run `pnpm install && pnpm build` and use `node <repo>/apps/mcp/dist/index.js` instead.

The pegged venue, forex venue and FX feed addresses default to the Arc deployment. Override `FXSWAP_ROUTER_ADDRESS` and `FXSWAP_AQUA_ADAPTER_ADDRESS` (the forex router and adapter; the names are kept) and `FX_ORACLE_ARS_USD` only for a fork. Leave `FX_ORACLE_BRL_USD` unset so BRL prices from RedStone; setting it replaces RedStone with a hand-set BRL-per-USD feed.

**To transact live**, the presenter restarts the server with `MCP_WRITE_MODE=execute` and a throwaway `WRITE_PRIVATE_KEY` in the server's environment, never in the chat. The signer must:
- be an address without contract code (an EIP-7702-delegated address is rejected through ERC-1271);
- hold `OPERATOR_ROLE` on the AquaAdapter it ships through;
- own the ARS/USD feed, for `set_fx_price` to send.

### Hosted endpoint (prepare-only)

Install the Claude Code plugin (`/plugin marketplace add Aqua0-fi/aqua0-ethglobal`, then `/plugin install aqua0@aqua0`), or add the endpoint by hand:

```bash
claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp
```

- MCP health: `https://ethglobal-mcp.18-207-103-187.nip.io/health`
- Judge dashboard: `https://ethglobal-demo.18-207-103-187.nip.io/`

It serves the same 25 tools in prepare mode with no signer, so write tools return calldata. Sign-in and `keeper_status` belong on a local server.

## Part 1: forex curve, live on Arc Testnet

`create_strategy` ships forex strategies by default. The forex venue is **Live** on Arc:
- `AquaForexSwapVMRouter` `0x475d0E487779743Fb52c8E7729A1718934D4187e` (ForexCurve, opcode 34), verified on Arcscan;
- forex AquaAdapter `0xc9cD056FCF2EF46116259fb094BD897c7E7C0EfB`, verified on Arcscan, allowlisted with `VENUE_SETTLER_ROLE` on the three vaults (see [`ARC_DEPLOYMENT.md`](ARC_DEPLOYMENT.md#wiring-for-the-forex-adapter-done)), and `OPERATOR_ROLE` granted to the shared Circle operator;
- ARS/USD `ManualFxOracle` `0xc05A3Fb016f973C82b0232EF50336d4C0466E70C` at 1400, owned by the demo wallet `0xAFF7…b02c`;
- RedStone BRL feed `0xac4D10eE7FF790c2E505fBBD6A72d15D7Cbc1796` (USD per 1 BRL), **Live**, updated only from signed RedStone prices.

This is the flow the demo Circle wallet `0xb0c0687eb013a5ffde4d23a89398a11bc424d952` ran on 2026-09-12 through the `aqua0` CLI with `SIGNER=circle` in execute mode; the shared Circle operator sent the strategy ships the wallet signed. Hashes are in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json) under `forexLiveRun`. Steps 7 and 8 show curve regimes the live run did not reach, and `set_fx_price` needs the feed owner, so run those two on the fork and say so.

| # | Say | Tool call |
| --- | --- | --- |
| 1 | "What's the real BRL rate right now?" | `get_fx_prices {"pair":"BRL"}` |
| 2 | "Create a peso strategy that tracks the oracle." | `create_strategy {"pair":"USDC/ARS"}` |
| 3 | "Same USDC with reais, at the real rate." | `create_strategy {"pair":"usdc to brl"}` |
| 4 | "How many reais for 0.1 USDC right now?" | `quote_swap {"pair":"USDC/BRL","amount":"0.1"}` |
| 5 | "Swap it." | `swap {"pair":"USDC/BRL","amount":"0.1"}` |
| 6 | "Swap 0.1 USDC for pesos. Show the oracle price and spread." | `quote_swap` then `swap {"pair":"USDC/ARS","amount":"0.1"}` |
| 7 | On the fork: "And for 0.3 USDC? And 0.8?" | `quote_swap {"pair":"USDC/ARS","amount":"0.3"}`, then `quote_swap {"pair":"USDC/ARS","amount":"0.8"}` |
| 8 | On the fork: "Push the ARS/USD price up 5% and quote again." | `set_fx_price {"pair":"ARS","changePercent":5}`, then `quote_swap {"pair":"USDC/ARS","amount":"0.1"}` |
| 9 | "Is my USDC backing both FX strategies?" | `get_shared_backing {}` |

At steps 2 and 3, point out that no opcode was passed: the forex curve is the default.

At step 9, the answer lists the two forex classes, 6 and 7, on the same USDC. The demo wallet's earlier pegged class 4 was retired on 2026-09-13 (`peggedClass4Retirement` in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json)).

At steps 3 to 5, say where the BRL price comes from. `create_strategy` sizes the BRL leg from the live RedStone price. The feed quotes USD per BRL, which is already the curve's USDC-per-BRL price, so the invert-price flag stays off. `quote_swap` applies the latest signed payload as an `eth_call` state override and sends nothing. `swap` first pushes that payload on-chain (about 130k gas), because there is no keeper. BRL is never set by hand.

At steps 6 and 7, explain the curve. Each strategy ships 1 USDC plus its value in FX, so the book starts at an even split. While each balance stays within 15% of its ideal (half the book's value), the price is the oracle less the 30 bps fee, which is why both live swaps cost about 30 bps. Past that flat band an inventory fee grows with the imbalance, capped at 25%, and 30% of it goes back to trades that rebalance the book. A trade that would leave a balance more than 50% from its ideal reverts: that is the halt band, and on the fork the 0.8 USDC quote hits it.

At step 8, name the trust assumption: the ARS feed is an owner-set demo oracle, because RedStone has no ARS feed. Forex strategies trade at whatever their feed says within their price band and staleness window.

Live results (`forexLiveRun`):
- `create_strategy` picked `opcode:"forex"` by default, with no fallback, and reused the existing classes: USDC/ARS class 6, strategy `0xc39dd71d…8597` ([ship tx](https://testnet.arcscan.app/tx/0xc74849a497ff73207e70872d3d83ed9d5cbc1babaa8f161ee716f444a9b7071e)); USDC/BRL class 7, strategy `0x87e021d4…2aa1` ([ship tx](https://testnet.arcscan.app/tx/0xb1d40beb277fda1516f39e59eacfd535c9199c0670d78d8181420289f88406b4)). The shared Circle operator sent both ships;
- USDC/ARS: 0.1 USDC → 139.58 ARGt at oracle 1400, execution 1395.8, spread 29.99 bps ([tx](https://testnet.arcscan.app/tx/0x54f61cb5ddbeea9ea6cdeef75346aba69fe08c9f59f1d2f0eea4dd89e3ef7554));
- USDC/BRL: `swap` pushed a signed RedStone price ([tx](https://testnet.arcscan.app/tx/0x46dbaaa5685b7365c30c0b815a32e0cb3f5efd856283993c6f11698d74d28bed)), then 0.1 USDC → 0.513598 BRAt at oracle 5.15143, execution 5.135976, spread 29.99 bps ([tx](https://testnet.arcscan.app/tx/0xe28f401465a86dd8557ddd8de548366b0ad5e1fe20db74f71e56cd4a6bcc172a));
- `get_shared_backing`: 1 USDC principal committed to three classes at once, class 4 (pegged USDC/BRL), class 6 and class 7. Class 4 has since been retired, so a new run lists classes 6 and 7.

Fork results ([`scripts/test-arc-fork-forex.sh`](../scripts/test-arc-fork-forex.sh)), the repeatable proof of the curve regimes:
- one 2 USDC deposit backs forex USDC/ARS and USDC/BRL;
- inside the flat band a swap costs 30 bps;
- a trade past the flat band paid 666 bps, the inventory fee;
- a trade past the halt band reverts with `ForexCurveUpperHalt()`;
- the feed owner moves ARS/USD +5% and the quote moves by exactly 5%;
- USDC/BRL: `swap` pushes a signed RedStone BRL price, then fills at its quote;
- quotes agree with the reference `scripts/fxforex_math.py` to about 1e-16.

The live BRL rate moves, so a new run gives slightly different BRL figures.

Strategy defaults: `α` 0.5 (halt band), `β` 0.15 (flat band), `δ` 0.5 (fee slope), `maxFee` 0.25, `λ` 0.3 (rebate share), fee `ε` 30 bps. ARS: band half to double 1400 ARS per USD, max feed age 7 days. BRL: band 0.0909 to 0.3636 USD per BRL, max feed age 1 hour.

```bash
pnpm install && pnpm build
./scripts/test-arc-fork-forex.sh   # deploys the forex venue on an Arc fork and runs the curve regimes
```

To show steps 7 and 8 in a conversation, start `anvil --fork-url https://rpc.testnet.arc.network --port 8580` yourself and run the script with `REUSE_ANVIL=1`, so the fork stays up. Then point a local execute-mode MCP at `WRITE_RPC_URL=http://127.0.0.1:8580`, with `FXSWAP_ROUTER_ADDRESS` and `FXSWAP_AQUA_ADAPTER_ADDRESS` set to the router and adapter the script prints.

## Two-session demo: autonomous keeper

The keeper runs by itself in terminal A. In terminal B a person trades through Claude Code with the Aqua0 MCP. The keeper sees the swap on-chain and rebalances the book without being asked; then the person asks their session what happened. **Live** on Arc Testnet (hashes under `keeperRun` in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json)).

What is autonomous: the keeper loop, what it pays for, and what it decides. An OpenAI model (`gpt-5-nano`, `OPENAI_MODEL`) chooses one action (rebalance, wait, recommend_dock, top_up_usdc, top_up_gateway) and gives a reason. Hard limits are enforced in code whatever the model says: data budget per hour, max trade size, per-strategy cooldown, allowed actions, daily top-up and model spend caps, dry-run. If the model's answer is invalid, out of limits, late or over its cap, the deterministic rules policy decides instead, and the journal says so. Without `OPENAI_API_KEY` the rules policy decides. The keeper recommends docking a strategy with a stale or out-of-band oracle but cannot dock it: that needs the strategist's signature.

### Setup (once)

```bash
pnpm install && pnpm build
alias aqua0="node $PWD/apps/cli/dist/index.js"
# In the environment, never in chat: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID,
# CIRCLE_OPERATOR_WALLET_ID, and OPENAI_API_KEY for the model policy.
aqua0 keeper setup   # keeper Circle wallet (refId aqua0-keeper), App Kit funding, Gateway deposit, ERC-8004 identity
```

### Terminal A

```bash
scripts/demo/terminal-a-keeper.sh            # seller and keeper in one process: aqua0 keeper demo --interval 60 --poll 4
```

By hand: `aqua0 signals serve` (seller on http://127.0.0.1:8402, paid to the operator wallet), then `aqua0 keeper run --interval 90 --poll 4` in a second tab.

The keeper polls the forex router's `Swapped` logs every `--poll` seconds and wakes on a swap against a live forex strategy; a heartbeat every `--interval` seconds checks oracles and balances. Each tick prints one line: what woke it, the signals bought and their cost against the hourly budget, each book's spread and oracle age, who decided (model or rules) and why, the model's tokens and cost, spreads before and after, and Arcscan links. Ctrl+C stops after the current tick. The journal is `~/.aqua0/keeper/journal.jsonl` (`AQUA0_KEEPER_JOURNAL`).

### Terminal B: Claude Code with the Aqua0 MCP

`scripts/demo/terminal-b-agent.sh` starts Claude Code on Sonnet at low effort with only the Aqua0 MCP, run as the published `@aqua0/mcp` package pinned to `apps/mcp`'s version (`AQUA0_MCP_SOURCE=local` uses the repo build): `SIGNER=circle`, `CIRCLE_WALLET_ID` of the demo wallet and `MCP_WRITE_MODE=execute`, the Aqua0 tools pre-approved, and no user hooks, plugins or other MCP servers. `MODEL=opus` switches to Opus (type `/fast` in the session for fast mode). Both scripts load keys from the gitignored `.secrets/` (`circle.env`, `openai.env`, `graph-gateway.env`, `demo.env`) and never print them.

| Say | Tool call | Expect |
| --- | --- | --- |
| "Is the BRL book healthy?" | `get_signals {"pair":"BRL"}` | About 30 bps, `balanced` |
| "Swap 0.1 USDC to BRL." | `swap {"pair":"USDC/BRL","amount":"0.1"}` | Fills at about 30 bps and leaves the book USDC-heavy: the next 0.1 USDC would pay about 265 bps |
| (wait for terminal A) | | A `wake=swap` tick within one or two polls; the rebalance takes about a minute |
| "Did the keeper rebalance my book?" | `keeper_status {}` | `summary` with the spread before and after, the reason and the swap link |
| "Show the keeper's spend." | `keeper_status {"last":5}` | `spend`: USDC on signals, dollars on model calls |
| "Is it healthy now?" | `get_signals {"pair":"BRL"}` | Back near 30 bps |

On Arcscan, point at the user's swap, then the keeper's mint, RedStone push, approve and `BRAt -> USDC` swap from `0x5214…4d87`, and the operator's ERC-8004 `giveFeedback`.

### Recorded run (2026-09-12)

Terminal A (keeper and seller output, secrets redacted, lines shortened):

```text
keeper 0x5214daeb80b07340bac9060559d660e905564d87 (Circle wallet 334a4d65-949d-5904-88cc-92f45cb81a8d) ERC-8004 agent #894559 | policy llm gpt-5-nano | live | signals http://127.0.0.1:8402
watching Swapped on 0x475d0E487779743Fb52c8E7729A1718934D4187e every 4s, heartbeat every 90s (Ctrl+C to stop)
[signals] 20:07:33 sold /v1/oracle 0.0005 USDC to 0x5214...4d87 (Gateway settlement 29c369f7-ca30-49a2-a610-6d07d1d6d856)
[signals] 20:07:39 sold /v1/book 0.001 USDC to 0x5214...4d87 (Gateway settlement 54196cc5-b9ef-4c20-a819-c47eec514d6a)
20:07:45 #3 wake=startup | bought oracle+book 0.0015 USDC (hour 0.005/0.5) | ARS +30.1bps oracle 29513s ok, BRL +30.0bps oracle 0s ok | rules: wait - books within 150 bps (USDC/ARS 30.1 bps, USDC/BRL 30 bps), oracles fresh | no action
[signals] 20:08:38 sold /v1/book 0.001 USDC to 0x5214...4d87 (Gateway settlement 603b9149-6807-43b0-a2ed-b9e992ae5809)
20:09:13 #4 wake=swap swap 0xa1ed7419... usdc-in on USDC/BRL by 0xb0c068... | bought book 0.001 USDC (hour 0.006/0.5) | ARS +30.1bps oracle 29513s ok, BRL +265.5bps oracle 0s ok | llm:gpt-5-nano: rebalance USDC/BRL - USDC/BRL spread 265.53 bps above 150 so rebalance aligns with fx-in direction using suggested size 0.100082 USDC. | model gpt-5-nano 1171/133 tok $0.000112 (day $0.000112) | spread 265.53 -> 29.99 bps | swap 0.515515 BRAt -> USDC (worth 0.100082 USDC): received 0.099781, min out 0.099282 | https://testnet.arcscan.app/tx/0xad87d827... https://testnet.arcscan.app/tx/0x34f57b9c... https://testnet.arcscan.app/tx/0x3e5ee1b0... https://testnet.arcscan.app/tx/0xa3a786f8... https://testnet.arcscan.app/tx/0x76f1b72b...
```

Terminal B. At 20:08:20 the demo wallet `0xb0c0…d952` swapped 0.1 USDC → 0.513568 BRAt at +29.99 bps: [RedStone push](https://testnet.arcscan.app/tx/0x04a0f15d1bd1c283789d421b6afdb99f1c45bab0310d016e5be145b5a05944ce), [approve](https://testnet.arcscan.app/tx/0x6ca37b8e861879311ec7993914d42df69f91ad389f9a3762a5d4b415a30451b6), [swap](https://testnet.arcscan.app/tx/0xa1ed7419b56c1888ce80b60af125579e82877d247f38dcd366cacc61d3b80e1c). Then, on the bundled MCP:

```text
keeper_status -> Running: last event 26s ago. Last rebalance: USDC/BRL at 2026-09-12T20:09:13.165Z, spread 265.53 bps -> 29.99 bps.
                 Spent 0.006 USDC on 8 paid signals (0.006 in the last hour) and $0.000112 on model calls.
get_signals {"pair":"BRL"} -> ["BRL +30.00bps oracle 0s ok"], balanced, USDC share 0.50007 (block 61783518)
```

The recording ran terminal B's tool calls as a separate process rather than a recorded Claude Code conversation: the swap went through the `aqua0` CLI in execute mode, which calls the same `executeFxSwap` as the MCP `swap` tool, and `keeper_status` and `get_signals` were called on the bundled `@aqua0/mcp` over stdio.

Keeper transactions: [mint BRAt](https://testnet.arcscan.app/tx/0xad87d8270d80d2a2706a9955fb51af1067b61e89d1d6524d6c5d4359c906a739), [RedStone push](https://testnet.arcscan.app/tx/0x34f57b9cbe520091f76e92b67216f4bc3e228016ab2c7a8f305edf47909f009c), [approve BRAt](https://testnet.arcscan.app/tx/0x3e5ee1b0ba6ff919790330a56ee3e5b3938d65af46871e4f59a115297e574c08), [swap BRAt → USDC](https://testnet.arcscan.app/tx/0xa3a786f86937bb03ab6f5bc6dbb5745b7f22ab3cbf03a8dca164362a4ea165e4), [ERC-8004 feedback](https://testnet.arcscan.app/tx/0x76f1b72bde3dedea7ab054ed60cfb30208902c033a7f38287aa8735299c657c2).

## Fallbacks

- **Forex cannot ship for the presenter's signer** (`opcodeNote` says forex was not used, for example no `OPERATOR_ROLE`): do not switch to pegged. Use the demo Circle wallet, whose forex strategies are already live, or show the recorded `forexLiveRun` hashes and the fork.
- **Arc RPC or execute key unavailable:** run [`scripts/test-arc-fork-forex.sh`](../scripts/test-arc-fork-forex.sh) and point at the recorded live hashes in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).
- **Hosted endpoint only:** use the read steps; `create_strategy`, `deposit` and `swap` return calldata there, and sending needs a local execute-mode server.

## Close the loop

After any real transaction is mined:

> "Query The Graph again and explain what changed in Aqua0's vault and strategy state."

Natural-language request → typed tool → Arc → The Graph → natural-language explanation. Studio serves the Aqua strategies and fills, so the venue side can come from `graph_query`; `get_shared_backing` adds the on-chain view of commitments.

## Appendix: pegged venue (not in the demo)

The pegged venue (`AquaSwapVMRouter`, `[FlatFeeAmountIn][PeggedSwap]` at a fixed price) is live on the same vaults, but a fixed price does not track FX, so the video leaves it out. On 2026-09-12 the demo wallet `0xAFF7…b02c` [deposited 2 USDC](https://testnet.arcscan.app/tx/0x088fb34b8147f936b7c10ac8066de4a59773f7d393f33eda64a4defeb8f6c6bd), shipped [USDC/ARS](https://testnet.arcscan.app/tx/0x97d5fea443f9090f6b9dd2432036bdfbc2ed58d636e8ac802742d2e499968471) and [USDC/BRL](https://testnet.arcscan.app/tx/0x7571eea087df535b0a4391a48d510abeb9ed0084cc3816946040c05214aa2293) on that one deposit, and swapped [0.1 USDC → 138.912644 ARGt](https://testnet.arcscan.app/tx/0x24d95d61c83e3dfdf5ffa8530350635eb9c9b5f71b51835f31b98eb61c5102fb) and [0.1 USDC → 0.545728 BRAt](https://testnet.arcscan.app/tx/0x811e5fd474e554e7a3330f09f34edb09f40ca50475028be89c4de3e6cfd32539). To run it, pass `opcode:"pegged"` to `create_strategy`, `quote_swap` and `swap`. Hashes: `liveVenueRun` in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json); fork proof: [`scripts/test-arc-fork-strategies.sh`](../scripts/test-arc-fork-strategies.sh).
