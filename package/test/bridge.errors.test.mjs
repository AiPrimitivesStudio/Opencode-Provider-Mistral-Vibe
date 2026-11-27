import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { runBridge, bridgePath } from "./helpers.mjs"

// Direct bridge behaviour: failures must reach the user with their real cause,
// not a generic mask. The bridge used to replace every failure with
// "Mistral Vibe bridge failed (SDKError). Check the Vibe installation..." which
// hid 402s, timeouts and auth details.

test("generate without any credential reports what was actually checked", async () => {
  // Simulate the worst case: no env var, no keyring backend, no OIDC session.
  const stripped = { ...process.env }
  for (const key of ["VIBE_CLI_OIDC_ENABLED", "PYTHON_KEYRING_BACKEND", "PYTHONPATH", "MISTRAL_API_KEY"]) {
    delete stripped[key]
  }
  const { events } = await runBridge(
    {
      type: "generate",
      model: "mistral-large-4-0",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    },
    { env: stripped, timeoutMs: 90_000 },
  )
  const error = events.find((event) => event.type === "error")
  assert.ok(error, "expected an error event without credentials")
  assert.match(error.message, /No Mistral credential/, "must state the real cause")
  assert.match(error.message, /MISTRAL_API_KEY/, "must mention what was checked")
  assert.match(error.message, /VIBE_CLI_OIDC_ENABLED/, "must mention the OIDC flag state")
})

test("bridge.py no longer masks failures with the generic installation message", async () => {
  const source = readFileSync(bridgePath, "utf8")
  assert.ok(
    !source.includes("Check the Vibe installation and run vibe --setup"),
    "the generic mask must be gone",
  )
})
