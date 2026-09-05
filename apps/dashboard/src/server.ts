import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { type Aqua0Service } from "@aqua0/shared";

import { ApiError, parsePrepareStrategyInput, readJsonBody } from "./body.js";
import { type PublicDashboardConfig } from "./config.js";

export type DashboardService = Pick<
  Aqua0Service,
  "health" | "getProtocolSnapshot" | "listOpportunities" | "rawGraphQuery" | "prepareCreateStrategy"
>;

type DashboardServerOptions = {
  service: DashboardService;
  publicConfig: PublicDashboardConfig;
  publicDir: string;
  docsDir: string;
};

const securityHeaders: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer"
};

const liveQuery = `query Aqua0ArcLive {
  _meta { block { number } }
  vaults(first: 10, orderBy: updatedAtTimestamp, orderDirection: desc) {
    id address asset name symbol network sharedIdle totalDeployed vaultLiveTvl frontReservedAssets segregatedFees orphanedSegregatedFees paused updatedAtBlock updatedAtTimestamp
  }
  strategies(first: 10, orderBy: updatedAtTimestamp, orderDirection: desc) {
    id strategyId strategyKey registry network firstSeenBlock firstSeenTimestamp updatedAtBlock updatedAtTimestamp
  }
  strategyVaults(first: 20, orderBy: updatedAtTimestamp, orderDirection: desc) {
    id vault strategyId network exists strategist paused committedBacking deployedAssets availableFor sharePriceRay settlementRoute updatedAtBlock updatedAtTimestamp
  }
}`;

const allowedDocs = new Set(["ARCHITECTURE.md", "ARC_DEPLOYMENT.md", "THE_GRAPH_TRACK.md"]);

export function createDashboardServer(options: DashboardServerOptions) {
  return createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", errorMessage(error));
      sendJson(response, apiError.status, {
        error: {
          code: apiError.code,
          message: apiError.message
        }
      });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardServerOptions
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dashboard.local");
  setSecurityHeaders(response);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url.pathname, options);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendMethodNotAllowed(response, ["GET", "HEAD"]);
    return;
  }

  if (url.pathname.startsWith("/docs/")) {
    await serveDoc(response, url.pathname, options.docsDir, request.method === "HEAD");
    return;
  }

  await serveStatic(response, url.pathname, options.publicDir, request.method === "HEAD");
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: DashboardServerOptions
): Promise<void> {
  if (pathname === "/api/health") {
    if (!requireMethod(request, response, ["GET"])) return;
    sendJson(response, 200, await options.service.health());
    return;
  }
  if (pathname === "/api/snapshot") {
    if (!requireMethod(request, response, ["GET"])) return;
    sendJson(response, 200, await options.service.getProtocolSnapshot());
    return;
  }
  if (pathname === "/api/opportunities") {
    if (!requireMethod(request, response, ["GET"])) return;
    sendJson(response, 200, await options.service.listOpportunities());
    return;
  }
  if (pathname === "/api/live") {
    if (!requireMethod(request, response, ["GET"])) return;
    sendJson(response, 200, await options.service.rawGraphQuery(liveQuery));
    return;
  }
  if (pathname === "/api/config") {
    if (!requireMethod(request, response, ["GET"])) return;
    sendJson(response, 200, options.publicConfig);
    return;
  }
  if (pathname === "/api/prepare-strategy") {
    if (!requireMethod(request, response, ["POST"])) return;
    const body = await readJsonBody(request, {
      contentLength: firstHeader(request.headers["content-length"]),
      contentType: firstHeader(request.headers["content-type"])
    });
    const input = parsePrepareStrategyInput(body);
    sendJson(response, 200, await options.service.prepareCreateStrategy(input));
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "API route not found" } });
}

function requireMethod(
  request: IncomingMessage,
  response: ServerResponse,
  allowed: string[]
): boolean {
  if (!request.method || !allowed.includes(request.method)) {
    sendMethodNotAllowed(response, allowed);
    return false;
  }
  return true;
}

async function serveStatic(
  response: ServerResponse,
  pathname: string,
  publicDir: string,
  headOnly: boolean
): Promise<void> {
  const decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const filePath = resolve(publicDir, `.${decodedPath}`);
  if (!isWithin(publicDir, filePath)) {
    sendPlain(response, 404, "Not found");
    return;
  }

  await serveFile(response, filePath, contentTypeFor(filePath), headOnly);
}

async function serveDoc(
  response: ServerResponse,
  pathname: string,
  docsDir: string,
  headOnly: boolean
): Promise<void> {
  const docName = decodeURIComponent(pathname.slice("/docs/".length));
  if (!allowedDocs.has(docName)) {
    sendPlain(response, 404, "Not found");
    return;
  }
  await serveFile(response, resolve(docsDir, docName), "text/markdown; charset=utf-8", headOnly);
}

async function serveFile(
  response: ServerResponse,
  filePath: string,
  contentType: string,
  headOnly: boolean
): Promise<void> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendPlain(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      ...securityHeaders,
      "content-type": contentType,
      "content-length": fileStat.size.toString()
    });
    if (!headOnly) {
      await pipeline(createReadStream(filePath), response);
    } else {
      response.end();
    }
  } catch {
    sendPlain(response, 404, "Not found");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString()
  });
  response.end(body);
}

function sendPlain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message).toString()
  });
  response.end(message);
}

function sendMethodNotAllowed(response: ServerResponse, allowed: string[]): void {
  response.writeHead(405, {
    ...securityHeaders,
    allow: allowed.join(", "),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: { code: "method_not_allowed", message: "Method not allowed" } }));
}

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    response.setHeader(name, value);
  }
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function isWithin(root: string, filePath: string): boolean {
  const normalizedRoot = resolve(root);
  return filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected server error";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
