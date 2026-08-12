/**
 * tandem — native OpenCode browser control over CDP.
 *
 * Shares one Chrome with the human (own profile, own tab) and drives it through
 * the DevTools protocol directly: no Playwright, no MCP hop, no per-call process
 * spawn. Every tool call is a few WebSocket frames on an already-open socket.
 *
 * Refs (s1, s2, …) come from a DOM walk that stamps `data-tnd-ref` on each
 * interactive element, so a later click resolves by attribute lookup instead of
 * re-deriving a locator from role/text — deterministic, and immune to two
 * elements sharing an accessible name.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

const z = tool.schema

// ── config ────────────────────────────────────────────────────────────────

const CDP_ENDPOINT = process.env.CHROME_CDP ?? "http://127.0.0.1:9222"
const CDP_URL = new URL(CDP_ENDPOINT)
const CDP_HOST = CDP_URL.hostname || "127.0.0.1"
const CDP_PORT = Number(CDP_URL.port || 9222)
const CDP_BASE = `http://${CDP_HOST}:${CDP_PORT}`

const HOME = process.env.HOME ?? "/tmp"
const CHROME_PROFILE = process.env.TANDEM_PROFILE ?? `${HOME}/.claude/tandem/chrome-profile`
const CACHE_DIR = `${HOME}/.cache/tandem-opencode`
const AGENT_TAB_MARKER = "__tandem_agent__"
const HEADLESS = ["1", "true", "yes"].includes((process.env.TANDEM_HEADLESS ?? "").toLowerCase())

const CONSOLE_CAP = 500
const NETWORK_CAP = 1000

// ── CDP connection ────────────────────────────────────────────────────────

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

class CDPConn {
  private ws: WebSocket
  private seq = 0
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, Set<(params: any) => void>>()
  closed = false
  ready: Promise<void>

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout (10s)")), 10_000)
      this.ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve()
      })
      this.ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error(`CDP websocket error on ${url}`))
      })
    })
    this.ws.addEventListener("message", (ev: any) => this.onMessage(String(ev.data)))
    this.ws.addEventListener("close", () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"))
      this.pending.clear()
    })
  }

  private onMessage(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message ?? "CDP error"}${msg.error.data ? ` — ${msg.error.data}` : ""}`))
      else p.resolve(msg.result)
      return
    }
    if (typeof msg.method === "string") {
      const set = this.handlers.get(msg.method)
      if (!set) return
      for (const fn of set) {
        try {
          fn(msg.params ?? {})
        } catch {
          // a listener must never take down the socket pump
        }
      }
    }
  }

  send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"))
    const id = ++this.seq
    const payload: Record<string, any> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (e: any) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`CDP send failed: ${e?.message ?? e}`))
      }
    })
  }

  on(method: string, fn: (params: any) => void) {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(fn)
  }

  close() {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // already gone
    }
  }
}

// ── chrome lifecycle ──────────────────────────────────────────────────────

function chromeBinary(): string {
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = Bun.which(name)
    if (p) return p
  }
  throw new Error("No Chrome/Chromium binary found in PATH")
}

async function cdpVersion(timeoutMs = 2000): Promise<any | null> {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function ensureChrome(): Promise<any> {
  const existing = await cdpVersion()
  if (existing) return existing

  const bin = chromeBinary()
  const args = [
    bin,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ]
  if (HEADLESS) args.splice(1, 0, "--headless=new")

  // setsid detaches fully: a plugin reload or an opencode exit must not take
  // the human's browser down with it.
  const setsid = Bun.which("setsid")
  const cmd = setsid ? [setsid, ...args] : args
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  proc.unref()

  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500)
    const v = await cdpVersion()
    if (v) return v
  }
  throw new Error(`Chrome did not start on ${CDP_HOST}:${CDP_PORT} within 10s`)
}

// ── DOM walker ────────────────────────────────────────────────────────────

// Shared by the walker and the descriptor resolver: both must agree on what an
// element is "called", or a recovered ref would land on a different element.
const NAME_FN = String.raw`function tndName(el) {
  const own = Array.from(el.childNodes)
    .filter(n => n.nodeType === 3)
    .map(n => n.textContent)
    .join(' ').trim().replace(/\s+/g, ' ');
  const v = (el.getAttribute('aria-label') || '').trim()
    || (el.getAttribute('placeholder') || '').trim()
    || (el.getAttribute('title') || '').trim()
    || (el.tagName === 'INPUT' ? String(el.value || '') : '')
    || own
    || (el.textContent || '').trim().replace(/\s+/g, ' ');
  return v.trim().substring(0, 120);
}
function tndRoot() {
  return document.querySelector('main') || document.querySelector('#app') || document.body;
}
function tndVisible(el) {
  return el.offsetParent !== null || el.tagName === 'OPTION';
}`

// String.raw keeps `\n` / `\s` as literal backslash sequences so they reach the
// page as JS escapes rather than being consumed by this file's parser.
const WALKER_JS = String.raw`(() => {
  for (const e of document.querySelectorAll('[data-tnd-ref]')) e.removeAttribute('data-tnd-ref');

  ${NAME_FN}

  function tndPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 12) {
      const parent = cur.parentElement;
      if (!parent) break;
      const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      parts.unshift(cur.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : ''));
      cur = parent;
    }
    return parts.join('>');
  }

  let idCounter = 0;
  const interactive = new Set([
    "a","button","input","select","textarea","summary",
    "iframe","audio","video","details",
  ]);
  const interactiveRoles = new Set([
    "button","tab","link","checkbox","radio","option","textbox","combobox",
    "menuitem","listbox","switch","searchbox","spinbutton","slider","menuitemcheckbox","menuitemradio",
  ]);
  const refs = [];

  const perf = performance.getEntriesByType('navigation')[0];
  const perfOut = perf ? {
    domContentLoaded: Math.round(perf.domContentLoadedEventEnd - perf.fetchStart),
    load: Math.round(perf.loadEventEnd - perf.fetchStart),
    fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0),
    ttfb: Math.round(perf.responseStart - perf.fetchStart),
  } : null;

  function walk(el, depth) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
    if (el.offsetParent === null && el.tagName !== 'OPTION' && tag !== 'body') return '';

    const role = (el.getAttribute('role') || '').trim();
    const ariaLabel = (el.getAttribute('aria-label') || '').trim();
    const ph = (el.getAttribute('placeholder') || '').trim();
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80);

    const isInteractive =
      interactive.has(tag) ||
      interactiveRoles.has(role) ||
      el.hasAttribute('onclick') ||
      el.getAttribute('tabindex') !== null;

    let line = '  '.repeat(depth) + '<' + tag;
    if (role) line += ' role="' + role + '"';
    if (ariaLabel) line += ' aria-label="' + ariaLabel.substring(0, 60) + '"';
    if (ph) line += ' placeholder="' + ph.substring(0, 40) + '"';

    if (isInteractive) {
      idCounter++;
      const refId = 's' + idCounter;
      el.setAttribute('data-tnd-ref', refId);
      line += ' #' + refId;
      refs.push({
        ref: refId,
        tag: tag,
        role: role,
        name: tndName(el),
        path: tndPath(el),
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      });
    }

    const children = Array.from(el.children);
    if (text) {
      line += ' "' + text.substring(0, 70) + (text.length > 70 ? '…' : '') + '"';
    } else if (children.length === 0) {
      return line + ' />';
    }
    line += '>';
    for (const child of children) {
      const r = walk(child, depth + 1);
      if (r) line += '\n' + r;
    }
    return line;
  }

  const tree = walk(tndRoot(), 0);

  // Ordinal among same-descriptor siblings: the tiebreaker that lets a recovered
  // ref pick the right one of N identically-named elements instead of giving up.
  const seen = new Map();
  for (const r of refs) {
    const key = r.tag + '|' + r.role + '|' + r.name;
    const n = seen.get(key) || 0;
    r.ord = n;
    seen.set(key, n + 1);
  }

  return { tree: tree, refs: refs, url: location.href, title: document.title, perf: perfOut };
})()`

/** Re-find an element from its recorded descriptor when the stamp is gone. */
function resolveJs(d: Record<string, any>): string {
  return `(() => {
  ${NAME_FN}
  const d = ${JSON.stringify(d)};
  const matches = [];
  for (const el of tndRoot().querySelectorAll('*')) {
    if (!tndVisible(el)) continue;
    if (el.tagName.toLowerCase() !== d.tag) continue;
    if ((el.getAttribute('role') || '').trim() !== d.role) continue;
    if (tndName(el) !== d.name) continue;
    matches.push(el);
  }
  let el = matches.length ? (matches[d.ord] || matches[0]) : null;
  if (!el && d.path) el = document.querySelector(d.path);
  if (!el) return { found: false, candidates: matches.length };
  el.setAttribute('data-tnd-ref', d.ref);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return {
    found: true, candidates: matches.length,
    x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
    label: d.name,
  };
})()`
}

