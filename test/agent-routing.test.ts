import { describe, it, expect } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"

type Frontmatter = Record<string, string>
type Agent = { name: string; mode?: string; source: string; disabled?: boolean }

const root = new URL("..", import.meta.url).pathname
const agentsDir = `${root}agents`

function parseFrontmatter(source: string): Frontmatter {
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return {}

  const values: Frontmatter = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break
    const match = line.match(/^([\w-]+):\s*(.*)$/)
    if (!match) continue
    const value = match[2].trim()
    values[match[1]] = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
  }
  return values
}

function configuredAgents(): Agent[] {
  const config = JSON.parse(readFileSync(`${root}opencode.json`, "utf8"))
  const agents: Agent[] = []

  for (const [name, definition] of Object.entries(config.agent ?? {})) {
    const agent = definition as { mode?: string; disable?: boolean }
    if (agent.disable) continue
    // `build` and `plan` are OpenCode built-ins: absent `mode` they stay primary.
    // An explicit `mode` still wins, which is what the MCP bridge assumes too.
    const mode = agent.mode ?? (name === "build" || name === "plan" ? "primary" : undefined)
    agents.push({ name, mode, source: "opencode.json" })
  }

  for (const file of readdirSync(agentsDir).filter((entry) => entry.endsWith(".md"))) {
    const name = file.slice(0, -3)
    const frontmatter = parseFrontmatter(readFileSync(`${agentsDir}/${file}`, "utf8"))
    const mode = frontmatter.mode
    agents.push({ name, mode, source: file })
  }
  return agents
}

describe("agent routing", () => {
  it("makes every enabled agent reachable via opencode run --agent", () => {
    const agents = configuredAgents()
    expect(agents.some((agent) => agent.name === "build" && agent.mode === "primary")).toBe(true)
    expect(agents.some((agent) => agent.name === "plan" && agent.mode === "primary")).toBe(true)
    expect(agents.some((agent) => agent.name === "general")).toBe(false)
    for (const agent of agents) {
      if (agent.mode !== "primary" && agent.mode !== "all") {
        throw new Error(`${agent.name} (${agent.mode ?? "undefined"}, ${agent.source}): not reachable via opencode run --agent`)
      }
    }
  })

  it("requires model and description in every agent file", () => {
    for (const file of readdirSync(agentsDir).filter((entry) => entry.endsWith(".md"))) {
      const frontmatter = parseFrontmatter(readFileSync(`${agentsDir}/${file}`, "utf8"))
      expect(frontmatter.model, `${file}: model`).toBeTruthy()
      expect(frontmatter.description, `${file}: description`).toBeTruthy()
    }
  })

})
