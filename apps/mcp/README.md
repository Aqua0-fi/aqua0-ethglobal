# @aqua0/mcp

The Aqua0 MCP server. Your AI agent reads Aqua0's vaults and fills from The Graph, creates USDC/FX market-making strategies on 1inch Aqua and SwapVM, quotes and swaps, checks the autonomous keeper, and benchmarks a strategy against the onchain market. It runs on **Arc Testnet**.

One USDC deposit backs several strategies at once. Fills draw liquidity from the Aqua0 vaults just in time, and USDC/BRL and USDC/ARS strategies price from an FX oracle through the forex curve (SwapVM opcode 34).

> Testnet only. ARGt and BRAt are open-mint demo tokens standing in for ARS and BRL stablecoins; they are not real money.

## Install

**Claude Code**

```sh
claude mcp add aqua0 -- npx -y @aqua0/mcp
```

Or install the Claude Code plugin, which adds the Aqua0 agent skill and the hosted MCP server (prepare-only, no signing key) in one step:

```text
/plugin marketplace add Aqua0-fi/aqua0-ethglobal
/plugin install aqua0@aqua0
```

**Any MCP client** (Claude Desktop, Cursor and others)

```json
{
  "mcpServers": {
    "aqua0": {
      "command": "npx",
      "args": ["-y", "@aqua0/mcp"]
    }
  }
}
```

It needs Node.js 20 or later and no other setup: by default it reads the public Aqua0 subgraph on Subgraph Studio and the Arc Testnet RPC, and it never sends transactions.

## Modes

| Mode | What it does | Configure |
| --- | --- | --- |
| **Prepare** (default) | Reads, quotes and benchmarks; write tools return ordered calldata for you to sign | nothing |
| **Execute with your own key** | Deposits and swaps on Arc Testnet from your wallet. Creating a strategy also needs `OPERATOR_ROLE` on the Aqua0 adapter, or the Circle mode below | `MCP_WRITE_MODE=execute`, `WRITE_PRIVATE_KEY=0x...` |
| **Execute with Privy sign-in and Circle wallets** | `login` opens a Privy sign-in; the user gets a Circle developer-controlled wallet, and an Aqua0 operator wallet sends the strategies they sign | `MCP_WRITE_MODE=execute`, `SIGNER=circle`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`, `CIRCLE_OPERATOR_WALLET_ID`, `PRIVY_APP_ID` |

Example with your own testnet key:

```sh
claude mcp add aqua0 -e MCP_WRITE_MODE=execute -e WRITE_PRIVATE_KEY=0xYOUR_TESTNET_KEY -- npx -y @aqua0/mcp
```

The key's address needs testnet USDC on Arc, which pays gas, and must have no contract code. The execution guard only allows Arc Testnet or a local fork, and `dryRun: true` always returns calldata. Use a throwaway key, set only in the server's environment, never in chat.

**How Privy sign-in with Circle wallets works:**

1. `login` opens `http://localhost:8787/login`, where the user signs in with any method the Privy app enables (allow that origin on the Privy app client).
2. The server verifies the Privy token and uses the Privy user id as the `refId` of a Circle developer-controlled wallet on Arc Testnet, created on first sign-in. Only the user id and wallet address are saved (`~/.aqua0/session.json`).
3. The shared operator wallet tops up a new wallet holding under 1 USDC.
4. `deposit`, `create_strategy` and `swap` then run as that user. The user's wallet signs each strategy and the operator only sends it.

Local sign-in chooses which Circle wallet signs; it does not isolate users, because whoever runs the server holds the Circle secrets.

## Tools

25 tools, plus `authorize_strategy` in execute mode (26). Write tools send only when the server runs with `MCP_WRITE_MODE=execute` and `dryRun` isn't true; otherwise they return calldata and EIP-712 typed data. Graph reads return raw integer units as strings.

