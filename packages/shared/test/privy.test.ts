import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import {
  clearSession,
  readPrivyEnv,
  readSession,
  startPrivyLogin,
  verifyPrivyAccessToken,
  writeSession
} from "../src/privy.js";

const APP_ID = "test-app-id";
const DID = "did:privy:cmtestuser0001";

async function signer() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: { sub?: string; aud?: string; iss?: string; exp?: string }) =>
    new SignJWT({ sid: "session-1" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject(claims.sub ?? DID)
      .setAudience(claims.aud ?? APP_ID)
      .setIssuer(claims.iss ?? "privy.io")
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "1h")
      .sign(privateKey);
  return { keys, sign };
}

test("Privy access tokens verify against the app's keys and yield the did:privy user id", async () => {
  const { keys, sign } = await signer();
  const identity = await verifyPrivyAccessToken(await sign({}), APP_ID, keys);
  assert.equal(identity.did, DID);
  assert.equal(identity.sessionId, "session-1");

  await assert.rejects(verifyPrivyAccessToken(await sign({ aud: "another-app" }), APP_ID, keys), /aud/);
  await assert.rejects(verifyPrivyAccessToken(await sign({ iss: "evil.example" }), APP_ID, keys), /iss/);
  await assert.rejects(verifyPrivyAccessToken(await sign({ sub: "user-1" }), APP_ID, keys), /did:privy/);
  await assert.rejects(verifyPrivyAccessToken(await sign({ exp: "-2m" }), APP_ID, keys), /exp/);
  const other = await signer();
  await assert.rejects(verifyPrivyAccessToken(await other.sign({}), APP_ID, keys), /signature/);
});

test("the saved session holds only the Privy user id and wallet, readable by the owner only", () => {
  const file = join(mkdtempSync(join(tmpdir(), "aqua0-session-")), "nested", "session.json");
  assert.equal(readSession(file), undefined);
  writeSession(
    { version: 1, privyAppId: APP_ID, did: DID, circleWalletSetId: "set-1", walletAddress: "0xabc", signedInAt: "2026-09-12T00:00:00.000Z" },
    file
  );
  assert.equal(readSession(file)?.did, DID);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(clearSession(file), true);
  assert.equal(readSession(file), undefined);
  assert.equal(clearSession(file), false);

  assert.deepEqual(readPrivyEnv({ PRIVY_APP_ID: ` ${APP_ID} `, PRIVY_LOGIN_PORT: "9001" }), {
    privyAppId: APP_ID,
    privyLoginPort: 9001
  });
  assert.throws(() => readPrivyEnv({ PRIVY_LOGIN_PORT: "http" }), /TCP port/);
});

test("the local login server completes only for a same-origin callback with its state and a verified token", async () => {
  const seen: string[] = [];
  const login = await startPrivyLogin({
    appId: APP_ID,
    port: 0,
    verify: async (token) => {
      if (token !== "good-token") {
        throw new Error("bad token");
      }
      return { did: DID, expiresAt: 0 };
    },
    onIdentity: async (identity) => {
      seen.push(identity.did);
      return { did: identity.did, walletAddress: "0xwallet" };
    }
  });
  const origin = `http://localhost:${login.port}`;
  assert.equal(login.url, `${origin}/login`);

  const page = await fetch(login.url);
  const html = await page.text();
  const state = /"state":"([^"]+)"/.exec(html)?.[1];
  assert.equal(page.status, 200);
  assert.ok(html.includes(APP_ID) && state);

  const post = (body: unknown, headers: Record<string, string> = { origin }) =>
    fetch(`${origin}/callback`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  assert.equal((await post({ token: "good-token", state }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ token: "good-token", state: "wrong" })).status, 403);
  assert.equal((await post({ token: "bad-token", state })).status, 401);
  assert.deepEqual(seen, []);

  const ok = await post({ token: "good-token", state });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { did: DID, walletAddress: "0xwallet" });
  assert.deepEqual(await login.completed, { did: DID, walletAddress: "0xwallet" });
  assert.equal((await post({ token: "good-token", state })).status, 409);
});

test("a cancelled login rejects its completion", async () => {
  const login = await startPrivyLogin({ appId: APP_ID, port: 0, verify: async () => ({ did: DID, expiresAt: 0 }), onIdentity: async () => ({}) });
  login.close();
  await assert.rejects(login.completed, /cancelled/);
});
