# Arc Track Judge Notes

Aqua0 now includes a minimal judge-facing web MVP for the Arc bounty in `apps/dashboard`.

## Qualification checklist

- **Functional frontend:** a static, responsive HTML/CSS/vanilla-JS dashboard served by the Node package. It shows Arc vault cards, live Graph health, raw indexed data, live strategy classes, ARS/BRL presets, and prepare-only calldata.
- **Functional backend:** a TypeScript Node HTTP server with JSON routes for health, protocol snapshot, opportunities, raw live Graph data, public config, and `prepareCreateStrategy`. It has no execute endpoint and never reads `WRITE_PRIVATE_KEY`.
- **Diagram:** the dashboard includes a compact architecture flow and links the full Mermaid architecture diagram in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## Architecture path

```mermaid
flowchart LR
  D[Judge browser dashboard] --> API[TypeScript Node HTTP API]
  API --> S[@aqua0/shared service]
  S --> G[The Graph Arc subgraph]
  G --> A[Arc Testnet Shape-C contracts]
  API -->|prepare-only classForStrategy read + calldata| R[Arc Testnet RPC]
  R --> A
```

## Public evidence

- Arc deployment and public addresses: [`docs/ARC_DEPLOYMENT.md`](ARC_DEPLOYMENT.md)
- Full architecture diagram: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
- The Graph submission notes: [`docs/THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md)
- Dashboard placeholder URL: `https://ethglobal-demo.18-207-103-187.nip.io/` until the AWS/Caddy public route is assigned.

## Local and AWS run

Local:

```bash
GRAPH_ENDPOINT=https://your-subgraph-endpoint \
WRITE_RPC_URL=https://rpc.testnet.arc.network \
WRITE_CHAIN_ID=5042002 \
VAULT_REGISTRY_ADDRESS=0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf \
pnpm --filter @aqua0/dashboard dev
```

AWS loopback compose:

```bash
docker compose -f deploy/aws/dashboard.compose.yml up -d --build
```

The AWS compose file binds `127.0.0.1:8400->3000`, attaches `graph-node_default`, and pins `MCP_WRITE_MODE=prepare`.
