import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { environment, python, resolvePython, vibeLoginHint } from "../src/process.ts"

// The bridge must authenticate against the Vibe plan via the OIDC credential.
// These tests pin the environment the plugin injects into every Python child,
// independent of how the opencode server itself was launched (the 01:30 failure
// was exactly a server whose own env lacked the OIDC variables).

test("environment() injects the OIDC/keyring variables the bridge needs", () => {
  const env = JSON.parse(environment())
  assert.equal(env.VIBE_CLI_OIDC_ENABLED, "1")
  assert.equal(env.PYTHON_KEYRING_BACKEND, "vibe_file_keyring.FileKeyring")
  assert.ok(
    env.PYTHONPATH.includes("pylibs"),
    `PYTHONPATH must include the file-keyring pylibs directory, got: ${env.PYTHONPATH}`,
  )
  assert.ok(env.PYTHONPATH.includes(".vibe"), "PYTHONPATH must point into ~/.vibe/pylibs")
})

test("environment() forces UTF-8 for Python children", () => {
  const env = JSON.parse(environment())
  assert.equal(env.PYTHONUTF8, "1")
  assert.equal(env.PYTHONIOENCODING, "utf-8")
  assert.equal(env.PYTHONLEGACYWINDOWSSTDIO, "0")
})

test("environment() is stable across calls (warm workers must stay reusable)", () => {
  assert.equal(environment(), environment())
})

test("environment() forces the OIDC flag even when the server env disables it", () => {
  const previous = process.env.VIBE_CLI_OIDC_ENABLED
  process.env.VIBE_CLI_OIDC_ENABLED = "0"
  try {
    const env = JSON.parse(environment())
    assert.equal(env.VIBE_CLI_OIDC_ENABLED, "1")
  } finally {
    if (previous === undefined) delete process.env.VIBE_CLI_OIDC_ENABLED
    else process.env.VIBE_CLI_OIDC_ENABLED = previous
  }
})

test("environment() preserves unrelated inherited env", () => {
  const previous = process.env.SOME_PLUGIN_TEST_VAR
  process.env.SOME_PLUGIN_TEST_VAR = "keepme"
  try {
    const env = JSON.parse(environment())
    assert.equal(env.SOME_PLUGIN_TEST_VAR, "keepme")
  } finally {
    if (previous === undefined) delete process.env.SOME_PLUGIN_TEST_VAR
    else process.env.SOME_PLUGIN_TEST_VAR = previous
  }
})

test("python() resolves to an executable", async () => {
  const executable = await python()
  assert.ok(executable && executable.length > 0, `python() returned: ${executable}`)
})

const binDir = process.platform === "win32" ? "Scripts" : "bin"
const exeName = process.platform === "win32" ? "python.exe" : "python"
const vibeName = process.platform === "win32" ? "vibe.exe" : "vibe"

test("resolvePython() honors the OPENCODE_VIBE_PYTHON override without discovery", async () => {
  const previous = process.env.OPENCODE_VIBE_PYTHON
  process.env.OPENCODE_VIBE_PYTHON = "X:/override/python.exe"
  try {
    assert.equal(await resolvePython(), "X:/override/python.exe")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_VIBE_PYTHON
    else process.env.OPENCODE_VIBE_PYTHON = previous
  }
})

test("resolvePython() uses the plugin-managed runtime when it exists", async () => {
  const root = join(tmpdir(), `vibe-resolve-test-${process.pid}`)
  const dir = join(root, "3.1.3")
  mkdirSync(join(dir, binDir), { recursive: true })
  writeFileSync(join(dir, binDir, exeName), "")
  writeFileSync(join(dir, "opencode-runtime.json"), JSON.stringify({ version: "3.1.3" }))
  const previousBase = process.env.OPENCODE_VIBE_RUNTIME_DIR
  const previousPython = process.env.OPENCODE_VIBE_PYTHON
  delete process.env.OPENCODE_VIBE_PYTHON
  process.env.OPENCODE_VIBE_RUNTIME_DIR = root
  try {
    assert.equal(await resolvePython(), join(dir, binDir, exeName))
    assert.equal(vibeLoginHint(), `"${join(dir, binDir, vibeName)}" --setup`)
  } finally {
    if (previousBase === undefined) delete process.env.OPENCODE_VIBE_RUNTIME_DIR
    else process.env.OPENCODE_VIBE_RUNTIME_DIR = previousBase
    if (previousPython !== undefined) process.env.OPENCODE_VIBE_PYTHON = previousPython
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolvePython() resolves the discovered compatible runtime", async () => {
  // Hermetic: a fake launcher with a sibling interpreter plus a seeded version
  // probe - no real Vibe installation required, so CI on a clean runner passes.
  const { _setProbedVersion } = await import("../src/runtime.ts")
  const dir = join(tmpdir(), `vibe-discover-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const launcher = join(dir, process.platform === "win32" ? "vibe.exe" : "vibe")
  const sibling = join(dir, process.platform === "win32" ? "python.exe" : "python")
  writeFileSync(launcher, "")
  writeFileSync(sibling, "")
  chmodSync(launcher, 0o755)
  chmodSync(sibling, 0o755)
  // Discovery resolves the launcher through the native async realpath, which
  // expands 8.3 short path components (GitHub runners expose TMP as
  // C:\Users\RUNNER~1). The probe cache seed and the assertion must use the
  // exact same resolver.
  const realDir = dirname(await realpath(launcher))
  const realSibling = join(realDir, process.platform === "win32" ? "python.exe" : "python")
  const previousPath = process.env.OPENCODE_VIBE_PATH
  const previousPython = process.env.OPENCODE_VIBE_PYTHON
  const previousBase = process.env.OPENCODE_VIBE_RUNTIME_DIR
  delete process.env.OPENCODE_VIBE_PYTHON
  process.env.OPENCODE_VIBE_PATH = launcher
  process.env.OPENCODE_VIBE_RUNTIME_DIR = join(dir, "runtime")
  _setProbedVersion(realSibling, "3.1.2")
  try {
    assert.equal(await resolvePython(), realSibling, "a compatible discovery must be used as-is")
  } finally {
    if (previousPath === undefined) delete process.env.OPENCODE_VIBE_PATH
    else process.env.OPENCODE_VIBE_PATH = previousPath
    if (previousPython !== undefined) process.env.OPENCODE_VIBE_PYTHON = previousPython
    if (previousBase === undefined) delete process.env.OPENCODE_VIBE_RUNTIME_DIR
    else process.env.OPENCODE_VIBE_RUNTIME_DIR = previousBase
    rmSync(dir, { recursive: true, force: true })
  }
})
