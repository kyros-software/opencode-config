import { describe, it, expect } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { createProxyServer, UPSTREAMS, CHAINS } from "../fallback-proxy-lib"

type Seen = { path: string; model?: string; auth?: string }

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

// Verbatim shapes observed from https://opencode.ai/zen/go/v1. Two axes vary
// independently — the status and the error type — and both have to be read: 401
// carries a retired model and a bad key alike, while 403 carries a region-gated
// model and an ordinary refusal alike.
const modelError = (model: string | undefined) =>
  json(401, { type: "error", error: { type: "ModelError", message: `Model ${model} is not supported` } })
const regionError = () =>
  json(403, {
    type: "error",
    error: {
      type: "RegionError",
      message: "The latest version of this model is only available hosted in China and requires explicit opt in",
    },
  })
const badKey = () => json(401, { type: "error", error: { type: "AuthError", message: "invalid api key" } })
const forbidden = () => json(403, { type: "error", error: { type: "PermissionError", message: "not your workspace" } })

/** An upstream that records what it was asked for and answers per model. */
function startUpstream(respond: (model: string | undefined, req: Request) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      let model: string | undefined
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any
        model = body?.model
      }
      seen.push({ path: url.pathname, model, auth: req.headers.get("authorization") ?? undefined })
      return respond(model, req)
    },
  })
  return { server, seen, url: `http://127.0.0.1:${server.port}` }
}

/**
 * Builds a proxy over freshly-started upstreams and tears everything down
 * afterwards. Each test gets its own rig — no state leaks between them.
 */
async function withRig(
  opts: {
    chains: Record<string, string[]>
    go: (model: string | undefined, req: Request) => Response | Promise<Response>
    zen?: (model: string | undefined, req: Request) => Response | Promise<Response>
    timeoutMs?: number
  },
  run: (rig: {
    post: (tier: string, body: unknown) => Promise<Response>
    get: (tier: string, path: string) => Promise<Response>
    logs: string[]
    swaps: string[]
    go: Seen[]
    zen: Seen[]
  }) => Promise<void>,
) {
  const go = startUpstream(opts.go)
  const zen = startUpstream(opts.zen ?? (() => json(200, { tier: "zen" })))
  const logs: string[] = []
  // Recorded as "requested→served" so a test can assert the whole swap history
  // in one shot: how many fired, and which model each one names.
  const swaps: string[] = []
  const proxy = createProxyServer({
    log: (m) => logs.push(m),
    onSwap: (requested, served) => swaps.push(`${requested}→${served}`),
    upstreams: { zen: zen.url, go: go.url },
    chains: opts.chains,
    headersTimeoutMs: opts.timeoutMs ?? 60_000,
  })
  try {
    await run({
      post: (tier, body) =>
        fetch(`http://127.0.0.1:${proxy.port}/${tier}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${tier}-key` },
          body: JSON.stringify(body),
        }),
      get: (tier, path) => fetch(`http://127.0.0.1:${proxy.port}/${tier}${path}`),
      logs,
      swaps,
      go: go.seen,
      zen: zen.seen,
    })
  } finally {
    proxy.stop()
    go.server.stop()
    zen.server.stop()
  }
}

