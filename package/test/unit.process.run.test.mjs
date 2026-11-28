import assert from "node:assert/strict"
import { test, beforeEach, afterEach } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// run() spawns the bridge resolved by python()/BRIDGE. Point both at the
// scripted fake bridge so the whole spawn/parse/kill machinery is exercised.
process.env.OPENCODE_VIBE_BRIDGE = fileURLToPath(new URL("./fixtures/fake-bridge.py", import.meta.url))
process.env.FAKE_BRIDGE_WARM_PID_FILE = join(tmpdir(), `fake-bridge-warm-${process.pid}.pid`)

const { vibePython } = await import("./helpers.mjs")
process.env.OPENCODE_VIBE_PYTHON = process.env.OPENCODE_VIBE_PYTHON ?? vibePython()

const { run, python, shutdown, environment } = await import("../src/process.ts")

const pidFile = join(tmpdir(), `fake-bridge-run-${process.pid}.pid`)
const generate = (scenario) => ({ type: "generate", scenario, pidFile, messages: [], tools: [] })
const readPid = () => parseInt(writeRead(pidFile), 10)
import { readFileSync as _readFileSync } from "node:fs"
function writeRead(path) {
  return _readFileSync(path, "utf8").trim()
}
const collect = () => {
  const events = []
  return { events, emit: (event) => events.push(event) }
}

let tempDirs = []
beforeEach(() => {
  tempDirs.push(mkdtempSync(join(tmpdir(), "vibe-test-")))
})
afterEach(() => {
  shutdown()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("run() resolves a catalog event and exposes it to the caller", async () => {
  const { events, emit } = collect()
  await run({ type: "probe" }, emit, new AbortController().signal)
  assert.equal(events.at(-1).type, "catalog")
  assert.equal(events.at(-1).source, "remote")
})

test("run() streams text and reasoning events before the result", async () => {
  const { events, emit } = collect()
  await run(generate("stream"), emit, new AbortController().signal)
  assert.deepEqual(
    events.map((event) => event.type),
    ["reasoning", "text", "text", "result"],
  )
  assert.equal(events.at(-1).finish_reason, "stop")
})

test("run() rejects with the bridge error message and status", async () => {
  const { emit } = collect()
  await assert.rejects(
    run(generate("bridge-error"), emit, new AbortController().signal),
    (error) => error.message === "boom from fake bridge" && error.status === 402,
  )
})

test("run() rejects invalid JSON from the bridge", async () => {
  const { emit } = collect()
  await assert.rejects(run(generate("invalid-json"), emit, new AbortController().signal), (error) =>
    /Invalid response from the Mistral Vibe bridge/.test(error.message),
  )
})

test("run() rejects events that fail the protocol schema, naming the failing field", async () => {
  const { emit } = collect()
  await assert.rejects(
    run(generate("schema-invalid"), emit, new AbortController().signal),
    (error) =>
      /Invalid response from the Mistral Vibe bridge/.test(error.message) &&
      /schema error at models\.0\./.test(error.message),
  )
})

test("run() rejects data emitted after the final event", async () => {
  const { emit } = collect()
  await assert.rejects(
    run(generate("data-after-terminal"), emit, new AbortController().signal),
    (error) => error.message === "Data after final Vibe response",
  )
})

test("run() rejects when the bridge exits without a final event", async () => {
  const { emit } = collect()
  await assert.rejects(run(generate("no-terminal"), emit, new AbortController().signal), (error) =>
    /stopped before completing/.test(error.message),
  )
})

test("run() rejects on a nonzero exit code", async () => {
  const { emit } = collect()
  await assert.rejects(run(generate("nonzero-exit"), emit, new AbortController().signal), (error) =>
    /stopped before completing/.test(error.message),
  )
})

test("run() rejects trailing bytes after the final event", async () => {
  const { emit } = collect()
  await assert.rejects(run(generate("trailing-bytes"), emit, new AbortController().signal), (error) =>
    /stopped before completing/.test(error.message),
  )
})

test("run() rejects an oversized protocol message", async () => {
  const { emit } = collect()
  await assert.rejects(run(generate("oversized"), emit, new AbortController().signal), (error) =>
    /oversized protocol message/.test(error.message),
  )
})

test("run() aborts a hanging bridge with the signal reason", async () => {
  const abort = new AbortController()
  abort.abort(new Error("user pressed escape"))
  await assert.rejects(
    run(generate("hang"), collect().emit, abort.signal),
    (error) => error.message === "user pressed escape",
  )
})

test("run() aborts mid-flight when the signal fires later", async () => {
  const abort = new AbortController()
  // Abort deterministically on the first streamed event instead of a timer:
  // mid-flight by construction, no load-sensitive wait.
  const events = []
  const emit = (event) => {
    events.push(event)
    abort.abort(new Error("cancelled mid-flight"))
  }
  await assert.rejects(run(generate("hang"), emit, abort.signal), (error) => error.message === "cancelled mid-flight")
  assert.equal(events.length, 1, "the abort must fire after the first event, mid-flight")
})

test("run() rejects when the Python executable cannot start", async () => {
  const previous = process.env.OPENCODE_VIBE_PYTHON
  process.env.OPENCODE_VIBE_PYTHON = "Z:\\definitely\\not\\an\\executable.exe"
  try {
    await assert.rejects(
      run(generate(), collect().emit, new AbortController().signal),
      (error) => /Cannot start the Mistral Vibe Python environment/.test(error.message) && /ENOENT/.test(error.message),
    )
  } finally {
    process.env.OPENCODE_VIBE_PYTHON = previous
  }
})

test("a prewarmed worker is reused by the next generate request", async () => {
  const first = collect()
  await run(generate(), first.emit, new AbortController().signal)
  const coldPid = readPid()
  const warmPidFile = process.env.FAKE_BRIDGE_WARM_PID_FILE
  // The standby worker spawned after the first request registers its pid.
  const warmPid = await new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      try {
        resolve(parseInt(_readFileSync(warmPidFile, "utf8").trim(), 10))
        clearInterval(timer)
      } catch {
        if (Date.now() - start > 5000) {
          clearInterval(timer)
          resolve(null)
        }
      }
    }, 50)
  })
  assert.ok(warmPid, "prewarm worker must register its pid")
  assert.notEqual(warmPid, coldPid)

  const second = collect()
  await run(generate(), second.emit, new AbortController().signal)
  assert.equal(readPid(), warmPid, "second request must reuse the warm worker")

  const third = collect()
  await run(generate(), third.emit, new AbortController().signal)
  assert.notEqual(readPid(), warmPid, "third request takes the next warm worker")
})

