#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAqua0Service } from "@aqua0/shared";
import { z } from "zod";

import { readMcpConfig } from "./config.js";

const config = readMcpConfig();
const aqua0 = createAqua0Service(config);

const server = new McpServer({
  name: "aqua0-continuity",
  version: "0.1.0"
});

server.tool("health", {}, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(aqua0.health(), null, 2)
    }
  ]
}));

server.tool(
  "info",
  {
    includeConfig: z
      .boolean()
      .optional()
      .describe("Include public endpoint configuration in the response")
  },
  async ({ includeConfig }) => {
    const info = aqua0.info();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            includeConfig ? info : { ...info, endpoints: undefined },
            null,
            2
          )
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
