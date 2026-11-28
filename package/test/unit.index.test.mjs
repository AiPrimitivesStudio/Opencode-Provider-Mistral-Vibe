import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { poll, sleep } from "./helpers.mjs"

// setup() is driven with a mocked opencode context; the bridge probe runs
// against the scripted fake bridge so refresh() is exercised end to end.
process.env.OPENCODE_VIBE_BRIDGE = fileURLToPath(new URL("./fixtures/fake-bridge.py", import.meta.url))
delete process.env.FAKE_BRIDGE_SCENARIO

const { vibePython } = await import("./helpers.mjs")
process.env.OPENCODE_VIBE_PYTHON = process.env.OPENCODE_VIBE_PYTHON ?? vibePython()

const plugin = (await import("../src/index.ts")).default

function mockContext({ workspaceID, saved, connection } = {}) {
  const calls = {
    storageSet: [],
    status: [],
    reloads: 0,
    hooks: [],
    providerAdd: null,
    adds: [],
    integrationUpdate: null,
    methodUpdate: null,
  }
  const queue = []
  const makeEditor = () => ({
    add: (entry) => {
      calls.providerAdd = entry
      calls.adds.push(entry)
    },
  })
  let transform
  const ctx = {
    location: { workspaceID },
    storage: {
      get: async (key) => (key === "catalog" ? saved : undefined),
      set: async (key, value) => calls.storageSet.push({ key, value }),
    },
    provider: {
      transform: async (editor) => {
        transform = editor
        editor(makeEditor())
      },
      reload: async () => {
        calls.reloads++
        if (transform) transform(makeEditor())
      },
    },
    integration: {
      transform: async (editor) =>
        editor({
          update: (id, update) => {
            const target = {}
            update(target)
            calls.integrationUpdate = { id, target }
          },
          method: { update: (entry) => (calls.methodUpdate = entry) },
        }),
      connection: {
        active: async () => connection,
        status: async (entry) => calls.status.push(entry),
      },
    },
    aisdk: { hook: async (kind, hook, options) => calls.hooks.push({ kind, hook, options }) },
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length) yield queue.shift()
            else await new Promise((resolve) => setTimeout(resolve, 10))
          }
        },
      }),
    },
    queue,
    calls,
  }
  return ctx
}

const CONNECTION = { id: "cred_test" }

test("setup skips entirely inside a workspace instance", async () => {
  const ctx = mockContext({ workspaceID: "ws_1" })
  const teardown = await plugin.setup(ctx)
  assert.equal(teardown, undefined)
  assert.equal(ctx.calls.hooks.length, 0)
})

test("setup registers the provider, integration and sdk hook, then refreshes", async () => {
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    assert.equal(ctx.calls.providerAdd.info.name, "Mistral Vibe")
    assert.ok(
      ctx.calls.providerAdd.models.some((model) => model.id === "fake-model"),
      "after the probe refreshes, the registered models must come from the bridge catalog",
    )
    assert.equal(ctx.calls.integrationUpdate.id, "mistral-vibe")
    assert.equal(ctx.calls.integrationUpdate.target.name, "Mistral Vibe")
    assert.equal(ctx.calls.methodUpdate.integrationID, "mistral-vibe")
    assert.equal(ctx.calls.hooks.length, 1)
    assert.equal(ctx.calls.reloads, 1, "refresh must reload the provider")
    assert.ok(ctx.calls.status.length >= 1, "refresh must report connection status")
    assert.equal(ctx.calls.status.at(-1).status, undefined, "authenticated catalog must clear needs_auth")
    assert.ok(ctx.calls.storageSet.some((entry) => entry.key === "catalog"))
  } finally {
    await teardown()
  }
})

test("a stored catalog is used until the probe replaces it", async () => {
  const saved = {
    type: "catalog",
    version: "3.1.3",
    source: "cache",
    models: [
      { id: "saved-model", name: "Saved", context: 5, output: 5, images: false, efforts: [], authenticated: true },
    ],
  }
  const ctx = mockContext({ saved, connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    assert.ok(
      ctx.calls.adds[0].models.some((model) => model.id === "saved-model"),
      "the stored catalog must register first",
    )
  } finally {
    await teardown()
  }
})

test("an unreadable stored catalog falls back to an empty one", async () => {
  const ctx = mockContext({ saved: { nonsense: true }, connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    assert.deepEqual(ctx.calls.adds[0].models, [])
  } finally {
    await teardown()
  }
})

test("refresh marks the connection needs_auth when no model is authenticated", async () => {
  process.env.FAKE_BRIDGE_SCENARIO = "unauthenticated-catalog"
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    assert.equal(ctx.calls.status.at(-1).status.status, "needs_auth")
    assert.match(ctx.calls.status.at(-1).status.message, /not logged in/)
  } finally {
    await teardown()
    delete process.env.FAKE_BRIDGE_SCENARIO
  }
})

test("needs_auth names the plugin-managed login command when the runtime is bootstrapped", async () => {
  const root = join(tmpdir(), `vibe-hint-${process.pid}`)
  const dir = join(root, "3.1.3")
  const binDir = process.platform === "win32" ? "Scripts" : "bin"
  const exe = process.platform === "win32" ? "python.exe" : "python"
  const vibe = process.platform === "win32" ? "vibe.exe" : "vibe"
  mkdirSync(join(dir, binDir), { recursive: true })
  writeFileSync(join(dir, binDir, exe), "")
  writeFileSync(join(dir, "opencode-runtime.json"), JSON.stringify({ version: "3.1.3" }))
  const previousBase = process.env.OPENCODE_VIBE_RUNTIME_DIR
  process.env.OPENCODE_VIBE_RUNTIME_DIR = root
  process.env.FAKE_BRIDGE_SCENARIO = "unauthenticated-catalog"
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    assert.match(ctx.calls.status.at(-1).status.message, /not logged in/)
    assert.ok(
      ctx.calls.status.at(-1).status.message.includes(join(dir, binDir, vibe)),
      `the login hint must name the managed vibe binary, got: ${ctx.calls.status.at(-1).status.message}`,
    )
  } finally {
    await teardown()
    delete process.env.FAKE_BRIDGE_SCENARIO
    if (previousBase === undefined) delete process.env.OPENCODE_VIBE_RUNTIME_DIR
    else process.env.OPENCODE_VIBE_RUNTIME_DIR = previousBase
    rmSync(root, { recursive: true, force: true })
  }
})

