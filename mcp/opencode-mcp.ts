#!/usr/bin/env bun
// MCP bridge — exposes this OpenCode fleet to Claude Code as two tools.
//
// Why a bridge at all, when Claude Code can already shell out to `opencode run`:
// what bash cannot do is come back cheap. A raw run prints the whole tool trace,
// and pasting that into the caller's window to read one answer is the opposite
// of the point. This returns the final text plus one line of accounting and
// leaves the trace on the floor — which is the only reason delegating to a
// cheaper model is worth anything.
//
// Hand-rolled JSON-RPC: MCP over stdio is newline-delimited JSON-RPC with four
// methods. This repo has one dependency; adding an SDK to speak four methods is
// not a trade worth making.

import { Database } from "bun:sqlite"

const NAME = "opencode"
const VERSION = "0.1.0"
const FALLBACK_PROTOCOL = "2025-06-18"
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR ?? `${process.env.HOME}/.config/opencode`
const DEFAULT_TIMEOUT_S = 240
const BUILTIN_PRIMARY = new Set(["build", "plan"])
const DB_PATH = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/opencode.db`

// ---------------------------------------------------------------- run

type RunArgs = {
  prompt: string
  agent?: string
  model?: string
  dir?: string
  session?: string
  timeout_s?: number
}

type Digest = { text: string; footer: string; failed: boolean }

// What actually ran, straight from OpenCode's own database.
//
// Necessary because the `--format json` stream names neither the agent nor the
// model — its events carry only `type`, `part`, `sessionID` and `timestamp` —
// so the only other in-band signal was OpenCode's stderr warning, and matching
// on the wording of a warning breaks the day upstream rephrases it. This row is
// the same thing the TUI displays.
function readRun(session: string): { agent?: string; model?: string } {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    // Newest first, then the first assistant row: a resumed session holds every
    // earlier turn too, and the one that matters is this run's. `id` breaks ties
    // when two rows share a millisecond.
    const rows = db.query("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 20").all(session) as { data: string }[]
    for (const r of rows) {
      let m: any
      // Per row: one unparseable row must not hide the good rows behind it.
      try {
        m = JSON.parse(r.data)
      } catch {
        continue
      }
      if (m?.role === "assistant" && typeof m.agent === "string" && m.agent) {
        return { agent: m.agent, model: typeof m.modelID === "string" ? m.modelID : undefined }
      }
    }
  } finally {
    db.close()
  }
  return {}
}

// What actually ran, straight from OpenCode's own database.
//
// Necessary because the `--format json` stream names neither the agent nor the
// model — its events carry only `type`, `part`, `sessionID` and `timestamp` —
// so the only other in-band signal was OpenCode's stderr warning, and matching
// on the wording of a warning breaks the day upstream rephrases it. This row is
// the same thing the TUI displays.
//
// Retries because a read that comes back empty is indistinguishable from "ran
// as asked", and that is the one wrong answer this check must never give. The
// row is written during the run, so the first attempt nearly always has it; the
// rest cover a commit landing after the process exits.
async function actualRun(session: string): Promise<{ agent?: string; model?: string }> {
  if (!session) return {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const found = readRun(session)
      if (found.agent) return found
    } catch (e: any) {
      // A readonly connection to a WAL database still needs its `-shm`; that,
      // a schema change upstream, or a locked file all land here. Say so on
      // stderr — stdout is the JSON-RPC channel and cannot carry diagnostics —
      // and let the stderr fallback check downstream do the work.
      process.stderr.write(`opencode-mcp: could not read ${DB_PATH}: ${e?.message ?? e}\n`)
      return {}
    }
    if (attempt < 2) await Bun.sleep(75)
  }
  process.stderr.write(`opencode-mcp: no assistant row for session ${session}; falling back to the stderr check\n`)
  return {}
}

async function runOpencode(a: RunArgs): Promise<Digest> {
  if (!a.prompt?.trim()) throw new Error("prompt is required")

  // An unknown --agent is not an error to OpenCode: it silently falls through to
  // the default agent, which here is `build` — edit allow, bash allow. So a typo
  // in this argument turns "reads and reasons" into full write access, with
  // nothing in the output saying so. Validate before spawning.
  const agent = a.agent ?? "plan"
  const known = await fleet()
  const match = known.find((k) => k.name === agent)
  if (!match) {
    throw new Error(`unknown agent "${agent}". Fleet: ${known.map((k) => k.name).join(", ")}`)
  }
  // A name in the fleet is not enough: `run --agent` takes primaries only, and
  // hands a subagent the same silent fallback as a typo. Refuse here rather
  // than pay for a run that answers as the wrong agent.
  if (!match.primary) {
    throw new Error(
      `agent "${agent}" is mode: subagent, which \`opencode run --agent\` cannot start — ` +
        `it would silently fall back to the default agent. Give it \`mode: all\` in its ` +
        `definition to make it reachable from here. Reachable now: ${known.filter((k) => k.primary).map((k) => k.name).join(", ")}`,
    )
  }

  // `--auto` approves anything the agent's permission block does not explicitly
  // deny. Without it a non-interactive run dies the first time an agent asks —
  // the rejection aborts the whole run rather than being absorbed. It cannot
  // widen a `deny`, so a read-only agent stays read-only under it.
  const args = ["run", "--format", "json", "--auto"]
  args.push("--agent", agent)
  if (a.model) args.push("--model", a.model)
  if (a.session) args.push("--session", a.session)
  args.push("--dir", a.dir ?? process.cwd())
  args.push(a.prompt)

  const started = Date.now()
  const proc = Bun.spawn(["opencode", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  })

  let timedOut = false
  const timer = setTimeout(
    () => {
      timedOut = true
      proc.kill()
    },
    (a.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000,
  )

  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  clearTimeout(timer)
  const code = await proc.exited

  // Text arrives as parts that may be re-emitted as they stream, so key by part
  // id and keep the last version of each — concatenating every event instead
  // would repeat the answer once per token.
  const texts = new Map<string, string>()
  const tools = new Map<string, number>()
  let session = a.session ?? ""
  let cost = 0
  let tin = 0
  let tout = 0
  let cache = 0

  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue
    let e: any
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.sessionID) session = e.sessionID
    const p = e.part ?? {}
    if (e.type === "text" && typeof p.text === "string") texts.set(p.id ?? String(texts.size), p.text)
    if (e.type === "tool_use" && p.tool) tools.set(p.tool, (tools.get(p.tool) ?? 0) + 1)
    if (e.type === "step_finish") {
      cost += p.cost ?? 0
      tin += p.tokens?.input ?? 0
      tout += p.tokens?.output ?? 0
      cache += p.tokens?.cache?.read ?? 0
    }
  }

  const text = [...texts.values()].join("\n").trim()
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  const toolLine = tools.size ? ` · ${[...tools].map(([t, n]) => `${t}×${n}`).join(" ")}` : ""
  // Prompt size is input + cache.read: reading `input` alone compares runs with
  // different cache states and reports nonsense.
  const ran = await actualRun(session)
  const ranLine = ran.agent ? ` · ran as ${ran.agent}${ran.model ? `/${ran.model}` : ""}` : ""
  const footer = `— ${session || "no session"} · ${secs}s · $${cost.toFixed(4)} · prompt ${tin + cache} · out ${tout}${toolLine}${ranLine}`

  // OpenCode does not fail when it refuses an agent: it warns on stderr and runs
  // `default_agent` instead, which here is `build` — edit allow, bash allow. The
  // answer comes back looking perfectly fine, so an unchecked run silently
  // returns the write-enabled primary, at the primary's price, for a request
  // that named a read-only specialist.
  //
  // Compare names rather than reading the warning: the database says what ran,
  // and it keeps saying it whatever upstream does to the wording. The stderr
  // match stays behind it for the case where the database cannot be read.
  const misrouted = ran.agent !== undefined && ran.agent !== agent
  const fellBack = misrouted || /is a subagent, not a primary agent/.test(err)
  const fallbackNote = fellBack
    ? `opencode did NOT run this as the requested agent "${agent}"` +
      (ran.agent ? ` — it ran as "${ran.agent}"${ran.model ? ` on ${ran.model}` : ""}` : ", it fell back to the default agent") +
      `. Permissions and cost are not what was asked for, so treat the output below as untrusted.\n\n`
    : ""

  if (timedOut) {
    // No session id means the run was killed before OpenCode emitted its first
    // event, so there is nothing to resume — say that instead of handing back
    // an empty id to pass to `session`.
    const resume = session ? `resume with session: "${session}"` : "no session id was emitted, so this run cannot be resumed"
    return {
      text: fallbackNote + (text || "(no output before the timeout)"),
      footer: `${footer} · TIMED OUT after ${a.timeout_s ?? DEFAULT_TIMEOUT_S}s — ${resume}`,
      failed: true,
    }
  }

  if (fellBack) {
    const detail = misrouted ? "" : `stderr: ${err.replace(/\x1b\[[0-9;]*m/g, "").trim()}\n\n`
    return { text: `${fallbackNote}${detail}${text}`, footer, failed: true }
  }
  if (code !== 0 && !text) {
    return { text: `opencode exited ${code}\n${err.trim().slice(-2000)}`, footer, failed: true }
  }
  return { text: text || "(the run produced no text)", footer, failed: false }
}

