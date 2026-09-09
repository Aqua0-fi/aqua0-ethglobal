#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAqua0Service, isExecutionAllowedByConfig } from "@aqua0/shared";
import { z } from "zod";

import { readMcpConfig, type McpConfig } from "./config.js";

const config = readMcpConfig();

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function createAqua0McpServer(config: McpConfig): McpServer {
  const aqua0 = createAqua0Service(config);
  const server = new McpServer({
    name: "aqua0-continuity",
    version: "0.1.0"
  });

  server.tool("health", {}, async () => jsonText(await aqua0.health()));
  server.tool(
    "info",
    {
      includeConfig: z
        .boolean()
        .optional()
        .describe("Include non-secret endpoint origins and write-mode configuration in the response")
    },
    async ({ includeConfig }) => {
      const info = aqua0.info();
      return jsonText(includeConfig ? info : { ...info, endpoints: undefined });
    }
  );
  server.tool(
    "get_balance",
    {
      address: z.string().describe("LP address")
    },
    async ({ address }) => jsonText(await aqua0.getBalance(address))
  );
  server.tool(
    "get_strategies",
    {
      address: z.string().describe("LP address")
    },
    async ({ address }) => jsonText(await aqua0.getStrategies(address))
  );
  server.tool(
    "get_fees",
    {
      address: z.string().describe("LP address"),
      periodSeconds: z.number().int().positive().optional()
    },
    async ({ address, periodSeconds }) => jsonText(await aqua0.getFees(address, periodSeconds))
  );
  server.tool("list_opportunities", {}, async () => jsonText(await aqua0.listOpportunities()));
  server.tool("protocol_snapshot", {}, async () => jsonText(await aqua0.getProtocolSnapshot()));
  server.tool(
    "graph_query",
    {
      query: z.string().describe("Raw GraphQL query for advanced agents"),
      variables: z.record(z.unknown()).optional().describe("GraphQL variables")
    },
    async ({ query, variables }) => jsonText(await aqua0.rawGraphQuery(query, variables))
  );
  server.tool(
    "prepare_create_strategy",
    {
      strategist: z.string(),
      token0: z.string(),
      token1: z.string(),
      label: z.string(),
      vaults: z.array(z.string()).min(1)
    },
    async (input) => jsonText(await aqua0.prepareCreateStrategy(input))
  );
  server.tool(
    "prepare_authorize_strategy",
    {
      vault: z.string(),
      strategyId: z.string(),
      backing: z.boolean()
    },
    async (input) => jsonText(aqua0.prepareAuthorizeStrategy(input))
  );
  server.tool(
    "prepare_deposit",
    {
      vault: z.string(),
      assets: z.string().describe("Raw asset amount in vault units"),
      receiver: z.string()
    },
    async (input) => jsonText(aqua0.prepareDeposit(input))
  );
  server.tool(
    "prepare_withdraw",
    {
      vault: z.string(),
      assets: z.string().describe("Raw asset amount in vault units"),
      receiver: z.string(),
      owner: z.string()
    },
    async (input) => jsonText(aqua0.prepareWithdraw(input))
  );

  if (config.mcpWriteMode === "execute") {
    server.tool(
      "create_strategy",
      {
        strategist: z.string(),
        token0: z.string(),
        token1: z.string(),
        label: z.string(),
        vaults: z.array(z.string()).min(1)
      },
      async (input) => jsonText(await aqua0.executeCreateStrategy(input))
    );
    server.tool(
      "authorize_strategy",
      {
        vault: z.string(),
        strategyId: z.string(),
        backing: z.boolean()
      },
      async (input) => jsonText(await aqua0.executeAuthorizeStrategy(input))
    );
  }

  return server;
}

async function startStdio(config: McpConfig): Promise<void> {
  const server = createAqua0McpServer(config);
  await server.connect(new StdioServerTransport());
}

async function startHttp(config: McpConfig): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const health = await createAqua0Service(config).health();
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
      return;
    }

    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const server = createAqua0McpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    try {
      await server.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(req, res, req.method === "POST" ? await readJson(req) : undefined);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Internal server error"
            },
            id: null
          })
        );
      }
    }
  });

  httpServer.listen(config.port, config.host, () => {
    const writeMode = isExecutionAllowedByConfig(config) ? "execute-enabled" : config.mcpWriteMode;
    console.error(
      `aqua0 MCP HTTP listening on http://${config.host}:${config.port}/mcp (${writeMode})`
    );
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (config.transport === "http") {
  await startHttp(config);
} else {
  await startStdio(config);
}
