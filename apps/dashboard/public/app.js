const state = {
  config: null,
  health: null,
  live: null,
  snapshot: null,
  opportunities: null
};

const byId = (id) => document.getElementById(id);

const fields = {
  lastUpdated: byId("last-updated"),
  healthPill: byId("health-pill"),
  metricVaults: byId("metric-vaults"),
  metricStrategies: byId("metric-strategies"),
  metricBlock: byId("metric-block"),
  network: byId("network"),
  registry: byId("registry"),
  rawGraph: byId("raw-graph"),
  vaultGrid: byId("vault-grid"),
  strategyList: byId("strategy-list"),
  preparedKey: byId("prepared-key"),
  preparedClass: byId("prepared-class"),
  preparedNext: byId("prepared-next"),
  preparedCalldata: byId("prepared-calldata")
};

byId("refresh").addEventListener("click", () => {
  void refreshAll();
});

byId("preset-ars").addEventListener("click", () => {
  applyPreset(findPreset("ARS"));
});

byId("preset-brl").addEventListener("click", () => {
  applyPreset(findPreset("BRL"));
});

byId("prepare-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void prepareStrategy();
});

void refreshAll();
setInterval(() => {
  void refreshAll();
}, 15000);

async function refreshAll() {
  const [config, health, live, snapshot, opportunities] = await Promise.allSettled([
    getJson("/api/config"),
    getJson("/api/health"),
    getJson("/api/live"),
    getJson("/api/snapshot"),
    getJson("/api/opportunities")
  ]);

  updateSettled("config", config);
  updateSettled("health", health);
  updateSettled("live", live);
  updateSettled("snapshot", snapshot);
  updateSettled("opportunities", opportunities);

  if (state.config) {
    renderConfig();
  }
  renderHealth();
  renderRawGraph();
  renderVaults();
  renderStrategies();
  fields.lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function updateSettled(key, result) {
  if (result.status === "fulfilled") {
    state[key] = result.value;
  } else {
    state[key] = { error: result.reason?.message || "Request failed" };
  }
}

async function getJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { accept: "application/json", ...(options.headers || {}) },
    ...options
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(value?.error?.message || `HTTP ${response.status}`);
  }
  return value;
}

function renderConfig() {
  fields.network.textContent = state.config.graph.network;
  fields.registry.textContent = state.config.write.vaultRegistryAddress || "-";
  if (!byId("strategist").value) {
    applyPreset(findPreset("ARS") || state.config.presets[0]);
  }
}

function renderHealth() {
  const health = state.health;
  if (!health || health.error) {
    fields.healthPill.textContent = "Graph error";
    fields.healthPill.classList.add("bad");
    fields.metricBlock.textContent = "-";
    return;
  }
  fields.healthPill.textContent = health.ok ? "Healthy" : "Unreachable";
  fields.healthPill.classList.toggle("bad", !health.ok);
  fields.metricBlock.textContent = health.graphBlockNumber || state.live?._meta?.block?.number || "-";
}

function renderRawGraph() {
  fields.rawGraph.textContent = JSON.stringify(state.live, null, 2);
}

function renderVaults() {
  fields.vaultGrid.textContent = "";
  const configVaults = state.config?.deployment?.vaults || {};
  const liveVaults = Array.isArray(state.live?.vaults) ? state.live.vaults : [];
  const snapshotVaults = Array.isArray(state.snapshot?.vaults) ? state.snapshot.vaults : [];
  fields.metricVaults.textContent = state.snapshot?.counts?.vaults?.toString() || liveVaults.length.toString();
  fields.metricStrategies.textContent =
    state.snapshot?.counts?.activeStrategyVaults?.toString() ||
    countActiveStrategyVaults(state.live?.strategyVaults).toString();

  for (const [symbol, address] of Object.entries(configVaults)) {
    const liveVault = findVaultByAddress(liveVaults, address) || findVaultByAddress(snapshotVaults, address);
    const card = document.createElement("article");
    card.className = "vault-card";
    appendHeading(card, symbol.toUpperCase());
    appendSmall(card, address);
    card.appendChild(definitionList([
      ["sharedIdle", liveVault?.raw?.sharedIdle || liveVault?.sharedIdle || "0"],
      ["TVL", liveVault?.raw?.vaultLiveTvl || liveVault?.vaultLiveTvl || "0"],
      ["deployed", liveVault?.raw?.totalDeployed || liveVault?.totalDeployed || "0"],
      ["updated block", liveVault?.updatedAtBlock || "-"]
    ]));
    fields.vaultGrid.appendChild(card);
  }
}

