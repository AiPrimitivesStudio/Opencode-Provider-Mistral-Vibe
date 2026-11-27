import assert from "node:assert/strict"
import { test } from "node:test"
import { Catalog, Event } from "../src/protocol.ts"

const sampleCatalog = {
  type: "catalog",
  version: "3.1.3",
  source: "remote",
  models: [
    {
      id: "zai-glm-5-3-flash",
      name: "GLM 5.3 Flash",
      context: 200000,
      output: 65536,
      images: false,
      efforts: [],
      authenticated: true,
    },
  ],
}

test("Catalog parses a well-formed probe response", () => {
  const parsed = Catalog.parse(sampleCatalog)
  assert.equal(parsed.source, "remote")
  assert.equal(parsed.models[0].id, "zai-glm-5-3-flash")
  assert.equal(parsed.models[0].authenticated, true)
})

test("Catalog accepts hidden flag and rejects negative context", () => {
  assert.ok(Catalog.safeParse({ ...sampleCatalog, models: [{ ...sampleCatalog.models[0], hidden: true }] }).success)
  assert.equal(
    Catalog.safeParse({ ...sampleCatalog, models: [{ ...sampleCatalog.models[0], context: -1 }] }).success,
    false,
  )
})

test("Event discriminates text, error and result payloads", () => {
  assert.equal(Event.parse({ type: "text", text: "WORKING" }).type, "text")
  assert.equal(Event.parse({ type: "reasoning", text: "thinking..." }).type, "reasoning")
  const error = Event.parse({ type: "error", message: "boom", status: 402 })
  assert.equal(error.status, 402)
  const result = Event.parse({
    type: "result",
    parts: [{ type: "text", text: "OK" }],
    finish_reason: "stop",
    usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 },
  })
  assert.equal(result.finish_reason, "stop")
  assert.equal(Event.safeParse({ type: "nonsense" }).success, false)
})
