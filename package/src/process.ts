import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { access, readFile, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { StringDecoder } from "node:string_decoder"
import { Event } from "./protocol.js"
import {
  AUTO_INSTALL,
  installRuntime,
  managedRuntime,
  probeVersion,
  resolveRuntimePython,
  runtimeBase,
  vibeNextTo,
} from "./runtime.js"

export async function python() {
  if (process.env.OPENCODE_VIBE_PYTHON) return process.env.OPENCODE_VIBE_PYTHON
  const paths = process.env.OPENCODE_VIBE_PATH
    ? [process.env.OPENCODE_VIBE_PATH]
    : [
        ...(process.env.PATH ?? "").split(delimiter).map((path) => join(path, "vibe")),
        join(homedir(), ".local/bin/vibe"),
      ]
  for (const path of paths) {
    if (
      !(await access(path, constants.X_OK).then(
        () => true,
        () => false,
      ))
    )
      continue
    const target = await realpath(path)
    const sibling = join(dirname(target), process.platform === "win32" ? "python.exe" : "python")
    if (
      await access(sibling, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return sibling
    // CRLF launchers leave a trailing "\r" that would corrupt the interpreter
    // path (spawn then fails ENOENT); trim it. Argument-bearing shebangs
    // (#!/usr/bin/env python) cannot be exec'd directly, so they are left to
    // the sibling-interpreter and PATH resolution paths above.
    const line = (await readFile(target, "utf8")).split("\n", 1)[0]?.trimEnd()
    if (line?.startsWith("#!/") && !line.includes(" ")) return line.slice(2)
  }
  throw new Error(
    "Mistral Vibe's Python environment was not found. Install with uv tool install mistral-vibe==3.1.3, or set OPENCODE_VIBE_PYTHON.",
  )
}

// OPENCODE_VIBE_BRIDGE lets the test suite substitute a scripted bridge process.
const BRIDGE = process.env.OPENCODE_VIBE_BRIDGE ?? fileURLToPath(new URL("./bridge.py", import.meta.url))
// Set OPENCODE_VIBE_PREWARM=0 to go back to one cold Python process per request.
const PREWARM = process.env.OPENCODE_VIBE_PREWARM !== "0"
const WARM_IDLE_MS = 10 * 60 * 1000
// Protocol guard: a single NDJSON line larger than this is not a real bridge
// event (runaway output, memory corruption) and must fail loudly, not be read.
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024

// One idle worker with Vibe already imported. A request takes it, runs once and
// exits exactly like a cold process; a fresh one is started for the next request.
type Worker = ChildProcessByStdio<Writable, Readable, null>
let warm: { child: Worker; executable: string; env: string; timer: ReturnType<typeof setTimeout> } | undefined

// A warm worker keeps the environment it was started with, so it is only reused while that is unchanged.
// UTF-8 is forced for Python children: without this, Windows relays env/stdin through the
// console codepage and non-ASCII text in requests becomes lone surrogates, which later crash
// the bridge with UnicodeEncodeError and surface to users as "Mistral Vibe bridge failed (SDKError)".
export const environment = () => {
  // OIDC plan billing: the bridge must resolve MISTRAL_API_KEY to the Vibe OIDC
  // credential, not a raw API key. These vars point Python at the file-based
  // keyring that stores the OIDC session (Windows Credential Manager rejects
  // blobs > 1280 bytes). Injecting them here makes the bridge independent of
  // how the opencode server itself was launched - a server env carrying
  // VIBE_CLI_OIDC_ENABLED=0 must not silently switch children to raw API
  // billing, so the flag is forced, not inherited.
  const pylibs = join(homedir(), ".vibe", "pylibs")
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONLEGACYWINDOWSSTDIO: "0",
    VIBE_CLI_OIDC_ENABLED: "1",
    PYTHON_KEYRING_BACKEND: process.env.PYTHON_KEYRING_BACKEND ?? "vibe_file_keyring.FileKeyring",
    PYTHONPATH: [pylibs, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  }
  return JSON.stringify(env)
}

function discard() {
  if (!warm) return
  clearTimeout(warm.timer)
  warm.child.kill("SIGKILL")
  warm = undefined
}

function prewarm(executable: string) {
  if (!PREWARM || warm) return
  try {
    const child = spawn(executable, ["-u", BRIDGE, "--warm"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: JSON.parse(environment()),
    })
    const entry = { child, executable, env: environment(), timer: setTimeout(discard, WARM_IDLE_MS) }
    entry.timer.unref?.()
    child.unref()
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdout.on("data", () => {}) // Nothing is expected before a request; drop it.
    child.once("close", () => {
      clearTimeout(entry.timer)
      if (warm === entry) warm = undefined
    })
    warm = entry
  } catch {
    warm = undefined
  }
}

// Only model requests are worth a standby worker; a catalog probe alone is not.
function acquire(executable: string, standby: boolean): Worker {
  if (
    PREWARM &&
    warm &&
    warm.executable === executable &&
    warm.env === environment() &&
    warm.child.exitCode === null &&
    !warm.child.killed
  ) {
    const { child, timer } = warm
    clearTimeout(timer)
    warm = undefined
    child.ref()
    child.stdout.removeAllListeners("data")
    if (standby) prewarm(executable)
    return child
  }
  discard()
  const child = spawn(executable, ["-u", BRIDGE], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: JSON.parse(environment()),
  })
  if (standby) prewarm(executable)
  return child
}

process.on("exit", discard)

/** Stop the standby worker, e.g. when the plugin is disposed or reloaded. */
export const shutdown = discard

// --- runtime resolution ------------------------------------------------------

/**
 * The interpreter that will run the bridge. Never installs anything: a
 * request must fail fast with an actionable error instead of blocking on an
 * install. The background bootstrap (ensureRuntime) owns installations.
 */
export async function resolvePython(): Promise<string> {
  return resolveRuntimePython({
    override: process.env.OPENCODE_VIBE_PYTHON,
    discover: () => python(),
    probe: probeVersion,
    install: (dir) => installRuntime(dir).then(() => undefined),
    base: runtimeBase(),
    allowInstall: false,
  })
}

let inflightRuntime: Promise<{ python: string; installed: boolean }> | undefined

/**
 * Bootstrap the pinned runtime when nothing compatible exists (background
 * safe: deduped in-process; the cross-process lock lives in installRuntime).
 * `installed` is true only when this call actually created the managed
 * runtime, so callers can avoid spurious follow-up work.
 */
export function ensureRuntime(): Promise<{ python: string; installed: boolean }> {
  inflightRuntime ??= (async () => {
    const before = managedRuntime(runtimeBase())
    const resolved = await resolveRuntimePython({
      override: process.env.OPENCODE_VIBE_PYTHON,
      discover: () => python(),
      probe: probeVersion,
      install: (dir) => installRuntime(dir).then(() => undefined),
      base: runtimeBase(),
      allowInstall: AUTO_INSTALL,
    })
    return { python: resolved, installed: !before && !!managedRuntime(runtimeBase()) }
  })().catch((error: unknown) => {
    inflightRuntime = undefined
    throw error
  })
  return inflightRuntime
}

/** The login command for the runtime actually in use: the managed vibe when bootstrapped. */
export function vibeLoginHint(): string {
  const managed = managedRuntime(runtimeBase())
  if (!managed) return "vibe --setup"
  return `"${vibeNextTo(managed)}" --setup`
}

export async function run(request: object, emit: (event: Event) => void, signal: AbortSignal) {
  signal.throwIfAborted()
  const executable = await resolvePython()
  signal.throwIfAborted()
  const child = acquire(executable, (request as { type?: unknown }).type === "generate")
  let buffer = ""
  const decoder = new StringDecoder("utf8")
  let terminal = false
  let failure: Error | undefined
  const stop = () => child.kill("SIGKILL")
  const complete = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      // Keep the real cause (ENOENT, EACCES, the path) next to the hint.
      failure = new Error(
        `Cannot start the Mistral Vibe Python environment. Check OPENCODE_VIBE_PYTHON. (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    })
    child.stdin.on("error", () => {}) // Process exit/abort is reported by close.
    child.stdout.on("data", (data: Buffer) => {
      buffer += decoder.write(data)
      if (buffer.length > MAX_PROTOCOL_LINE_BYTES) {
        failure = new Error("Mistral Vibe returned an oversized protocol message")
        stop()
        return
      }
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim() || failure) continue
        try {
          const event = Event.parse(JSON.parse(line))
          if (terminal) throw new Error("Data after final Vibe response")
          if (event.type === "error") {
            // Keep the bridge's structured HTTP status (402 quota, 401 auth)
            // on the error so callers can branch on the real cause.
            const error = new Error(event.message) as Error & { status?: number }
            if (event.status !== undefined) error.status = event.status
            throw error
          }
          terminal = event.type === "catalog" || event.type === "result"
          emit(event)
        } catch (error) {
          // Schema errors may include response values; do not expose them.
          // The failing field PATH names the real cause without any values.
          const schemaIssues = (error as { issues?: { path: PropertyKey[] }[] }).issues
          const detail =
            error instanceof Error && Array.isArray(schemaIssues) && schemaIssues.length > 0
              ? `schema error at ${schemaIssues[0].path.map(String).join(".")}`
              : `(${error instanceof Error ? error.name : "unknown"})`
          failure =
            error instanceof Error && error.name === "Error"
              ? error
              : new Error(`Invalid response from the Mistral Vibe bridge (${detail})`)
          stop()
        }
      }
    })
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop)
      if (signal.aborted) return reject(signal.reason)
      if (failure) return reject(failure)
      if (code !== 0 || !terminal || buffer.trim())
        return reject(new Error("Mistral Vibe stopped before completing its response"))
      resolve()
    })
  })
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  child.stdin.end(JSON.stringify(request) + "\n")
  return complete
}
