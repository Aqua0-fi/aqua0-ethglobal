/**
 * Privy sign-in for a local Aqua0 MCP server or CLI, feeding the Circle signer.
 *
 * `startPrivyLogin` serves a Privy login page on http://localhost:<port>, offering every login method the Privy app
 * enables. The page posts the user's Privy access token back to that server, which verifies it against Privy's
 * public JWKS (no app secret needed) and hands the Privy user id (`did:privy:...`) to the caller. The caller uses it
 * as the Circle wallet refId. Only the DID and wallet address are saved (`~/.aqua0/session.json`); Privy tokens are
 * never stored.
 *
 * Local sign-in chooses which Circle wallet this machine signs with. It is not isolation between users: whoever holds
 * the Circle API key and entity secret here can sign for any refId. A hosted server keeps those secrets to itself.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const PRIVY_DEFAULT_LOGIN_PORT = 8787;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_CALLBACK_BYTES = 16_384;

export type PrivyEnvConfig = {
  /** Privy app id (public). */
  privyAppId?: string;
  /** Port of the local login page; allow `http://localhost:<port>` in the Privy dashboard. Default 8787. */
  privyLoginPort?: number;
  /** Where the signed-in Privy user id is saved. Default `~/.aqua0/session.json`. */
  aqua0SessionFile?: string;
};

export function readPrivyEnv(env: Readonly<Record<string, string | undefined>>): PrivyEnvConfig {
  const port = env.PRIVY_LOGIN_PORT?.trim() ? Number(env.PRIVY_LOGIN_PORT) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("PRIVY_LOGIN_PORT must be a TCP port number");
  }
  return {
    ...(env.PRIVY_APP_ID?.trim() ? { privyAppId: env.PRIVY_APP_ID.trim() } : {}),
    ...(port === undefined ? {} : { privyLoginPort: port }),
    ...(env.AQUA0_SESSION_FILE?.trim() ? { aqua0SessionFile: env.AQUA0_SESSION_FILE.trim() } : {})
  };
}

// ---------------------------------------------------------------------------------------------
// token verification

export type PrivyIdentity = {
  /** Privy user id, e.g. `did:privy:cm...`: stable across sessions and login methods linked to the account. */
  did: string;
  sessionId?: string;
  expiresAt: number;
};

const jwksByApp = new Map<string, JWTVerifyGetKey>();

