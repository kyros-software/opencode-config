// Shared types and helpers for the fallback proxy.
// Imported by both the plugin entry point and tests.

export const UPSTREAMS: Record<string, string> = {
  zen: "https://opencode.ai/zen/v1",
  go: "https://opencode.ai/zen/go/v1",
}

// Fallback chains keyed by `${tier}/${model}`. Candidates must stay on their
// home tier: the caller's Authorization header is forwarded verbatim and each
// tier is a separate provider with its own API key, so a cross-tier hop would
// present the wrong credential. Cross-tier candidates are skipped at runtime.
//
// Invariant: every model pinned anywhere in opencode.json or agents/*.md needs a
// key here. A model with no chain is a single point of failure for whichever
// agents pin it, and the primary having no chain takes the whole session down.
//
// Both deepseek models spent Aug 2026 behind a China-region opt-in answering
// 403/RegionError, and both came back. deepseek-v4-pro is the primary again — a
// chain covers it, so its next disappearance costs a round-trip instead of a
// session. It stays out of every other model's candidate list, though: a fallback
// has to be more available than the thing it replaces, and this is the one model
// on the account with a demonstrated history of vanishing. Same for -flash.
// Every candidate below was probed against the live Go upstream and answered 200.
// A candidate is also a price decision. glm-5.1 used to sit in 8 of these 9
// chains — every outage funnelled into it — while being strictly dominated:
// 1.4/4.4/0.26 against kimi-k2.7-code's 0.95/4/0.19 on every axis, and slower
// than both luna and deepseek in a measured run. It is now in none of them, and
// pinned nowhere, so it has no chain of its own either.
//
// Order within a chain is capability-tier first, then price. Reasoning models
// fall to reasoning models; the cheap agents fall to cheap models. Dropping
// `architect` straight to a budget model would keep the session alive and make
// its output worthless, which is not what a fallback is for.
export const CHAINS: Record<string, string[]> = {
  "go/deepseek-v4-pro":    ["go/gpt-5.6-luna", "go/kimi-k2.7-code", "go/mimo-v2.5-pro"],
  "go/gpt-5.6-luna":       ["go/mimo-v2.5-pro", "go/minimax-m3", "go/qwen3.7-plus"],
  "go/kimi-k3":            ["go/kimi-k2.7-code", "go/qwen3.8-max", "go/minimax-m3"],
  "go/kimi-k2.7-code":     ["go/kimi-k3", "go/minimax-m3", "go/gpt-5.6-luna"],
  "go/qwen3.8-max":        ["go/qwen3.7-plus", "go/kimi-k3", "go/minimax-m3"],
  "go/qwen3.7-plus":       ["go/qwen3.6-plus", "go/minimax-m3", "go/gpt-5.6-luna"],
  "go/qwen3.6-plus":       ["go/qwen3.7-plus", "go/mimo-v2.5-pro", "go/gpt-5.6-luna"],
  // Unpinned, but kept: it is the primary's sibling and the obvious manual pick
  // during exactly the outage we just lived through.
  "go/deepseek-v4-flash":  ["go/gpt-5.6-luna", "go/kimi-k2.7-code", "go/mimo-v2.5-pro"],
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

// Upstream answers "that model is not available to you" on a status that also
// carries "your credential is wrong", so only the error type in the body tells
// them apart. A model that went away has to fall down the chain; a bad key has to
// surface immediately rather than burn every candidate.
//
// This list is the whole reason the fleet sat out the Aug 2026 deepseek outage:
// it held 401 alone, deepseek-v4-pro went China-only behind 403/RegionError, and
// every request for it passed straight through to the caller with the chain
// never consulted. When upstream invents the next way to retire a model, this is
// the list that needs it — not the chains.
const MODEL_UNAVAILABLE_STATUSES = new Set([401, 403, 404])
const MODEL_UNAVAILABLE_TYPES = new Set(["ModelError", "RegionError"])

// Guards time-to-first-byte only, never the body stream: a long generation is
// expected to keep streaming well past this. Must stay well under the client's
// own `headerTimeout` (opencode.json) divided by the longest chain: the client
// aborting mid-walk kills the fallback outright, because an aborted request is
// indistinguishable from the caller hanging up and the loop rethrows instead of
// trying the next candidate.
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000

function parseCandidate(s: string): { tier: string; model: string } | null {
  const idx = s.indexOf("/")
  if (idx <= 0 || idx === s.length - 1) return null
  return { tier: s.slice(0, idx), model: s.slice(idx + 1) }
}

export type ProxyOptions = {
  /** Trace of every routing decision the chain makes. */
  log: (msg: string) => void
  /**
   * Fires once a fallback has actually answered — never for a candidate the
   * chain merely tried. Announcing the attempt instead would lie twice over: the
   * chain walks straight past a candidate that fails, and an exhausted chain
   * hands back the requested model's own error, having served nothing else.
   */
  onSwap?: (requested: string, served: string) => void
  upstreams?: Record<string, string>
  chains?: Record<string, string[]>
  headersTimeoutMs?: number
}

export function createProxyServer(opts: ProxyOptions) {
  const {
    log,
    onSwap = () => {},
    upstreams = UPSTREAMS,
    chains = CHAINS,
    headersTimeoutMs = DEFAULT_HEADERS_TIMEOUT_MS,
  } = opts
  return Bun.serve({
    // Loopback only: this is an unauthenticated forwarder to the upstream.
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const tierMatch = url.pathname.match(/^\/(zen|go)\/(.+)/)
      const homeTier = tierMatch?.[1] ?? "zen"
      const restPath = tierMatch ? "/" + tierMatch[2] : url.pathname
      // Every request this server makes goes to the caller's home tier: the chain
      // rejects cross-tier candidates below, so there is nowhere else to send it.
      const target = upstreams[homeTier]

      if (!tierMatch || !restPath.endsWith("/chat/completions")) {
        return proxyTo(target, restPath + url.search, req, null, headersTimeoutMs)
      }

      let body: any
      try {
        body = await req.clone().json()
      } catch {
        return proxyTo(target, restPath + url.search, req, null, headersTimeoutMs)
      }

      const model = body?.model
      if (!model) return proxyTo(target, restPath + url.search, req, null, headersTimeoutMs)

      const originalBodyStr = JSON.stringify(body)
      const chainKey = `${homeTier}/${model}`
      const candidates = [chainKey, ...(chains[chainKey] ?? [])]

      // The requested model's own failure, kept in case nothing downstream works.
      let primaryFailure: Response | null = null

      for (let i = 0; i < candidates.length; i++) {
        const parsed = parseCandidate(candidates[i])
        if (!parsed) {
          log(`malformed chain candidate ignored: ${candidates[i]}`)
          continue
        }
        const { tier, model: candidateModel } = parsed

        if (tier !== homeTier) {
          log(`skipping cross-tier candidate ${candidates[i]}: credentials are per-tier`)
          continue
        }

        if (i > 0) log(`${model} → ${candidateModel}`)

        const bodyStr = candidateModel === model ? originalBodyStr : JSON.stringify({ ...body, model: candidateModel })

        let res: Response
        try {
          res = await proxyTo(target, restPath + url.search, req, bodyStr, headersTimeoutMs)
        } catch (err) {
          // The client hung up — retrying down the chain would burn quota on a
          // response nobody will read.
          if (req.signal.aborted) throw err
          log(`${candidateModel} unreachable: ${err}`)
          continue
        }

        if (res.ok) {
          // i > 0 means the caller asked for one model and is getting another.
          // Guarded: this is the success path, and a notifier is the last thing
          // that should be able to sink a response the chain just worked to get.
          if (i > 0) {
            try {
              onSwap(model, candidateModel)
            } catch (err) {
              log(`onSwap threw, response delivered anyway: ${err}`)
            }
          }
          return res
        }

        if (i === 0) {
          // The model the caller actually asked for failed. Whatever the chain
          // cannot route around is a real answer and belongs to them.
          const verdict = await classifyPrimaryFailure(res, candidateModel)
          if (verdict.passThrough) return verdict.response
          // Held, not dropped: if the chain comes up empty this is still the most
          // useful thing the caller can be told. A 429 carries the upstream's
          // retry-after, a ModelError names the model that went away — both beat
          // a synthetic 503 that says only "something, somewhere, failed".
          primaryFailure = verdict.held
          log(verdict.reason)
        } else {
          // A fallback candidate failing only means that candidate is unusable.
          log(`${candidateModel} returned ${res.status}`)
          await res.body?.cancel().catch(() => {})
        }
      }

      // Reached only when no candidate answered at all — every one was skipped or
      // unreachable — so there is no upstream verdict to hand back.
      return primaryFailure ?? new Response("No model in the chain produced a response", { status: 503 })
    },
  })
}

