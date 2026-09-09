import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { ApiError, MAX_JSON_BODY_BYTES, parsePrepareStrategyInput, readJsonBody } from "../src/body.js";

test("readJsonBody rejects payloads above 32KB before parsing", async () => {
  await assert.rejects(
    readJsonBody(Readable.from([Buffer.alloc(MAX_JSON_BODY_BYTES + 1)]), {
      contentType: "application/json"
    }),
    (error) => error instanceof ApiError && error.status === 413
  );
});

test("readJsonBody returns strict JSON errors", async () => {
  await assert.rejects(
    readJsonBody(Readable.from(["{not-json"]), { contentType: "application/json" }),
    (error) =>
      error instanceof ApiError && error.status === 400 && error.code === "invalid_json"
  );
});

test("parsePrepareStrategyInput trims and validates create strategy input", () => {
  const parsed = parsePrepareStrategyInput({
    strategist: " 0x1111111111111111111111111111111111111111 ",
    token0: "0x2222222222222222222222222222222222222222",
    token1: "0x3333333333333333333333333333333333333333",
    label: " FXSwap ARS ",
    vaults: [" 0x4444444444444444444444444444444444444444 "]
  });

  assert.deepEqual(parsed, {
    strategist: "0x1111111111111111111111111111111111111111",
    token0: "0x2222222222222222222222222222222222222222",
    token1: "0x3333333333333333333333333333333333333333",
    label: "FXSwap ARS",
    vaults: ["0x4444444444444444444444444444444444444444"]
  });
});
