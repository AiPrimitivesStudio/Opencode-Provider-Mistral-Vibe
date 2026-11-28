import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

// The bridge speaks mistral-vibe 3.1.x internal Python interfaces only; the
// bootstrap exists so users never have to install the right runtime by hand
// and never have their own (possibly incompatible) tool touched.
export const REQUIRED_VIBE_VERSION = "3.1.3"
const COMPATIBLE_PREFIX = "3.1."
export const MARKER = "opencode-runtime.json"
const LOCK_MAX_AGE_MS = 15 * 60 * 1000
const LOCK_WAIT_MS = 10 * 60 * 1000
const LOCK_POLL_MS = () => Number(process.env.OPENCODE_VIBE_LOCK_POLL_MS) || 2000
export const AUTO_INSTALL = process.env.OPENCODE_VIBE_AUTO_INSTALL !== "0"

export const runtimeBase = () =>
  process.env.OPENCODE_VIBE_RUNTIME_DIR ?? join(homedir(), ".config", "opencode", "mistral-vibe-runtime")

const binDir = process.platform === "win32" ? "Scripts" : "bin"
const pythonName = process.platform === "win32" ? "python.exe" : "python"
const vibeName = process.platform === "win32" ? "vibe.exe" : "vibe"
const pythonIn = (dir: string) => join(dir, binDir, pythonName)

/** The `vibe` CLI executable shipped next to a given interpreter. */
export const vibeNextTo = (python: string) => join(dirname(python), vibeName)

export const isCompatible = (version: string | undefined) =>
  typeof version === "string" && version.startsWith(COMPATIBLE_PREFIX)

/** The plugin-managed runtime is usable when its marker and interpreter both exist. */
export function managedRuntime(base: string): string | undefined {
  const dir = join(base, REQUIRED_VIBE_VERSION)
  const python = pythonIn(dir)
  if (!existsSync(join(dir, MARKER)) || !existsSync(python)) return undefined
  return python
}

// --- resolution ------------------------------------------------------------

export interface ResolveOptions {
  /** Explicit executable; trusted as-is (power-user override). */
  override?: string
  /** Existing discovery (PATH/vibe launcher/sibling interpreter). */
  discover?: () => Promise<string | undefined>
  /** Returns the mistral-vibe version an interpreter has installed. */
  probe?: (python: string) => Promise<string | undefined>
  /** Installs the pinned runtime into the given directory. */
  install?: (dir: string) => Promise<void>
  /** Where the managed runtime lives. */
  base?: string
  /** Whether installing is allowed when nothing compatible is found. */
  allowInstall?: boolean
}

export async function resolveRuntimePython(options: ResolveOptions): Promise<string> {
  if (options.override) return options.override
  const base = options.base ?? runtimeBase()
  const managed = managedRuntime(base)
  if (managed) return managed
  let found: string | undefined
  if (options.discover) {
    const discovered = await options.discover()
    if (discovered) {
      const version = options.probe ? await options.probe(discovered) : undefined
      if (isCompatible(version)) return discovered
      found = `${discovered} (mistral-vibe ${version ?? "not installed"})`
    }
  }
  if (!options.allowInstall || !options.install) {
    throw new Error(
      `No compatible Mistral Vibe runtime found${found ? `: ${found}` : ""}. ` +
        `This integration needs mistral-vibe ${REQUIRED_VIBE_VERSION} (3.1.x). ` +
        `Set OPENCODE_VIBE_PYTHON to a compatible interpreter or re-enable the automatic install (OPENCODE_VIBE_AUTO_INSTALL).`,
    )
  }
  await options.install(join(base, REQUIRED_VIBE_VERSION))
  const installed = managedRuntime(base)
  if (!installed) throw new Error("The Mistral Vibe runtime install reported success but the runtime is not usable.")
  return installed
}

// --- version probe ---------------------------------------------------------

const probed = new Map<string, string | undefined>()

/** Test seam: pre-seed the version-probe cache so tests stay hermetic (no real Vibe needed). */
export function _setProbedVersion(python: string, version: string | undefined) {
  probed.set(python, version)
}

