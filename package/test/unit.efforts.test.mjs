import assert from "node:assert/strict"
import { test } from "node:test"
import { offered, effective } from "../src/efforts.ts"

test("offered() hides only the levels the model refuses", () => {
  assert.equal(offered("deepseek-v4-1-flash-1017", "medium"), false)
  assert.equal(offered("deepseek-v4-1-flash-1017", "low"), true)
  assert.equal(offered("deepseek-v4-1-flash-1017", "high"), true)
  assert.equal(offered("zai-glm-5-3-flash", "medium"), true)
  assert.equal(offered("unknown-model", "medium"), true)
})

test("effective() replaces refused levels and passes the rest through", () => {
  assert.equal(effective("deepseek-v4-1-flash-1017", "medium"), "high")
  assert.equal(effective("deepseek-v4-1-flash-1017", "low"), "low")
  assert.equal(effective("zai-glm-5-3-flash", "medium"), "medium")
  assert.equal(effective("zai-glm-5-3-flash", undefined), undefined)
})
