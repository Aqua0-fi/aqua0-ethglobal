# The Graph track

The Graph is load-bearing in this project. Analytics tools do not fall back to RPC: balance, strategy, fee, opportunity, and protocol snapshot reads all come from indexed Graph entities. The raw `graph_query` tool is also available to agents for queries that are not covered by a typed tool.

## Provider deployment

For the ETHGlobal submission, use a live Graph provider endpoint (Subgraph Studio or The Graph Network) for `GRAPH_ENDPOINT`. The AWS Graph Node in `deploy/aws` is useful for reproducible development and for Arc Testnet, but the judge-facing endpoint should be a Graph provider endpoint rather than a local/static dataset.

The provider deployment target for this hackathon is the live **Arc Testnet Shape-C deployment**. The Graph now lists Arc Testnet (`arc-testnet`, chain ID `5042002`) as a supported network, so the judge-facing provider subgraph should index the same Arc contracts used by the Arc + FXSwap demo.

1. In Subgraph Studio, create a subgraph and copy its slug and deploy key.
2. Run:

```bash
GRAPH_STUDIO_SLUG=<studio-slug> \
GRAPH_STUDIO_DEPLOY_KEY=<secret-deploy-key> \
./scripts/deploy-graph-studio.sh
```

3. Copy the resulting Studio query endpoint into `GRAPH_ENDPOINT` for the MCP service. Keep the query/deploy API keys out of git.
4. Run `health`, `protocol_snapshot`, and an agent query through the MCP to demonstrate that the provider endpoint is actually load-bearing.

The deploy script intentionally deploys `packages/subgraph/subgraph.arc.yaml`. The self-hosted AWS Graph Node remains useful as a development/fallback indexer, but the hackathon provider deployment should use The Graph's native Arc Testnet support rather than the old Base-provider workaround.

## Demo proof

A good judge flow is:

- ask the agent for current protocol capital and strategy availability;
- have it call `get_balance`, `get_strategies`, or `list_opportunities` through MCP;
- create/prepare an FX strategy through the typed Shape-C write tools;
- query The Graph again and show the indexed state transition;
- use `graph_query` for an ad-hoc follow-up without adding a bespoke backend endpoint.

This makes The Graph a reusable analytics and agent-data layer rather than a presentation-only dashboard dependency.