/** Privy's public signing keys for an app (the endpoint `@privy-io/node` verifies against). */
export function privyJwksUrl(appId: string): URL {
  return new URL(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`);
}

/** Verifies a Privy access token (ES256, issuer `privy.io`, audience = app id) and returns the user's DID. */
export async function verifyPrivyAccessToken(
  token: string,
  appId: string,
  keys?: JWTVerifyGetKey
): Promise<PrivyIdentity> {
  let getKey = keys ?? jwksByApp.get(appId);
  if (!getKey) {
    getKey = createRemoteJWKSet(privyJwksUrl(appId));
    jwksByApp.set(appId, getKey);
  }
  const { payload } = await jwtVerify(token, getKey, {
    issuer: "privy.io",
    audience: appId,
    algorithms: ["ES256"],
    clockTolerance: 30
  });
  if (typeof payload.sub !== "string" || !payload.sub.startsWith("did:privy:")) {
    throw new Error("Privy token subject is not a did:privy user id");
  }
  return {
    did: payload.sub,
    ...(typeof payload.sid === "string" ? { sessionId: payload.sid } : {}),
    expiresAt: payload.exp ?? 0
  };
}

// ---------------------------------------------------------------------------------------------
// saved session

export type Aqua0Session = {
  version: 1;
  privyAppId: string;
  did: string;
  circleWalletSetId?: string;
  walletAddress?: string;
  signedInAt: string;
};

export function sessionFilePath(file?: string): string {
  return file ?? join(homedir(), ".aqua0", "session.json");
}

export function readSession(file?: string): Aqua0Session | undefined {
  const path = sessionFilePath(file);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const session = JSON.parse(readFileSync(path, "utf8")) as Partial<Aqua0Session>;
    return session.version === 1 &&
      typeof session.privyAppId === "string" &&
      typeof session.did === "string" &&
      session.did.startsWith("did:privy:")
      ? (session as Aqua0Session)
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeSession(session: Aqua0Session, file?: string): void {
  const path = sessionFilePath(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

/** Deletes the saved session; returns whether one existed. */
export function clearSession(file?: string): boolean {
  const path = sessionFilePath(file);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return existed;
}

// ---------------------------------------------------------------------------------------------
// local login server

export type PrivyLogin<T> = {
  url: string;
  port: number;
  /** Settles with `onIdentity`'s result once a verified sign-in arrives, or rejects on timeout or close. */
  completed: Promise<T>;
  close(): void;
};

export type PrivyLoginOptions<T> = {
  appId: string;
  /** Default 8787; 0 picks a free port (tests). */
  port?: number;
  onIdentity: (identity: PrivyIdentity) => Promise<T>;
  /** Token check; defaults to `verifyPrivyAccessToken` against the app's JWKS. */
  verify?: (token: string) => Promise<PrivyIdentity>;
  timeoutMs?: number;
  /** Bundled login page script; defaults to `login-page.js` next to this module. */
  pageScriptPath?: string;
};

/**
 * Serves the Privy login page on localhost until one verified sign-in completes. The callback accepts only a
 * same-origin POST carrying this login's random state, so another site cannot complete it.
 */
export async function startPrivyLogin<T>(options: PrivyLoginOptions<T>): Promise<PrivyLogin<T>> {
  const state = randomBytes(24).toString("base64url");
  const verify = options.verify ?? ((token: string) => verifyPrivyAccessToken(token, options.appId));
  let resolveCompleted!: (value: T) => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<T>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // Callers that only want the URL may never await this.
  completed.catch(() => undefined);

  let port = options.port ?? PRIVY_DEFAULT_LOGIN_PORT;
  let settled = false;
  let busy = false;
  const servers: Server[] = [];
  const timer = setTimeout(() => finish(new Error("Privy sign-in timed out after 10 minutes; start it again")), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timer.unref();

  function finish(outcome: Error | { value: T }): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    // Let the last response flush before the listeners go away.
    setTimeout(() => servers.forEach((server) => server.close()), 250).unref();
    if (outcome instanceof Error) {
      rejectCompleted(outcome);
    } else {
      resolveCompleted(outcome.value);
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => sendJson(res, 500, { error: errorText(error) }));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = `http://localhost:${port}`;
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) {
      sendJson(res, 403, { error: `Open the sign-in page at ${origin}/login` });
      return;
    }
    const path = new URL(req.url ?? "/", origin).pathname;
    if (req.method === "GET" && (path === "/" || path === "/login")) {
      if (req.headers.host !== `localhost:${port}`) {
        res.writeHead(302, { location: `${origin}/login` }).end();
        return;
      }
      sendHtml(res, loginPageHtml(options.appId, state, settled));
      return;
    }
    if (req.method === "GET" && path === "/login.js") {
      sendScript(res, readLoginScript(options.pageScriptPath));
      return;
    }
    if (req.method === "POST" && path === "/callback") {
      if (req.headers.origin !== origin) {
        sendJson(res, 403, { error: `Sign-in must come from ${origin}` });
        return;
      }
      if (settled || busy) {
        sendJson(res, 409, { error: settled ? "This sign-in already finished; start a new one" : "A sign-in is being processed" });
        return;
      }
      let body: { token?: unknown; state?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch (error) {
        sendJson(res, 400, { error: errorText(error) });
        return;
      }
      if (body.state !== state) {
        sendJson(res, 403, { error: "Sign-in state does not match; start the sign-in again" });
        return;
      }
      if (typeof body.token !== "string" || body.token.length === 0) {
        sendJson(res, 400, { error: "token is required" });
        return;
      }
      busy = true;
      try {
        let identity: PrivyIdentity;
        try {
          identity = await verify(body.token);
        } catch (error) {
          sendJson(res, 401, { error: `Privy token rejected: ${errorText(error)}` });
          return;
        }
        let value: T;
        try {
          value = await options.onIdentity(identity);
        } catch (error) {
          // Leave the login open so the user can retry from the page.
          sendJson(res, 500, { error: errorText(error) });
          return;
        }
        sendJson(res, 200, value);
        finish({ value });
      } finally {
        busy = false;
      }
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  }

  const primary = createServer(handler);
  await listen(primary, port, "127.0.0.1");
  servers.push(primary);
  const address = primary.address();
  port = typeof address === "object" && address ? address.port : port;
  // Browsers may resolve localhost to ::1 first; serve it too when the host has IPv6.
  const ipv6 = createServer(handler);
  await listen(ipv6, port, "::1").then(
    () => servers.push(ipv6),
    () => undefined
  );

  return {
    url: `http://localhost:${port}/login`,
    port,
    completed,
    close: () => finish(new Error("Privy sign-in was cancelled"))
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.close();
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} is in use; stop whatever uses it or set PRIVY_LOGIN_PORT (and allow that origin in Privy)`)
          : error
      );
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function loginPageHtml(appId: string, state: string, finished: boolean): string {
  const config = JSON.stringify({ appId, state, finished }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aqua0 sign-in</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #f4f6f8; color: #14171a; }
  main { background: #fff; border-radius: 14px; padding: 32px; width: min(440px, calc(100vw - 48px)); box-shadow: 0 2px 12px rgba(20, 23, 26, 0.08); }
  h1 { font-size: 22px; margin: 0 0 8px; }
  button { font: inherit; padding: 10px 20px; border: 0; border-radius: 8px; background: #14171a; color: #fff; cursor: pointer; }
  code { word-break: break-all; }
</style>
</head>
<body>
<main id="root"><p>Loading sign-in…</p></main>
<script>window.__AQUA0_LOGIN__ = ${config};</script>
<script type="module" src="/login.js"></script>
</body>
</html>`;
}

function readLoginScript(path?: string): string {
  const file = path ?? fileURLToPath(new URL("./login-page.js", import.meta.url));
  if (!existsSync(file)) {
    throw new Error("The login page bundle is missing; run pnpm --filter @aqua0/shared build");
  }
  return readFileSync(file, "utf8");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CALLBACK_BYTES) {
        reject(new Error("Sign-in request is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
}

function sendScript(res: ServerResponse, script: string): void {
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(script);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