// ── key map ───────────────────────────────────────────────────────────────

type KeyDef = { key: string; code: string; keyCode: number; text?: string }

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 }

function parseKey(spec: string): { def: KeyDef; modifiers: number } {
  const parts = spec.split("+").filter(Boolean)
  let modifiers = 0
  while (parts.length > 1) {
    const bit = MODIFIER_BITS[parts[0]!.toLowerCase()]
    if (bit === undefined) break
    modifiers |= bit
    parts.shift()
  }
  const last = parts.join("+") || spec
  const named = NAMED_KEYS[last.toLowerCase()]
  if (named) return { def: named, modifiers }
  if (last.length === 1) {
    const upper = last.toUpperCase()
    const isLetter = upper >= "A" && upper <= "Z"
    const isDigit = last >= "0" && last <= "9"
    return {
      def: {
        key: last,
        code: isLetter ? `Key${upper}` : isDigit ? `Digit${last}` : "",
        keyCode: upper.charCodeAt(0),
        // A modified chord (Control+A) must not also insert the character.
        text: modifiers & ~8 ? undefined : last,
      },
      modifiers,
    }
  }
  throw new Error(`Unknown key: ${spec}`)
}

// ── tandem session ────────────────────────────────────────────────────────

type ConsoleEntry = { level: string; text: string; source: string }
type NetEntry = { method: string; url: string; type: string; status: string | number }
type RefDescriptor = {
  tag: string
  role: string
  name: string
  path: string
  ord: number
  disabled: boolean
}

