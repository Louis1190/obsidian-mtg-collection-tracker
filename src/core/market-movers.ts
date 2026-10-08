import type { CardbaseMover, CardbaseFinish } from "../api/cardbase";
import type { Finish } from "./card-model";
import type { PriceCurrency } from "./price";

/* -------------------------------------------------------------------------- */
/* PURE logic behind Home's "Market Trends" block (2026-09-23): anomaly */
/* filter, data age, matching with the collection/wantlist, displayed price. */
/* No Obsidian/DOM access — tested in market-movers.test.ts; the rendering */
/* itself is in view/home-render.ts. */
/* -------------------------------------------------------------------------- */

export const MOVER_MIN_PRICE = 2;
export const MOVER_MAX_JUMP_RATIO = 5;
export const MOVER_HIGH_PRICE = 250;
export const MOVER_HIGH_PRICE_MAX_JUMP_RATIO = 2;

export function shouldHideMover(m: Pick<CardbaseMover, "priceFrom" | "priceTo">): boolean {
	const { priceFrom, priceTo } = m;
	if (!Number.isFinite(priceFrom) || !Number.isFinite(priceTo)) return true;
	const lo = Math.min(priceFrom, priceTo);
	const hi = Math.max(priceFrom, priceTo);
	// lo < MOVER_MIN_PRICE also covers 0/negative: the division below never
	// runs with lo <= 0.
	if (lo < MOVER_MIN_PRICE) return true;
	const ratio = hi / lo;
	if (ratio > MOVER_MAX_JUMP_RATIO) return true;
	return hi >= MOVER_HIGH_PRICE && ratio > MOVER_HIGH_PRICE_MAX_JUMP_RATIO;
}

// Filters then sorts explicitly (gainers: largest rise first; losers: largest
// drop first) rather than trusting the API's order — it is already that way
// today, but nothing guarantees it. Does not modify the received array (it
// lives in the plugin's session cache, cardbaseMoversCache, and will be
// served as is again on the next display).
export function selectDisplayMovers(rows: CardbaseMover[], direction: "up" | "down", limit: number): CardbaseMover[] {
	const kept = rows.filter((m) => !shouldHideMover(m));
	kept.sort(direction === "up" ? (a, b) => b.changePct - a.changePct : (a, b) => a.changePct - b.changePct);
	return kept.slice(0, limit);
}

/* --- Data age ------------------------------------------------
   cardbase updates its prices once a day (~06:40 UTC): an `as_of` date
   (meta.as_of, see CardbaseMoversResult) from yesterday or the day before is
   normal, not an incident. On 2026-09-23, however, it was dated 2026-09-09
   (/status announced the next update for 09-10) — and the block only showed
   "Data as of 2026-09-09" in very small print, signalling nothing. Threshold
   at 3 days: wide enough never to light up on an ordinary lag (weekend
   included), short enough to catch a real pipeline stoppage. */
export const MOVERS_STALE_AFTER_DAYS = 3;

// undefined = missing or unreadable date (no warning in that case — better
// to stay silent than shout about data we can't read). asOf is a
// "YYYY-MM-DD" date (UTC); the count is in whole days since UTC midnight
// of that date, never negative.
export function getMoversAgeDays(asOf: string | undefined, now: number): number | undefined {
	if (!asOf) return undefined;
	const t = Date.parse(`${asOf}T00:00:00Z`);
	if (!Number.isFinite(t)) return undefined;
	return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function isMoversDataStale(ageDays: number | undefined): boolean {
	return ageDays !== undefined && ageDays >= MOVERS_STALE_AFTER_DAYS;
}

/* --- Matching with the collection/wantlist ----------------------------
   A /movers row is specific to a printing AND a finish (a foil's price moves
   independently of the non-foil): "I own this card" therefore only means
   something here for the SAME finish — an "owned ×2" badge on a foil price
   move while both copies are non-foil would suggest that THEIR value moved.
   Finish (this plugin) → CardbaseFinish: Surge Foil is priced as a foil (see
   getRawCardPrice, price.ts); Proxy has no market value → null. */
export function moverFinishOf(finish: Finish): CardbaseFinish | null {
	switch (finish) {
		case "regular":
			return "normal";
		case "foiled":
		case "surged":
			return "foil";
		case "etched":
			return "etched";
		default:
			return null;
	}
}

export function moverOwnershipKey(scryfallId: string, finish: CardbaseFinish): string {
	return `${scryfallId}|${finish}`;
}

/* --- Displayed price ----------------------------------------------
   cardbase gives each price in the vendor's NATIVE currency (USD for
   TCGplayer/Card Kingdom/Cardsphere, EUR for Cardmarket): in "All vendors", a
   list therefore mixes both. We convert into the currency chosen by the user
   (settings.priceCurrency) — like the Price History chart, and for the same
   reason: rows comparable with each other. `convert` is injected (see
   convertUsdEur, api/frankfurter.ts) rather than imported, so that this
   module has no dependency on Obsidian; without a function (rate
   unavailable), we display the native amount as is rather than hiding the
   price — never a wrong figure, at worst a figure in the other currency with
   its own symbol. */
export interface MoverPriceDisplay {
	// Currency actually displayed: the one requested, or the vendor's native
	// currency if no conversion was possible.
	currency: PriceCurrency;
	from: number;
	to: number;
	delta: number;
	converted: boolean;
}

export type MoverConvert = (amount: number, from: PriceCurrency, to: PriceCurrency) => number;

export function moverNativeCurrency(m: Pick<CardbaseMover, "currency">): PriceCurrency {
	return m.currency.toUpperCase() === "EUR" ? "eur" : "usd";
}

export function getMoverPriceDisplay(
	m: Pick<CardbaseMover, "currency" | "priceFrom" | "priceTo">,
	target: PriceCurrency,
	convert: MoverConvert | undefined
): MoverPriceDisplay {
	const native = moverNativeCurrency(m);
	if (native === target || !convert) {
		return { currency: native, from: m.priceFrom, to: m.priceTo, delta: m.priceTo - m.priceFrom, converted: false };
	}
	const from = convert(m.priceFrom, native, target);
	const to = convert(m.priceTo, native, target);
	return { currency: target, from, to, delta: to - from, converted: true };
}