function renderStrategies() {
  fields.strategyList.textContent = "";
  const presets = state.config?.presets || [];
  const liveStrategies = Array.isArray(state.live?.strategies) ? state.live.strategies : [];
  const liveStrategyVaults = Array.isArray(state.live?.strategyVaults) ? state.live.strategyVaults : [];

  for (const preset of presets) {
    const strategy = liveStrategies.find((item) =>
      sameAddress(item.strategyKey, preset.strategyKey) ||
      item.strategyId?.toString() === preset.classId ||
      item.strategyId?.toString() === preset.currentClassId
    );
    const classId = preset.classId || preset.currentClassId || strategy?.strategyId || "0";
    const legs = liveStrategyVaults
      .filter((item) => item.strategyId?.toString() === classId?.toString())
      .map((item) => `${vaultSymbol(item.vault)}: ${item.vault}`);
    const expectedLegs = preset.vaults.map((vault) => `${vaultSymbol(vault)}: ${vault}`);

    const card = document.createElement("article");
    card.className = "strategy-card";
    appendHeading(card, preset.label);
    appendSmall(card, preset.status);
    card.appendChild(definitionList([
      ["strategyKey", preset.strategyKey || strategy?.strategyKey || "-"],
      ["current class", classId],
      ["vault legs", (legs.length > 0 ? legs : expectedLegs).join("\n") || "-"]
    ]));
    fields.strategyList.appendChild(card);
  }
}

async function prepareStrategy() {
  fields.preparedCalldata.textContent = "Preparing calldata...";
  const vaults = byId("vaults").value
    .split(/\s|,/)
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    const result = await getJson("/api/prepare-strategy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategist: byId("strategist").value,
        token0: byId("token0").value,
        token1: byId("token1").value,
        label: byId("label").value,
        vaults
      })
    });
    fields.preparedKey.textContent = result.strategyKey || "-";
    fields.preparedClass.textContent = result.currentClassId || "-";
    fields.preparedNext.textContent = result.stage || "-";
    fields.preparedCalldata.textContent = JSON.stringify(
      {
        prepareOnly: true,
        noBroadcast: true,
        explanation: result.explanation,
        next: result.transactions
      },
      null,
      2
    );
  } catch (error) {
    fields.preparedKey.textContent = "-";
    fields.preparedClass.textContent = "-";
    fields.preparedNext.textContent = "error";
    fields.preparedCalldata.textContent = error.message || "Prepare failed";
  }
}

function applyPreset(preset) {
  if (!preset) {
    return;
  }
  byId("strategist").value = preset.strategist || "";
  byId("label").value = preset.label || "";
  byId("token0").value = preset.token0 || "";
  byId("token1").value = preset.token1 || "";
  byId("vaults").value = (preset.vaults || []).join("\n");
  fields.preparedKey.textContent = preset.strategyKey || "-";
  fields.preparedClass.textContent = preset.classId || preset.currentClassId || "-";
  fields.preparedNext.textContent = preset.nextTransaction?.functionName || "ready";
  fields.preparedCalldata.textContent = JSON.stringify(
    {
      prepareOnly: true,
      noBroadcast: true,
      preset: preset.label,
      nextTransaction: preset.nextTransaction || null
    },
    null,
    2
  );
}

function findPreset(name) {
  return state.config?.presets?.find((preset) => preset.label.toUpperCase().includes(name));
}

function definitionList(items) {
  const dl = document.createElement("dl");
  dl.className = "compact-list";
  for (const [term, detail] of items) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = detail?.toString() || "-";
    row.append(dt, dd);
    dl.appendChild(row);
  }
  return dl;
}

function appendHeading(parent, text) {
  const heading = document.createElement("h3");
  heading.textContent = text;
  parent.appendChild(heading);
}

function appendSmall(parent, text) {
  const small = document.createElement("p");
  small.className = "muted";
  small.textContent = text;
  parent.appendChild(small);
}

function findVaultByAddress(vaults, address) {
  return vaults.find((vault) => sameAddress(vault.address, address));
}

function countActiveStrategyVaults(items) {
  return Array.isArray(items) ? items.filter((item) => item.exists && !item.paused).length : 0;
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function vaultSymbol(address) {
  const vaults = state.config?.deployment?.vaults || {};
  const match = Object.entries(vaults).find(([, value]) => sameAddress(value, address));
  return match ? match[0].toUpperCase() : "Vault";
}