| Tool | Kind | What it does |
| --- | --- | --- |
| `health`, `info` | Graph, config | Graph `_meta` query (configured vs reachable); public chain and write config, secrets redacted |
| `login`, `whoami`, `logout` | Sign-in | Privy sign-in to a Circle developer-controlled wallet; the sign-in page runs on the local server |
| `get_balance`, `get_strategies`, `get_fees` | Graph | An LP's vault positions (principal, credit, deployed and free units), strategy positions and fee history |
| `list_opportunities`, `protocol_snapshot`, `graph_query` | Graph | Live strategy vaults and recent events, vault and strategy totals, raw GraphQL |
| `deposit` | Write | Deposit USDC, ARS (ARGt) or BRL (BRAt) in human units; approves when needed |
| `create_strategy` | Write | `{pair, chain?, opcode?, params?, strategist?, fundFxLeg?, dryRun?}`: class → vault legs → FX funding → commitments → EIP-712 sign → `AquaAdapter.shipStrategyWithFee`. Idempotent; accepts loose pairs ("usdc to brl", "pesos"). `opcode` is `"forex"` (default) or `"pegged"`. Forex params: `feeBps`, `alpha`, `beta`, `delta`, `maxFee` or `maxFeePercent`, `lambda`, `bandPercent` or `minPrice`/`maxPrice`, `maxStaleness`, `usdcAmount`, `fxAmount`; pegged takes `price` |
| `quote_swap` | RPC read | Exact-in quote through the strategy's router: oracle or fixed price, execution price and effective spread; sends nothing. RedStone-priced strategies are quoted at the latest signed price through a state override |
| `swap` | Write | Pushes the latest signed RedStone price for BRL, re-quotes, enforces min out on-chain (`slippageBps` default 50, or `minAmountOut`), approves and swaps |
| `get_shared_backing` | RPC read | Principal counted once, every committed class, backing and availability per vault, shipped strategies on both venues |
| `get_fx_prices` | RPC read, RedStone gateways | BRL: the latest signed price and the value on-chain. ARS: price, age and owner. Without a pair it also lists MXNe |
| `set_fx_price` | Write | `{pair, price \| changePercent, dryRun?}`: `ManualFxOracle.setAnswer` on the ARS/USD feed; refuses the RedStone feed; sends only when the signer owns the feed |
| `benchmark_fx_strategy` | Graph: Messari DEX subgraphs + Aqua0 subgraph | `{pair, feeBps?, flatBandPercent?, tradeSizesUsd?, lookbackDays?, chains?, fallback?, includeArcQuote?}` for EUR, BRL, MXN, ARS, SGD or CAD against USDC: pools, the Aqua0 strategy's fee and fills, and a verdict. Needs `GRAPH_GATEWAY_API_KEY` |
| `get_signals` | RPC read | The oracle and book signals the keeper buys, read for free: each forex book's spread, tilt and oracle age |
| `keeper_status` | Keeper journal | Reads the keeper's journal on the machine running the server (`AQUA0_KEEPER_JOURNAL`): running or not, last rebalance, recent ticks, spend |
| `prepare_create_strategy`, `prepare_authorize_strategy`, `prepare_deposit`, `prepare_withdraw` | RPC read, ABI | Strategy key and `classForStrategy`, and calldata for the lower-level vault calls |
| `authorize_strategy` | Write, execute mode only | `AssetVault.setCommitment` sent directly |

Things to ask your agent:

- "Deposit 2 USDC and create a USDC to Brazilian real strategy."
- "Quote 0.1 USDC to BRL, then swap it."
- "Does one deposit back both of my strategies?"
- "Is the BRL book healthy? Did the keeper rebalance it?"
- "How does my USDC/BRL strategy compare with the onchain market?"

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `http` serves Streamable HTTP on `HOST`/`PORT` |
| `GRAPH_ENDPOINT` | public Aqua0 subgraph on Subgraph Studio | Aqua0 subgraph to read |
| `GRAPH_GATEWAY_API_KEY` | none | The Graph Network API key, needed by `benchmark_fx_strategy` |
| `WRITE_RPC_URL`, `WRITE_CHAIN_ID` | Arc Testnet, `5042002` | Chain for quotes and writes |
| `MCP_WRITE_MODE` | `prepare` | `execute` sends transactions |
| `WRITE_PRIVATE_KEY` | none | Local signer for execute mode (secret) |
| `SIGNER` | `local` | `circle` signs through Circle developer-controlled wallets |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | none | Secrets for `SIGNER=circle` |
| `CIRCLE_WALLET_ID`, `CIRCLE_WALLET_SET_ID`, `CIRCLE_USER_REF` | none | Which Circle wallet signs: a fixed wallet, or the wallet in the set whose `refId` is the user ref |
| `CIRCLE_OPERATOR_WALLET_ID` | none | Operator wallet holding `OPERATOR_ROLE`: sends the ships users sign and tops up new users |
| `AQUA0_ONBOARD_USDC`, `AQUA0_ONBOARD_DAILY_CAP_USDC` | 5, 50 | Top-up size and rolling 24-hour cap for new users |
| `PRIVY_APP_ID`, `PRIVY_CLIENT_ID`, `PRIVY_LOGIN_PORT` | none, none, `8787` | Privy app for `login` and the sign-in page port |
| `FXSWAP_ROUTER_ADDRESS`, `FXSWAP_AQUA_ADAPTER_ADDRESS`, `AQUA_ADAPTER_ADDRESS`, `AQUA_SWAPVM_ROUTER_ADDRESS` | Arc deployment | Forex and pegged venue overrides |
| `FX_ORACLE_ARS_USD`, `FX_ORACLE_BRL_USD` | Arc deployment, none | ARS/USD feed override; optional BRL feed that replaces RedStone |
| `AQUA0_KEEPER_JOURNAL` | `~/.aqua0/keeper/journal.jsonl` | Keeper journal that `keeper_status` reads |
| `HOST`, `PORT` | | HTTP bind settings for `MCP_TRANSPORT=http` |

Contract addresses default to the Arc Testnet deployment and can be overridden; see the repository.

## Links

- Repository, architecture and contracts: https://github.com/Aqua0-fi/aqua0-ethglobal
- Agent skill: https://github.com/Aqua0-fi/aqua0-ethglobal/blob/main/skills/aqua0/SKILL.md
- Aqua0 subgraph on Subgraph Studio: https://thegraph.com/studio/subgraph/aqua-0-ethglobal-arc-testnet

## License

MIT
