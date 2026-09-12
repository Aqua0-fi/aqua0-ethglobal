// Privy sign-in page served by the local Aqua0 MCP server or CLI (packages/shared/src/privy.ts). Bundled with esbuild
// into dist/login-page.js. It offers every login method enabled on the Privy app, then posts the Privy access token
// to /callback on the same localhost origin, where it is verified and mapped to the user's Circle wallet.
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { createElement as h, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type LoginConfig = { appId: string; clientId?: string; state: string; finished: boolean };
type Outcome = { ok: boolean; title: string; text: string };

const config = (window as unknown as { __AQUA0_LOGIN__: LoginConfig }).__AQUA0_LOGIN__;

function Login() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const [outcome, setOutcome] = useState<Outcome | null>(
    config.finished
      ? { ok: true, title: "Already signed in", text: "This sign-in has finished. Return to your agent." }
      : null
  );
  const sent = useRef(config.finished);

  useEffect(() => {
    if (!ready || !authenticated || sent.current) {
      return;
    }
    sent.current = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        const response = await fetch("/callback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, state: config.state })
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string; walletAddress?: string | null };
        if (!response.ok) {
          throw new Error(body.error ?? `Sign-in failed (HTTP ${response.status})`);
        }
        setOutcome({
          ok: true,
          title: "Signed in to Aqua0",
          text: body.walletAddress
            ? `Your Circle wallet on Arc Testnet is ${body.walletAddress}. You can close this tab and go back to your agent.`
            : "You can close this tab and go back to your agent."
        });
      } catch (error) {
        setOutcome({ ok: false, title: "Sign-in failed", text: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, [ready, authenticated, getAccessToken]);

  if (outcome) {
    return h(
      "div",
      null,
      h("h1", null, outcome.title),
      h("p", null, outcome.text),
      outcome.ok
        ? null
        : h(
            "button",
            {
              onClick: () => {
                sent.current = false;
                setOutcome(null);
                void logout();
              }
            },
            "Try again"
          )
    );
  }
  if (!ready) {
    return h("p", null, "Loading sign-in…");
  }
  if (authenticated) {
    return h("p", null, "Checking your sign-in and preparing your Circle wallet…");
  }
  return h(
    "div",
    null,
    h("h1", null, "Sign in to Aqua0"),
    h(
      "p",
      null,
      "Use any sign-in method below. Aqua0 then creates your Circle wallet on Arc Testnet, or reuses it if you signed in before."
    ),
    h("button", { onClick: () => login() }, "Sign in")
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    h(PrivyProvider, {
      appId: config.appId,
      ...(config.clientId ? { clientId: config.clientId } : {}),
      children: h(Login)
    })
  );
}
