# Circle / Arc track notes

For prize-by-prize criteria and checklists, see [README: Prize tracks](../README.md#prize-tracks). This page is the Arc-specific product inventory and a short guide to the web MVP.

<!-- TODO: add demo video link -->

## What Aqua0 uses on Arc today

| Circle / Arc product | Used? | How |
| --- | --- | --- |
| Arc (chain `5042002`) | Yes | The Aqua0 vault core, three AssetVaults and the pegged 1inch Aqua venue are **Live**, with two strategies shipped and filled. RedStone BRL and MXNe price feeds are **Live**. The FXSwap venue is **Deployed, awaiting wiring**. See [`ARC_DEPLOYMENT.md`](ARC_DEPLOYMENT.md). |
| USDC | Yes | Arc's native USDC (ERC-20 interface `0x3600…0000`, 6 dp) is the shared quote asset. One 2 USDC deposit backs a USDC/ARS and a USDC/BRL strategy at once: **Live**. |
| Circle Wallets (developer-controlled) | Yes | A person signs in with Privy from the terminal (`login`) and gets a Circle EOA wallet on Arc. Deposits, strategy creation and swaps run through Circle's API; a shared Circle operator wallet sends the strategies users sign and tops up new wallets with testnet USDC: **Live**. See [Agent transactions on Arc](#agent-transactions-on-arc). |
| App Kits, Circle Contracts, CCTP, Gateway, StableFX | Not yet | **Planned**, see below |
| Agent Stack, Nanopayments, Paymaster | Not yet | **Planned**, see below |

Arc is testnet-only for Aqua0 today.

## FX market data on Arc

FXSwap USDC/BRL strategies price from real FX market data on Arc: RedStone prices signed by 3 of its 5 primary-prod signers and verified on-chain by the RedStone adapter.
- **Feeds:** BRL (USD per 1 BRL) and MXNe (MXN per 1 USD, from Etherfuse's MXNe stablecoin), **Live** on Arc Testnet. No Aqua0 MXN vault exists yet.
- **Why RedStone:** its gateways are free and need no API key. Pyth's free tier excludes FX feeds, Chainlink Data Feeds are on Arc mainnet only, StableFX covers only USDC/EURC, and RedStone has no ARS feed, so USDC/ARS stays on a hand-set feed.
- **Status:** FXSwap USDC/BRL through the MCP on these feeds is **Fork-proven**. FXSwap on Arc itself is **Deployed, awaiting wiring**.

Addresses and mechanics: [`ARC_DEPLOYMENT.md`](ARC_DEPLOYMENT.md#6-redstone-price-feeds-live).

## Arc prize requirements checklist

| Requirement | Evidence | Status |
| --- | --- | --- |
| Functional MVP: frontend | Judge dashboard at `https://ethglobal-demo.18-207-103-187.nip.io/` ([`apps/dashboard`](../apps/dashboard)): Arc vault cards, live Graph health, indexed data, strategy classes, ARS/BRL presets, prepare-only strategy calldata. The primary interface is the agentic terminal via MCP. | **Live** (read-only and prepare-only) |
| Functional MVP: backend | Dashboard Node API, MCP server ([`apps/mcp`](../apps/mcp)), typed service ([`packages/shared`](../packages/shared)), subgraph on Subgraph Studio, Arc contracts | **Live**; FXSwap venue **Deployed, awaiting wiring** |
| Architecture diagram | [README: How it works](../README.md#how-it-works), [`ARCHITECTURE.md`](ARCHITECTURE.md) | **Live** |
| Video demo of core functions and use of Circle developer tools | Link added at submission | **In progress** |
| Detailed documentation | README, `docs/`, [`skills/aqua0/SKILL.md`](../skills/aqua0/SKILL.md) | **Live** |
| GitHub repository | `https://github.com/Aqua0-fi/aqua0-ethglobal` | **Live** |
| Arc Mainnet deployment (mainnet-conditional share of each prize) | Not deployed | **Planned** |

## Web MVP architecture

```mermaid
flowchart LR
  D["Judge browser dashboard"] --> API["TypeScript Node HTTP API"]
  API --> S["@aqua0/shared service"]
  S -->|"GraphQL analytics"| G["The Graph: Arc subgraph on Subgraph Studio"]
  G --> A["Arc Testnet Aqua0 vault contracts"]
  API -->|"prepare-only: classForStrategy read and calldata"| R["Arc Testnet RPC"]
  R --> A
```

Dashboard routes:

| Path | Purpose |
| --- | --- |
| `/` | Judge-facing dashboard |
| `/api/config` | Sanitized public Arc deployment and ARS/BRL preset config from `deployments/*.json` |
| `/api/health` | Graph-backed health |
| `/api/snapshot` | Protocol snapshot |
| `/api/opportunities` | Live strategy vaults and recent lifecycle events |
| `/api/live` | One raw Graph query for `_meta`, `vaults`, `strategies`, `strategyVaults` |
| `/api/prepare-strategy` | POST, prepare-only `prepareCreateStrategy` |
| `/docs/ARCHITECTURE.md`, `/docs/ARC_DEPLOYMENT.md`, `/docs/THE_GRAPH_TRACK.md` | Raw docs |

The dashboard backend has no execute endpoint and never reads `WRITE_PRIVATE_KEY`.

## Agent transactions on Arc

A local MCP or CLI started with `MCP_WRITE_MODE=execute` sends `deposit`, `create_strategy` and `swap` transactions itself, and `set_fx_price` when the signer owns the ARS/USD feed. For a RedStone-priced strategy, `swap` first pushes the latest signed price on-chain. This is limited to Arc Testnet or a local fork.

- **Live on Arc Testnet:** the demo wallet ran deposit → two pegged strategies → one swap each → shared-backing read through the `aqua0` CLI, which calls the same service functions as the MCP tools. Hashes: [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).
- **Fork-proven:** the FXSwap flow, including a RedStone price push before the USDC/BRL swap and an ARS feed move and re-quote ([`scripts/test-arc-fork-fxswap.sh`](../scripts/test-arc-fork-fxswap.sh)).
- The first live run signed with a locally configured key (`WRITE_PRIVATE_KEY`). `SIGNER=circle` signs with a Circle developer-controlled EOA wallet instead, one per user.
- **Live on Arc Testnet, Circle wallets:** a person signed in with Privy (`aqua0 login`), which created their Circle wallet `0x34f9…450f`. The Aqua0 operator wallet `0xcdbd…d404` topped it up with 5 testnet USDC. With no role of its own, the wallet then deposited 2 USDC, created a USDC/BRL strategy (it signed the ship, the operator sent it, tx `0xea960df6…4c8b1a`) and swapped 0.1 USDC → 0.547 BRAt against it (tx `0x586c0105…3b49e4`). Every transaction went through Circle's API.
- The agent acts on user instructions; it is not an autonomous agent.
- The public endpoint is prepare-only and holds no key.

## Run

```bash
GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest \
WRITE_RPC_URL=https://rpc.testnet.arc.network \
WRITE_CHAIN_ID=5042002 \
VAULT_REGISTRY_ADDRESS=0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf \
pnpm --filter @aqua0/dashboard dev
```

AWS loopback compose: `docker compose -f deploy/aws/dashboard.compose.yml up -d --build`. It binds `127.0.0.1:8400->3000`, attaches `graph-node_default`, and pins `MCP_WRITE_MODE=prepare`.

## Next steps toward the Circle stack (Planned, not built)

- **Circle Wallets / Agent Stack:** give the agent its own wallet to sign the strategy, deposit and swap transactions it already builds. Keep policy limits (chain, tokens, max notional) in the wallet layer, not in the prompt.
- **Nanopayments:** charge per quote or per strategy-management action in USDC.
- **Paymaster:** sponsor strategist and LP transactions.
- **StableFX:** it covers only USDC/EURC today, so FXSwap's BRL price comes from RedStone. Evaluate StableFX for a USDC/EURC pair or as a comparison venue.
- **CCTP / Gateway:** bring USDC in from other chains before depositing into the shared vault.
- **Arc Mainnet:** deploy after a security review of the contracts and FXSwap.