describe("config invariants", () => {
  it("maps each tier to its own upstream", () => {
    // Regression: both tiers once pointed at the Go endpoint, silently
    // hijacking every Zen model call.
    expect(UPSTREAMS.zen).toBe("https://opencode.ai/zen/v1")
    expect(UPSTREAMS.go).toBe("https://opencode.ai/zen/go/v1")
    expect(UPSTREAMS.zen).not.toBe(UPSTREAMS.go)
  })

  it("only chains well-formed, same-tier, non-self candidates", () => {
    for (const [key, candidates] of Object.entries(CHAINS)) {
      const tier = key.slice(0, key.indexOf("/"))
      expect(UPSTREAMS[tier]).toBeDefined()
      for (const candidate of candidates) {
        expect(candidate).toMatch(/^[^/]+\/.+$/)
        expect(candidate.slice(0, candidate.indexOf("/"))).toBe(tier)
        expect(candidate).not.toBe(key)
      }
      expect(new Set(candidates).size).toBe(candidates.length)
    }
  })

  it("gives every model this config pins a chain to fall down", () => {
    // The Aug 2026 outage had two halves and this is the second one: the manual
    // workaround repointed build at a model that had no chain, so the config came
    // back up with no fallback at all and nothing said so. A model pinned by an
    // agent but absent from CHAINS is a single point of failure for that agent;
    // when it is the primary, it is one for the whole session.
    const root = new URL("..", import.meta.url).pathname
    const sources = [
      readFileSync(`${root}/opencode.json`, "utf8"),
      ...readdirSync(`${root}/agents`)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readFileSync(`${root}/agents/${f}`, "utf8")),
    ]
    // Only the Go tier is chained: Zen models are Anthropic's own and have no
    // sibling worth swapping in.
    const pinned = new Set(sources.flatMap((s) => [...s.matchAll(/opencode-go\/([\w.-]+)/g)].map((m) => m[1])))
    expect(pinned.size).toBeGreaterThan(0)
    for (const model of pinned) expect(CHAINS[`go/${model}`]).toBeDefined()
  })

  it("never falls back to a model with a history of disappearing", () => {
    // Both deepseek models are reachable again as of this commit, so this is no
    // longer about dead candidates — it is about which models are allowed to be
    // somebody's safety net. A fallback has to be more available than the thing
    // it replaces. These two went region-gated for a month; they can be primaries
    // (a chain covers them) but never candidates, or an outage in one model
    // routes traffic straight into the one with the worst availability record.
    const neverACandidate = ["go/deepseek-v4-pro", "go/deepseek-v4-flash"]
    for (const candidates of Object.values(CHAINS)) {
      for (const candidate of candidates) expect(neverACandidate).not.toContain(candidate)
    }
  })

  it("never falls back to a strictly dominated model", () => {
    // glm-5.1 is 1.4/4.4/0.26 against kimi-k2.7-code's 0.95/4/0.19 — worse on
    // input, output and cache_read alike — and it was slower than luna and
    // deepseek in a measured run. It once sat in 8 of 9 chains, which meant every
    // outage funnelled traffic into the priciest model on the account at the
    // moment things were already going wrong. A fallback is picked under duress;
    // that is exactly when nobody is watching the bill.
    const dominated = ["go/glm-5.1"]
    for (const [key, candidates] of Object.entries(CHAINS)) {
      expect(dominated).not.toContain(key)
      for (const candidate of candidates) expect(dominated).not.toContain(candidate)
    }
  })
})

