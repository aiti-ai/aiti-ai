import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { parseMaxTokenCap } = await loadSubject("./max-token-cap.ts");

test("parses max output caps from provider error messages", () => {
  assert.equal(
    parseMaxTokenCap("The parameter `max_tokens` specified in the request are not valid: integer above maximum value, expected a value <= 128000, but got 131072"),
    128000,
  );
  assert.equal(parseMaxTokenCap("'max_tokens' is invalid: value must be less than or equal to 16384"), 16384);
  assert.equal(parseMaxTokenCap("max_tokens should be at most 8192 tokens"), 8192);
  assert.equal(parseMaxTokenCap("The maximum length of the response is limited to 4096 tokens"), 4096);
  assert.equal(parseMaxTokenCap("max_tokens exceeds the maximum of 1,000,000 tokens"), 1000000);
  assert.equal(parseMaxTokenCap("max_tokens exceeded the limit of 65536 output tokens"), 65536);
});

test("ignores errors without a usable cap", () => {
  assert.equal(parseMaxTokenCap("Incorrect API key provided"), undefined);
  assert.equal(parseMaxTokenCap("Model not found: xyz"), undefined);
  assert.equal(parseMaxTokenCap(""), undefined);
  assert.equal(parseMaxTokenCap("request id 021787447837646252c31405ea13a3faffc9ac5530b150c32ac24"), undefined);
  assert.equal(parseMaxTokenCap(undefined), undefined);
  assert.equal(parseMaxTokenCap("The model is overloaded, try again later"), undefined);
});
