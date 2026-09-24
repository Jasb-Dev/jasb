# Jasb — Just a Browser

**Type what you want, get the right sites. No chat, no agents, no ads.**

Every AI browser shipping today answers *for* you. This one doesn't. You type
what you're after in plain language, and you get a small grid of websites —
each labelled with what it actually is — and then you go read them. The model
is a router, not an author.

```
  cheap flights berlin to lisbon
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │ 1            │ │ 2            │ │ 3            │
  │              │ │              │ │              │
  ├──────────────┤ ├──────────────┤ ├──────────────┤
  │ PRICE LISTING│ │ FORUM DISCUS.│ │ OFFICIAL SITE│
  │ Berlin→Lisbon│ │ Cheapest way │ │ TAP Air …    │
  │ ▍▍▍░░░░░ 9   │ │ ▍░░░░░░░ 2   │ │ ▍▍░░░░░░ 4   │
  └──────────────┘ └──────────────┘ └──────────────┘
```

Those ticks under each card are the number of third-party hosts that page
contacts. Measured, not guessed.

---

## What it refuses to do

This list is the product, not a roadmap gap:

| No | Why |
| --- | --- |
| Chat panel or generated answer | The web already wrote the answer. We take you to it. |
| Agent that clicks for you | Page content never becomes a model instruction, so there is no prompt-injection surface. |
| Ads or sponsored cards | One sponsored card and the ranking claim is worthless. |
| Account requirement | The free tier works with an anonymous device token. |
| Telemetry | Not even crash reports. |

---

## Run it

```bash
pnpm install
cp .env.example .env     # optional — it runs with no keys at all
pnpm dev                 # server on :8787, web app on :5173
```

With no keys configured it still works: Wikipedia and Marginalia are free and
need no account, and the engine falls back to keyword intent detection and
structural reason labels. Add a `JASB_BRAVE_API_KEY` for a real general index.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Server + web client, both watching |
| `pnpm test` | 98 tests across the engine and the server |
| `pnpm typecheck` | Every package |
| `pnpm --filter @jasb/extension build` | Chrome extension → `apps/extension/dist` |
| `pnpm --filter @jasb/site build` | jasb.dev landing page → `apps/site/dist` |
| `pnpm --filter @jasb/desktop dist:mac` | Desktop app → `apps/desktop/release` (`.dmg`, `.zip`) |
| `deploy/deploy.sh root@<ip>` | Ship to production — see [LAUNCH.md](LAUNCH.md) |
| `pnpm --filter @jasb/desktop dev` | Electron app (rebuilds the native SQLite binding first) |

To load the extension: `chrome://extensions` → Developer mode → **Load unpacked**
→ `apps/extension/dist`. Then type `j` + space in the address bar from anywhere.

---

## How it works

```
input
 ├─ 1. classify            URL / bare domain / bang   →  go, 0 ms, $0
 ├─ 2. navigation index    "figma sign in"            →  go, ~10 µs, $0
 ├─ 3. cache               exact hash, then semantic  →  cards, $0
 ├─ 4. decide              intent + lens, one call
 ├─ 5. fan out             Brave ∥ Wikipedia ∥ Marginalia ∥ SearxNG
 ├─ 6. measure             trackers · speed · paywall · your block/pin rules
 ├─ 7. judge               relevance + spam + label, per candidate, in parallel
 └─ 8. cut                 6 cards — or fewer, when confidence is low
```

The ordering *is* the economics. A URL costs nothing. A navigation hit costs
nothing. A cache hit costs nothing. Only genuinely new natural-language intent
reaches a paid API, at roughly **$0.005 per uncached query** — and about 95% of
that is the search API, not the model.

### One engine, four shells

`@jasb/intent-engine` is pure TypeScript with zero runtime dependencies and no
I/O of its own. Network, storage, preferences, embeddings and the clock are all
injected by the host. That is what lets the server, the web app, the Chrome
extension and the Electron shell run byte-identical ranking logic — and what
makes the whole pipeline testable without a single network call.

```
packages/intent-engine   the brain — ranking, caching, classification
packages/ui              tokens + React components shared by every client
apps/server              Hono proxy: quota, shared cache, zero logs
apps/web                 the web client, plus the blind-test bench at /bench
apps/extension           MV3: new tab, omnibox keyword, your bookmarks as a source
apps/desktop             Electron: real tabs, SQLite, OS keychain, live measurement
```

### The decision layer

Almost nothing in this pipeline is text generation — it's selection and
scoring. So there's one `Decider` interface with three primitives (`choose`,
`score`, `yesNo`) and three implementations:

