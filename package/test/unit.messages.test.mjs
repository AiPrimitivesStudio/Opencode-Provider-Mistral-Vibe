import assert from "node:assert/strict"
import { test } from "node:test"
import { messages } from "../src/messages.ts"

test("system messages are passed through and empty ones dropped", () => {
  assert.deepEqual(messages([{ role: "system", content: "be brief" }]), [
    { role: "system", content: [{ type: "text", text: "be brief" }] },
  ])
  assert.deepEqual(messages([{ role: "system", content: "" }]), [])
})

test("user text and reasoning parts convert, empty text is dropped", () => {
  const result = messages([
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "" },
        { type: "reasoning", text: "hmm" },
        { type: "reasoning", text: "" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "" }] },
  ])
  assert.deepEqual(result, [
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "reasoning", content: [{ type: "text", text: "hmm" }] },
      ],
    },
  ])
})

test("tool-call parts carry their raw json arguments", () => {
  const result = messages([
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "x" } }],
    },
  ])
  const part = result[0].content[0]
  assert.equal(part.type, "tool_call")
  assert.equal(part.id, "c1")
  assert.equal(part.arguments.value.path, "x")
})

test("file parts accept base64 strings and buffers but reject URLs", () => {
  const result = messages([
    { role: "user", content: [{ type: "file", data: "aGk=", mediaType: "image/png" }] },
  ])
  assert.deepEqual(result[0].content[0], { type: "image", data: "aGk=", mimeType: "image/png" })

  const fromBuffer = messages([
    { role: "user", content: [{ type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" }] },
  ])
  assert.equal(fromBuffer[0].content[0].mimeType, "image/jpeg")

  assert.throws(
    () => messages([{ role: "user", content: [{ type: "file", data: new URL("https://x/y.png"), mediaType: "image/png" }] }]),
    /downloaded image attachments/,
  )
  assert.throws(
    () => messages([{ role: "user", content: [{ type: "file", data: "aGk=", mediaType: "text/plain" }] }]),
    /image attachments, not this file type/,
  )
})

test("unknown part types are rejected", () => {
  assert.throws(
    () => messages([{ role: "user", content: [{ type: "mystery" }] }]),
    /Unsupported Vibe message part/,
  )
})

test("tool results map outputs and outcomes", () => {
  const result = messages([
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "file body" } },
        { type: "tool-result", toolCallId: "c2", toolName: "read", output: { type: "error-text", value: "failed" } },
        { type: "tool-result", toolCallId: "c3", toolName: "read", output: { type: "json", value: { a: 1 } } },
        { type: "tool-result", toolCallId: "c4", toolName: "read", output: { type: "error-json", value: { b: 2 } } },
        { type: "tool-result", toolCallId: "c5", toolName: "read", output: { type: "execution-denied" } },
        { type: "tool-result", toolCallId: "c6", toolName: "read", output: { type: "execution-denied", reason: "not allowed" } },
      ],
    },
  ])
  assert.equal(result.length, 6)
  assert.equal(result[0].outcome, "success")
  assert.equal(result[0].content[0].text, "file body")
  assert.equal(result[1].outcome, "failure")
  assert.equal(result[2].content[0].text, '{"a":1}')
  assert.equal(result[3].outcome, "failure")
  assert.equal(result[4].content[0].text, "Tool execution denied")
  assert.equal(result[5].content[0].text, "not allowed")
  assert.equal(result[5].outcome, "failure")
})

test("tool results with content arrays map text and image parts", () => {
  const result = messages([
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "screenshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "shot" },
              { type: "image-data", data: "aGk=", mediaType: "image/png" },
            ],
          },
        },
      ],
    },
  ])
  assert.deepEqual(result[0].content, [
    { type: "text", text: "shot" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ])

  assert.throws(
    () =>
      messages([
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c", toolName: "x", output: { type: "content", value: [{ type: "weird" }] } },
          ],
        },
      ]),
    /Unsupported Vibe tool output/,
  )
})

test("provider tool approvals inside tool messages are rejected", () => {
  assert.throws(
    () => messages([{ role: "tool", content: [{ type: "provider-tool-approval" }] }]),
    /provider tool approvals/,
  )
})
