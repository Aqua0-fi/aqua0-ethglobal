# The Graph track

The Graph is load-bearing in this project. Analytics tools do not fall back to RPC: balance, strategy, fee, opportunity, and protocol snapshot reads all come from indexed Graph entities. The raw `graph_query` tool is also available to agents for queries that are not covered by a typed tool.

## Provider deployment

For the ETHGlobal submission, use a live Graph provider endpoint (Subgraph Studio or The Graph Network) for `GRAPH_ENDPOINT`. The AWS Graph Node in `deploy/aws` is useful for reproducible development and for Arc Testnet, but the judge-facing endpoint should be a Graph provider endpoint rather than a local/static dataset.

The current Base Shape-C deployment is a good provider target because Base is supported by The Graph and the complete canonical accounting-event manifest already indexes it.

1. In Subgraph Studio, create a subgraph and copy its slug and deploy key.
2. Run:

```bash
GRAPH_STUDIO_SLUG=<studio-slug> \
GRAPH_STUDIO_DEPLOY_KEY=<secret-deploy-key> \
./scripts/deploy-graph-studio.sh
```

3. Copy the resulting Studio query endpoint into `GRAPH_ENDPOINT` for the MCP service. Keep the query/deploy API keys out of git.
4. Run `health`, `protocol_snapshot`, and an agent query through the MCP to demonstrate that the provider endpoint is actually load-bearing.

The deploy script intentionally deploys `packages/subgraph/subgraph.base.yaml`. Arc Testnet is also indexed by our self-hosted Graph Node, but it requires an Arc RPC compatibility proxy because the public Arc RPC limits the number of event signatures in one `eth_getLogs` topic OR-list.

## Demo proof

A good judge flow is:

- ask the agent for current protocol capital and strategy availability;
- have it call `get_balance`, `get_strategies`, or `list_opportunities` through MCP;
- create/prepare an FX strategy through the typed Shape-C write tools;
- query The Graph again and show the indexed state transition;
- use `graph_query` for an ad-hoc follow-up without adding a bespoke backend endpoint.

This makes The Graph a reusable analytics and agent-data layer rather than a presentation-only dashboard dependency.