// ---------------------------------------------------------------- agents

type Agent = { name: string; model: string; mode?: string; primary: boolean; description: string }

// Read off disk rather than hardcoded: the fleet is repinned often enough that a
// baked-in list would be wrong within a week.
async function fleet(): Promise<Agent[]> {
  const out: Agent[] = []

  try {
    const cfg = JSON.parse(await Bun.file(`${CONFIG_DIR}/opencode.json`).text())
    for (const [name, a] of Object.entries<any>(cfg.agent ?? {})) {
      if (a?.disable) continue
      // `build` and `plan` are OpenCode's own primaries: a config block that only
      // repins their model does not demote them, so absent `mode` they stay primary.
      const mode = a.mode ?? (BUILTIN_PRIMARY.has(name) ? "primary" : undefined)
      out.push({ name, model: a.model ?? cfg.model ?? "?", mode, primary: mode === "primary" || mode === "all", description: a.description ?? "no description" })
    }
  } catch (e) {
    throw new Error(`could not read ${CONFIG_DIR}/opencode.json: ${e}`)
  }

  const glob = new Bun.Glob("*.md")
  for await (const file of glob.scan({ cwd: `${CONFIG_DIR}/agents` })) {
    const raw = await Bun.file(`${CONFIG_DIR}/agents/${file}`).text()
    const lines = raw.split(/\r?\n/)
    // Only a block opening on line 1 is frontmatter. Splitting on "---" anywhere
    // would read a horizontal rule in the body of a file that has none.
    const close = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1
    const fm = close === -1 ? "" : lines.slice(1, close).join("\n")
    const grab = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim()
    const mode = grab("mode")
    out.push({ name: file.replace(/\.md$/, ""), model: grab("model") ?? "?", mode, primary: mode === "primary" || mode === "all", description: grab("description") ?? "no description" })
  }

  for (const name of BUILTIN_PRIMARY) {
    if (out.some((a) => a.name === name)) continue
    out.push({ name, model: "?", mode: "primary", primary: true, description: "OpenCode built-in (not configured here)" })
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function listAgents(): Promise<string> {
  return (await fleet())
    .map((a) => {
      const tag = a.primary ? "" : " (mode: subagent — NOT reachable through `run`)"
      return `${a.name} [${a.model}]${tag} — ${a.description}`
    })
    .join("\n")
}

// ---------------------------------------------------------------- protocol

const TOOLS = [
  {
    name: "run",
    description:
      "Delegate a task to the local OpenCode fleet and get back only the final answer plus a cost line — the tool trace stays out of this context. Use for work that is verbose to do here and cheap to do there: repo-wide sweeps, running a build or test suite and reporting what broke, browser verification through the tandem plugin, or a second opinion from a different model family. The default agent `plan` cannot edit files. Call `agents` first if unsure which specialist fits.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task, written as if for a fresh agent: it starts cold and shares no context with this conversation." },
        agent: { type: "string", description: "Fleet agent to run as. Default `plan` — reads and reasons, edit denied. Pass `build` to allow edits, or a specialist (`explore`, `debug`, `test`, `security`, `council`, ...) from the `agents` tool." },
        model: { type: "string", description: "Override the agent's pinned model, as provider/model (e.g. opencode-go/gpt-5.6-luna). Omit to use what the agent pins." },
        dir: { type: "string", description: "Directory to run in. Defaults to this server's working directory." },
        session: { type: "string", description: "Continue an earlier OpenCode session by id instead of starting cold." },
        timeout_s: { type: "number", description: `Seconds before the run is killed (default ${DEFAULT_TIMEOUT_S}). On timeout the partial output and the session id come back, so it can be resumed.` },
      },
      required: ["prompt"],
    },
  },
  {
    name: "agents",
    description: "List the OpenCode fleet — agent names, pinned models and what each is for — read live from the installed config. Call before `run` when the right specialist is not obvious.",
    inputSchema: { type: "object", properties: {} },
  },
]

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function reply(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result })
}