| | Where it runs | Notes |
| --- | --- | --- |
| `JevDecider` | TypeSafe AI's API | Typed decisions with calibrated confidence, 70–500 ms |
| `LayaDecider` | In-process, ONNX | Open weights, fully offline; ~1.7 GB opt-in download |
| `LlmDecider` | Any provider | Anthropic · OpenAI · Gemini · OpenRouter · Ollama, JSON-schema constrained |

`AutoDecider` chains them with a cooldown, so a provider outage degrades the
product instead of breaking it. If *every* decider is down, the engine still
returns cards using keyword intent detection and structural labels.

**Calibrated confidence earns its keep at step 8.** When the deciders are
collectively unsure, the grid shows three cards and says so, rather than padding
to six. An ordinary LLM is confidently wrong at the same rate it's confidently
right, which is exactly why that check needs a model that reports uncertainty.

### Why the "why this site" line is never generated

Card reasons come from a fixed set of 32 labels — `Official docs`,
`Forum discussion`, `Ad-free recipe`, `Small-web find`. The model picks one; it
never writes one. That keeps reasons short, consistent, translatable, and
impossible to hallucinate. It also means the "no generated text" promise is
enforced by the type system rather than by a prompt.

### Choosing a rerank model

The default is `claude-opus-5`. For the reranking workload specifically —
bounded judgements over short snippets — `claude-haiku-4-5` costs 1/5 as much
per token and is usually indistinguishable in card quality. Set
`JASB_LLM_MODEL=claude-haiku-4-5` to switch, and measure the difference on your
own golden set before committing either way.

Better still, use a System One model (`JASB_JEV_API_KEY`): the same decisions
cost roughly $0.0003 per query instead of $0.001–0.003, and land in 100 ms
instead of a second.

### Why Serper is not the default

Serper returns real Google results for a third of Brave's price. It's supported
and it is not the default: Google sued SerpApi in December 2025 over scraped
results, and that shadow falls across every provider in the class. Brave has an
independent index, so it goes in front. Serper is opt-in and never runs as the
only general source.

---

## Privacy, concretely

These are implementation facts, not intentions — each one has a test or a code
comment pinning it down.

- **The server keeps no logs of query content or IP addresses.** `privacyLogger`
  redacts query-shaped fields before anything reaches stdout.
- **Your ranking rules never leave your device.** The shared cache stores the
  *unpersonalised* card list; block and pin are re-applied on read, per device.
  There's a test for exactly this.
- **A query only reaches the shared cache once `k` distinct devices have asked
  for it** (default 3). A search only one person ever makes is never retained.
- **Quota is anonymous.** A random device token you generate, hashed before
  storage. No account, no IP, no correlation.
- **Desktop keys go in the OS keychain** via `safeStorage`, write-only from the
  renderer's point of view. Extension storage is *not* encrypted, and the
  settings screen says so rather than pretending otherwise.
- **One button erases everything**, including the device token — clearing that
  while keeping a stable identifier would not be clearing everything.

---

## The quality signal

Kagi crawls the web to learn which pages are slow and ad-heavy. A browser gets
that for free: the moment you open a page we count third-party requests, time
the load, detect a paywall, and notice if you bounced within three seconds.

That evidence lands in your local SQLite and feeds *your* ranking first. Domain
counts are smoothed with an exponential moving average, so a site that cleaned
up its act stops being punished for it. Nothing is uploaded. Aggregating it
across users would require opt-in and a k-anonymity threshold, and isn't built.

Until you've visited anything, a small curated tracker table covers the cold
start. Unknown domains return *no* signal rather than an invented average —
absence is neutral in the scorer, which is honest; a made-up average would
quietly rank every unknown domain identically.

---

## Does it actually beat Google?

That's the question the project is gated on, and `/bench` is how you answer it:
100 real queries, our six cards against a competitor's first six, sides shuffled
and unlabelled until every query is graded.

The thresholds from the plan: **≥60% equal-or-better against Google**, **≥45%
against Kagi**, p50 under 1.5 s uncached. Run it before you trust any of this.

---

## Status

Working end to end: the engine (61 tests), the server (37 tests, including Paddle billing), the web client,
the Chrome extension, and the Electron shell with real tabs and live
measurement.

Not built yet, and deliberately named rather than hidden: Privacy Pass tokens
and an OHTTP relay (the roadmap's Phase 5), the generated ~1M-entry navigation
index, opt-in aggregate quality signals, desktop code signing and auto-update, and iOS.

MIT licensed.
