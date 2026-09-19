/**
 * 再生基线快照（fix-ledger-storm 口径修订）：老化桶按聚合日入柱趋势后，
 * serializeViews().daily 变化——用当前实现重新冻结 test/fixtures/ledger-baseline.json。
 * 一次性脚本：node test/regen-baseline.mjs
 */
import { writeFileSync, readFileSync } from "node:fs";
import { aggregateLedgerViews, priceDailyCost } from "../src/ledger.mjs";
import { SEED_TABLE, buildSeedLedger, seedExpandedRows, seedForkIds, serializeViews, serializeDaily } from "./ledger-seed.mjs";

const fixturePath = new URL("./fixtures/ledger-baseline.json", import.meta.url);
const previous = JSON.parse(readFileSync(fixturePath, "utf8"));
const ledger = buildSeedLedger();
const views = aggregateLedgerViews(ledger, SEED_TABLE, seedExpandedRows(), seedForkIds());
const daily = priceDailyCost(ledger, SEED_TABLE);
const next = { views: serializeViews(views), daily: serializeDaily(daily) };
/* daily（费用）口径不变：仅 views.daily（趋势 token）随老化桶入柱而变化。 */
console.log("daily unchanged:", JSON.stringify(next.daily) === JSON.stringify(previous.daily));
const prevDays = Object.keys(previous.views.daily);
const nextDays = Object.keys(next.views.daily);
console.log("views.daily days:", prevDays.join(", "), "→", nextDays.join(", "));
writeFileSync(fixturePath, JSON.stringify(next, null, 2) + "\n");
console.log("fixture regenerated");
