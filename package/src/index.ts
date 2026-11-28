import { Model, Plugin, Provider } from "@opencode/plugin"
import { Schema } from "effect"
import { ID, PACKAGE, VibeModel } from "./model.js"
import { Catalog } from "./protocol.js"
import { ensureRuntime, run, shutdown, vibeLoginHint } from "./process.js"
import { offered } from "./efforts.js"

// Official Mistral API prices in USD per 1M tokens (mistral.ai/pricing, models.dev provider "mistral").
// Vibe bills the workspace balance / abo credits at exactly these rates, so OpenCode must
// report real costs against the 255 EUR contingency instead of an empty cost list.
const API_PRICES: Record<string, { input: number; output: number; cache: { read: number; write: number } }> = {
  "mistral-large-4-0": { input: 0.7, output: 2.1, cache: { read: 0.07, write: 0 } },
  "mistral-medium-latest": { input: 1.5, output: 7.5, cache: { read: 0.15, write: 0 } },
  "zai-glm-5-3": { input: 1.4, output: 4.4, cache: { read: 0.14, write: 0 } },
  "zai-glm-5-3-flash": { input: 0.15, output: 0.5, cache: { read: 0.03, write: 0 } },
  "zai-glm-5-3-flash-vibe-free": { input: 0, output: 0, cache: { read: 0, write: 0 } },
}

const apiCost = (modelID: string): Model.Cost[] => {
  const price = API_PRICES[modelID]
  if (!price) return []
  return [
    Schema.decodeSync(Model.Cost)({
      input: price.input,
      output: price.output,
      cache: { read: price.cache.read, write: price.cache.write },
    }),
  ]
}

export default Plugin.define({
  id: "opencode.provider.mistral-vibe",
  async setup(ctx) {
    if (ctx.location.workspaceID !== undefined) return
    const id = Provider.ID.make(ID)
    const saved = Catalog.safeParse(await ctx.storage.get("catalog"))
    let catalog: Catalog = saved.success ? saved.data : { type: "catalog", version: "", models: [] }
    await ctx.provider.transform((editor) => {
      editor.add({
        info: { ...Provider.Info.empty(id), name: "Mistral Vibe", package: `aisdk:${PACKAGE}` },
        models: catalog.models.map((model) => ({
          ...Model.Info.default(id, Model.ID.make(model.id)),
          name: model.name,
          enabled: model.hidden !== true,
          limit: { context: model.context, output: model.output },
          capabilities: { tools: true, input: model.images ? ["text", "image"] : ["text"], output: ["text"] },
          variants: model.efforts
            .filter((effort) => offered(model.id, effort))
            .map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
          // Vibe bills the workspace balance / abo credits at the official Mistral API rates,
          // so report those instead of hiding costs.
          cost: apiCost(model.id),
        })),
      })
    })
    await ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Mistral Vibe"
      })
      editor.method.update({
        integrationID: ID,
        method: { id: "vibe-login", type: "external", label: "Use Vibe login (vibe --setup)" },
      })
    })
    await ctx.aisdk.hook(
      "sdk",
      (event) => {
        if (event.package !== PACKAGE) return
        event.sdk = { languageModel: (model: string) => new VibeModel(model) }
      },
      { providerID: ID },
    )
    const abort = new AbortController()
    const doRefresh = async () => {
      const connection = await ctx.integration.connection.active(ID)
      if (!connection) return
      const problem = await run(
        { type: "probe" },
        (event) => {
          if (event.type === "catalog") catalog = event
        },
        AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      ).then(
        () =>
          catalog.models.some((model) => model.authenticated)
            ? undefined
            : `Mistral Vibe is not logged in. Run ${vibeLoginHint()} on the OpenCode server, then reconnect Mistral Vibe.`,
        (error: unknown) => (error instanceof Error ? error.message : "Mistral Vibe could not be checked"),
      )
      if (abort.signal.aborted) return
      await ctx.storage.set("catalog", catalog)
      await ctx.provider.reload()
      await ctx.integration.connection.status({
        integrationID: ID,
        connection,
        status: problem ? { status: "needs_auth", message: problem } : undefined,
      })
    }
    // Refresh runs are serialized: a switch event during startup would otherwise
    // run a second probe concurrently and a stale result could overwrite a
    // fresher one. Each run's failure surfaces through its own promise; the
    // chain itself never rejects so later switches are not poisoned.
    let refreshQueue: Promise<void> = Promise.resolve()
    const refresh = () => {
      const attempt = refreshQueue.then(() => doRefresh())
      refreshQueue = attempt.then(
        () => undefined,
        () => undefined,
      )
      return attempt
    }
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ types: ["credential.switched"], signal: abort.signal })) {
        if (event.type === "credential.switched" && event.data.integrationID === ID) await refresh()
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted)
        // Log the real cause, not just the error class: a storage failure and
        // an AbortError must be distinguishable in the server log.
        console.error("Mistral Vibe refresh failed", error instanceof Error ? error.message : String(error))
    })
    await refresh()
    // Bootstrap the pinned runtime in the background when nothing compatible
    // exists: server startup must never block on an install. When this call
    // actually installed the runtime, refresh again so its models appear.
    ensureRuntime().then(
      async (info) => {
        if (info.installed) await refresh()
      },
      (error: unknown) => {
        console.error("Mistral Vibe runtime bootstrap failed", error instanceof Error ? error.message : String(error))
      },
    )
    return async () => {
      abort.abort()
      shutdown()
      await events
    }
  },
})
