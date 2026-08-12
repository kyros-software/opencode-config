---
name: tandem
description: How to drive the Chrome shared with the human through the tandem_* tools — navigate, read pages, fill forms, inspect console and network, and hand off the walls only a human can clear (captcha, 2FA, anti-bot checkpoints). Use whenever a task involves a real browser, verifying a UI change, or debugging what a page actually does at runtime.
metadata:
  origin: local
---

# tandem — shared browser

You and the human share one Chrome. They see it and drive it with the mouse;
you drive it with the `tandem_*` tools over CDP. Same state, same cookies, same
session. Tandem owns **its own agent tab** — `tandem_reset` closes only that one,
the human's other tabs are untouched. So you are not fighting for their focus.

`tandem_nav` **starts Chrome if it is not running**. There is no separate start
command to ask for. If something looks wrong, `tandem_status` reports whether
Chrome is reachable, which tab is owned, and what is buffered.

## The 14 tools

**Navigate and see**
- `tandem_nav(url, limit?)` — go somewhere, settle, return the interactive tree.
  Bare host/path gets `http://` prefixed.
- `tandem_snap(limit?, visible?, role?, tag?)` — re-walk the page, refresh refs.
  Needed after any change you did not make through tandem, or when a ref stops
  resolving.
- `tandem_refs()` — list current refs with tag, role, label. **No page
  round-trip.** Reach for this before re-snapping.

**Act** (refs are `s1`, `s2`, … — there is no selector form for these)
- `tandem_click(ref, snap?)` — real input events, settles, refreshes refs.
  `snap` defaults to **false**: it does not dump the tree back at you.
- `tandem_type(ref, text, submit?)` — focus, clear, type through the input
  pipeline. `submit: true` presses Enter after.
- `tandem_press(key, ref?)` — `"Enter"`, `"Escape"`, `"Control+a"`. Optionally
  focus a ref first.
- `tandem_wait(text? | selector?, gone?, timeout?)` — poll until it appears,
  then refresh refs. `gone: true` waits for disappearance. Needs one of `text`
  or `selector`. Default timeout 10s.

**Read deeper**
- `tandem_eval(js, limit?)` — JS in the page, JSON back, awaits promises.
- `tandem_html(selector?, limit?)` — inner HTML of the first match (default
  `body`). For structure the snapshot flattens away.
- `tandem_cons(keep?, limit?)` — console messages and page exceptions captured
  **live** since the tab was attached. No reload needed. Clears on read unless
  `keep`.
- `tandem_net(failuresOnly?, includeStatic?, keep?, limit?)` — network captured
  live. Static assets hidden unless asked.
- `tandem_screenshot(path?, full?)` — PNG to disk, returns the path.

**Housekeeping**
- `tandem_status()`, `tandem_reset()`.

## Frugality is built in — use it

Every returning tool takes `limit` (default **5000 chars**). You will not
accidentally dump a 135 KB snapshot into context. But defaults are not strategy:

- **`tandem_refs` before `tandem_snap`.** Refs is cheap and has no round-trip.
  Re-snap only when the page actually changed under you.
- **Filter the snapshot.** `tandem_snap(visible: true)` drops everything without
  a ref. `role: "button"` or `tag: "input"` narrows it to what you are about to
  act on. A filtered snap beats a truncated one.
- **For repeated data — lists, tables, cards — use `tandem_eval`** with a
  targeted `querySelectorAll` returning a compact array. The tree is for finding
  things to click; `eval` is for extracting data.
- **`tandem_click` already refreshes refs internally.** Do not chain a
  `tandem_snap` after every click out of habit.

## Refs survive more than you would think

Refs are recovered by descriptor — tag, role, accessible name, plus an ordinal
to disambiguate identically-named siblings. A ref that shifted position after a
re-render usually still resolves. So a failing ref means the element is
genuinely gone or renamed, not merely moved. Re-snap then, not before.

## Division of labour

- **The human does** what requires being human: captchas, anti-bot checkpoints,
  2FA, visual judgement calls.
- **You do** the analysis: navigate, extract, fill, click, read console and
  network.
- Pattern: the human clears the wall → you read the already-rendered page.

When you hit a wall, say exactly which and where. Do not burn attempts on a
checkpoint that is designed to stop you.

## Security

- Dedicated profile, not the human's personal Chrome. Even so, any login they do
  there leaves cookies and tokens reachable over CDP.
- Do not navigate to banking or personal email in the shared tab unless asked.
- `tandem_eval` runs arbitrary JS: analysis, not destructive actions, never
  exfiltration of session data to third parties.
- Authorized scope only. A shared browser is not a licence to wander.

## Patterns

**Verifying a UI change you just made** — the highest-value use here.
`tandem_nav` to the route → `tandem_cons` for exceptions → assert the rendered
state with `tandem_eval` → `tandem_screenshot` only if the human needs to see it.
A screenshot is proof for a human, not evidence for you: `eval` returns facts,
a PNG returns pixels you then have to guess at.

**Debugging a failing request.** `tandem_net(failuresOnly: true)` is usually the
whole answer. Buffers capture live from attach, so you do not need to reload and
lose the state that broke.

**Forms.** `tandem_snap(tag: "input")` → `tandem_type` per ref → `tandem_click`
submit, or `tandem_type(submit: true)` on the last field → verify the resulting
state, do not assume it worked.

**Infinite scroll / lazy load.** The first read is incomplete by design. One
async `tandem_eval` that scrolls until the count stabilises (N iterations
unchanged, with a hard cap) and collects in the same pass — one call does the
whole load.

**Pagination.** Detect the page count first so you are not walking blind. Then
async `tandem_eval` with same-origin `fetch` + `DOMParser` so the human's window
does not reload on every jump. **Always an explicit cap**, and say what the cap
was — silently walking 3 of 50 pages and reporting "the books" is a lie.

**Cookie banners and consent modals.** Usually a cross-origin third-party
iframe, so `tandem_eval` on the top document cannot reach inside. Try
`tandem_snap` and click the button by ref; if it does not surface, ask the human
to close it with the mouse. Accepting or rejecting cookies is their decision —
do not click "Accept all" on your own.

**Signal vs noise.** A broad extraction catches junk: duplicates, internal
links, auxiliary files. Filter and dedupe before reporting, and state the real
count after filtering. "96 links" is not "96 items".

## Not available here

Coming from the Claude Code tandem MCP, these have no equivalent — do not plan
around them: tab management (`browser_tabs`), acting by CSS selector instead of
ref (`tandem_click` takes refs only), `browser_run_code_unsafe`, file upload,
drag and drop, dialog handling. `tandem_wait` does accept a `selector`, and
`tandem_html` takes one — but for *reading*, not for acting.
