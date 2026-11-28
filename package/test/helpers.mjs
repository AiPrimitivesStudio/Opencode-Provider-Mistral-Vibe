import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const pluginDir = fileURLToPath(new URL("..", import.meta.url))

/** The Vibe tool's Python interpreter: explicit override, else the uv tool layout per platform. */
export function vibePython() {
  if (process.env.OPENCODE_VIBE_PYTHON) return process.env.OPENCODE_VIBE_PYTHON
  const candidates =
    process.platform === "win32"
      ? [join(process.env.APPDATA ?? "", "uv", "tools", "mistral-vibe", "Scripts", "python.exe")]
      : [join(homedir(), ".local", "share", "uv", "tools", "mistral-vibe", "bin", "python")]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    "The mistral-vibe Python interpreter was not found in the uv tool directory. " +
      "Set OPENCODE_VIBE_PYTHON to the tool's python executable to run the Python-spawning tests.",
  )
}

export const bridgePath = join(pluginDir, "src", "bridge.py")

/**
 * Run the bridge directly over its stdin/stdout protocol, with exactly the
 * environment the plugin would inject (imported from the real process.ts).
 * Resolves with every event emitted, rejects when the child fails.
 */
export async function runBridge(request, { env, timeoutMs = 60_000 } = {}) {
  const child = spawn(vibePython(), ["-u", bridgePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...env, PYTHONUNBUFFERED: "1" },
  })
  const events = []
  let stderr = ""
  let stdout = ""
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`bridge timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 2000)}`))
    }, timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      let index
      while ((index = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, index).trim()
        stdout = stdout.slice(index + 1)
        if (!line) continue
        try {
          events.push(JSON.parse(line))
        } catch {
          reject(new Error(`bridge emitted invalid JSON: ${line.slice(0, 200)}`))
          child.kill("SIGKILL")
          return
        }
      }
    })
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("close", (code) => {
      clearTimeout(timer)
      const terminal = events.at(-1)
      if (code !== 0 || !terminal || !["catalog", "result", "error"].includes(terminal.type)) {
        reject(
          new Error(
            `bridge exited unexpectedly (code=${code}, last=${terminal?.type}). stderr: ${stderr.slice(0, 2000)}`,
          ),
        )
        return
      }
      resolve({ events, code })
    })
  })
  child.stdin.write(JSON.stringify(request) + "\n")
  child.stdin.end()
  return done
}

/** The opencode service endpoint and Basic auth credentials. */
export function opencodeService() {
  const service = JSON.parse(
    readFileSync(join(process.env.USERPROFILE ?? "", ".config", "opencode", "service.json"), "utf8"),
  )
  const port = process.env.OPENCODE_PORT ?? "28894"
  const url = `http://127.0.0.1:${port}`
  const auth = "Basic " + Buffer.from(`opencode:${service.password}`).toString("base64")
  return { url, auth }
}

export async function opencodeFetch(path, { method = "GET", body, auth } = {}) {
  const { url, auth: defaultAuth } = opencodeService()
  const headers = { Authorization: auth ?? defaultAuth }
  if (process.env.OPENCODE_TEST_DIRECTORY) headers["x-opencode-directory"] = process.env.OPENCODE_TEST_DIRECTORY
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const response = await fetch(url + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: response.status, json }
}

/** Poll a predicate against the opencode API until it returns a truthy value. */
export async function poll(fn, { timeoutMs = 90_000, intervalMs = 2000, label = "condition" } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