test("refresh surfaces bridge probe failures on the connection status", async () => {
  process.env.FAKE_BRIDGE_SCENARIO = "bridge-error"
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    assert.equal(ctx.calls.status.at(-1).status.status, "needs_auth")
    assert.equal(ctx.calls.status.at(-1).status.message, "boom from fake bridge")
  } finally {
    await teardown()
    delete process.env.FAKE_BRIDGE_SCENARIO
  }
})

test("refresh runs again when the credential is switched", async () => {
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    const reloads = ctx.calls.reloads
    ctx.queue.push({ type: "credential.switched", data: { integrationID: "mistral-vibe" } })
    await poll(() => ctx.calls.reloads === reloads + 1, {
      timeoutMs: 5000,
      intervalMs: 25,
      label: "matching switch refresh",
    })
    const settled = ctx.calls.reloads
    ctx.queue.push({ type: "credential.switched", data: { integrationID: "someone-else" } })
    await poll(() => ctx.queue.length === 0, {
      timeoutMs: 5000,
      intervalMs: 25,
      label: "foreign switch consumption",
    })
    // The event was consumed and ignored; a refresh takes well over one
    // iterator tick (10ms), so a quiet window proves no probe started.
    await sleep(150)
    assert.equal(ctx.calls.reloads, settled, "a foreign switch must be ignored")
  } finally {
    await teardown()
  }
})

test("refresh failures log the real error message", async () => {
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  const logged = []
  const originalError = console.error
  console.error = (...args) => logged.push(args.map((value) => String(value)).join(" "))
  try {
    ctx.storage.set = async () => {
      throw new Error("storage exploded")
    }
    ctx.queue.push({ type: "credential.switched", data: { integrationID: "mistral-vibe" } })
    const deadline = Date.now() + 5000
    while (!logged.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.ok(
      logged.some((line) => line.includes("storage exploded")),
      `the real cause must be logged, got: ${JSON.stringify(logged)}`,
    )
  } finally {
    console.error = originalError
    await teardown()
  }
})

test("registered models carry costs, filtered effort variants and hidden handling", async () => {
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    const models = ctx.calls.providerAdd.models
    const priced = models.find((model) => model.id === "zai-glm-5-3-flash")
    assert.ok(priced, "the priced fixture model must be registered")
    assert.equal(priced.cost.length, 1, "a model with an API_PRICES entry must report a cost")
    assert.equal(priced.cost[0].input, 0.15)
    assert.deepEqual(
      priced.variants.map((variant) => variant.settings.effort),
      ["low", "high"],
    )
    const filtered = models.find((model) => model.id === "deepseek-v4-1-flash-1017")
    assert.ok(filtered, "the fallback fixture model must be registered")
    assert.deepEqual(
      filtered.variants.map((variant) => variant.settings.effort),
      ["low", "high"],
      "a refused effort level must be filtered from the offered variants",
    )
    const hidden = models.find((model) => model.id === "hidden-model")
    assert.ok(hidden, "the hidden fixture model must be registered")
    assert.equal(hidden.enabled, false, "a hidden model must be registered disabled")
    assert.equal(
      models.find((model) => model.id === "fake-model").enabled,
      true,
      "a non-hidden model must be registered enabled",
    )
  } finally {
    await teardown()
  }
})

test("concurrent refreshes are serialized so results cannot overwrite each other", async () => {
  const ctx = mockContext({ connection: CONNECTION })
  let inFlight = 0
  let maxInFlight = 0
  const originalSet = ctx.storage.set
  ctx.storage.set = async (key, value) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await sleep(150)
      return await originalSet(key, value)
    } finally {
      inFlight--
    }
  }
  // A switch event landing during startup races the initial refresh; the two
  // probe results must never be applied out of order or concurrently.
  ctx.queue.push({ type: "credential.switched", data: { integrationID: "mistral-vibe" } })
  const teardown = await plugin.setup(ctx)
  try {
    await poll(() => ctx.calls.reloads >= 2, { timeoutMs: 10_000, intervalMs: 25, label: "both refreshes" })
    assert.equal(maxInFlight, 1, "refresh runs must be serialized, not overlapping")
  } finally {
    await teardown()
  }
})

test("the sdk hook installs a VibeModel for the vibe package only", async () => {
  const ctx = mockContext({ connection: CONNECTION })
  const teardown = await plugin.setup(ctx)
  try {
    const { hook } = ctx.calls.hooks[0]
    const foreign = { package: "other", sdk: {} }
    hook(foreign)
    assert.equal(foreign.sdk.languageModel, undefined, "foreign packages must be ignored")
    const ours = { package: "@opencode/vibe-agent", sdk: {} }
    hook(ours)
    assert.equal(typeof ours.sdk.languageModel, "function")
  } finally {
    await teardown()
  }
})
