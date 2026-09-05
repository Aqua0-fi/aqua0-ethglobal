# Aqua0 ETHGlobal Continuity

Agentic terminal layer for Aqua0 Shape-C on Arc Testnet. The Graph is the load-bearing analytics source: MCP tools and CLI analytics read indexed subgraph entities only and do not silently fall back to RPC.

## Setup

```bash
pnpm install
cp .env.example .env
# Fill GRAPH_ENDPOINT (and any write settings you want). check-env loads .env automatically.
pnpm check-env
pnpm typecheck
pnpm build
pnpm test
```

Required config:

| Variable | Purpose |
| --- | --- |
| `GRAPH_ENDPOINT` | Required GraphQL endpoint for the Aqua0 subgraph. |
| `GRAPH_AUTH_TOKEN` | Optional bearer token for Graph reads. Omitted from `info`. |
| `GRAPH_NETWORK` | Human-readable network label reported by health/info, e.g. `arc-testnet` or `base`. |
| `WRITE_RPC_URL` | RPC used to read `classForStrategy` and optionally execute writes. |
| `WRITE_CHAIN_ID` | Chain id used in strategy key derivation and write guards. |
| `VAULT_REGISTRY_ADDRESS` | Shape-C `VaultRegistry` address for strategy class reads/writes. |
| `MCP_WRITE_MODE` | `prepare` or `execute`; defaults to `prepare`. |
| `WRITE_PRIVATE_KEY` | Secret required only for guarded execution mode. Never logged or returned. |
| `MCP_TRANSPORT` | `stdio` or `http`; defaults to stdio. |
| `HOST`, `PORT` | HTTP MCP bind settings. |

## MCP Tools

| Tool | Source | Description |
| --- | --- | --- |
| `health` | Graph | Runs a cheap `_meta` query and reports configured vs reachable. |
| `info` | Config | Returns public chain/write config with secrets redacted. |
| `get_balance` | Graph | LP vault positions with raw principal/credit/deployed/free units and vault metadata. |
| `get_strategies` | Graph | LP strategy positions joined with indexed `StrategyVault` and vault metadata. |
| `get_fees` | Graph | LP `StrategyFeeAccruedEvent` history, optionally scoped by seconds, with raw-unit totals. |
| `list_opportunities` | Graph | Live, unpaused indexed strategy vaults plus recent V4 swap and Aqua lifecycle events. |
| `protocol_snapshot` | Graph | Vault/strategy counts and raw-unit totals from indexed entities. |
| `graph_query` | Graph | Raw GraphQL escape hatch for advanced agents. |
| `prepare_create_strategy` | RPC read + ABI encode | Derives the current Aqua0 `strategyKey`, reads `classForStrategy`, and returns stage calldata. |
| `prepare_authorize_strategy` | ABI encode | Returns `AssetVault.setCommitment` calldata. |
| `prepare_deposit` | ABI encode | Returns `AssetVault.deposit` calldata in raw units. |
| `prepare_withdraw` | ABI encode | Returns `AssetVault.withdraw` calldata in raw units. |
| `create_strategy` | Guarded write | Only registered when `MCP_WRITE_MODE=execute`; still enforces the execution guard. |
| `authorize_strategy` | Guarded write | Only registered when `MCP_WRITE_MODE=execute`; calls `setCommitment` under the guard. |

Natural-language MCP clients should call the typed tools directly. There is no custom natural-language parser in this repo.

## Transports

Stdio:

```bash
pnpm --filter @aqua0/mcp dev
```

Streamable HTTP:

```bash
MCP_TRANSPORT=http HOST=0.0.0.0 PORT=3000 pnpm --filter @aqua0/mcp dev
```

HTTP exposes:

| Path | Purpose |
| --- | --- |
| `/health` | JSON health check backed by a live Graph `_meta` query. |
| `/mcp` | Streamable HTTP MCP endpoint. |

## CLI

```bash
pnpm --filter @aqua0/cli dev health
pnpm --filter @aqua0/cli dev balance 0x...
pnpm --filter @aqua0/cli dev strategies 0x...
pnpm --filter @aqua0/cli dev fees 0x... 86400
pnpm --filter @aqua0/cli dev opportunities
pnpm --filter @aqua0/cli dev snapshot
pnpm --filter @aqua0/cli dev create-strategy --strategist 0x... --token0 0x... --token1 0x... --label "ARS carry" --vault 0x... --vault 0x...
pnpm --filter @aqua0/cli dev authorize --vault 0x... --strategy-id 123 --backing true
```

CLI write commands honor the same `MCP_WRITE_MODE` guard as MCP. In `prepare` mode they return calldata. In `execute` mode they send only when the explicit chain/RPC execution guard passes.

## Strategy Key

`prepare_create_strategy` derives the key exactly as the current Aqua0 frontend:

```text
keccak256(abi.encode(strategist, chainId, sorted token0/token1, keccak256(trimmed label)))
```

If `VaultRegistry.classForStrategy(strategyKey)` returns `0`, the result contains only stage 1 `registerStrategyClass` calldata and explains that the class id must be re-read after mining. It never infers `lastClassId`. If a class id exists, the result contains `AssetVault.registerStrategy(strategyId, strategist)` calldata for every supplied vault leg.

## Execution Safety

Default mode is preparation only. Execution requires all of:

- `MCP_WRITE_MODE=execute`
- `WRITE_PRIVATE_KEY`
- `WRITE_RPC_URL`
- `WRITE_CHAIN_ID`
- chain id `5042002` for Arc Testnet, or a local Anvil URL

The guard refuses Ethereum mainnet (`1`) and Base mainnet (`8453`) writes. Deposit and withdraw are preparation-only to avoid token-spend surprises.

## Hackathon deployment notes

- Live Arc Testnet core addresses and verification: [`docs/ARC_DEPLOYMENT.md`](docs/ARC_DEPLOYMENT.md)
- The Graph provider/submission path: [`docs/THE_GRAPH_TRACK.md`](docs/THE_GRAPH_TRACK.md)
- Arc RPC compatibility shim for full canonical event coverage: [`infra/arc-rpc-proxy`](infra/arc-rpc-proxy)
- Architecture diagram: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Continuity / pre-existing-vs-new scope: [`docs/CONTINUITY.md`](docs/CONTINUITY.md)
- Judge/demo runbook and public MCP endpoint: [`docs/DEMO.md`](docs/DEMO.md)

## Example Agent Prompts

Codex:

```text
Use the Aqua0 MCP tools. Check health, then get_balance and get_strategies for 0x... from The Graph. Return raw units only and mention vault symbols when indexed.
```

Claude:

```text
Using Aqua0's MCP server, call list_opportunities and protocol_snapshot. Summarize which strategy vaults have the largest raw availableFor without converting decimals.
```

Write prep:

```text
Call prepare_create_strategy for strategist 0x..., token0 0x..., token1 0x..., label "ETHGlobal FXSwap ARS proof", and vault legs 0x... and 0x.... Do not execute.
```
