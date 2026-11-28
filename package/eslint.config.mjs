// ESLint for the TypeScript plugin sources and the .mjs test suite.
// Flat config (ESLint 9); TypeScript-aware rules without type-checking, so
// the lint stays fast and deterministic in CI.
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config({ ignores: ["node_modules/**", "coverage/**"] }, ...tseslint.configs.recommended, {
  files: ["**/*.mjs"],
  languageOptions: { globals: globals.node },
})
