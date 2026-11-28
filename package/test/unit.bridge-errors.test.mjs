import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { vibePython } from "./helpers.mjs"

// Offline unit tests for bridge.py's error reporting helpers. The bridge's
// direct behaviour is covered separately in bridge.errors.test.mjs.

function pythonRun(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(vibePython(), ["-u", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (err += c))
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`python exited ${code}: ${err.slice(0, 800)}`)),
    )
    child.on("error", reject)
  })
}

test("bridge_error_message / no_credential_message expose real errors", async () => {
  const output = await pythonRun(join(fileURLToPath(new URL(".", import.meta.url)), "bridge_errors_unit.py"))
  assert.ok(output.includes("ALL PASS"), `unit checks failed:\n${output}`)
})