class Tandem {
  private conn: CDPConn | null = null
  private sessionId: string | null = null
  private targetId: string | null = null
  private connecting: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  console: ConsoleEntry[] = []
  network = new Map<string, NetEntry>()
  refs = new Map<string, RefDescriptor>()
  private inflight = 0
  private lastNetworkActivity = 0

  /** Serialise tool bodies: CDP is fine concurrently, our ref table is not. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  async ensure(): Promise<void> {
    if (this.conn && !this.conn.closed && this.sessionId) return
    if (this.connecting) return this.connecting
    this.connecting = this.connect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connect(): Promise<void> {
    const version = await ensureChrome()
    const wsUrl = version.webSocketDebuggerUrl
    if (!wsUrl) throw new Error("Chrome reported no webSocketDebuggerUrl")

    this.conn?.close()
    this.sessionId = null
    this.targetId = null

    const conn = new CDPConn(wsUrl)
    await conn.ready
    this.conn = conn

    const { targetInfos } = await conn.send("Target.getTargets")
    const pages = (targetInfos ?? []).filter((t: any) => t.type === "page" && !String(t.url).startsWith("devtools://"))

    // Recover the agent tab across plugin reloads: the marker lives in the page,
    // not in this process.
    for (const page of pages) {
      let sid: string | null = null
      try {
        const r = await conn.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })
        sid = r.sessionId
        const probe = await conn.send(
          "Runtime.evaluate",
          { expression: "window.name", returnByValue: true },
          sid!,
        )
        if (probe?.result?.value === AGENT_TAB_MARKER) {
          this.sessionId = sid
          this.targetId = page.targetId
          break
        }
      } catch {
        // target vanished or refuses attach — keep scanning
      }
      if (sid) {
        try {
          await conn.send("Target.detachFromTarget", { sessionId: sid })
        } catch {
          // best effort
        }
      }
    }

    if (!this.sessionId) {
      const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" })
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true })
      this.targetId = targetId
      this.sessionId = sessionId
      await conn.send(
        "Runtime.evaluate",
        { expression: `window.name = ${JSON.stringify(AGENT_TAB_MARKER)}`, returnByValue: true },
        sessionId,
      )
    }

    await this.enableDomains()
  }

  private async enableDomains() {
    const conn = this.conn!
    const sid = this.sessionId!
    await conn.send("Page.enable", {}, sid)
    await conn.send("Runtime.enable", {}, sid)
    await conn.send("Log.enable", {}, sid)
    await conn.send("Network.enable", {}, sid)

    // Re-marking on every commit keeps the tab recoverable after a cross-origin
    // navigation wipes window.name.
    conn.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: `try { window.name = ${JSON.stringify(AGENT_TAB_MARKER)} } catch (e) {}` },
      sid,
    ).catch(() => {})

    conn.on("Runtime.consoleAPICalled", (p) => {
      if (p.sessionId && p.sessionId !== sid) return
      const text = (p.args ?? [])
        .map((a: any) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
        .join(" ")
      const frame = p.stackTrace?.callFrames?.[0]
      this.pushConsole({
        level: p.type === "warning" ? "warning" : p.type === "error" ? "error" : "info",
        text,
        source: frame ? `${frame.url}:${frame.lineNumber + 1}` : "",
      })
    })

    conn.on("Runtime.exceptionThrown", (p) => {
      if (p.sessionId && p.sessionId !== sid) return
      const d = p.exceptionDetails ?? {}
      const text = d.exception?.description ?? d.text ?? "Uncaught exception"
      this.pushConsole({ level: "error", text, source: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : "" })
    })

    conn.on("Log.entryAdded", (p) => {
      if (p.sessionId && p.sessionId !== sid) return
      const e = p.entry ?? {}
      this.pushConsole({
        level: e.level === "warning" ? "warning" : e.level === "error" ? "error" : "info",
        text: e.text ?? "",
        source: e.url ? `${e.url}:${e.lineNumber ?? 0}` : (e.source ?? ""),
      })
    })

    conn.on("Network.requestWillBeSent", (p) => {
      if (p.sessionId && p.sessionId !== sid) return
      this.inflight++
      this.lastNetworkActivity = Date.now()
      this.pushNetwork(p.requestId, {
        method: p.request?.method ?? "GET",
        url: p.request?.url ?? "",
        type: (p.type ?? "Other").toLowerCase(),
        status: "PENDING",
      })
    })

    conn.on("Network.responseReceived", (p) => {
      if (p.sessionId && p.sessionId !== sid) return
      const e = this.network.get(p.requestId)
      if (e) {
        e.status = p.response?.status ?? "?"
        e.type = (p.type ?? e.type).toLowerCase()
      }
    })

    conn.on("Network.loadingFinished", (p) => {
      if (p.sessionId && p.sessionId !== sid) return
      this.inflight = Math.max(0, this.inflight - 1)
      this.lastNetworkActivity = Date.now()
    })

    conn.on("Network.loadingFailed", (p) => {
      if (p.sessionId && p.sessionId !== sid) return
      this.inflight = Math.max(0, this.inflight - 1)
      this.lastNetworkActivity = Date.now()
      const e = this.network.get(p.requestId)
      if (e) e.status = p.canceled ? "CANCELED" : `FAIL(${p.errorText ?? "?"})`
    })
  }

  private pushConsole(entry: ConsoleEntry) {
    this.console.push(entry)
    if (this.console.length > CONSOLE_CAP) this.console.splice(0, this.console.length - CONSOLE_CAP)
  }

  private pushNetwork(id: string, entry: NetEntry) {
    this.network.set(id, entry)
    if (this.network.size > NETWORK_CAP) {
      const drop = this.network.size - NETWORK_CAP
      let i = 0
      for (const k of this.network.keys()) {
        if (i++ >= drop) break
        this.network.delete(k)
      }
    }
  }

  /** One CDP round-trip, transparently reconnecting when the session died. */
  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    await this.ensure()
    try {
      return await this.conn!.send(method, params, this.sessionId!)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (!/closed|Session with given id|Target closed|not found/i.test(msg)) throw e
      this.sessionId = null
      await this.ensure()
      return await this.conn!.send(method, params, this.sessionId!)
    }
  }

  async evaluate(expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description ?? d.text ?? "JS evaluation failed")
    }
    return r.result?.value
  }

  /** Wait until the page stops fetching, or give up. Not a hard guarantee. */
  async networkIdle(quietMs = 500, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.inflight <= 0 && Date.now() - this.lastNetworkActivity >= quietMs) return
      await Bun.sleep(100)
    }
  }

  async settle(initialMs = 300): Promise<void> {
    await Bun.sleep(initialMs)
    await this.networkIdle(400, 5000)
    await Bun.sleep(200)
  }

  async snap(): Promise<{ tree: string; refs: any[]; url: string; title: string; perf: any }> {
    const data = await this.evaluate(WALKER_JS)
    if (!data || typeof data !== "object") throw new Error("Walker returned nothing — is a page loaded?")
    this.refs.clear()
    for (const r of data.refs ?? []) {
      this.refs.set(r.ref, {
        tag: r.tag,
        role: r.role,
        name: r.name,
        path: r.path,
        ord: r.ord ?? 0,
        disabled: r.disabled,
      })
    }
    return data
  }

  /**
   * Resolve a ref to viewport coordinates, scrolling it into view first.
   *
   * The stamp is the fast, exact path and survives ordinary re-renders — a
   * framework only drops it by destroying the element. When it is gone (the
   * element really was rebuilt, or another client re-stamped the tab) fall back
   * to the recorded descriptor rather than failing outright.
   */
  async locate(ref: string): Promise<{ x: number; y: number; label: string; recovered: boolean }> {
    const stamped = await this.evaluate(
      `(() => {
        const el = document.querySelector('[data-tnd-ref=${JSON.stringify(ref)}]');
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          w: r.width,
          h: r.height,
          label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 80),
        };
      })()`,
    )
    if (stamped && stamped.w > 0 && stamped.h > 0) return { ...stamped, recovered: false }

    const desc = this.refs.get(ref)
    if (!desc) {
      throw new Error(`Unknown ref: ${ref} — no snapshot holds it. Run tandem_snap.${this.refHint(ref)}`)
    }
    const found = await this.evaluate(resolveJs({ ...desc, ref }))
    if (!found?.found) {
      throw new Error(
        `Ref ${ref} (${desc.tag}${desc.role ? `[${desc.role}]` : ""} "${desc.name}") no longer exists — ` +
          `it was removed from the page. Run tandem_snap.${this.refHint(ref)}`,
      )
    }
    if (found.w === 0 || found.h === 0) throw new Error(`Ref ${ref} has zero size (hidden or collapsed)`)
    return { x: found.x, y: found.y, label: found.label, recovered: true }
  }

  private refHint(ref: string): string {
    const known = [...this.refs.keys()]
    if (!known.length) return ""
    return `\nKnown refs: ${known.slice(0, 20).join(", ")}${known.length > 20 ? ", …" : ""}`
  }

  async click(ref: string): Promise<{ label: string; recovered: boolean }> {
    const { x, y, label, recovered } = await this.locate(ref)
    const base = { x, y, button: "left", clickCount: 1 }
    // Real input events, not el.click(): headless-UI libraries listen on
    // pointerdown and ignore synthetic clicks.
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none", buttons: 0 })
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 })
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 })
    return { label, recovered }
  }

  async pressKey(spec: string): Promise<void> {
    const { def, modifiers } = parseKey(spec)
    const common = {
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
    }
    await this.send("Input.dispatchKeyEvent", {
      ...common,
      type: def.text ? "keyDown" : "rawKeyDown",
      text: def.text,
      unmodifiedText: def.text,
    })
    await this.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" })
  }

  /** Select the focused field's contents via the editing command, not a chord. */
  async selectAll(): Promise<void> {
    const common = { key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }
    await this.send("Input.dispatchKeyEvent", { ...common, type: "rawKeyDown", commands: ["selectAll"] })
    await this.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" })
  }

  /** Drop the socket but leave Chrome and the agent tab alive. */
  disconnect(): void {
    this.conn?.close()
    this.conn = null
    this.sessionId = null
  }

  async reset(): Promise<void> {
    if (this.conn && this.targetId) {
      try {
        await this.conn.send("Target.closeTarget", { targetId: this.targetId })
      } catch {
        // tab already gone
      }
    }
    this.conn?.close()
    this.conn = null
    this.sessionId = null
    this.targetId = null
    this.refs.clear()
    this.console = []
    this.network.clear()
    this.inflight = 0
  }

  status() {
    return {
      connected: !!this.conn && !this.conn.closed,
      targetId: this.targetId,
      sessionId: this.sessionId,
      refs: this.refs.size,
      console: this.console.length,
      network: this.network.size,
    }
  }
}

