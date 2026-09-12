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
  /** Optional Privy app client id (public), e.g. a client whose allowed origins include the local login page. */
  privyClientId?: string;
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
    ...(env.PRIVY_CLIENT_ID?.trim() ? { privyClientId: env.PRIVY_CLIENT_ID.trim() } : {}),
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
  /** Privy app client id, when the login page should use a specific app client. */
  clientId?: string;
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
      sendHtml(res, loginPageHtml(options.appId, options.clientId, state, settled));
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

/** The Aqua0 pixel-drop mark from the web app (public/aqua0-logo.svg), one 0.86 square per grid cell of a 57-unit box. */
const LOGIN_LOGO_PATH = "M28.07 0.07h.86v.86h-.86zm0 1h.86v.86h-.86zm-1 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-2 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-2 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-3 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-4 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-5 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-6 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm2 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-7 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm2 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-8 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-9 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-11 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-13 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-14 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-15 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-17 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-19 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-21 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-22 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-23 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm2 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-25 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-27 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm4 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-28 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm7 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm7 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-29 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm8 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-31 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm8 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-32 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm10 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-33 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm12 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-34 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm12 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-35 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm14 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-36 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm16 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-37 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm16 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm18 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm18 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm20 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm20 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm20 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm20 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm20 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm18 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-38 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm18 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-37 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm18 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm5 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-36 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm16 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-36 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm14 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-35 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm12 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-34 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm8 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm6 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-33 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm7 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm7 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-32 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm7 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm7 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-31 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm8 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm8 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-29 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm22 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-27 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm18 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-25 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm16 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-23 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm10 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-20 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-16 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm-11 1h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86zm1 0h.86v.86h-.86z";

function loginPageHtml(appId: string, clientId: string | undefined, state: string, finished: boolean): string {
  const config = JSON.stringify({ appId, ...(clientId ? { clientId } : {}), state, finished }).replace(/</g, "\\u003c");
  // Palette, type and radius mirror the Aqua0 web app (app/globals.css): dark-only canvas, aqua #7FE5E5 accent,
  // Space Grotesk, 12px radius, glass card over a faint dot field. Rules stay scoped so the Privy modal keeps its own.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#060606">
<title>Sign in to Aqua0</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&amp;family=Space+Grotesk:wght@400;500;600;700&amp;display=swap">
<style>
  :root {
    color-scheme: dark;
    --bg: #060606;
    --fg: #f8f8f8;
    --fg-muted: rgba(248, 248, 248, 0.64);
    --fg-subtle: rgba(248, 248, 248, 0.5);
    --line: rgba(255, 255, 255, 0.08);
    --line-strong: rgba(255, 255, 255, 0.12);
    --aqua: #7fe5e5;
    --aqua-hover: #73cfcf;
    --on-aqua: #0b0b0b;
    --danger: #f87171;
    --radius: 12px;
    --sans: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--bg);
  }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 32px 16px; box-sizing: border-box; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
  .backdrop { position: fixed; inset: 0; pointer-events: none; background: radial-gradient(70% 50% at 50% 100%, rgba(127, 229, 229, 0.08), transparent 70%); }
  .backdrop::before { content: ""; position: absolute; inset: 0; opacity: 0.2; background-image: radial-gradient(circle, #fff 0.9px, transparent 1.4px); background-size: 11px 11px; -webkit-mask-image: radial-gradient(ellipse 75% 65% at 50% 45%, transparent 30%, #000 90%); mask-image: radial-gradient(ellipse 75% 65% at 50% 45%, transparent 30%, #000 90%); }
  .card, .card * { box-sizing: border-box; }
  .card { position: relative; width: 100%; max-width: 440px; display: flex; flex-direction: column; align-items: center; gap: 28px; padding: 40px 24px; text-align: center; border: 1px solid var(--line); border-radius: 16px; background: rgba(255, 255, 255, 0.02); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5); }
  .logo { display: block; width: 44px; height: 44px; flex: none; }
  .content { width: 100%; }
  .card h1 { margin: 0; font-size: clamp(24px, 6.4vw, 30px); line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; }
  .card :focus-visible { outline: 2px solid var(--aqua); outline-offset: 3px; }
  .stack { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .lead { margin: 0; max-width: 36ch; font-size: 14px; line-height: 1.6; color: var(--fg-muted); text-wrap: balance; }
  .fine { margin: 0; font-size: 12px; color: var(--fg-subtle); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border: 1px solid rgba(127, 229, 229, 0.4); border-radius: 999px; background: rgba(127, 229, 229, 0.1); color: var(--aqua); font-size: 11px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase; }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--aqua); box-shadow: 0 0 6px var(--aqua); }
  .actions { display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%; margin-top: 8px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; width: 100%; max-width: 320px; min-height: 44px; padding: 0 24px; border: 0; border-radius: 999px; background: var(--aqua); color: var(--on-aqua); font: 600 15px/1 var(--sans); cursor: pointer; transition: background-color 0.15s ease, transform 0.15s ease; }
  .btn:hover { background: var(--aqua-hover); }
  .btn:active { transform: translateY(1px); }
  .badge { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; border: 1px solid rgba(127, 229, 229, 0.35); background: rgba(127, 229, 229, 0.1); color: var(--aqua); }
  .badge.error { border-color: rgba(248, 113, 113, 0.35); background: rgba(248, 113, 113, 0.1); color: var(--danger); }
  .badge svg { width: 22px; height: 22px; }
  .error-text { margin: 0; max-width: 36ch; max-height: 6rem; overflow-y: auto; font-size: 13px; line-height: 1.55; color: var(--danger); overflow-wrap: anywhere; }
  .wallet { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 360px; }
  .label { font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-subtle); }
  .chip { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 6px 6px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: rgba(255, 255, 255, 0.04); }
  .chip code { flex: 0 1 auto; min-width: 0; max-width: 22ch; font: 500 13px/1.45 var(--mono); color: var(--fg); text-align: left; overflow-wrap: anywhere; user-select: all; }
  .copy { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: transparent; color: var(--fg-muted); font: 500 12px/1 var(--sans); cursor: pointer; transition: background-color 0.15s ease, color 0.15s ease; }
  .copy:hover { background: rgba(255, 255, 255, 0.06); color: var(--fg); }
  .copy svg { width: 14px; height: 14px; }
  .spinner { display: block; width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(127, 229, 229, 0.2); border-top-color: var(--aqua); animation: aqua0-spin 0.8s linear infinite; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @keyframes aqua0-spin { to { transform: rotate(360deg); } }
  @media (min-width: 480px) { .card { padding: 48px 44px; } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } .btn, .copy { transition: none; } }
</style>
</head>
<body>
<div class="backdrop" aria-hidden="true"></div>
<main class="card">
<svg class="logo" id="aqua0-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 57 57" width="44" height="44" fill="#ffffff" role="img" aria-label="Aqua0"><path d="${LOGIN_LOGO_PATH}"/></svg>
<div id="root" class="content" aria-live="polite"><div class="stack"><span class="spinner" aria-hidden="true"></span><p class="lead">Loading sign-in…</p></div></div>
</main>
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
