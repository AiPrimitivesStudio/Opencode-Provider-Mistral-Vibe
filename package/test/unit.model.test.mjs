import assert from "node:assert/strict"
import { test } from "node:test"
import { VibeModel } from "../src/model.ts"

// VibeModel takes the bridge executor as a constructor argument, so the whole
// LanguageModelV3 surface can be driven with scripted events.

const RESULT = (parts, finish_reason = "stop") => ({
  type: "result",
  parts,
  finish_reason,
  usage: { input_tokens: 10, output_tokens: 20, cached_input_tokens: 4, cache_write_tokens: 1, reasoning_tokens: 5 },
})

const OPTIONS = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ type: "function", name: "read", description: "read a file", inputSchema: { type: "object" } }],
}

async function collectStream(stream) {
  const reader = stream.getReader()
  const parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

function withEvents(events, after) {
  const seen = []
  return {
    seen,
    execute: async (request, emit) => {
      seen.push(request)
      for (const event of events) emit(event)
      if (after) await after(request, emit)
    },
  }
}

test("doStream emits start, text deltas and a mapped finish", async () => {
  const harness = withEvents([
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    RESULT([{ type: "text", text: "Hello" }]),
  ])
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const parts = await collectStream((await model.doStream(OPTIONS)).stream)
  assert.deepEqual(
    parts.map((part) => part.type),
    ["stream-start", "text-start", "text-delta", "text-delta", "text-end", "finish"],
  )
  const finish = parts.at(-1)
  assert.equal(finish.finishReason.unified, "stop")
  assert.equal(finish.finishReason.raw, "stop")
  assert.deepEqual(finish.usage.outputTokens, { total: 20, text: 15, reasoning: 5 })
  assert.deepEqual(finish.usage.inputTokens, { total: 10, noCache: 5, cacheRead: 4, cacheWrite: 1 })
})

test("doStream reports unsupported option warnings", async () => {
  const harness = withEvents([RESULT([{ type: "text", text: "ok" }])])
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const parts = await collectStream(
    (
      await model.doStream({
        ...OPTIONS,
        topK: 3,
        seed: 1,
        stopSequences: ["x"],
        presencePenalty: 1,
        frequencyPenalty: 1,
      })
    ).stream,
  )
  const warnings = parts[0].warnings.map((warning) => warning.feature)
  assert.deepEqual(warnings, ["topK", "seed", "stopSequences", "presencePenalty", "frequencyPenalty"])
})

test("doStream maps tool_call finishes and enqueues offered tool calls", async () => {
  const harness = withEvents([
    RESULT([{ type: "tool_call", id: "call_1", name: "read", arguments_json: '{"path":"x"}' }], "tool_call"),
  ])
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const parts = await collectStream((await model.doStream(OPTIONS)).stream)
  const toolCall = parts.find((part) => part.type === "tool-call")
  assert.equal(toolCall.toolName, "read")
  assert.equal(toolCall.toolCallId, "call_1")
  const finish = parts.at(-1)
  assert.equal(finish.finishReason.unified, "tool-calls")
})

test("doStream warns but still passes through unoffered tool calls", async () => {
  const warnings = []
  const original = console.warn
  console.warn = (message) => warnings.push(String(message))
  try {
    const harness = withEvents([
      RESULT([{ type: "tool_call", id: "call_2", name: "not-offered", arguments_json: "{}" }], "tool_call"),
    ])
    const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
    const parts = await collectStream((await model.doStream(OPTIONS)).stream)
    assert.ok(parts.some((part) => part.type === "tool-call" && part.toolName === "not-offered"))
  } finally {
    console.warn = original
  }
  assert.match(warnings[0] ?? "", /did not offer/)
})

test("doStream maps content_filter finishes and emits reasoning from the result", async () => {
  const harness = withEvents([
    RESULT([{ type: "reasoning", content: [{ type: "text", text: "pondered" }] }], "content_filter"),
  ])
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const parts = await collectStream((await model.doStream(OPTIONS)).stream)
  assert.equal(parts.at(-1).finishReason.unified, "content-filter")
  const reasoning = parts
    .filter((part) => part.type === "reasoning-delta")
    .map((part) => part.delta)
    .join("")
  assert.equal(reasoning, "pondered")
})

test("doStream passes through length and other finish reasons", async () => {
  for (const reason of ["length", "other"]) {
    const harness = withEvents([RESULT([{ type: "text", text: "x" }], reason)])
    const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
    const parts = await collectStream((await model.doStream(OPTIONS)).stream)
    assert.equal(parts.at(-1).finishReason.unified, reason)
  }
})

test("doStream surfaces a bridge error on the stream", async () => {
  const model = new VibeModel("zai-glm-5-3-flash", async () => {
    throw new Error("bridge exploded")
  })
  const stream = (await model.doStream(OPTIONS)).stream
  await assert.rejects(collectStream(stream), (error) => error.message === "bridge exploded")
})

test("doStream fails when the bridge returns no result event", async () => {
  const harness = withEvents([{ type: "text", text: "orphan" }])
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const stream = (await model.doStream(OPTIONS)).stream
  await assert.rejects(collectStream(stream), (error) => /did not return a model result/.test(error.message))
})

test("doStream rejects forced tool choice, structured output and provider tools", async () => {
  const model = new VibeModel("zai-glm-5-3-flash", async () => {})
  await assert.rejects(model.doStream({ ...OPTIONS, toolChoice: { type: "required" } }), /forced tool choice/)
  await assert.rejects(model.doStream({ ...OPTIONS, toolChoice: { type: "tool" } }), /forced tool choice/)
  await assert.rejects(model.doStream({ ...OPTIONS, responseFormat: { type: "json" } }), /structured output/)
  await assert.rejects(model.doStream({ ...OPTIONS, tools: [{ type: "provider" }] }), /function tools only/)
})

test("doStream honours toolChoice none and maps efforts through the fallbacks", async () => {
  const harness = withEvents([RESULT([{ type: "text", text: "ok" }])])
  const deepseek = new VibeModel("deepseek-v4-1-flash-1017", harness.execute)
  await collectStream(
    (
      await deepseek.doStream({
        ...OPTIONS,
        toolChoice: { type: "none" },
        providerOptions: { "mistral-vibe": { effort: "medium" } },
      })
    ).stream,
  )
  assert.equal(harness.seen[0].effort, "high", "deepseek medium must be replaced by high")
  assert.deepEqual(harness.seen[0].tools, [], "toolChoice none must send an empty tool list")

  const glm = new VibeModel("zai-glm-5-3-flash", harness.execute)
  await collectStream(
    (await glm.doStream({ ...OPTIONS, providerOptions: { "mistral-vibe": { effort: "low" } } })).stream,
  )
  assert.equal(harness.seen[1].effort, "low")
})

test("doStream forwards the abort signal and cancels the bridge task", async () => {
  const abort = new AbortController()
  abort.abort(new Error("aborted up front"))
  const model = new VibeModel("zai-glm-5-3-flash", async () => {})
  await assert.rejects(model.doStream({ ...OPTIONS, abortSignal: abort.signal }), /aborted up front/)
})

test("doStream cancel() stops event delivery", async () => {
  let started
  const harness = {
    execute: (request, emit, signal) =>
      new Promise((resolve) => {
        started = signal
        emit({ type: "text", text: "before" })
        setTimeout(resolve, 150)
      }),
  }
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const stream = (await model.doStream(OPTIONS)).stream
  const reader = stream.getReader()
  await reader.read()
  await reader.cancel()
  assert.ok(started.aborted, "cancel must abort the bridge signal")
})

test("doGenerate aggregates streamed blocks into one result", async () => {
  const harness = withEvents([
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    RESULT([{ type: "text", text: "Hello" }]),
  ])
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const result = await model.doGenerate(OPTIONS)
  assert.equal(result.content[0].type, "text")
  assert.equal(result.content[0].text, "Hello")
  assert.equal(result.finishReason.unified, "stop")
  assert.deepEqual(result.warnings, [])
})

test("doGenerate includes tool calls and propagates bridge failures", async () => {
  const harness = withEvents([
    RESULT([{ type: "tool_call", id: "c1", name: "read", arguments_json: "{}" }], "tool_call"),
  ])
  const model = new VibeModel("zai-glm-5-3-flash", harness.execute)
  const result = await model.doGenerate(OPTIONS)
  assert.ok(result.content.some((part) => part.type === "tool-call"))

  const failing = new VibeModel("zai-glm-5-3-flash", async () => {
    throw new Error("no good")
  })
  await assert.rejects(failing.doGenerate(OPTIONS), /no good/)
})
