# @aqua0/mcp

The Aqua0 MCP server. Your AI agent reads Aqua0's vaults and fills from The Graph, creates USDC/FX market-making strategies on 1inch Aqua and SwapVM, quotes and swaps, and benchmarks a strategy against the onchain market. It runs on **Arc Testnet**.

One USDC deposit backs several strategies at once. Fills draw liquidity from the Aqua0 vaults just in time, and USDC/BRL and USDC/ARS strategies price from an FX oracle through the forex curve (SwapVM opcode 34).

> Testnet only. ARGt and BRAt are open-mint demo tokens standing in for ARS and BRL stablecoins; they are not real money.

## Install

**Claude Code**

```sh
claude mcp add aqua0 -- npx -y @aqua0/mcp
```

Or install the Claude Code plugin, which adds the hosted MCP server and the Aqua0 agent skill in one step:

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

## Tools

| Tool | What it does |
| --- | --- |
| `health`, `info` | Server, Graph and chain status |
| `get_balance`, `get_strategies`, `get_fees` | An LP's vault positions, strategy classes and fees, from the Aqua0 subgraph |
| `list_opportunities`, `protocol_snapshot`, `graph_query` | Protocol-wide reads and raw GraphQL against the Aqua0 subgraph |
| `deposit` | Deposit USDC, ARGt or BRAt into an Aqua0 vault |
| `create_strategy` | Create a USDC/ARS or USDC/BRL strategy (forex curve by default, fixed-price pegged on request), idempotently |
| `quote_swap`, `swap` | Quote and swap against a live strategy, with an enforced minimum output |
| `get_shared_backing` | Show one USDC deposit backing several strategies at once |
| `get_fx_prices`, `set_fx_price` | Read the FX feeds (RedStone signed BRL prices, a hand-set ARS feed); move the ARS demo feed as its owner |
| `benchmark_fx_strategy` | Compare a strategy with the onchain market for the same currency: one query over Messari standardized DEX subgraphs on The Graph Network, composed with the Aqua0 subgraph |
| `login`, `whoami`, `logout` | Privy sign-in with a Circle wallet (local stdio server only) |
| `prepare_create_strategy`, `prepare_authorize_strategy`, `prepare_deposit`, `prepare_withdraw` | Calldata builders for the lower-level vault calls |

Things to ask your agent:

- "Deposit 2 USDC and create a USDC to Brazilian real strategy."
- "Quote 0.1 USDC to BRL, then swap it."
- "Does one deposit back both of my strategies?"
- "How does my USDC/BRL strategy compare with the onchain market?"

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `http` serves Streamable HTTP on `HOST`/`PORT` |
| `GRAPH_ENDPOINT` | public Aqua0 subgraph on Subgraph Studio | Aqua0 subgraph to read |
| `GRAPH_GATEWAY_API_KEY` | none | The Graph Network API key, needed by `benchmark_fx_strategy` |
| `WRITE_RPC_URL`, `WRITE_CHAIN_ID` | Arc Testnet, `5042002` | Chain for quotes and writes |
| `MCP_WRITE_MODE` | `prepare` | `execute` sends transactions |
| `WRITE_PRIVATE_KEY` | none | Local signer for execute mode |

Contract addresses default to the Arc Testnet deployment and can be overridden; see the repository.

## Links

- Repository, architecture and contracts: https://github.com/Aqua0-fi/aqua0-ethglobal
- Agent skill: https://github.com/Aqua0-fi/aqua0-ethglobal/blob/main/skills/aqua0/SKILL.md
- Aqua0 subgraph on Subgraph Studio: https://thegraph.com/studio/subgraph/aqua-0-ethglobal-arc-testnet

## License

MIT
