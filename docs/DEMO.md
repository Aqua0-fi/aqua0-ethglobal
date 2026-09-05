# ETHGlobal demo runbook

This runbook keeps the live claims separate from fallback/local proof so the demo never relies on fake state.

## Public MCP

The AWS MCP is exposed over Streamable HTTP at:

```text
https://ethglobal-mcp.18-207-103-187.nip.io/mcp
```

Health:

```text
https://ethglobal-mcp.18-207-103-187.nip.io/health
```

The public endpoint is **prepare-only**: it has no signing key and cannot broadcast transactions. Agent analytics are backed by `GRAPH_ENDPOINT` only.

The current public endpoint has been SDK-smoke-tested over HTTPS with `health`, `protocol_snapshot`, `list_opportunities`, `graph_query`, and `prepare_create_strategy`. The reverse-proxy pattern is committed as `deploy/aws/Caddyfile.mcp.example`.

## 1. Show The Graph as the read layer

Ask a Claude/Codex-style MCP client:

```text
Check Aqua0 health, show the protocol snapshot, then list current strategy opportunities. Tell me which data came from The Graph.
```

Expected tools:

1. `health`
2. `protocol_snapshot`
3. `list_opportunities`
4. optionally `graph_query` for an ad-hoc follow-up

For The Graph bounty submission, point `GRAPH_ENDPOINT` at the Subgraph Studio / Graph Network deployment described in `THE_GRAPH_TRACK.md`. The self-hosted AWS node is the development and Arc-Testnet indexing path, not a substitute for the bounty's provider requirement.

## 2. Show live Arc Shape-C deployment

Public addresses are in `../deployments/arc-testnet.json`.

The three live AssetVaults are:

- USDC: `0x99c2ab427b29dB1Cc14D228d970596015d1C4429`
- ARGt: `0x8a3d6188C58d7877499592E179DfE3bd80c4F460`
- BRAt: `0xEcB132648B781ec5742b582c526243Eeef900785`

The live ARS strategy class is recorded in `../deployments/arc-testnet-strategies.json`: class `1` spans the USDC and ARGt vaults. The BRL strategy is deliberately recorded as `prepared-not-broadcast` until its transaction is actually sent.

## 3. Show agent-native strategy preparation

Ask the agent:

```text
Prepare an Aqua0 FXSwap BRL strategy on Arc Testnet for strategist 0xBaA361817C8676b4A8a8C5e6fd050253f81f407C, using Arc USDC and BRAt, with the USDC and BRAt Shape-C vaults. Do not broadcast anything.
```

The MCP should call `prepare_create_strategy`, derive the exact current Aqua0 strategy key, read `classForStrategy` from Arc, and return the next transaction rather than guessing a class id.

## 4. Shared-backing proof

The deterministic fork test is:

```bash
./scripts/start-base-fork.sh
./scripts/test-shared-backing-fork.sh
```

It proves the key invariant with real Shape-C bytecode/state: one 100 USDC principal position can commit to both the ARS and BRL strategy classes at 100 USDC backing each. The principal is not split into two isolated 50 USDC pools.

This is the fallback proof if the venue/FXSwap opcode workstream is not ready for a complete live fill. It is not presented as an Arc transaction.

## Optional live 1 USDC Arc flow

To make the Arc demo show non-zero USDC state, `scripts/prepare-arc-usdc-demo.sh` prints (but never sends) an approval, a 1 USDC Shape-C deposit, and commitment to the already-live ARS class. Sign those three prepared transactions with the demo wallet during the presentation if desired, then wait for The Graph and refresh the dashboard/MCP.

```bash
./scripts/prepare-arc-usdc-demo.sh
```

The script is deliberately preparation-only; no private key is read and no transaction is broadcast.

## 5. End with indexed state

After any real state-changing demo transaction is mined, ask:

```text
Query The Graph again and explain what changed in Aqua0's vault/strategy state. Use graph_query if the typed tool does not expose the exact field you need.
```

That closes the loop: natural-language agent -> typed Shape-C action -> chain -> The Graph -> natural-language explanation.
