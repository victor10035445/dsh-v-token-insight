# dsh-v-token-insight · V TOKEN INSIGHT

[简体中文](README.md)  | **English**

A **token usage & cost insight plugin** for the DeepSeek Harness Web client — turning session and workspace token consumption, cache hits, and estimated costs into an always-available dashboard.

Pure client-side, zero kernel changes: it replaces or disables no official plugin, and all data comes from the host's existing projections and session windows.

## Features at a Glance

| Entry | Capabilities |
|---|---|
| **Sidebar seat → Token Stats Overview** (full page) | All-session KPIs (billed tokens / billed input / output / cache hit rate / session count / cost) + five dimension tabs: Overview charts (usage trend / model distribution / project share / cost trend), By Workspace, By Session (details table + search/sort/column resize/right-click jump), By Time (dual caliber), By Model, and Price Table |
| **Third session tab "Session Token Stats"** | Per-session KPIs (four billing cards + first-token latency / generation speed), context pressure meter, per-turn details table (four buckets / hit rate / estimated cost; click a row to jump back to the corresponding turn; expand a row for per-step call details) |
| **Tail lightweight readout** | Appends `⏱ duration · ≈cost · tokens (↑input ↓output)` inside the official action row; hover for the full pricing basis |
| **Local per-step ledger** | Records usage per (session, turn, step); per-session deep backfill, one-click rebuild, JSON backup/restore, compaction aging, and orphan cleanup — archived sessions stay traceable |
| **Price table & cost estimation** | Maintainable price table (four-bucket unit prices / tiers / time-window discounts / currency guards), per-step billing recalculated live, never approximated by "total × unit price"; costs stay hidden when no entry matches (no guessing) |

All charts are hand-written SVG/HTML (zero chart-library dependencies), colored exclusively via official theme tokens that follow light/dark themes, honoring `prefers-reduced-motion`; every chart ships with a table alternative (accessibility).

## Install

**Option 1 · Install from GitHub (recommended)** — the build artifact `lib/client.js` is committed to the repo, so no local build is needed:

```
dsh plugin --profile web add "github:victor10035445/dsh-v-token-insight"
```

To pin a version (later pushes won't silently change the running code):

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
npm pack                     # produces dsh-v-token-insight-0.3.0.tgz
dsh plugin --profile web add "<absolute-path-to-tgz>"
```

> **Note**: unlike the zero-build `dsh-v-theme`, this plugin's sources (`src/`) are bundled by esbuild into the client bundle. Direct/link installs use the prebuilt `lib/client.js` already committed to the repo; if you modify `src/`, run `pnpm install && pnpm build` before restarting.

## Usage

- The "**Token Stats**" seat at the bottom of the sidebar opens the cross-session overview page (archived sessions included);
- The third tab "**Session Token Stats**" at the top of any session shows turn-level details and per-step calls for that session;
- The reply tail shows a lightweight per-usage readout; right-click rows in the details table to jump to a session or copy its ID;
- The "**Price Table**" tab in the overview maintains the price table (the editor can align with the official model catalog); costs are recalculated live with every edit;
- The ledger persists in browser `localStorage` (`dsh-v-token-insight.ledger.v1`); the price table (`dsh-v-token-insight.prices.v1`) and column-width preferences (`dsh-v-token-insight.colwidths.v2`) persist locally as well — after clearing browser data, rebuild the ledger with one click from the overview page.

## How It Works

| Mechanism | Notes |
|---|---|
| Plugin form | Pure client-side plugin: `cordis.patch.yml` registers the plugin with the cordis loader, `dsh.client.inject` declares the bootstrap baseline (runtime / locale / ui-layout / ui-conversation / ui-sidebar), and client-modules bundles `lib/client.js` into the `/plugins` startup graph |
| Two-tier data caliber | Tier 0 = host list-row projections (`tokenUsage` / `sessionStats` etc., O(1) bounded state, authoritative all-session totals); Tier 1 = local per-step ledger (keyed `(sessionId, turn, step)`, with offline deep backfill) |
| Per-turn details | Reads session-window node `usage / timing`, joined with trajectory-view `requests[]` on `(turn, step)` to recover each step's model and request params |
| Pricing | L1 four-bucket unit prices → L2 dual-dimension tiers (context size / session cumulative) → L3 time-window × per-entry discounts, computed per step and presented live without persistence; steps with mismatched currency are treated as "unpriced" |
| Charts | Hand-written SVG layout primitives (stacked bars / horizontal bars / lines + `niceScale` integer ticks), zero dependencies, colors all via `--dsw-alias-*` / `--dsw-static-*` tokens |
| Build | esbuild → factory-form `lib/client.js` (react / `@deepseek-ai/*` all external); pure-function modules like `pricing / stats-fold / charts` unit-test directly under node |

The host-side `lib/index.js` is a logic-free empty plugin whose only job is to let the cordis loader resolve the package.

## Development

```
pnpm install
pnpm build   # esbuild → lib/client.js
pnpm check   # node --check on both artifacts
pnpm test    # node --test pure-function unit tests (94 cases)
```

## Files

```
package.json          Plugin manifest (dsh.bundle.patch + dsh.client declaration)
cordis.patch.yml      Loader insertion entry
build.mjs             esbuild build script (src/ → lib/client.js)
lib/index.js          Host-side entry (empty plugin)
lib/client.js         Client bundle (factory form, committed to the repo)
src/                  Client sources (client.jsx + pure-function modules: pricing/ledger/stats/…)
test/                 Pure-function unit tests (node --test)
docs/                 Developer-facing internals dossier (zh / en)
```

For implementation details (registration-slot quick reference, page anchors & style hooks, integration risk log), see the [Internals dossier](docs/en/internals.md) (简体中文).

## License

[MIT](LICENSE)