const tandem = new Tandem()

// ── output helpers ────────────────────────────────────────────────────────

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…\n[truncated ${text.length - limit} chars — raise limit or filter]`
}

function refLines(): string {
  const entries = [...tandem.refs.entries()].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
  if (!entries.length) return "No refs. Run tandem_snap or tandem_nav first."
  return entries
    .map(([id, r]) => `  ${id.padEnd(5)} ${r.tag}${r.role ? `[${r.role}]` : ""}${r.disabled ? " (disabled)" : ""}  ${r.name}`)
    .join("\n")
}

function snapOutput(data: { tree: string; url: string; title: string }, limit: number, filter: {
  visible?: boolean
  role?: string
  tag?: string
}): string {
  let lines = data.tree.split("\n")
  if (filter.visible) lines = lines.filter((l) => l.includes("#s"))
  if (filter.role) lines = lines.filter((l) => l.includes(`role="${filter.role}"`))
  if (filter.tag) lines = lines.filter((l) => l.trimStart().startsWith(`<${filter.tag}`))
  const header = `${data.title || "(untitled)"} — ${data.url}\n${tandem.refs.size} refs\n`
  return header + clamp(lines.join("\n"), limit)
}

const STATIC_TYPES = new Set(["script", "stylesheet", "font", "image", "media", "manifest", "other", "ping"])

// ── tools ─────────────────────────────────────────────────────────────────

function defineTools(): Record<string, ToolDefinition> {
  return {
    tandem_nav: tool({
      description:
        "Navigate the shared browser's agent tab to a URL, wait for the page to settle, and return an accessibility-style snapshot with interactive refs (s1, s2, …). Starts Chrome if it is not running.",
      args: {
        url: z.string().describe("Absolute URL, or a bare host/path which is prefixed with http://"),
        limit: z.number().optional().describe("Max characters of the returned tree (default 5000)"),
      },
      async execute({ url, limit }) {
        return tandem.run(async () => {
          const target = /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`
          const t0 = Date.now()
          await tandem.send("Page.navigate", { url: target })
          await tandem.settle(300)
          const data = await tandem.snap()
          return {
            title: `nav ${data.url} (${Date.now() - t0}ms)`,
            output: snapOutput(data, limit ?? 5000, {}),
            metadata: { url: data.url, refs: tandem.refs.size, perf: data.perf },
          }
        })
      },
    }),

    tandem_snap: tool({
      description:
        "Re-walk the current page and return its interactive tree, refreshing refs. Use after any change you did not make through tandem (or when a ref stops resolving).",
      args: {
        limit: z.number().optional().describe("Max characters of the returned tree (default 5000)"),
        visible: z.boolean().optional().describe("Only lines that carry a ref"),
        role: z.string().optional().describe("Only elements with this ARIA role"),
        tag: z.string().optional().describe("Only elements with this tag name"),
      },
      async execute({ limit, visible, role, tag }) {
        return tandem.run(async () => {
          const data = await tandem.snap()
          return {
            title: `snap ${tandem.refs.size} refs`,
            output: snapOutput(data, limit ?? 5000, { visible, role, tag }),
            metadata: { url: data.url, refs: tandem.refs.size },
          }
        })
      },
    }),

    tandem_refs: tool({
      description: "List the refs from the last snapshot with their tag, role and label. Cheap — no page round-trip.",
      args: {},
      async execute() {
        return { title: `${tandem.refs.size} refs`, output: refLines() }
      },
    }),

    tandem_click: tool({
      description:
        "Click an element by ref (s1, s2, …) using real browser input events, then wait for the page to settle and refresh refs.",
      args: {
        ref: z.string().describe("Ref id from a snapshot, e.g. s4"),
        snap: z.boolean().optional().describe("Return the refreshed tree too (default false)"),
      },
      async execute({ ref, snap }) {
        return tandem.run(async () => {
          const t0 = Date.now()
          const { label, recovered } = await tandem.click(ref)
          await tandem.settle(300)
          const data = await tandem.snap()
          const head =
            `clicked ${ref} "${label}" (${Date.now() - t0}ms) — ${tandem.refs.size} refs` +
            (recovered ? "\n(stamp was gone — re-found by descriptor; the page had rebuilt that element)" : "")
          return {
            title: `click ${ref}`,
            output: snap ? `${head}\n\n${snapOutput(data, 5000, {})}` : head,
            metadata: { url: data.url, refs: tandem.refs.size },
          }
        })
      },
    }),

    tandem_type: tool({
      description:
        "Focus an element by ref, clear it, and type text through the browser input pipeline (fires real input events). Optionally press Enter afterwards.",
      args: {
        ref: z.string().describe("Ref id of the input/textarea/contenteditable"),
        text: z.string().describe("Text to type"),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      },
      async execute({ ref, text, submit }) {
        return tandem.run(async () => {
          const t0 = Date.now()
          await tandem.click(ref)
          await Bun.sleep(80)
          await tandem.selectAll()
          // insertText replaces the selection; an empty value needs an explicit delete.
          if (text) await tandem.send("Input.insertText", { text })
          else await tandem.pressKey("Delete")
          if (submit) {
            await Bun.sleep(120)
            await tandem.pressKey("Enter")
          }
          await tandem.settle(300)
          const data = await tandem.snap()
          return {
            title: `type ${ref}`,
            output: `typed ${JSON.stringify(text)} into ${ref}${submit ? " + Enter" : ""} (${Date.now() - t0}ms) — ${tandem.refs.size} refs`,
            metadata: { url: data.url, refs: tandem.refs.size },
          }
        })
      },
    }),

    tandem_press: tool({
      description:
        'Press a key or chord on the page, e.g. "Enter", "Escape", "ArrowDown", "Control+a". Optionally focus a ref first.',
      args: {
        key: z.string().describe('Key or chord, e.g. "Enter" or "Control+Shift+k"'),
        ref: z.string().optional().describe("Focus this ref before pressing"),
      },
      async execute({ key, ref }) {
        return tandem.run(async () => {
          const t0 = Date.now()
          if (ref) {
            await tandem.click(ref)
            await Bun.sleep(80)
          }
          await tandem.pressKey(key)
          await tandem.settle(200)
          await tandem.snap()
          return {
            title: `press ${key}`,
            output: `pressed ${key}${ref ? ` on ${ref}` : ""} (${Date.now() - t0}ms) — ${tandem.refs.size} refs`,
          }
        })
      },
    }),

    tandem_wait: tool({
      description:
        "Poll until visible text appears (or a CSS selector matches), then refresh refs. Use `gone: true` to wait for it to disappear.",
      args: {
        text: z.string().optional().describe("Visible text to wait for"),
        selector: z.string().optional().describe("CSS selector to wait for instead of text"),
        gone: z.boolean().optional().describe("Wait for absence instead of presence"),
        timeout: z.number().optional().describe("Seconds before giving up (default 10)"),
      },
      async execute({ text, selector, gone, timeout }) {
        return tandem.run(async () => {
          if (!text && !selector) throw new Error("tandem_wait needs either `text` or `selector`")
          const probe = selector
            ? `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && e.offsetParent !== null })()`
            : `(() => {
                 const t = ${JSON.stringify(text)};
                 for (const el of document.querySelectorAll('body *')) {
                   if (el.offsetParent === null) continue;
                   if (el.children.length === 0 && (el.textContent || '').includes(t)) return true;
                 }
                 return (document.body.innerText || '').includes(t);
               })()`
          const want = !gone
          const deadline = Date.now() + (timeout ?? 10) * 1000
          const t0 = Date.now()
          let last = false
          while (Date.now() < deadline) {
            last = !!(await tandem.evaluate(probe))
            if (last === want) {
              await tandem.snap()
              const what = selector ? `selector ${selector}` : `text ${JSON.stringify(text)}`
              return {
                title: `wait ok`,
                output: `${what} ${gone ? "gone" : "visible"} after ${Date.now() - t0}ms — ${tandem.refs.size} refs`,
              }
            }
            await Bun.sleep(150)
          }
          const what = selector ? `selector ${selector}` : `text ${JSON.stringify(text)}`
          throw new Error(`Timed out after ${timeout ?? 10}s waiting for ${what} to be ${gone ? "gone" : "visible"}`)
        })
      },
    }),

    tandem_eval: tool({
      description:
        "Evaluate a JavaScript expression in the page and return the result as JSON. Awaits promises. Use for reads the snapshot cannot express.",
      args: {
        js: z.string().describe("Expression, e.g. document.title or (async () => …)()"),
        limit: z.number().optional().describe("Max characters of the returned JSON (default 5000)"),
      },
      async execute({ js, limit }) {
        return tandem.run(async () => {
          const value = await tandem.evaluate(js)
          const text = value === undefined ? "undefined" : JSON.stringify(value, null, 2)
          return { title: "eval", output: clamp(text ?? "null", limit ?? 5000) }
        })
      },
    }),

    tandem_cons: tool({
      description:
        "Return console messages and page exceptions captured live since the tab was attached (no reload needed). Clears the buffer by default.",
      args: {
        level: z.enum(["error", "warning", "info"]).optional().describe("Minimum level (default error)"),
        keep: z.boolean().optional().describe("Do not clear the buffer after reading"),
        limit: z.number().optional().describe("Max characters returned (default 5000)"),
      },
      async execute({ level, keep, limit }) {
        return tandem.run(async () => {
          await tandem.ensure()
          const min = level ?? "error"
          const rank = { error: 3, warning: 2, info: 1 } as const
          const total = tandem.console.length
          const wanted = tandem.console.filter((e) => rank[e.level as keyof typeof rank] >= rank[min])
          const out = wanted.map((e) => `[${e.level}]${e.source ? ` ${e.source}` : ""} ${e.text}`).join("\n")
          if (!keep) tandem.console = []
          return {
            title: `console ${wanted.length}/${total}`,
            output: out ? clamp(out, limit ?? 5000) : `No ${min}-or-above messages captured.`,
          }
        })
      },
    }),

    tandem_net: tool({
      description:
        "Return network requests captured live since the tab was attached (no reload needed). Static assets are hidden unless asked for.",
      args: {
        failuresOnly: z.boolean().optional().describe("Only non-2xx/3xx entries"),
        includeStatic: z.boolean().optional().describe("Include scripts, styles, fonts, images"),
        keep: z.boolean().optional().describe("Do not clear the buffer after reading"),
        limit: z.number().optional().describe("Max characters returned (default 5000)"),
      },
      async execute({ failuresOnly, includeStatic, keep, limit }) {
        return tandem.run(async () => {
          await tandem.ensure()
          const rows = [...tandem.network.values()].filter((e) => {
            if (!includeStatic && STATIC_TYPES.has(e.type)) return false
            if (failuresOnly && /^[23]/.test(String(e.status))) return false
            return true
          })
          const out = rows.map((e) => `[${e.status}] ${e.method} ${e.url}`).join("\n")
          if (!keep) tandem.network.clear()
          return {
            title: `network ${rows.length}`,
            output: out ? clamp(out, limit ?? 5000) : "No matching requests captured.",
          }
        })
      },
    }),

    tandem_screenshot: tool({
      description: "Capture the agent tab as a PNG on disk and return its path.",
      args: {
        path: z.string().optional().describe("Output path (default ~/.cache/tandem-opencode/shot-<ts>.png)"),
        full: z.boolean().optional().describe("Capture the full scrollable page instead of the viewport"),
      },
      async execute({ path, full }) {
        return tandem.run(async () => {
          const params: Record<string, any> = { format: "png" }
          if (full) {
            const m = await tandem.send("Page.getLayoutMetrics")
            const c = m.cssContentSize ?? m.contentSize
            params.captureBeyondViewport = true
            params.clip = { x: 0, y: 0, width: c.width, height: c.height, scale: 1 }
          }
          const { data } = await tandem.send("Page.captureScreenshot", params)
          const out = path ?? `${CACHE_DIR}/shot-${Date.now()}.png`
          await Bun.write(out, Buffer.from(data, "base64"))
          return { title: "screenshot", output: out }
        })
      },
    }),

    tandem_html: tool({
      description: "Return the inner HTML of the first element matching a CSS selector. For inspecting structure the snapshot flattens away.",
      args: {
        selector: z.string().optional().describe("CSS selector (default body)"),
        limit: z.number().optional().describe("Max characters returned (default 5000)"),
      },
      async execute({ selector, limit }) {
        return tandem.run(async () => {
          const sel = selector ?? "body"
          const html = await tandem.evaluate(
            `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerHTML : null })()`,
          )
          if (html === null) throw new Error(`Selector matched nothing: ${sel}`)
          return { title: `html ${sel}`, output: clamp(html, limit ?? 5000) }
        })
      },
    }),

    tandem_status: tool({
      description: "Report whether Chrome is reachable, which tab tandem owns, and what it currently has buffered.",
      args: {},
      async execute() {
        const version = await cdpVersion()
        if (!version) {
          return {
            title: "chrome down",
            output: `Chrome not reachable on ${CDP_HOST}:${CDP_PORT}. Any tandem tool will start it.`,
          }
        }
        const s = tandem.status()
        let url = "-"
        if (s.connected) {
          try {
            url = await tandem.evaluate("location.href")
          } catch {
            url = "(unreachable)"
          }
        }
        const lines = [
          `chrome:    ${version.Browser}`,
          `cdp:       ${CDP_HOST}:${CDP_PORT}`,
          `attached:  ${s.connected ? "yes" : "no"}`,
          `agent tab: ${url}`,
          `refs:      ${s.refs}`,
          `buffers:   ${s.console} console, ${s.network} network`,
          `headless:  ${HEADLESS}`,
        ]
        return { title: "status", output: lines.join("\n") }
      },
    }),

    tandem_reset: tool({
      description: "Close tandem's agent tab, drop the CDP session and clear refs/buffers. The human's other tabs are untouched.",
      args: {},
      async execute() {
        return tandem.run(async () => {
          await tandem.reset()
          return { title: "reset", output: "Agent tab closed, session dropped, refs and buffers cleared." }
        })
      },
    }),
  }
}

// ── plugin entry ──────────────────────────────────────────────────────────

export default async () => {
  return {
    tool: defineTools(),
    async dispose() {
      // Drop the socket but leave Chrome and the tab alone: a plugin reload
      // must not cost the human their session.
      tandem.disconnect()
    },
  }
}