async function handle(req: any) {
  const { id, method, params } = req
  const isNotification = id === undefined || id === null

  switch (method) {
    case "initialize":
      // Echo the client's protocol version when it states one: this server has
      // no version-specific behaviour, so refusing over a version string would
      // only break the handshake.
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      })

    case "tools/list":
      return reply(id, { tools: TOOLS })

    case "tools/call": {
      const name = params?.name
      try {
        if (name === "agents") return reply(id, { content: [{ type: "text", text: await listAgents() }] })
        if (name === "run") {
          const d = await runOpencode(params?.arguments ?? {})
          return reply(id, { content: [{ type: "text", text: `${d.text}\n\n${d.footer}` }], isError: d.failed })
        }
        return reply(id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true })
      } catch (e: any) {
        // A thrown tool is reported in-band: a JSON-RPC error would strip the
        // message out of the model's view, and the message is the useful part.
        return reply(id, { content: [{ type: "text", text: `${name} failed: ${e?.message ?? e}` }], isError: true })
      }
    }

    case "ping":
      return reply(id, {})

    default:
      if (isNotification) return // notifications/initialized and friends
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

const decoder = new TextDecoder()
let buf = ""
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true })
  let nl: number
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let req: unknown
    try {
      req = JSON.parse(line)
    } catch {
      continue // no id to answer with, so there is nobody to tell
    }
    // Deliberately not awaited. A `run` holds this process for as long as the
    // delegated task takes, and awaiting here queues every other request behind
    // it — measured before the fix: an `agents` call costing 10ms of disk came
    // back at 3.19s, the exact instant the run in front of it finished. Every
    // response carries its own id, so answering out of order is correct.
    void handle(req).catch(() => {})
  }
}
