const required = ["GRAPH_ENDPOINT"];
const optional = [
  "GRAPH_AUTH_TOKEN",
  "WRITE_RPC_URL",
  "WRITE_CHAIN_ID",
  "VAULT_REGISTRY_ADDRESS",
  "MCP_WRITE_MODE",
  "WRITE_PRIVATE_KEY",
  "HOST",
  "PORT"
];

const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
  console.error("Copy .env.example to .env or export the values in your shell.");
  process.exit(1);
}

for (const name of optional) {
  if (!process.env[name]) {
    console.warn(`Optional environment variable not set: ${name}`);
  }
}

if (
  process.env.MCP_WRITE_MODE &&
  process.env.MCP_WRITE_MODE !== "prepare" &&
  process.env.MCP_WRITE_MODE !== "execute"
) {
  console.error("MCP_WRITE_MODE must be prepare or execute");
  process.exit(1);
}

console.log("Environment check passed.");
