// Builds the npm-facing README from the repo README.
//
// GitHub renders the mermaid diagram natively; npm does not. This script
// swaps the mermaid code block for a rendered image URL (mermaid.ink), so
// the npm package page displays the diagram as a picture while the GitHub
// repo keeps its native mermaid. One source of truth: the repo README.
import { readFileSync, writeFileSync } from "node:fs"

const root = new URL("../", import.meta.url)
const source = readFileSync(new URL("README.md", root), "utf8")
const mermaid = source.match(/```mermaid\r?\n([\s\S]*?)```/)

if (!mermaid) {
  writeFileSync(new URL("package/README.md", root), source)
  console.log("npm README: no mermaid block found, shipped verbatim")
} else {
  const code = mermaid[1].replace(/\r\n/g, "\n")
  const encoded = encodeURIComponent(Buffer.from(code).toString("base64"))
  const image = `![architecture diagram](https://mermaid.ink/img/${encoded})`
  writeFileSync(
    new URL("package/README.md", root),
    source.replace(/```mermaid\r?\n[\s\S]*?```/, image),
  )
  console.log("npm README: mermaid block replaced with a rendered image")
}
