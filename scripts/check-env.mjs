const required = ["GRAPH_ENDPOINT"];
const optional = ["AQUA0_API_URL", "ARC_RPC_URL"];

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

console.log("Environment check passed.");
