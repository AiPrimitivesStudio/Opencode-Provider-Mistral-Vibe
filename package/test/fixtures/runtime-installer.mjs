// Test seam for installRuntime(): fabricates the venv structure the real
// installer (uv/python -m venv) would produce, without any network access.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dir = process.argv[2]
if (!dir) {
  console.error("usage: node runtime-installer.mjs <dir>")
  process.exit(1)
}
const bin = process.platform === "win32" ? "Scripts" : "bin"
const exe = process.platform === "win32" ? "python.exe" : "python"
mkdirSync(join(dir, bin), { recursive: true })
writeFileSync(join(dir, bin, exe), "")