test("changing the environment discards the warm worker", async () => {
  const previous = process.env.VIBE_TEST_ENV_MARKER
  process.env.VIBE_TEST_ENV_MARKER = "one"
  try {
    const one = collect()
    await run(generate(), one.emit, new AbortController().signal)
    const pidOne = readPid()

    process.env.VIBE_TEST_ENV_MARKER = "two"
    const two = collect()
    await run(generate(), two.emit, new AbortController().signal)
    assert.notEqual(readPid(), pidOne, "env change must prevent warm reuse")
  } finally {
    // Restore even when an assertion fails: the leftover marker would change
    // environment() for every later test in this file.
    if (previous === undefined) delete process.env.VIBE_TEST_ENV_MARKER
    else process.env.VIBE_TEST_ENV_MARKER = previous
  }
})

test("environment() reflects a changed environment", () => {
  const before = environment()
  const previous = process.env.VIBE_TEST_ENV_MARKER
  process.env.VIBE_TEST_ENV_MARKER = "changed"
  try {
    assert.notEqual(environment(), before)
  } finally {
    if (previous === undefined) delete process.env.VIBE_TEST_ENV_MARKER
    else process.env.VIBE_TEST_ENV_MARKER = previous
  }
})

test("python() prefers OPENCODE_VIBE_PYTHON", async () => {
  assert.equal(await python(), vibePython())
})

test("python() resolves a sibling interpreter next to the vibe launcher", async () => {
  const previousPython = process.env.OPENCODE_VIBE_PYTHON
  delete process.env.OPENCODE_VIBE_PYTHON
  const dir = tempDirs[tempDirs.length - 1]
  const launcher = join(dir, "vibe")
  writeFileSync(launcher, "")
  process.env.OPENCODE_VIBE_PATH = launcher
  writeFileSync(join(dir, "python.exe"), "")
  try {
    // python() resolves the launcher through the native async realpath, which
    // expands 8.3 short path components (GitHub runners expose TMP as
    // C:\Users\RUNNER~1). The expectation must use the exact same resolver.
    const realDir = dirname(await realpath(launcher))
    assert.equal(await python(), join(realDir, "python.exe"))
  } finally {
    delete process.env.OPENCODE_VIBE_PATH
    process.env.OPENCODE_VIBE_PYTHON = previousPython
  }
})

test("python() falls back to the interpreter in the shebang", async () => {
  const previousPython = process.env.OPENCODE_VIBE_PYTHON
  delete process.env.OPENCODE_VIBE_PYTHON
  const dir = tempDirs[tempDirs.length - 1]
  const launcher = join(dir, "vibe")
  writeFileSync(launcher, "#!/custom/python\n")
  process.env.OPENCODE_VIBE_PATH = launcher
  try {
    assert.equal(await python(), "/custom/python")
  } finally {
    delete process.env.OPENCODE_VIBE_PATH
    process.env.OPENCODE_VIBE_PYTHON = previousPython
  }
})

test("python() tolerates a CRLF shebang line", async () => {
  const previousPython = process.env.OPENCODE_VIBE_PYTHON
  delete process.env.OPENCODE_VIBE_PYTHON
  const dir = tempDirs[tempDirs.length - 1]
  const launcher = join(dir, "vibe")
  // Windows tooling can write launchers with CRLF endings; the trailing \r
  // must not become part of the interpreter path (spawn would fail ENOENT).
  writeFileSync(launcher, "#!/custom/python\r\n")
  process.env.OPENCODE_VIBE_PATH = launcher
  try {
    assert.equal(await python(), "/custom/python")
  } finally {
    delete process.env.OPENCODE_VIBE_PATH
    process.env.OPENCODE_VIBE_PYTHON = previousPython
  }
})

test("python() throws when no Vibe installation can be found", async () => {
  const previousPython = process.env.OPENCODE_VIBE_PYTHON
  const previousPath = process.env.PATH
  const previousProfile = process.env.USERPROFILE
  delete process.env.OPENCODE_VIBE_PYTHON
  delete process.env.OPENCODE_VIBE_PATH
  process.env.PATH = join(tempDirs[tempDirs.length - 1], "empty")
  mkdirSync(process.env.PATH, { recursive: true })
  process.env.USERPROFILE = join(tempDirs[tempDirs.length - 1], "home")
  mkdirSync(process.env.USERPROFILE, { recursive: true })
  try {
    await assert.rejects(python(), (error) => /Python environment was not found/.test(error.message))
  } finally {
    process.env.OPENCODE_VIBE_PYTHON = previousPython
    process.env.PATH = previousPath
    process.env.USERPROFILE = previousProfile
  }
})
