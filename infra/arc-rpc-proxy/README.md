# Arc RPC topic-splitting proxy

Arc Testnet's public RPC rejects `eth_getLogs` when topic0 contains a large OR-list. The Shape-C AssetVault template intentionally indexes many canonical accounting events, so Graph Node can exceed that provider limit even for a one-block query.

This tiny JSON-RPC proxy is only a compatibility shim. For `eth_getLogs` requests whose first topic is an OR-list longer than `MAX_TOPIC_OR` (default 8), it splits the request into smaller upstream calls, merges/deduplicates the logs, and preserves canonical block/transaction/log ordering. Every other RPC method passes through unchanged.
