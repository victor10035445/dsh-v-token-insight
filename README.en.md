# dsh-v-token-insight · V TOKEN INSIGHT

[简体中文](README.md)  | **English**

A **token usage & cost insight plugin** for the DeepSeek Harness Web client — turning session and workspace token consumption, cache hits, estimated costs, and burn rate into an always-available dashboard.

Pure client-side, zero kernel changes: it replaces or disables no official plugin, and all data comes from the host's existing projections, session windows, and the local per-step ledger.

> **Host version requirement: DSH 0.1.2-rc.1 and above** (v0.4.0 targets the dsh-012 host APIs: the `useChat`/`useTrajectory` split, the `ctx.remote` typert surface, and the `data-shell-overlay` geometry anchor; the bootstrap baseline is now empty. **v0.4.1 targets the dsh 0.2.1-rc.5 trajectory contract** — model identity moves to `providerMetadata`/`requestConfig` with `provenance` removed, while remaining backward compatible with 0.1.x shapes). Do not upgrade on older hosts.

## Features at a Glance

| Entry | Capabilities |
|---|---|
| **Sidebar seat → Token Stats Overview** (full page) | 7 KPI cards (billed tokens / today's DPS / cache hit rate / session count / cost / avg cost per MTok) + dimension tabs: Overview dual-axis charts (usage trend + cost trend, day/month/year granularity, daily/monthly plan target bars, cost card with a per-day amounts table), By Workspace (cost sum column), By Session (details table + search/sort/column resize/right-click jump, fork sessions with a "branch" badge), By Model (per-model cost and avg-price columns), Price Table, Plan |
| **Seat speed gauge** (decorative) | Sidebar expanded = a rainbow bar along the button's bottom edge; 56px rail = a rainbow ring around the round button. Driven by today's burn rate vs the daily plan ratio, zero polling and zero animation; silently hidden when no plan is set |
| **Third session tab "Session Token Stats"** | Per-session KPIs, context pressure meter, per-turn details table (four buckets / hit rate / cost / cumulative cost; click a row to jump back to the turn; expand a row for per-step call details), sharing one fold cache with the tail chips (zero repeated folding on long sessions) |
| **Tail lightweight readout** | Appends `⏱ duration · ≈cost · tokens` inside the official action row; hover for the full pricing basis |
| **Fork dedupe** | A fork session's projection is a seeded copy of its parent's usage (the host seed-copies all events); it is automatically excluded from every total with the exclusion count disclosed; rows remain inspectable with a "branch" badge |
| **Local per-step ledger v2** | Sharded storage + compact encoding (−62% size) + a 5MB total budget with per-session eviction + a 2-day consolidation window + coverage-gap self-healing; **recorded pricing**: cost snapshots persist with the ledger, so editing the price table never rewrites history |
| **Price table & plans** | Maintainable price table (four-bucket unit prices / tiers / time-window discounts / currency guards, per-step billing recalculated live); daily/monthly plan consumption (tokens) driving target bars and the seat gauge |

All charts are hand-written SVG (zero chart-library dependencies), colored exclusively via official theme tokens, honoring `prefers-reduced-motion`; every chart ships with a table alternative (accessibility).

## Install

**Option 1 · Install from GitHub (recommended)** — the build artifact `lib/client.js` is committed to the repo, so no local build is needed:

```
dsh plugin --profile web add "github:victor10035445/dsh-v-token-insight"
```

To pin a version:

```
dsh plugin --profile web add "github:victor10035445/dsh-v-token-insight#<commit-sha>"
```

Restart `dsh web` after installing, then refresh the page.

**Option 2 · Local clone + link** (no packaging; changes take effect after restarting `dsh web`; good for development):

```
git clone https://github.com/victor10035445/dsh-v-token-insight.git
dsh plugin --profile web add "link:<clone-path>"
```

**Option 3 · tgz package install**:

```
pnpm install && pnpm build   # produces lib/client.js
npm pack                     # produces dsh-v-token-insight-0.4.1.tgz
dsh plugin --profile web add "<absolute-path-to-tgz>"
```

> **Note**: the sources (`src/`) are bundled by esbuild into the client bundle. Direct/link installs use the prebuilt `lib/client.js` committed to the repo; if you modify `src/`, run `pnpm install && pnpm build` before restarting.

## Usage

- The "**Token Stats**" seat at the bottom of the sidebar opens the cross-session overview page (the rainbow gauge on the seat shows today's burn rate; archived sessions are visible, fork sessions are deduped);
- The third tab "**Session Token Stats**" at the top of any session shows turn-level details and per-step calls;
- The "**Plan**" tab in the overview sets daily/monthly plan consumption (tokens); trend charts overlay target reference bars and the seat gauge lights up;
- The "**Price Table**" tab maintains the price table (the editor can align with the official model catalog); costs are recorded prices — editing the price table only affects newly recorded entries, never history;
- The ledger persists in browser `localStorage` (v2 shards: `dsh-v-token-insight.ledger.v2.index` + per-session shard keys); the plan (`dsh-v-token-insight.plan.v1`), price table (`dsh-v-token-insight.prices.v1`), and column widths (`dsh-v-token-insight.colwidths.v2`) persist locally as well; after clearing browser data, rebuild the ledger with one click from the overview page.

## How It Works

| Mechanism | Notes |
|---|---|
| Plugin form | Pure client-side plugin: `cordis.patch.yml` registers the plugin with the cordis loader, and client-modules bundles `lib/client.js` into the `/plugins` startup graph; since dsh-012 the `dsh.client.inject` bootstrap baseline is empty and the host bootstraps on demand |
| Two-tier data caliber | Tier 0 = host list-row projections (fork sessions excluded); Tier 1 = local per-step ledger (keyed `(sessionId, turn, step)`; deep backfill via the `ctx.remote` follow-open + page-paging, with inter-page yields and RTT backoff) |
| Fork dedupe | Sessions with a `parentId` that are not subagents are fork copies (the host seed-copies all parent events); excluded session-wide at the aggregation layer, rows kept inspectable, exclusion count disclosed |
| Ledger v2 | Sharded storage (index key + per-session shards), compact encoding, five-step persist orchestration (consolidate → watermark estimate → tightened retry → full-consolidation tier → per-session eviction), 5MB total budget |
| Recorded pricing | Every persist snapshots the single-pass pricing artifact into the shard (engine version + price fingerprint); cost display reads recorded prices; targeted or full recomputation after price edits |
| Shared folding | Two-level WeakMap (window snapshot → fold → join) + content signature (with in-place mutation protection); chips and the session tab reuse one computation with O(1) turn-lookup indexes |
| Pricing | L1 four-bucket unit prices → L2 dual-dimension tiers → L3 time-window × per-entry discounts, computed per step; steps with mismatched currency are treated as "unpriced" |
| Charts | Hand-written SVG primitives (stacked bars / horizontal bars / dual-axis lines + `niceScale` integer ticks), colors all via `--dsw-alias-*` / `--dsw-static-*` tokens |
| Build | esbuild → factory-form `lib/client.js` (react / `@deepseek-ai/*` all external); pure-function modules like `pricing / stats-fold / charts / pacing / plan-store` unit-test directly under node |

The host-side `lib/index.js` is a logic-free empty plugin whose only job is to let the cordis loader resolve the package.

## Development

```
pnpm install
pnpm build   # esbuild → lib/client.js
pnpm check   # node --check on both artifacts
pnpm test    # node --test pure-function unit tests (532 cases)
```

## Files

```
package.json          Plugin manifest (dsh.bundle.patch + dsh.client declaration)
cordis.patch.yml      Loader insertion entry
build.mjs             esbuild build script (src/ → lib/client.js)
lib/index.js          Host-side entry (empty plugin)
lib/client.js         Client bundle (factory form, committed to the repo)
src/                  Client sources (client.jsx + pure-function modules: pricing/ledger/stats/charts/pacing/plan-store)
test/                 Pure-function unit tests (node --test, incl. the ledger equivalence baseline fixture)
docs/                 Developer-facing internals dossier (zh / en)
```

For implementation details (registration-slot quick reference, page anchors & style hooks, integration risk log), see the [Internals dossier](docs/en/internals.md) (简体中文).

## License

[MIT](LICENSE)