/** The mistral-vibe version an interpreter has installed, cached per interpreter. */
export async function probeVersion(python: string): Promise<string | undefined> {
  if (probed.has(python)) return probed.get(python)
  const version = await new Promise<string | undefined>((resolve) => {
    const child = spawn(python, ["-c", "from importlib.metadata import version; print(version('mistral-vibe'))"], {
      windowsHide: true,
    })
    let out = ""
    child.stdout?.on("data", (chunk) => (out += chunk))
    child.on("error", () => resolve(undefined))
    child.on("close", () => resolve(out.trim().split("\n")[0] || undefined))
  })
  probed.set(python, version)
  return version
}

// --- installer -------------------------------------------------------------

function run(command: string, args: string[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stderr = ""
    child.stderr?.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => reject(new Error(`${what} failed: ${command}: ${error.message}`)))
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${what} failed (${command} ${args.join(" ")}), exit ${code}: ${stderr.slice(-2000).trim()}`),
          ),
    )
  })
}

const uvCommand = () => process.env.OPENCODE_VIBE_UV ?? "uv"
const basePython = () => process.env.OPENCODE_VIBE_BASE_PYTHON ?? (process.platform === "win32" ? "py" : "python3")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Install the pinned runtime into `dir`, atomically: build in a temp dir,
 * verify, swap. A fresh cross-process lock waits for a peer install; a stale
 * lock is taken over. Failures clean up and rethrow with the real cause.
 */
export async function installRuntime(dir: string): Promise<"installed" | "waited"> {
  const base = dirname(dir)
  const lockPath = join(base, "bootstrap.lock")
  await mkdir(base, { recursive: true })
  let lockHeld = false
  try {
    await writeFile(lockPath, String(process.pid), { flag: "wx" })
    lockHeld = true
  } catch {
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (age < LOCK_MAX_AGE_MS) {
      const deadline = Date.now() + LOCK_WAIT_MS
      while (Date.now() < deadline) {
        await sleep(LOCK_POLL_MS())
        if (managedRuntime(base)) return "waited"
      }
      throw new Error(
        "Another process is already installing the Mistral Vibe runtime; wait for it to finish and retry.",
      )
    }
    await writeFile(lockPath, String(process.pid)) // stale lock: take over
    lockHeld = true
  }
  const tmp = `${dir}.tmp-${process.pid}`
  try {
    await rm(tmp, { recursive: true, force: true })
    const seam = process.env.OPENCODE_VIBE_INSTALLER
    if (seam) {
      await run(process.execPath, [seam, tmp, REQUIRED_VIBE_VERSION], "Mistral Vibe runtime install")
    } else if (
      await run(uvCommand(), ["--version"], "uv").then(
        () => true,
        () => false,
      )
    ) {
      await run(uvCommand(), ["venv", tmp], "Mistral Vibe runtime install (uv venv)")
      await run(
        uvCommand(),
        ["pip", "install", "--python", pythonIn(tmp), `mistral-vibe==${REQUIRED_VIBE_VERSION}`],
        "Mistral Vibe runtime install",
      )
    } else {
      await run(basePython(), ["-m", "venv", tmp], "Mistral Vibe runtime install (venv)")
      await run(
        pythonIn(tmp),
        ["-m", "pip", "install", "--disable-pip-version-check", `mistral-vibe==${REQUIRED_VIBE_VERSION}`],
        "Mistral Vibe runtime install",
      )
    }
    if (!existsSync(pythonIn(tmp))) throw new Error(`The runtime install finished but ${pythonIn(tmp)} is missing.`)
    await writeFile(
      join(tmp, MARKER),
      JSON.stringify({ runtime: "mistral-vibe", version: REQUIRED_VIBE_VERSION, created: Date.now() }, null, 2),
      "utf8",
    )
    await rm(dir, { recursive: true, force: true })
    await rename(tmp, dir)
    return "installed"
  } catch (error) {
    await rm(tmp, { recursive: true, force: true })
    throw error
  } finally {
    if (lockHeld) await rm(lockPath, { force: true })
  }
}
