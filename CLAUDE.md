# CLAUDE.md — Claude Usage widget for the Corsair Xeneon Edge

This file orients any Claude Code instance working in `D:\WheelsHub\iCUe`.
Read it fully before changing anything. It describes **exactly** how the system
works, why each decision was made, and how to operate/extend it.

---

## 1. What this project is

A custom **iCUE dashboard widget** for the **Corsair Xeneon Edge** (a 14.5",
**2560×720, 32:9** LCD touchscreen) that displays the user's live **Claude usage**:
the **5-hour session** and **weekly** limits as ring gauges with reset
countdowns, plus tokens, cost, burn rate, and block projection — styled to feel
like Claude Code.

The user runs it in **one vertical third** of the dashboard, so the widget is
laid out for a **tall ≈853×720 tile** (one-third of 2560 wide × full height).

---

## 2. The core constraint (read this first)

An iCUE widget is **sandboxed HTML/JS** rendered in iCUE's Chromium engine
(QtWebEngine). From inside that sandbox a widget **cannot**:

- read local files (so it can't read Claude logs or the OAuth token),
- run CLIs like `ccusage`,
- set the `User-Agent` header (a *forbidden header* in browsers), which the
  Anthropic usage endpoint **requires**,
- call `api.anthropic.com` directly (CORS-blocked, and the UA problem above).

**Therefore the data must be gathered by a process *outside* the browser.** That
is the entire reason the local **collector** exists. There is no pure-inline /
serverless-without-a-host version (a remote Cloudflare Worker proxy is the only
true "no local process" route, and it was declined because it means storing a
Claude credential off-machine). See `README.md` for that discussion.

---

## 3. Architecture

```
┌────────────────────────┐   reads          ┌──────────────────────────┐
│  Data source           │ ───────────────▶ │  Collector (Node)        │
│  • ccusage (local logs)│                  │  collector/server.js     │
│  • /api/oauth/usage    │                  │  - polls every 180s      │
└────────────────────────┘                  │  - normalizes to JSON    │
                                            │  - serves on 127.0.0.1   │
                                            └────────────┬─────────────┘
                                                         │ HTTP :8787
                                  ┌──────────────────────┴───────────────────────┐
                                  │ GET /usage.json   (data, CORS *)              │
                                  │ GET /              (serves widget/index.html) │
                                  │ GET /health                                  │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                                            ┌────────────▼─────────────┐
                                            │  Widget (HTML/CSS/JS)    │
                                            │  on the Xeneon Edge,     │
                                            │  in an iCUE iFrame       │
                                            │  fetches /usage.json,    │
                                            │  draws rings + tiles     │
                                            └──────────────────────────┘
```

The collector **also serves the widget files itself**, so the iFrame just points
at `http://127.0.0.1:8787/` — no packaging required. (A packaged `.icuewidget`
is optional and still fetches the same `usage.json`.)

---

## 4. File map

```
D:\WheelsHub\iCUe\
├─ CLAUDE.md                 ← this file
├─ README.md                 ← user-facing docs (Markdown)
├─ README.html               ← user-facing docs (styled standalone page)
├─ collector\                ← the Node data collector + HTTP server
│  ├─ config.json            ← ALL configuration (provider, port, plan, etc.)
│  ├─ package.json           ← scripts: `start` (server), `once` (one-shot dump)
│  ├─ server.js              ← refresh loop + HTTP server (data + static widget)
│  ├─ usage.json             ← last snapshot, rewritten each refresh (debug/cache)
│  ├─ lib\credentials.js     ← resolves the OAuth token for the oauth provider
│  └─ providers\
│     ├─ ccusage.js          ← provider "ccusage" (local, estimated)
│     └─ oauth.js            ← provider "oauth" (official /api/oauth/usage)
├─ widget\                   ← the on-device widget (HTML/CSS/JS)
│  ├─ manifest.json          ← iCUE widget manifest (dashboard_lcd)
│  ├─ index.html             ← markup skeleton
│  ├─ style.css              ← layout for the 1/3 tile + Claude Code theme
│  ├─ app.js                 ← fetch + render + live clock/countdowns
│  └─ resources\icon.svg     ← coral asterisk "spark" mark
└─ scripts\
   ├─ start-collector.ps1    ← run collector in foreground
   ├─ install-startup.ps1    ← auto-start at login (Startup folder, no admin)
   └─ pack.ps1               ← build Claude-Usage.icuewidget
```

---

## 5. The collector (`collector/`)

### 5.1 `server.js`
- Loads `config.json` once at startup (config changes need a **restart**).
- Picks the provider: `config.provider === 'oauth' ? oauth : ccusage`.
- `refresh()` calls `provider.collect(config)`, wraps the result into a
  `snapshot` object, logs a line, and writes `collector/usage.json`.
- Runs `refresh()` immediately, then every `max(30, refreshSeconds)` seconds.
- HTTP server bound to `127.0.0.1:<port>` (default 8787):
  - `GET /usage.json` → current `snapshot` (JSON). Sends `Access-Control-Allow-Origin: *` so a packaged `file://` widget can fetch cross-origin.
  - `GET /health` → `{ok, provider, generatedAt}`.
  - anything else → static file from `../widget` (so `/` serves `index.html`).
- On provider error it keeps the last good `fiveHour`/`weekly` and sets `error`.

### 5.2 Providers — both return the SAME normalized shape
`collect(config)` returns (and `server.js` spreads it into the snapshot):

```jsonc
{
  "source": "official" | "estimated",
  "fiveHour":   { "utilization": <0-100|null>, "resetsAt": <ISO|null>,
                  "usedTokens": <n?>, "limitTokens": <n?>, "label": "...",
                  "estimated": <bool> } | null,
  "weekly":     { ...same shape... } | null,
  "weeklyOpus":   { ... } | null,    // oauth only; per-model weekly
  "weeklySonnet": { ... } | null,    // oauth only
  "tokens":   { "input", "output", "cacheCreate", "cacheRead", "total" },
  "cost":     { "session", "today", "week", "total" },        // USD, may be null
  "burnRate": { "tokensPerMin", "costPerHour" },
  "block":    { "startsAt", "endsAt", "projectedTotalTokens", "projectedCost" },
  "extraUsage": { "monthlyLimit", "usedCredits", "utilization" } | null, // oauth
  "warnings": [ "..." ]
}
```
The final snapshot served at `/usage.json` adds: `ok`, `provider`, `plan`
(from `config.plan.name`), `generatedAt`, `error`.

### 5.3 `providers/ccusage.js` — "estimated", fully local
- Spawns the user's `ccusage` via `execFile(runner, [...runnerArgs, ...])`
  (`config.ccusage.runner` default `npx`, args `["-y","ccusage@latest"]`).
  Uses `shell:true` on Windows so `npx.cmd` resolves (this triggers a harmless
  `DEP0190` deprecation warning on stderr — ignore it).
- `ccusage blocks --json` → active 5-hour block → `fiveHour`, `block`, `burnRate`, `cost.session`.
  - 5h **utilization is an estimate**: `usedTokens / limit`, where `limit` =
    `config.plan.blockTokenLimit` if set, else the **largest previous block**
    (`prevMax`). This is why ccusage % differs from the official number.
- `ccusage daily --json` → totals + sum of the **last 7 daily entries** →
  `weekly` (tokens; `%` only if `config.plan.weeklyTokenBudget` is set, else
  `utilization: null`, `resetsAt: null`), `tokens`, `cost.week`, `cost.total`.
- Field access is defensive (`pick(...)`) because ccusage key names drift
  between versions.

### 5.4 `providers/oauth.js` — "official", exact numbers
- Gets a token via `lib/credentials.resolveToken(config)`.
- `GET https://api.anthropic.com/api/oauth/usage` with headers:
  ```
  Authorization: Bearer <token>
  anthropic-beta: oauth-2025-04-20
  User-Agent: claude-code/<config.oauth.userAgentVersion>
  Content-Type: application/json
  ```
  The **User-Agent is mandatory** — without `claude-code/...` you hit an
  aggressive rate-limit bucket (persistent 429s). Poll **≥180s**.
- Response → normalized:
  ```jsonc
  {
    "five_hour":       { "utilization": <0-100>, "resets_at": <ISO UTC> },
    "seven_day":       { "utilization", "resets_at" },
    "seven_day_opus":  <obj|null>,
    "seven_day_sonnet":{ "utilization", "resets_at" },
    "extra_usage":     { "is_enabled", "monthly_limit", "used_credits", "utilization" }
  }
  ```
  → `fiveHour`, `weekly`, `weeklyOpus`, `weeklySonnet`, `extraUsage`.
  `utilization` is already 0–100 (used directly, no ×100).
- Error handling: **401** = token expired (run any Claude Code command to
  refresh it; the collector re-reads the token next cycle). **429** = raise
  `refreshSeconds`.
- If `config.oauth.supplementWithCcusage !== false`, it also runs
  `ccusage.collect()` to fill `tokens`/`cost`/`burnRate`/`block` (the official
  endpoint only returns percentages + reset times).

### 5.5 `lib/credentials.js`
`resolveToken(config)` resolution order:
1. `config.oauth.manualToken`
2. `process.env[config.oauth.tokenEnvVar]` (default `CLAUDE_CODE_OAUTH_TOKEN`)
3. `config.oauth.credentialsPath` or `~/.claude/.credentials.json` →
   `claudeAiOauth.accessToken` (tries several key spellings).

> NOTE: `~/.claude/.credentials.json` is protected by a local damage-control
> hook, so **Claude Code itself cannot read it** during development — but the
> collector (the user's own `node` process) reads it fine at runtime. Do not try
> to read or print this file from a tool call.

---

## 6. The widget (`widget/`)

`app.js` fetches the data and renders; it never talks to Anthropic directly.

- **Endpoint**: `window.CLAUDE_USAGE_ENDPOINT` || (`./usage.json` when served
  over http by the collector, else `http://127.0.0.1:8787/usage.json` when
  packaged/`file://`). Re-fetches every **30s**; ticks the clock + countdowns +
  pace bars every **1s**.
- **Layout** (`style.css`), tuned for the tall ≈853×720 third tile:
  - Header is a 3-zone CSS grid: brand (left) · **big centered date** · clock (right).
  - `.body` is a flex row: **gauges left (`flex: 2`)**, **stats panel right (`flex: 1`)** ⇒ 2/3 vs 1/3.
  - `.gauges` = two stacked cards (5-hour above weekly); each card = ring + info
    (label, used/limit, "resets in … @ HH:MM", and a **pace bar** showing % of
    the window elapsed — computed from `resetsAt` and a fixed window length:
    `WIN_5H = 5h`, `WIN_WK = 7d`).
  - `.panel` = **2 columns × 4 rows** of stat tiles (Tokens, Cache read, Cost·7d,
    Cost·all, Burn rate, Block proj, Block ends, Wk·Sonnet).
  - `.statusline` = Claude-Code-style footer: `⏵ usage · src oauth · 5h x% · wk y% · ↻ 30s`.
  - Everything is sized with `clamp()` + `vh/vw` so it scales to any tile size.
- **Theme**: near-black warm background, Claude **coral** `#d97757`, monospace
  font, the asterisk **spark** mark (`resources/icon.svg`, also used as a CSS mask).
- Rendering uses `innerHTML` with values the collector produces (numbers/known
  labels). Free-text fields (`warnings`, pills) use `textContent`. Keep it that
  way — don't inject external strings into `innerHTML`.

`manifest.json`: `id: com.wheelshub.claude-usage`, `supported_devices:
[{type:"dashboard_lcd"}]`, `os:[{platform:"windows"}]`.

---

## 7. Configuration (`collector/config.json`)

| Key | Meaning |
|---|---|
| `provider` | `"oauth"` (exact) or `"ccusage"` (local estimate). **Current: `oauth`.** |
| `port` | HTTP port. Default **8787**. Change ⇒ update the iCUE iFrame URL (and re-pack if packaged). |
| `refreshSeconds` | Upstream poll cadence. Keep **≥180** for `oauth`. |
| `plan.name` | Shown as a pill (e.g. "Max 20x"). |
| `plan.blockTokenLimit` | Fixed denominator for the ccusage 5h ring; else largest previous block. |
| `plan.weeklyTokenBudget` | Set a number to give the ccusage weekly ring a %. |
| `oauth.userAgentVersion` | The `claude-code/<version>` string sent upstream. |
| `oauth.manualToken` / `tokenEnvVar` / `credentialsPath` | Token sources (see §5.5). |
| `oauth.supplementWithCcusage` | When true (default), fill tokens/cost via ccusage. |

After editing config, **restart the collector** (§9).

---

## 8. Displaying it in iCUE

iCUE (v5.44+) → select Xeneon Edge → dashboard page → **"+"** → **iFrame** widget.
That field wants **embed code**, not a bare URL. Paste:

```html
<iframe src="http://127.0.0.1:8787/" style="width:100%;height:100%;border:0;display:block;" scrolling="no"></iframe>
```

Must be `http://` (not https), collector must be running, port must match config.
The redesign lives in the served files, so editing `widget/*` updates the tile on
its next refresh — no iCUE changes needed.

---

## 9. Operating it

**Run (foreground):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-collector.ps1
```

**Auto-start at login (current setup):** `scripts\install-startup.ps1` writes a
hidden VBS launcher to the user's **Startup folder**
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ClaudeUsageCollector.vbs`)
that runs `node server.js` with **no window, no admin**. It starts at **login**
(so the tile populates a few seconds after sign-in).
- Install / re-install: `powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1`
- Remove (and stop running instance): `... install-startup.ps1 -Remove`
- > A Windows **Scheduled Task** was the original approach but
  > `Register-ScheduledTask` needs admin and failed with Access Denied in this
  > environment — hence the Startup-folder method. Don't revert without elevation.

**Restart after a config/code change:**
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  ? { $_.CommandLine -like '*server.js*' } | % { Stop-Process $_.ProcessId -Force }
Start-Process 'wscript.exe' -ArgumentList "`"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ClaudeUsageCollector.vbs`""
```

**One-shot data dump (debug, no server):** `cd collector; npm run once`
**Health:** `http://127.0.0.1:8787/health`

**Package a `.icuewidget`:** `powershell -ExecutionPolicy Bypass -File scripts\pack.ps1`
(uses Corsair's `icuewidget` CLI if installed, else zips the folder).

---

## 10. Verifying changes (how this was developed)

The dev loop used the connected Chrome (claude-in-chrome MCP):
1. Start collector. 2. New tab → navigate to `http://127.0.0.1:8787/health`
(establishes origin). 3. `javascript_tool` `document.write` a wrapper page with
an **`<iframe>` fixed at 853×720** (the real tile size — the screenshot viewport
is otherwise locked ~1568px wide and would show the widget stretched landscape).
4. `computer` `zoom` region `[0,0,857,724]` to capture the true tile. Always
verify at 853×720, not the default viewport.

---

## 11. Current state (as of last session, 2026-06-21)

- `provider: "oauth"`, `port: 8787`, `refreshSeconds: 180`, `plan.name: "Max 20x"`.
- Auto-start **installed** (Startup folder) and the collector **is running**.
- Widget is the **2/3 gauges + 1/3 stat-tile (2×4)** layout, header date centered.
- README.md / README.html are user docs; this file is the technical source of truth.
