import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vibePython } from "./helpers.mjs"

// The unit gate must run on any machine: the interpreter is derived from the
// uv tool layout (or OPENCODE_VIBE_PYTHON), never pinned to one developer's home.

test("vibePython() prefers an explicit OPENCODE_VIBE_PYTHON", () => {
  const previous = process.env.OPENCODE_VIBE_PYTHON
  process.env.OPENCODE_VIBE_PYTHON = "X:/somewhere/python.exe"
  try {
    assert.equal(vibePython(), "X:/somewhere/python.exe")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_VIBE_PYTHON
    else process.env.OPENCODE_VIBE_PYTHON = previous
  }
})

test("vibePython() derives the interpreter from the uv tool layout, not a hardcoded home", () => {
  const previousPython = process.env.OPENCODE_VIBE_PYTHON
  const previousAppdata = process.env.APPDATA
  delete process.env.OPENCODE_VIBE_PYTHON
  process.env.APPDATA = join(tmpdir(), "no-such-uv-tools")
  try {
    assert.throws(() => vibePython(), /OPENCODE_VIBE_PYTHON/)
  } finally {
    if (previousPython !== undefined) process.env.OPENCODE_VIBE_PYTHON = previousPython
    process.env.APPDATA = previousAppdata
  }
})

test("vibePython() resolves an existing interpreter when the uv tool layout is present", () => {
  const resolved = vibePython()
  assert.ok(existsSync(resolved), `resolved interpreter must exist: ${resolved}`)
})
