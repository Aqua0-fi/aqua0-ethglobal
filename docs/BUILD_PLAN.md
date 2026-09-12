# Build plan

The pitch, demo, architecture and prize mapping are in the [README](../README.md). This page tracks workstreams and the engineering boundaries they share.

## Workstreams

| Workstream | Owner | Status |
| --- | --- | --- |
| Aqua0 vault subgraph, Arc manifest, Arc RPC proxy | Rithik | **Live** |
| Subgraph Studio deployment for Arc | Rithik | **Live**, indexing both Aqua venues (version `ethglobal-arc-3d0b9ef`) |
| MCP server, dashboard, public deployment | Rithik | **Live** (public endpoint on the earlier prepare-only build); hosted redeploy with 24 tools **Planned** |
| Arc deployment of the Aqua0 vault core | Tomás | **Live** |
| Pegged venue on Arc: Aqua + AquaSwapVMRouter + AquaAdapter | Yudhishthra | **Live** (wired; two strategies shipped and filled) |
| Arc SwapVM integration: strategy scripts, MCP strategy tools, Aqua venue indexing | Yudhishthra | Tools **Live** on Arc (pegged and forex); indexing **Live** |
| ForexCurve instruction (port of Tomás's forex curve), `AquaForexSwapVMRouter` and forex adapter on Arc | Yudhishthra | **Live** (wired; forex strategies shipped and filled) |
| RedStone BRL and MXNe price feeds on Arc | Yudhishthra | **Live** (deployed, updated on-chain, readable with `get_fx_prices`) |
| Forex curve in the MCP and CLI: `opcode:"forex"` (the default), `get_fx_prices`, `set_fx_price`, RedStone BRL pricing | Yudhishthra | **Live** on Arc |
| Forex curve reference, vectors and parameter simulations | Tomás | Done: the ForexCurve port matches all 979 reference vectors |
| Agent skill | Yudhishthra | **Live** ([`skills/aqua0/SKILL.md`](../skills/aqua0/SKILL.md)) |

## Forex curve design vs build

| Item | Status |
| --- | --- |
| Stateless oracle-priced curve, solved in closed form on every swap | ✅ |
| Oracle address and staleness declared in the program (Option B) | ✅ |
| Max-deviation check | ⚠️ simplified to a min/max price band |
| Signed prices (Option C): RedStone, pushed on-chain through the RedStone adapter before a swap. Pyth was dropped because its free tier excludes FX feeds. | ✅ for BRL; ARS stays hand-set (no RedStone ARS feed) |
| Volatility-based spread | **Planned** |

## Operational checklist

1. Set `GRAPH_ENDPOINT` to the Subgraph Studio query endpoint.
2. Set `WRITE_RPC_URL` and `WRITE_CHAIN_ID`. The Arc pegged venue, forex venue and feed addresses default from the Arc deployment.
3. Leave `MCP_WRITE_MODE=prepare` unless deliberately testing guarded execution.
4. For HTTP deployments, run with `MCP_TRANSPORT=http`, route `/mcp`, and use `/health` for Graph-backed reachability.
5. Run `pnpm typecheck`, `pnpm build`, `pnpm lint` and `pnpm test` before release. CI runs these in the `verify` job, and `forge build` and `forge test` in the `contracts` job (the Arc fork test is skipped there).

## Boundaries

- Analytics tools read The Graph only. On-chain reads (`classForStrategy`, venue readiness, quotes, feeds, `get_shared_backing`) are labelled as such.
- Write tools send only with `MCP_WRITE_MODE=execute` on Arc Testnet or a local fork, and `dryRun: true` always prepares. `prepare_withdraw` is preparation-only.
- `create_strategy` is idempotent: finished steps are reported as skipped. It uses the forex curve only when that venue is ready, and otherwise says why in `opcodeNote`.
- `swap` always quotes first and enforces a minimum output on-chain.
- `set_fx_price` moves only the ARS/USD `ManualFxOracle`, sends only when the signer owns it, and refuses the RedStone BRL feed.
- RedStone prices enter a `quote_swap` only through an `eth_call` state override, so nothing is sent. `swap` pushes the signed payload on-chain before swapping; in prepare mode that push is the first prepared transaction.
- Secrets come from environment variables and are omitted from `info` and logs.
- Documentation never claims something is live before it is on Arc Testnet or the public endpoints.
