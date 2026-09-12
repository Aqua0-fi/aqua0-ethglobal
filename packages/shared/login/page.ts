// Privy sign-in page served by the local Aqua0 MCP server or CLI (packages/shared/src/privy.ts). Bundled with esbuild
// into dist/login-page.js. It offers every login method enabled on the Privy app, then posts the Privy access token
// to /callback on the same localhost origin, where it is verified and mapped to the user's Circle wallet.
// Styles live in the HTML shell (loginPageHtml) and follow the Aqua0 web app: dark canvas, aqua accent, Space Grotesk.
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { createElement as h, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

type LoginConfig = { appId: string; clientId?: string; state: string; finished: boolean };
type Outcome = { ok: boolean; title: string; text: string; walletAddress?: string };

const config = (window as unknown as { __AQUA0_LOGIN__: LoginConfig }).__AQUA0_LOGIN__;

/** Aqua0 brand accent (the web app's --primary). */
const ACCENT = "#7FE5E5";
const RETURN_TEXT = "You can close this tab and return to your agent.";

// Stroke icons drawn inline, so the page loads no icon assets.
function icon(...children: ReactNode[]) {
  return h(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true
    },
    ...children
  );
}
const checkIcon = () => icon(h("path", { d: "M20 6 9 17l-5-5" }));
const alertIcon = () => icon(h("circle", { cx: 12, cy: 12, r: 10 }), h("path", { d: "M12 8v4" }), h("path", { d: "M12 16h.01" }));
const copyIcon = () =>
  icon(
    h("rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }),
    h("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
  );

function Spinner() {
  return h("span", { className: "spinner", "aria-hidden": true });
}

function WalletChip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; select the address so it can be copied by hand.
      const node = codeRef.current;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  };

  return h(
    "div",
    { className: "wallet" },
    h("span", { className: "label", id: "wallet-label" }, "Circle wallet · Arc Testnet"),
    h(
      "div",
      { className: "chip" },
      h("code", { ref: codeRef, "aria-labelledby": "wallet-label" }, address),
      h(
        "button",
        { type: "button", className: "copy", onClick: () => void copy() },
        copyIcon(),
        h("span", null, copied ? "Copied" : "Copy"),
        h("span", { className: "sr-only" }, " wallet address")
      )
    )
  );
}

function Login() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const [outcome, setOutcome] = useState<Outcome | null>(
    config.finished ? { ok: true, title: "Already signed in", text: `This sign-in has finished. ${RETURN_TEXT}` } : null
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
          text: RETURN_TEXT,
          ...(body.walletAddress ? { walletAddress: body.walletAddress } : {})
        });
      } catch (error) {
        setOutcome({ ok: false, title: "Sign-in failed", text: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, [ready, authenticated, getAccessToken]);

  if (outcome) {
    return h(
      "div",
      { className: "stack" },
      h("div", { className: outcome.ok ? "badge" : "badge error" }, outcome.ok ? checkIcon() : alertIcon()),
      h("h1", null, outcome.title),
      outcome.walletAddress ? h(WalletChip, { address: outcome.walletAddress }) : null,
      h("p", { className: outcome.ok ? "lead" : "error-text" }, outcome.text),
      outcome.ok
        ? null
        : h(
            "div",
            { className: "actions" },
            h(
              "button",
              {
                type: "button",
                className: "btn",
                onClick: () => {
                  sent.current = false;
                  setOutcome(null);
                  void logout();
                }
              },
              "Try again"
            )
          )
    );
  }
  if (!ready) {
    return h("div", { className: "stack" }, h(Spinner), h("p", { className: "lead" }, "Loading sign-in…"));
  }
  if (authenticated) {
    return h(
      "div",
      { className: "stack" },
      h(Spinner),
      h("h1", null, "Setting up your wallet"),
      h("p", { className: "lead" }, "Checking your sign-in and preparing your Circle wallet on Arc Testnet…")
    );
  }
  return h(
    "div",
    { className: "stack" },
    h("span", { className: "pill" }, "Arc Testnet"),
    h("h1", null, "Sign in to Aqua0"),
    h("p", { className: "lead" }, "Aqua0 creates a Circle wallet for you on Arc Testnet, or reuses the one you already have."),
    h(
      "div",
      { className: "actions" },
      h("button", { type: "button", className: "btn", onClick: () => login() }, "Sign in"),
      h("p", { className: "fine" }, "Sign-in is handled by Privy")
    )
  );
}

/** The shell draws the Aqua0 mark once; the Privy modal reuses it as a data URI. */
function modalLogo(): string | undefined {
  const mark = document.getElementById("aqua0-logo");
  return mark
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(mark))}`
    : undefined;
}

const root = document.getElementById("root");
if (root) {
  const logo = modalLogo();
  createRoot(root).render(
    h(PrivyProvider, {
      appId: config.appId,
      ...(config.clientId ? { clientId: config.clientId } : {}),
      config: {
        appearance: {
          // Privy's stock "dark" is navy; a custom dark hex keeps the modal on the page's neutral canvas.
          theme: "#0e0e0e",
          accentColor: ACCENT,
          landingHeader: "Sign in to Aqua0",
          ...(logo ? { logo } : {})
        }
      },
      children: h(Login)
    })
  );
}
