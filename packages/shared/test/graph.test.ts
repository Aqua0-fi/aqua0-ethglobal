import assert from "node:assert/strict";
import test from "node:test";

import { Aqua0Service, GraphClient, GraphRequestError, type FetchLike } from "../src/index.js";

test("GraphClient sends bearer auth and throws structured Graph errors", async () => {
  let authHeader: string | null = null;
  const fetchMock: FetchLike = async (_input, init) => {
    authHeader = new Headers(init?.headers).get("authorization");
    return new Response(
      JSON.stringify({
        errors: [{ message: "bad query" }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const client = new GraphClient({
    endpoint: "https://graph.example/subgraphs/name/aqua0",
    authToken: "secret",
    fetch: fetchMock
  });

  await assert.rejects(
    () => client.query("query { vaults { id } }"),
    (error) => {
      assert.ok(error instanceof GraphRequestError);
      assert.equal(error.message, "Graph query returned errors");
      assert.deepEqual(error.graphErrors, [{ message: "bad query" }]);
      return true;
    }
  );
  assert.equal(authHeader, "Bearer secret");
});

test("getBalance normalizes LP/vault addresses and aggregates raw BigInt strings", async () => {
  const lp = "0xF39Fd6E51AaD88F6F4CE6AB8827279cffFb92266";
  const fetchMock: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { variables: { lp: string } };
    assert.equal(body.variables.lp, lp.toLowerCase());
    return new Response(
      JSON.stringify({
        data: {
          lpVaultPositions: [
            {
              id: "a",
              vault: "0x3600000000000000000000000000000000000000",
              lp: lp.toLowerCase(),
              network: "arc-testnet",
              principal: "100",
              credit: "7",
              deployedByLp: "40",
              freePrincipal: "60",
              frontHeldPrincipal: "0",
              asyncHeld: "3",
              updatedAtBlock: "10",
              updatedAtTimestamp: "20"
            },
            {
              id: "b",
              vault: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              lp: lp.toLowerCase(),
              network: "arc-testnet",
              principal: "900719925474099312345",
              credit: "0",
              deployedByLp: "5",
              freePrincipal: "900719925474099312340",
              frontHeldPrincipal: "1",
              asyncHeld: "0",
              updatedAtBlock: "11",
              updatedAtTimestamp: "21"
            }
          ],
          vaults: [
            {
              id: "v1",
              address: "0x3600000000000000000000000000000000000000",
              asset: "0x3600000000000000000000000000000000000000",
              name: "USDC Interface",
              symbol: "USDCi",
              network: "arc-testnet",
              sharedIdle: "10",
              totalDeployed: "20",
              vaultLiveTvl: "30",
              frontReservedAssets: "0",
              segregatedFees: "0",
              orphanedSegregatedFees: "0",
              paused: false,
              updatedAtBlock: "10",
              updatedAtTimestamp: "20"
            }
          ]
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const service = new Aqua0Service({
    graphEndpoint: "https://graph.example/subgraphs/name/aqua0",
    fetch: fetchMock
  });

  const balance = await service.getBalance(lp);

  assert.equal(balance.address, lp.toLowerCase());
  assert.equal(balance.totals.principal, "900719925474099312445");
  assert.equal(balance.totals.deployedByLp, "45");
  assert.equal(balance.positions[1]?.vault, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(balance.positions[0]?.vaultMetadata?.raw.vaultLiveTvl, "30");
});

test("info redacts endpoint paths, query strings, and userinfo", () => {
  const service = new Aqua0Service({
    graphEndpoint: "https://user:password@gateway.example/api/secret-key/subgraphs/id/abc?api_key=hidden",
    writeRpcUrl: "https://rpc.example/v2/private-token?key=hidden",
    writeChainId: 5042002
  });

  const info = service.info();
  assert.deepEqual(info.endpoints, {
    graphOrigin: "https://gateway.example",
    writeRpcOrigin: "https://rpc.example"
  });
  assert.ok(!JSON.stringify(info).includes("secret-key"));
  assert.ok(!JSON.stringify(info).includes("private-token"));
  assert.ok(!JSON.stringify(info).includes("password"));
});
