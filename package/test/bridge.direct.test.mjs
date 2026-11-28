import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { environment } from "../src/process.ts"
import { runBridge, vibePython, bridgePath } from "./helpers.mjs"

// The bridge child must receive exactly the environment the plugin injects —
// these tests run bridge.py the way the opencode server does.
const bridgeEnv = () => JSON.parse(environment())

test("resolve_api_key returns the OIDC credential marker, not a raw key", async () => {
  // This is the regression test for the "Mistral Vibe is not logged in" failure:
  // it happens when resolve_api_key returns nothing, i.e. the OIDC session is not
  // reachable through the injected environment.
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      vibePython(),
      ["-c", "from vibe.utils.api_keys import resolve_api_key; print(resolve_api_key('MISTRAL_API_KEY') or 'NONE')"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: bridgeEnv() },
    )
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (err += c))
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`python exited ${code}: ${err.slice(0, 500)}`)),
    )
  })
  assert.ok(
    output.startsWith("vibe-cli-oidc"),
    `resolve_api_key must resolve to the OIDC marker under the plugin environment, got: ${output}`,
  )
})

test("bridge probe returns the remote authenticated catalog", async () => {
  const { events } = await runBridge({ type: "probe" }, { env: bridgeEnv() })
  const catalog = events.find((event) => event.type === "catalog")
  assert.ok(catalog, "probe must emit a catalog event")
  assert.equal(catalog.source, "remote", "probe must fetch the catalog from the Vibe backend, not fall back to local")
  assert.ok(catalog.models.length >= 5, `expected the full model catalog, got ${catalog.models.length} models`)
  assert.ok(
    catalog.models.every((model) => model.authenticated),
    "every model in the probe catalog must be authenticated",
  )
  assert.ok(
    catalog.models.some((model) => model.id === "zai-glm-5-3-flash"),
    "catalog must include zai-glm-5-3-flash",
  )
})

test("bridge generate completes a chat against the Vibe plan", async () => {
  const { events } = await runBridge(
    {
      type: "generate",
      model: "zai-glm-5-3-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK" }] }],
      tools: [],
    },
    { env: bridgeEnv(), timeoutMs: 120_000 },
  )
  const result = events.find((event) => event.type === "result")
  assert.ok(result, "generate must emit a result event")
  assert.equal(result.finish_reason, "stop", `expected finish_reason stop, got ${result.finish_reason}`)
  const text = events
    .filter((event) => event.type === "text")
    .map((event) => event.text)
    .join("")
  assert.ok(text.trim().length > 0, "generate must produce non-empty text")
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
  ]) {
    assert.equal(typeof result.usage[key], "number", `usage.${key} must be a number`)
  }
})

test("bridge generate with an unknown model reports a clean error", async () => {
  const { events } = await runBridge(
    {
      type: "generate",
      model: "definitely-not-a-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
    },
    { env: bridgeEnv() },
  )
  const error = events.find((event) => event.type === "error")
  assert.ok(error, "unknown model must emit an error event, not a crash")
  assert.match(error.message, /no longer available|not logged in/)
})

test("bridge.py requests carry the vibe_code billing metadata (source contract)", async () => {
  // Mistral routes the request to the Vibe plan budget only when the completion
  // body carries call_source "vibe_code". Guard the wiring at source level.
  const source = readFileSync(bridgePath, "utf8")
  assert.match(source, /"call_source":\s*"vibe_code"/, "bridge must set metadata.call_source = vibe_code")
  assert.match(source, /call_type/, "bridge must send the vibe metadata block")
  assert.ok(source.includes("ProviderCredentialSnapshot"), "bridge must pass the OIDC credential snapshot")
})

test("bridge.py must not dump full requests to disk (privacy)", async () => {
  const source = readFileSync(bridgePath, "utf8")
  assert.ok(!source.includes("bridge-last-request"), "the bridge must not persist user prompts/requests to disk")
})
