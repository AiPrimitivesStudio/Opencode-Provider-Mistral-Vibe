import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const { isCompatible, resolveRuntimePython, installRuntime, runtimeBase, REQUIRED_VIBE_VERSION, MARKER } =
  await import("../src/runtime.ts")

const bin = process.platform === "win32" ? "Scripts" : "bin"
const exe = process.platform === "win32" ? "python.exe" : "python"
const pyIn = (dir) => join(dir, bin, exe)
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

// A fake managed runtime: marker + interpreter present.
function makeManaged(dir) {
  mkdirSync(join(dir, bin), { recursive: true })
  writeFileSync(pyIn(dir), "")
  writeFileSync(join(dir, MARKER), JSON.stringify({ version: REQUIRED_VIBE_VERSION }))
}

const base = () => join(tmpdir(), `vibe-runtime-test-${process.pid}-${Date.now()}`)

test("isCompatible accepts 3.1.x only", () => {
  assert.equal(isCompatible("3.1.0"), true)
  assert.equal(isCompatible("3.1.3"), true)
  assert.equal(isCompatible("3.10.0"), false)
  assert.equal(isCompatible("3.2.0"), false)
  assert.equal(isCompatible("4.0.0"), false)
  assert.equal(isCompatible(undefined), false)
  assert.equal(isCompatible(""), false)
})

test("resolveRuntimePython: an explicit override wins without any discovery", async () => {
  let discovered = 0
  const python = await resolveRuntimePython({
    override: "X:/explicit/python.exe",
    discover: () => {
      discovered++
      return Promise.resolve("/discovered/python")
    },
  })
  assert.equal(python, "X:/explicit/python.exe")
  assert.equal(discovered, 0, "override must short-circuit discovery")
})

