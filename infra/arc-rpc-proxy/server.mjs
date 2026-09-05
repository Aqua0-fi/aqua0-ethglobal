import http from "node:http";

const upstream = process.env.UPSTREAM_RPC ?? "https://rpc.testnet.arc.network";
const port = Number(process.env.PORT ?? "8545");
const maxTopicOr = Number(process.env.MAX_TOPIC_OR ?? "8");
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? "30000");
const retryBaseMs = Number(process.env.RETRY_BASE_MS ?? "300");
const maxRetries = Number(process.env.MAX_RETRIES ?? "8");
const minRequestIntervalMs = Number(process.env.MIN_REQUEST_INTERVAL_MS ?? "300");

let rpcQueue = Promise.resolve();
let lastRpcStart = 0;

if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid PORT");
if (!Number.isSafeInteger(maxTopicOr) || maxTopicOr <= 0) throw new Error("Invalid MAX_TOPIC_OR");

let upstreamId = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcDirect(req) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const body = JSON.stringify({ ...req, id: upstreamId++ });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal
      });
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "0");
        const backoff = retryAfter > 0 ? retryAfter * 1000 : retryBaseMs * 2 ** attempt;
        await sleep(Math.min(backoff, 5000));
        continue;
      }
      if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error?.code === -32016 && attempt < maxRetries) {
        await sleep(Math.min(retryBaseMs * 2 ** attempt, 5000));
        continue;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Upstream retries exhausted");
}

function rpc(req) {
  const task = rpcQueue.then(async () => {
    const waitMs = Math.max(0, minRequestIntervalMs - (Date.now() - lastRpcStart));
    if (waitMs > 0) await sleep(waitMs);
    lastRpcStart = Date.now();
    return rpcDirect(req);
  });
  // Keep the global queue alive even if one caller fails.
  rpcQueue = task.catch(() => undefined);
  return task;
}

function logKey(log) {
  return `${log.blockHash ?? ""}:${log.transactionHash ?? ""}:${log.logIndex ?? ""}`;
}

function hexNumber(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) return 0n;
  return BigInt(value);
}

function sortLogs(a, b) {
  for (const key of ["blockNumber", "transactionIndex", "logIndex"]) {
    const av = hexNumber(a[key]);
    const bv = hexNumber(b[key]);
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

async function handleOne(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }

  const filter = request.method === "eth_getLogs" ? request.params?.[0] : undefined;
  const topicOr = Array.isArray(filter?.topics?.[0]) ? filter.topics[0] : undefined;

  if (!topicOr || topicOr.length <= maxTopicOr) {
    const response = await rpc(request);
    return { ...response, id: request.id ?? null };
  }

  const logs = [];
  for (let i = 0; i < topicOr.length; i += maxTopicOr) {
    const chunk = topicOr.slice(i, i + maxTopicOr);
    const splitFilter = { ...filter, topics: [chunk, ...(filter.topics?.slice(1) ?? [])] };
    const response = await rpc({ ...request, params: [splitFilter, ...(request.params?.slice(1) ?? [])] });
    if (response.error) return { jsonrpc: "2.0", id: request.id ?? null, error: response.error };
    if (!Array.isArray(response.result)) {
      return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32603, message: "Invalid eth_getLogs upstream result" } };
    }
    logs.push(...response.result);
  }

  const unique = [...new Map(logs.map((log) => [logKey(log), log])).values()].sort(sortLogs);
  return { jsonrpc: "2.0", id: request.id ?? null, result: unique };
}

async function handlePayload(payload) {
  if (Array.isArray(payload)) {
    const out = [];
    // Deliberately sequential: Arc's public RPC is rate-limited and Graph already parallelizes requests.
    for (const request of payload) out.push(await handleOne(request));
    return out;
  }
  return handleOne(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream, maxTopicOr }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "POST JSON-RPC only" }));
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await handlePayload(payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "proxy error";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message } }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Arc RPC topic-splitting proxy listening on :${port}, max topic OR=${maxTopicOr}`);
});
