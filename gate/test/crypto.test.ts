import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, passwordProblem, verifyPassword } from "../src/crypto.ts";

test("password policy uses the same Unicode normalisation as authentication", () => {
  assert.equal(passwordProblem("ｐａｓｓｗｏｒｄ１２３", "sara"), "pwTooCommon");
  assert.equal(passwordProblem("e\u0301".repeat(5), "sara"), "pwTooShort");
});

test("password hashes use independent salts and accept equivalent Unicode", async () => {
  const hash = await hashPassword("Café123456789");
  assert.equal(await verifyPassword("Cafe\u0301123456789", hash), true);
  assert.equal(await verifyPassword("incorrect password", hash), false);
  assert.notEqual(hash, await hashPassword("Café123456789"));
});