test("resolveRuntimePython: a usable managed runtime is preferred over discovery", async () => {
  const root = base()
  makeManaged(join(root, REQUIRED_VIBE_VERSION))
  try {
    let discovered = 0
    const python = await resolveRuntimePython({
      discover: () => {
        discovered++
        return Promise.resolve("/discovered/python")
      },
      base: root,
    })
    assert.equal(python, pyIn(join(root, REQUIRED_VIBE_VERSION)))
    assert.equal(discovered, 0, "a managed runtime must not trigger discovery")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveRuntimePython: a discovered compatible runtime is used, nothing installs", async () => {
  let installed = 0
  const python = await resolveRuntimePython({
    discover: () => Promise.resolve("/discovered/python"),
    probe: () => Promise.resolve("3.1.2"),
    install: () => {
      installed++
      return Promise.resolve()
    },
    base: base(),
  })
  assert.equal(python, "/discovered/python")
  assert.equal(installed, 0, "a compatible discovery must not install anything")
})

test("resolveRuntimePython: an incompatible discovery installs and then resolves to the managed runtime", async () => {
  const root = base()
  let installDir = ""
  const python = await resolveRuntimePython({
    discover: () => Promise.resolve("/users/own/python"),
    probe: () => Promise.resolve("3.2.0"),
    install: (dir) => {
      installDir = dir
      makeManaged(dir)
      return Promise.resolve()
    },
    allowInstall: true,
    base: root,
  })
  try {
    assert.equal(installDir, join(root, REQUIRED_VIBE_VERSION), "install must target the pinned managed dir")
    assert.equal(python, pyIn(join(root, REQUIRED_VIBE_VERSION)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveRuntimePython: without install rights the error names the found version and the override", async () => {
  await assert.rejects(
    resolveRuntimePython({
      discover: () => Promise.resolve("/users/own/python"),
      probe: () => Promise.resolve("3.2.0"),
      allowInstall: false,
      base: base(),
    }),
    (error) => /3\.2\.0/.test(error.message) && /OPENCODE_VIBE_PYTHON/.test(error.message),
  )
})

test("resolveRuntimePython: no discovery, no install rights -> actionable error", async () => {
  await assert.rejects(
    resolveRuntimePython({ allowInstall: false, base: base() }),
    (error) => /OPENCODE_VIBE_PYTHON/.test(error.message) && /mistral-vibe 3\.1\.3/.test(error.message),
  )
})

test("resolveRuntimePython: an install failure propagates with its real cause", async () => {
  await assert.rejects(
    resolveRuntimePython({
      discover: () => Promise.resolve("/users/own/python"),
      probe: () => Promise.resolve("3.2.0"),
      install: () => Promise.reject(new Error("uv venv failed: no space left on device")),
      allowInstall: true,
      base: base(),
    }),
    (error) => /no space left on device/.test(error.message),
  )
})

test("installRuntime: installs via the seam, writes marker + interpreter, repeat is atomic", async () => {
  const root = base()
  const dir = join(root, REQUIRED_VIBE_VERSION)
  const previous = process.env.OPENCODE_VIBE_INSTALLER
  process.env.OPENCODE_VIBE_INSTALLER = fixture("runtime-installer.mjs")
  try {
    await installRuntime(dir)
    assert.ok(existsSync(pyIn(dir)), "the managed interpreter must exist")
    assert.ok(existsSync(join(dir, MARKER)), "the marker must exist")
    const marker = JSON.parse(readMarker(dir))
    assert.equal(marker.version, REQUIRED_VIBE_VERSION)
    await installRuntime(dir) // replace-in-place must also work
    assert.ok(existsSync(pyIn(dir)))
  } finally {
    process.env.OPENCODE_VIBE_INSTALLER = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test("installRuntime: a failing installer surfaces stderr and cleans the temp dir", async () => {
  const root = base()
  const dir = join(root, REQUIRED_VIBE_VERSION)
  const previous = process.env.OPENCODE_VIBE_INSTALLER
  process.env.OPENCODE_VIBE_INSTALLER = fixture("runtime-installer-fail.mjs")
  try {
    await assert.rejects(installRuntime(dir), (error) =>
      /installer exploded: simulated network failure/.test(error.message),
    )
    assert.ok(!existsSync(`${dir}.tmp-${process.pid}`), "the temp dir must be cleaned up")
  } finally {
    process.env.OPENCODE_VIBE_INSTALLER = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test("installRuntime: a fresh cross-process lock waits for the peer to finish", async () => {
  const root = base()
  const dir = join(root, REQUIRED_VIBE_VERSION)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "bootstrap.lock"), "99999") // fresh lock from a "peer"
  const previousPoll = process.env.OPENCODE_VIBE_LOCK_POLL_MS
  const previousInstaller = process.env.OPENCODE_VIBE_INSTALLER
  process.env.OPENCODE_VIBE_LOCK_POLL_MS = "25"
  process.env.OPENCODE_VIBE_INSTALLER = fixture("runtime-installer.mjs")
  try {
    const started = installRuntime(dir)
    // The peer "finishes" its install shortly after we start waiting.
    await new Promise((resolve) => setTimeout(resolve, 100))
    makeManaged(dir)
    assert.equal(await started, "waited")
  } finally {
    process.env.OPENCODE_VIBE_LOCK_POLL_MS = previousPoll
    process.env.OPENCODE_VIBE_INSTALLER = previousInstaller
    rmSync(root, { recursive: true, force: true })
  }
})

test("installRuntime: a stale lock is taken over", async () => {
  const root = base()
  const dir = join(root, REQUIRED_VIBE_VERSION)
  mkdirSync(root, { recursive: true })
  const lock = join(root, "bootstrap.lock")
  writeFileSync(lock, "99999")
  const stale = new Date(Date.now() - 24 * 60 * 60 * 1000)
  utimesSync(lock, stale, stale)
  const previous = process.env.OPENCODE_VIBE_INSTALLER
  process.env.OPENCODE_VIBE_INSTALLER = fixture("runtime-installer.mjs")
  try {
    assert.equal(await installRuntime(dir), "installed")
    assert.ok(existsSync(pyIn(dir)))
  } finally {
    process.env.OPENCODE_VIBE_INSTALLER = previous
    rmSync(root, { recursive: true, force: true })
  }
})

function readMarker(dir) {
  return readFileSyncUtf8(join(dir, MARKER))
}
import { readFileSync } from "node:fs"
function readFileSyncUtf8(path) {
  return readFileSync(path, "utf8")
}

test("runtimeBase honors OPENCODE_VIBE_RUNTIME_DIR", () => {
  const previous = process.env.OPENCODE_VIBE_RUNTIME_DIR
  process.env.OPENCODE_VIBE_RUNTIME_DIR = "X:/custom/runtime-root"
  try {
    assert.equal(runtimeBase(), "X:/custom/runtime-root")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_VIBE_RUNTIME_DIR
    else process.env.OPENCODE_VIBE_RUNTIME_DIR = previous
  }
})
