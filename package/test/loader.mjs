// Node's TypeScript type stripping does not map "./protocol.js" to "./protocol.ts"
// the way Bun (which opencode uses) does. This hook adds that mapping so the unit
// tests can import the plugin's real source files with plain `node --test`.
import { registerHooks } from "node:module"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && specifier.endsWith(".js")) {
      const parentDir = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd()
      const candidate = specifier.slice(0, -3) + ".ts"
      try {
        if (existsSync(join(parentDir, candidate))) return nextResolve(candidate, context)
      } catch {
        // fall through to the default resolution
      }
    }
    return nextResolve(specifier, context)
  },
})
