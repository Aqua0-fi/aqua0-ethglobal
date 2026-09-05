import { Aqua0Service } from "@aqua0/shared";

import { readDashboardConfig } from "./config.js";
import { createDashboardServer } from "./server.js";

const config = await readDashboardConfig();
const service = new Aqua0Service(config.service);
const server = createDashboardServer({
  service,
  publicConfig: config.publicConfig,
  publicDir: config.publicDir,
  docsDir: config.docsDir
});

server.listen(config.port, config.host, () => {
  console.log(`Aqua0 dashboard listening on http://${config.host}:${config.port}`);
});