/** The error type upstream names in the body, or "" if this is not its error shape. */
function upstreamErrorType(body: string): string {
  try {
    const type = (JSON.parse(body) as any)?.error?.type
    return typeof type === "string" ? type : ""
  } catch {
    return ""
  }
}

type PrimaryVerdict =
  /** Nothing the chain can do about it: hand this straight to the caller. */
  | { passThrough: true; response: Response }
  /** Worth trying a fallback, but `held` still beats a synthetic 503 if none works. */
  | { passThrough: false; reason: string; held: Response }

/**
 * Decides whether a failure from the originally-requested model is something
 * the chain can route around, or an answer the caller needs to see. Either way
 * the response survives: failure bodies are small error payloads, so buffering
 * one costs nothing next to throwing the upstream's own verdict away.
 */
async function classifyPrimaryFailure(res: Response, model: string): Promise<PrimaryVerdict> {
  if (RETRY_STATUSES.has(res.status)) {
    return { passThrough: false, reason: `${model} returned ${res.status}`, held: await buffer(res) }
  }

  // These statuses are overloaded upstream — the same 401 means "your API key is
  // wrong" and "that model is not supported" — so the body is what decides.
  if (MODEL_UNAVAILABLE_STATUSES.has(res.status)) {
    const body = await res.text().catch(() => "")
    // The body was consumed to inspect it, so hand back an equivalent response.
    const held = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    const type = upstreamErrorType(body)
    if (MODEL_UNAVAILABLE_TYPES.has(type)) {
      return { passThrough: false, reason: `${model} is unavailable upstream (${type})`, held }
    }
    return { passThrough: true, response: held }
  }

  return { passThrough: true, response: res }
}

/** Re-reads a response into memory so it can outlive the chain that produced it. */
async function buffer(res: Response): Promise<Response> {
  const body = await res.text().catch(() => "")
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

async function proxyTo(
  targetUrl: string,
  pathQuery: string,
  req: Request,
  body: string | null,
  headersTimeoutMs: number,
): Promise<Response> {
  const upstreamUrl = `${targetUrl}${pathQuery}`
  const headers = new Headers(req.headers)
  headers.delete("host")
  headers.delete("content-length")
  headers.delete("accept-encoding")
  headers.delete("connection")

  const timeoutController = new AbortController()
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`upstream sent no response headers in ${headersTimeoutMs}ms`)),
    headersTimeoutMs,
  )

  let res: Response
  try {
    res = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body ?? req.body,
      // req.signal stays live for the body stream so a client abort still tears
      // the upstream down; the timeout is cleared as soon as headers land.
      signal: AbortSignal.any([req.signal, timeoutController.signal]),
    })
  } finally {
    clearTimeout(timer)
  }

  const outHeaders = new Headers(res.headers)
  outHeaders.delete("content-encoding")
  outHeaders.delete("content-length")
  outHeaders.delete("transfer-encoding")
  outHeaders.delete("connection")

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders })
}
