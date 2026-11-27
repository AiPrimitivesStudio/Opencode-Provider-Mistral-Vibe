import assert from "node:assert/strict"
import { test } from "node:test"
import { opencodeFetch, poll } from "./helpers.mjs"

// End-to-end acceptance: through the running opencode server (the same service
// the user's sessions use), the mistral-vibe provider must expose the
// authenticated model catalog and answer a real prompt.

const MODEL = { id: "zai-glm-5-3-flash", providerID: "mistral-vibe" }

test("server exposes the full authenticated mistral-vibe catalog", async () => {
  const { status, json } = await opencodeFetch("/api/model")
  assert.equal(status, 200)
  const models = json.data.filter((model) => model.providerID === "mistral-vibe")
  assert.ok(models.length >= 5, `expected >=5 mistral-vibe models on the server, got ${models.length}`)
  assert.ok(
    models.some((model) => model.id === "zai-glm-5-3-flash"),
    "server catalog must include zai-glm-5-3-flash",
  )
})

test("mistral-vibe connection is not in needs_auth", async () => {
  const { status, json } = await opencodeFetch("/api/integration/mistral-vibe")
  assert.equal(status, 200)
  const connections = json.data.connections ?? []
  assert.ok(connections.length > 0, "mistral-vibe must have at least one connection")
  const active = connections.filter((connection) => !connection.status)
  assert.ok(active.length > 0, `expected a healthy (non needs_auth) connection, got ${JSON.stringify(connections)}`)
})

test("a prompt through the server gets an assistant answer", async () => {
  // Fresh session so the test never touches the user's existing sessions.
  const created = await opencodeFetch("/api/session", { method: "POST", body: { title: "mistral-vibe plugin e2e test" } })
  assert.equal(created.status, 200, `session creation failed: ${JSON.stringify(created.json).slice(0, 200)}`)
  const sessionID = created.json.data?.id ?? created.json.data?.sessionID ?? created.json.data?.id
  assert.ok(sessionID, `could not read session id from response: ${JSON.stringify(created.json).slice(0, 300)}`)
  try {
    // The prompt API has no model field: the session model must be switched first.
    const switched = await opencodeFetch(`/api/session/${sessionID}/model`, {
      method: "POST",
      body: { model: MODEL },
    })
    assert.ok(switched.status < 300, `switchModel failed (${switched.status}): ${JSON.stringify(switched.json).slice(0, 200)}`)

    const prompt = await opencodeFetch(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: { text: "Reply with exactly OK and nothing else.", agent: "build" },
    })
    assert.equal(prompt.status, 200, `prompt failed: ${JSON.stringify(prompt.json).slice(0, 300)}`)

    // Wait for the assistant turn to finish with text.
    const answer = await poll(
      async () => {
        const { json } = await opencodeFetch(`/api/session/${sessionID}/message?limit=10`)
        const messages = json.data
        const assistant = messages.find((message) => message.type === "assistant")
        if (!assistant) return undefined
        const text = (assistant.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
        return text.trim() ? { assistant, text } : undefined
      },
      { label: "assistant answer", timeoutMs: 120_000 },
    )
    assert.ok(answer.text.length > 0, "assistant message must contain text")
    assert.equal(answer.assistant.model?.providerID, "mistral-vibe")
    assert.equal(answer.assistant.model?.id, "zai-glm-5-3-flash")

    // The session must settle without an error outcome.
    const idle = await poll(
      async () => {
        const { json } = await opencodeFetch(`/api/session/${sessionID}/message?limit=10`)
        const messages = json.data
        const latest = messages[0]
        return latest?.type === "idle" ? latest : undefined
      },
      { label: "session idle", timeoutMs: 60_000 },
    )
    assert.equal(idle.outcome, "succeeded", `session must end succeeded, got: ${JSON.stringify(idle).slice(0, 200)}`)
  } finally {
    await opencodeFetch(`/api/session/${sessionID}`, { method: "DELETE" })
  }
})
