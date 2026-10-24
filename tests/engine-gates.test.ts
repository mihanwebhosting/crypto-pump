/**
 * Logic tests for the three behaviours fixed in this branch:
 *   1. REAL entry anchors — a tracked trade may only be judged on trustworthy prices
 *   2. SYMBOL MUTING — muted symbols leave generation, broadcast and replies
 *   3. REGENERATE BROADCAST — dispatch summaries tell the truth about what happened
 *
 * Run with:  npm test
 * (WHALEPULSE_NO_AUTO_START prevents server.ts from booting Express + the 24/7 engine.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isTrackedPriceVerdictTrustworthy,
  reanchorSignalEntry,
  evaluateSignalOutcome,
  entryDriftPercent,
  recordSignalEntry,
  getSignalEntryRecord,
  clearSignalEntries,
  muteSymbol,
  unmuteSymbol,
  isSymbolMuted,
  listMutedSymbols,
  calculateSignalTargets,
  generateFreshSignalsSet,
  type InternalTrackedSignal
} from "../server.js";

let passed = 0;
let failed = 0;
const checks: string[] = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; checks.push(`  ✓ ${name}`); })
    .catch((err: any) => { failed++; checks.push(`  ✗ ${name}\n      ${err?.message || err}`); });
}

function makeSignal(over: Partial<InternalTrackedSignal>): InternalTrackedSignal {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    tokenSymbol: "TEST",
    name: "Test Token",
    chain: "solana",
    direction: "PUMP",
    entryPrice: 100,
    currentPrice: 100,
    target1: 104.2,
    target2: 111.8,
    stopLoss: 96.8,
    confidence: 90,
    telegramMessageId: 1,
    status: "ACTIVE",
    openedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    pnlPercent: 0,
    maxPnlPercent: 0,
    catalyst: "",
    notesFa: "",
    whaleInflowUsd: 0,
    ...over
  } as InternalTrackedSignal;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  // ── 1. REAL entry anchor / bogus "target reached" ───────────────────────────
  await test("rejects a tracked trade anchored on a demo price (the +11,000% bug)", () => {
    // Exactly the historic failure: entry from the wildcard catalog demo price,
    // live price from a real feed → the engine saw "TP1/TP2 reached" at once.
    const bogus = makeSignal({
      tokenSymbol: "FARTCOIN",
      entryPrice: 0.00001085,
      currentPrice: 1.24,
      priceIsReal: true
    });
    assert.ok(Math.abs(entryDriftPercent(bogus)) > 1000, "drift should be absurd");
    assert.equal(isTrackedPriceVerdictTrustworthy(bogus), false, "a demo anchor must never produce a TP/SL verdict");
  });

  await test("never fires a TP/SL alert while the live price is simulator data", () => {
    const sim = makeSignal({ entryPrice: 1, currentPrice: 9.99, priceIsReal: false });
    assert.equal(isTrackedPriceVerdictTrustworthy(sim), false);
  });

  await test("accepts a real in-progress trade (normal PnL tick)", () => {
    const ok = makeSignal({ entryPrice: 100, currentPrice: 103, priceIsReal: true });
    assert.equal(isTrackedPriceVerdictTrustworthy(ok), true);
  });

  await test("re-anchoring repairs the entry price and recomputes the targets", () => {
    const sig = makeSignal({ tokenSymbol: "TOXDUMP", entryPrice: 0.00001085, currentPrice: 1.24, priceIsReal: true });
    reanchorSignalEntry(sig, 1.24, "Binance Spot");

    assert.equal(sig.entryPrice, 1.24, "entry must be re-stuck to the real quote");
    assert.equal(sig.entryPriceSource, "Binance Spot");
    assert.equal(sig.pnlPercent, 0, "a repaired anchor starts from 0% PnL");
    const expected = calculateSignalTargets(1.24, true);
    assert.equal(sig.target1, expected.target1);
    assert.equal(sig.target2, expected.target2);
    assert.equal(sig.stopLoss, expected.stopLoss);
    assert.equal(isTrackedPriceVerdictTrustworthy(sig), true, "the anchor is trustworthy again");
    assert.equal(1.24 >= sig.target1, false, "and the price no longer 'already passed TP1'");
    assert.ok(sig.anchorNote?.includes("Binance Spot"), "the repair is surfaced for the dashboard");
  });

  await test("a fresh dispatch replaces a stale entry anchor (overwrite)", () => {
    clearSignalEntries();
    recordSignalEntry("PEPE", "PUMP", 0.00001085, { priceSource: "Catalog Demo Price", isReal: false });
    assert.equal(getSignalEntryRecord("PEPE")?.entryPrice, 0.00001085);

    // A new signal for the same symbol must re-anchor the dashboard PnL.
    recordSignalEntry("PEPE", "PUMP", 0.00001210, { overwrite: true, priceSource: "Binance Spot", isReal: true });
    const rec = getSignalEntryRecord("PEPE");
    assert.equal(rec?.entryPrice, 0.00001210, "stale anchor must not survive a real dispatch");
    assert.equal(rec?.isReal, true);
    assert.equal(rec?.maxPnlPercent, undefined, "max PnL resets with the new anchor");
  });

  await test("a plain first-seen record still does not clobber an existing anchor", () => {
    clearSignalEntries();
    recordSignalEntry("SOL", "PUMP", 184.5, { priceSource: "Binance Spot", isReal: true });
    recordSignalEntry("SOL", "PUMP", 999); // no overwrite flag → ignored
    assert.equal(getSignalEntryRecord("SOL")?.entryPrice, 184.5);
    clearSignalEntries();
  });

  // ── 1b. The engine's own outcome evaluator (same code the 24/7 tick runs) ───
  await test("no target is ever declared reached from an unverified anchor", () => {
    const bogus = makeSignal({ entryPrice: 0.00001085, currentPrice: 1.24, target1: 0.00001131, priceIsReal: true });
    const verdict = evaluateSignalOutcome(bogus);
    assert.deepEqual(
      { tp1: verdict.tp1, tp2: verdict.tp2, sl: verdict.stopLoss, trustworthy: verdict.trustworthy },
      { tp1: false, tp2: false, sl: false, trustworthy: false },
      "a demo-anchored trade must produce zero alerts"
    );
  });

  await test("long: TP1 fires only past target1 on a real anchor", () => {
    const sig = makeSignal({ entryPrice: 100, currentPrice: 104.3, target1: 104.2, target2: 111.8, stopLoss: 96.8, priceIsReal: true });
    const v = evaluateSignalOutcome(sig);
    assert.equal(v.trustworthy, true);
    assert.equal(v.tp1, true);
    assert.equal(v.tp2, false);
    assert.equal(v.stopLoss, false);
    assert.equal(evaluateSignalOutcome(makeSignal({ entryPrice: 100, currentPrice: 104.1, priceIsReal: true })).tp1, false, "104.1 < 104.2 target");
  });

  await test("long: TP2 and stop loss are both detected", () => {
    assert.equal(evaluateSignalOutcome(makeSignal({ entryPrice: 100, currentPrice: 112, priceIsReal: true })).tp2, true);
    assert.equal(evaluateSignalOutcome(makeSignal({ entryPrice: 100, currentPrice: 96.5, priceIsReal: true })).stopLoss, true);
  });

  await test("short: targets are on the downside", () => {
    const short = makeSignal({ direction: "DUMP", entryPrice: 100, currentPrice: 95, target1: 95.5, target2: 87.8, stopLoss: 103.4, priceIsReal: true });
    const v = evaluateSignalOutcome(short);
    assert.equal(v.tp1, true);
    assert.equal(v.tp2, false);
    assert.equal(v.stopLoss, false);
    assert.equal(evaluateSignalOutcome(makeSignal({ direction: "DUMP", entryPrice: 100, currentPrice: 103.5, target1: 95.5, stopLoss: 103.4, priceIsReal: true })).stopLoss, true);
  });

  await test("a stale/simulated live price cannot close a trade", () => {
    const sig = makeSignal({ entryPrice: 100, currentPrice: 999, target1: 104.2, priceIsReal: false });
    const v = evaluateSignalOutcome(sig, 999);
    assert.equal(v.tp1, false);
    assert.equal(v.trustworthy, false);
  });

  // ── 2. Symbol muting ────────────────────────────────────────────────────────
  await test("mute hides the symbol from generated signals, unmute brings it back", () => {
    const before = generateFreshSignalsSet(50, 1);
    assert.ok(before.length > 0, "expected at least one generated signal in the catalog universe");
    const victim = before[0].symbol as string;

    muteSymbol(victim, { reason: "unit test" });
    assert.equal(isSymbolMuted(victim), true);
    assert.ok(listMutedSymbols().some(m => m.symbol === victim));

    const after = generateFreshSignalsSet(50, 1);
    assert.equal(after.some((s: any) => s.symbol === victim), false, `${victim} must be filtered out while muted`);

    assert.equal(unmuteSymbol(victim), true);
    assert.equal(isSymbolMuted(victim), false);
    assert.equal(unmuteSymbol(victim), false, "unmuting a symbol that was not muted reports false");
  });

  await test("mute persists to disk and is restored from it", () => {
    muteSymbol("MUTEPERP", { reason: "persist check" });
    const file = path.join(process.cwd(), ".runtime", "muted_symbols.json");
    assert.ok(fs.existsSync(file), `${file} should exist after a mute`);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.ok(Array.isArray(raw) && raw.some((m: any) => m.symbol === "MUTEPERP"));
    unmuteSymbol("MUTEPERP");
  });

  await test("a timed mute expires by itself", async () => {
    muteSymbol("TEMP", { minutes: 0.02 }); // ~1.2s
    assert.equal(isSymbolMuted("TEMP"), true);
    await wait(1400);
    assert.equal(isSymbolMuted("TEMP"), false, "expired mute must stop blocking the symbol");
    assert.equal(listMutedSymbols().some(m => m.symbol === "TEMP"), false);
  });

  // ── 3. Regenerate / broadcast plumbing ──────────────────────────────────────
  await test("muted symbols never come back through the signals API", () => {
    muteSymbol("FARTCOIN");
    const set = generateFreshSignalsSet(1, 1);
    assert.equal(set.some((s: any) => String(s.symbol).toUpperCase() === "FARTCOIN"), false);
    unmuteSymbol("FARTCOIN");
  });

  assert.equal(listMutedSymbols().length, 0, "test run must leave no muted symbols behind");
  clearSignalEntries();

  console.log("\nEngine gate tests\n" + checks.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
