# ETHGlobal Docker naming

Hackathon-only Docker artifacts use an `ethglobal-` prefix so they are easy to identify and remove after the event.

Expected images/containers:

- `ethglobal-mcp:latest` / `ethglobal-mcp`
- `ethglobal-dashboard:latest` / `ethglobal-dashboard`
- `ethglobal-arc-rpc-proxy:latest` / `ethglobal-arc-rpc-proxy`
- `ethglobal-graph-node:v0.42.0` / `ethglobal-graph-node`
- `ethglobal-graph-ipfs:v0.37.0` / `ethglobal-graph-ipfs`
- `ethglobal-graph-postgres:16` / `ethglobal-graph-postgres`

All containers we control also carry `com.aqua0.scope=ethglobal`.

Inventory commands:

```bash
docker ps -a --filter label=com.aqua0.scope=ethglobal
docker images 'ethglobal-*'
```

After the hackathon, review those two commands before deleting anything. The public MCP/dashboard do not depend on the self-hosted Graph fallback stack anymore; they query Subgraph Studio `/version/latest` directly.