describe("fallback-proxy", () => {
  it("falls back when the first model returns 429", async () => {
    await withRig(
      {
        chains: { "go/deepseek-v4-pro": ["go/kimi-k2.7-code", "go/deepseek-v4-flash"] },
        go: (model) => (model === "deepseek-v4-pro" ? json(429, { error: "rate limit" }) : json(200, { model })),
      },
      async ({ post, logs, go }) => {
        const res = await post("go", { model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("kimi-k2.7-code")
        expect(go.map((s) => s.model)).toEqual(["deepseek-v4-pro", "kimi-k2.7-code"])
        expect(logs).toEqual(["deepseek-v4-pro returned 429", "deepseek-v4-pro → kimi-k2.7-code"])
      },
    )
  })

  it("passes through untouched when the first try succeeds", async () => {
    await withRig(
      { chains: { "go/deepseek-v4-pro": ["go/kimi-k2.7-code"] }, go: (model) => json(200, { model }) },
      async ({ post, logs, go }) => {
        const res = await post("go", { model: "deepseek-v4-pro", messages: [] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("deepseek-v4-pro")
        expect(go).toHaveLength(1)
        expect(logs).toEqual([])
      },
    )
  })

  it("does not chain a model that has no chain entry", async () => {
    // Regression: an unchained model's 429 used to come back as a synthetic 503.
    // The zen tier has no chains at all, so that was every Claude rate limit.
    await withRig({ chains: {}, go: (model) => json(429, { model }) }, async ({ post, go }) => {
      const res = await post("go", { model: "lonely-model", messages: [] })
      expect(res.status).toBe(429)
      expect(go).toHaveLength(1)
    })
  })

  it("routes each tier to its own upstream", async () => {
    // Would have caught the zen-points-at-go bug: only meaningful because the
    // two upstreams are distinct servers.
    await withRig(
      { chains: {}, go: (model) => json(200, { tier: "go", model }), zen: (model) => json(200, { tier: "zen", model }) },
      async ({ post, go, zen }) => {
        expect((await (await post("zen", { model: "claude-opus-4-8" })).json()).tier).toBe("zen")
        expect((await (await post("go", { model: "kimi-k3" })).json()).tier).toBe("go")
        expect(go.map((s) => s.model)).toEqual(["kimi-k3"])
        expect(zen.map((s) => s.model)).toEqual(["claude-opus-4-8"])
      },
    )
  })

  it("returns a non-retryable status from the requested model to the caller", async () => {
    await withRig(
      {
        chains: { "go/deepseek-v4-pro": ["go/kimi-k2.7-code"] },
        go: (model) => (model === "deepseek-v4-pro" ? json(400, { error: "bad request" }) : json(200, { model })),
      },
      async ({ post, go }) => {
        const res = await post("go", { model: "deepseek-v4-pro", messages: [] })
        expect(res.status).toBe(400)
        expect((await res.json()).error).toBe("bad request")
        // The caller's request was malformed; burning a fallback would not help.
        expect(go).toHaveLength(1)
      },
    )
  })

  it("keeps walking the chain when a fallback candidate is non-retryable", async () => {
    // Regression: a dead model early in a chain used to abort the whole chain,
    // so the healthy candidate behind it was never reached.
    await withRig(
      {
        chains: { "go/qwen3.7-plus": ["go/does-not-exist", "go/deepseek-v4-flash"] },
        go: (model) => {
          if (model === "qwen3.7-plus") return json(429, { error: "rate limit" })
          if (model === "does-not-exist") return modelError(model)
          return json(200, { model })
        },
      },
      async ({ post, go }) => {
        const res = await post("go", { model: "qwen3.7-plus", messages: [] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("deepseek-v4-flash")
        expect(go.map((s) => s.model)).toEqual(["qwen3.7-plus", "does-not-exist", "deepseek-v4-flash"])
      },
    )
  })

  it("routes around a requested model that upstream has retired", async () => {
    // A retired primary model answers 401/ModelError. That is not the caller's
    // fault and the chain can cover it, so it must not reach them.
    await withRig(
      {
        chains: { "go/kimi-k3": ["go/deepseek-v4-flash"] },
        go: (model) => (model === "kimi-k3" ? modelError(model) : json(200, { model })),
      },
      async ({ post, logs, go }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("deepseek-v4-flash")
        expect(go.map((s) => s.model)).toEqual(["kimi-k3", "deepseek-v4-flash"])
        expect(logs.some((l) => /unavailable upstream \(ModelError\)/.test(l))).toBe(true)
      },
    )
  })

  it("routes around a requested model that upstream has region-gated", async () => {
    // The Aug 2026 outage in one test. deepseek-v4-pro went China-only and
    // started answering 403/RegionError; the classifier knew only 401/ModelError,
    // so this failure passed straight through to the caller and the chain — which
    // existed, and whose first candidate was healthy — was never consulted.
    await withRig(
      {
        chains: { "go/deepseek-v4-pro": ["go/kimi-k2.7-code"] },
        go: (model) => (model === "deepseek-v4-pro" ? regionError() : json(200, { model })),
      },
      async ({ post, logs, swaps, go }) => {
        const res = await post("go", { model: "deepseek-v4-pro", messages: [] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("kimi-k2.7-code")
        expect(go.map((s) => s.model)).toEqual(["deepseek-v4-pro", "kimi-k2.7-code"])
        expect(logs.some((l) => /unavailable upstream \(RegionError\)/.test(l))).toBe(true)
        expect(swaps).toEqual(["deepseek-v4-pro→kimi-k2.7-code"])
      },
    )
  })

  it("surfaces a 403 the chain cannot cover instead of burning it", async () => {
    // Same status as the region gate, different type. Widening the classifier by
    // status alone would swallow this and report a misleading 503 four requests
    // later; it is the error type that says whether a swap can help.
    await withRig(
      { chains: { "go/kimi-k3": ["go/kimi-k2.7-code", "go/glm-5.1"] }, go: () => forbidden() },
      async ({ post, go }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(403)
        expect((await res.json()).error.type).toBe("PermissionError")
        expect(go).toHaveLength(1)
      },
    )
  })

  it("surfaces a bad key immediately instead of burning the chain", async () => {
    // Same 401 as a retired model, different body. Walking the chain here would
    // fire four doomed requests and report a misleading 503.
    await withRig(
      { chains: { "go/kimi-k3": ["go/deepseek-v4-flash", "go/mimo-v2.5"] }, go: () => badKey() },
      async ({ post, go }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(401)
        expect((await res.json()).error.type).toBe("AuthError")
        expect(go).toHaveLength(1)
      },
    )
  })

  it("skips cross-tier candidates instead of leaking the wrong credential", async () => {
    await withRig(
      {
        chains: { "go/kimi-k3": ["zen/claude-opus-4-8", "go/deepseek-v4-flash"] },
        go: (model) => (model === "kimi-k3" ? json(429, {}) : json(200, { model })),
        zen: (model) => json(200, { model }),
      },
      async ({ post, logs, go, zen }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("deepseek-v4-flash")
        // The Go key must never reach the Zen upstream.
        expect(zen).toHaveLength(0)
        expect(go.every((s) => s.auth === "Bearer go-key")).toBe(true)
        expect(logs.some((l) => /cross-tier/.test(l))).toBe(true)
      },
    )
  })

  it("skips malformed and unknown-tier candidates, then keeps walking", async () => {
    await withRig(
      {
        chains: { "go/kimi-k3": ["nope/model-x", "bare-model", "go/deepseek-v4-flash"] },
        go: (model) => (model === "kimi-k3" ? json(429, {}) : json(200, { model })),
      },
      async ({ post, logs }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("deepseek-v4-flash")
        expect(logs.some((l) => /cross-tier/.test(l))).toBe(true)
        expect(logs.some((l) => /malformed/.test(l))).toBe(true)
      },
    )
  })

  it("falls back when the upstream stalls before sending headers", async () => {
    await withRig(
      {
        timeoutMs: 150,
        chains: { "go/kimi-k3": ["go/deepseek-v4-flash"] },
        go: (model, req) => {
          if (model !== "kimi-k3") return json(200, { model })
          // Never answers; settles only once the proxy gives up on it.
          return new Promise<Response>((resolve) => {
            req.signal.addEventListener("abort", () => resolve(json(499, {})))
          })
        },
      },
      async ({ post, logs }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(200)
        expect((await res.json()).model).toBe("deepseek-v4-flash")
        expect(logs.some((l) => /unreachable/.test(l))).toBe(true)
      },
    )
  })

  it("forwards non-chat requests directly", async () => {
    await withRig({ chains: {}, go: () => json(200, { ok: true }) }, async ({ get, go }) => {
      const res = await get("go", "/models")
      expect(res.status).toBe(200)
      expect(go[0].path).toBe("/models")
    })
  })

  it("hands back the requested model's own failure when every candidate fails", async () => {
    // Regression: the chain used to swallow the primary's 429 and answer 503,
    // throwing away the retry-after the client needs to back off correctly.
    await withRig(
      {
        chains: { "go/always-fail": ["go/still-fail"] },
        go: (model) =>
          model === "always-fail"
            ? new Response(JSON.stringify({ error: "rate limit" }), {
                status: 429,
                headers: { "content-type": "application/json", "retry-after": "30" },
              })
            : json(500, { error: "boom" }),
      },
      async ({ post, go }) => {
        const res = await post("go", { model: "always-fail" })
        expect(res.status).toBe(429)
        expect(res.headers.get("retry-after")).toBe("30")
        expect((await res.json()).error).toBe("rate limit")
        expect(go.map((s) => s.model)).toEqual(["always-fail", "still-fail"])
      },
    )
  })

  it("hands back a retired model's own 401 when the chain cannot cover it", async () => {
    // Same principle for the other routable failure: "kimi-k3 is not supported"
    // tells the caller what to change, "all fallbacks exhausted" does not.
    await withRig(
      {
        chains: { "go/kimi-k3": ["go/deepseek-v4-flash"] },
        go: (model) => (model === "kimi-k3" ? modelError(model) : json(503, {})),
      },
      async ({ post }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(401)
        expect((await res.json()).error.type).toBe("ModelError")
      },
    )
  })

  it("answers 503 only when no candidate produced a response at all", async () => {
    await withRig(
      {
        timeoutMs: 100,
        chains: { "go/kimi-k3": ["go/deepseek-v4-flash"] },
        // Neither model ever sends headers, so there is no upstream verdict to
        // pass on and the synthetic status is the only thing left.
        go: (_model, req) =>
          new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => resolve(json(499, {})))),
      },
      async ({ post, logs }) => {
        const res = await post("go", { model: "kimi-k3", messages: [] })
        expect(res.status).toBe(503)
        expect(logs.filter((l) => /unreachable/.test(l))).toHaveLength(2)
      },
    )
  })

  it("binds to loopback only", async () => {
    const server = createProxyServer({
      log: () => {},
      upstreams: { zen: "http://127.0.0.1:1", go: "http://127.0.0.1:1" },
      chains: {},
    })
    try {
      expect(server.hostname).toBe("127.0.0.1")
    } finally {
      server.stop()
    }
  })
})

// onSwap drives a TUI toast, so a spurious fire is a lie told to the user's face
// rather than a stray log line. Every case below pins down when it must not fire.
describe("onSwap", () => {
  it("fires once a fallback has answered, naming the model that served", async () => {
    await withRig(
      {
        chains: { "go/deepseek-v4-pro": ["go/kimi-k2.7-code"] },
        go: (model) => (model === "deepseek-v4-pro" ? json(429, {}) : json(200, { model })),
      },
      async ({ post, swaps }) => {
        await post("go", { model: "deepseek-v4-pro", messages: [] })
        expect(swaps).toEqual(["deepseek-v4-pro→kimi-k2.7-code"])
      },
    )
  })

  it("stays quiet when the requested model answers", async () => {
    await withRig(
      { chains: { "go/deepseek-v4-pro": ["go/kimi-k2.7-code"] }, go: (model) => json(200, { model }) },
      async ({ post, swaps }) => {
        await post("go", { model: "deepseek-v4-pro", messages: [] })
        expect(swaps).toEqual([])
      },
    )
  })

  it("announces nothing when the whole chain fails", async () => {
    // The caller gets the requested model's own 429 back, served by nothing else.
    // Firing on the attempt rather than the answer would announce a swap to a
    // model that never responded, on a request that came back as the original's
    // own error.
    await withRig({ chains: { "go/always-fail": ["go/still-fail"] }, go: () => json(429, {}) }, async ({ post, swaps, go }) => {
      const res = await post("go", { model: "always-fail", messages: [] })
      expect(res.status).toBe(429)
      expect(go.map((s) => s.model)).toEqual(["always-fail", "still-fail"])
      expect(swaps).toEqual([])
    })
  })

  it("delivers the response even if the notifier throws", async () => {
    // onSwap runs on the success path, so a broken notifier — a missing TUI, a
    // client method that vanished across an upstream SDK bump — must cost a log
    // line, not the answer the chain just fought to obtain.
    const go = startUpstream((model) => (model === "kimi-k3" ? json(429, {}) : json(200, { model })))
    const logs: string[] = []
    const proxy = createProxyServer({
      log: (m) => logs.push(m),
      onSwap: () => {
        throw new Error("no TUI attached")
      },
      upstreams: { zen: go.url, go: go.url },
      chains: { "go/kimi-k3": ["go/deepseek-v4-flash"] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/go/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).model).toBe("deepseek-v4-flash")
      expect(logs.some((l) => /onSwap threw/.test(l))).toBe(true)
    } finally {
      proxy.stop(true)
      go.server.stop(true)
    }
  })

  it("names only the model that answered, not the ones tried on the way", async () => {
    // Two candidates are attempted past the primary but only the last one
    // answers: firing per attempt would toast twice and name a dead model first.
    await withRig(
      {
        chains: { "go/qwen3.7-plus": ["go/does-not-exist", "go/deepseek-v4-flash"] },
        go: (model) => {
          if (model === "qwen3.7-plus") return json(429, {})
          if (model === "does-not-exist") return modelError(model)
          return json(200, { model })
        },
      },
      async ({ post, swaps }) => {
        await post("go", { model: "qwen3.7-plus", messages: [] })
        expect(swaps).toEqual(["qwen3.7-plus→deepseek-v4-flash"])
      },
    )
  })
})
