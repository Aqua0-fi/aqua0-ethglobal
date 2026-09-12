# AWS auto-deploy

`.github/workflows/deploy.yml` deploys only after the `CI` workflow completes successfully for a push to `main`.

## Public MCP and judge dashboard

Every successful `main` CI run syncs that exact commit to the ETHGlobal EC2 host and rebuilds:

- `Dockerfile.mcp` with `deploy/aws/mcp.compose.yml`
- `Dockerfile.dashboard` with `deploy/aws/dashboard.compose.yml`

The public runtime is intentionally prepare-only:

- `GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest`
- `WRITE_RPC_URL=https://rpc.testnet.arc.network`
- `WRITE_CHAIN_ID=5042002`
- `MCP_WRITE_MODE=prepare`
- `WRITE_PRIVATE_KEY=`
- no Circle signing credentials are passed to the public containers

`GRAPH_GATEWAY_API_KEY` is supplied only from the GitHub Actions secret of the same name. It is never committed or copied into the repository. The workflow writes a mode-600 runtime env file on the EC2 host.

The deploy job then checks both public health endpoints and lists the public MCP tools. `create_strategy` and `quote_swap` are required; `benchmark_fx_strategy` is reported as a warning until the commit containing that tool reaches `main`.

## Subgraph Studio

The same workflow deploys `scripts/deploy-graph-studio.sh` only when `packages/subgraph/**` changed since the previous successful `main` CI run. It uses:

- `GRAPH_STUDIO_SLUG=aqua-0-ethglobal-arc-testnet`
- GitHub Actions secret `GRAPH_STUDIO_DEPLOY_KEY`

The application containers always query `/version/latest`, so the previous indexed version remains usable while Studio indexes a new deployment.

## GitHub Actions secrets

Required repository secrets:

- `AWS_SSH_PRIVATE_KEY`
- `GRAPH_STUDIO_DEPLOY_KEY`
- `GRAPH_GATEWAY_API_KEY` (required by `benchmark_fx_strategy` once that tool lands)

The EC2 host and username are non-secret workflow configuration.
