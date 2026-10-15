import type { CardbaseFinish, CardbasePriceHistory, CardbasePriceSeries, CardbaseVendor } from "../api/cardbase";

/* -------------------------------------------------------------------------- */
/* Our own price history: the format of the shard files and how a card's        */
/* series become the CardbasePriceHistory the chart and the price columns read. */
/* -------------------------------------------------------------------------- */
// The files are produced by tools/price-history/ (read its README for the whole design): one gzip JSON file per
// first 3 hex characters of the Scryfall id, shaped
//   { "_": { "v": 1, "asOf": "2026-10-13", "newDays": { "cm": "2026-10-12", ... } }, "<scryfallId>": { "<vendor>.<finish>": record, ... }, ... }
// A record is [start, end, [offset, cents], ...] in days since 1970-01-01; only CHANGES are stored, a null price
// is a hole (the vendor stopped listing the card for a while), and `end` is the last day with data. This file is
// the TypeScript twin of tools/price-history/lib/series-codec.mjs (tools/ is never imported from src/); the Vitest
// golden file src/core/price-history.golden.json, written by that tool, is what keeps the two in step.

export type SeriesRecord = [start: number, end: number, ...changes: [offset: number, cents: number | null][]];

export const SHARD_FORMAT_VERSION = 1;

export interface PriceHistoryShard {
	/** Newest day the files were built from ("YYYY-MM-DD"). */
	asOf: string;
	/** Scryfall id -> "<vendor>.<finish>" -> record. Records are validated when a card is read, not here. */
	cards: Record<string, Record<string, unknown>>;
	/**
	 * Each vendor's latest day on which its prices REALLY moved, as days since 1970-01-01 ("cm", "tcg", "ck"). Cardmarket sometimes repeats the
	 * previous day's whole list; "the change since yesterday" is then read at that day, not at the as-of day, where every card looks unchanged.
	 * Absent when the file does not say (older files), and then nothing changes: the last two points are compared as before.
	 */
	newDays?: Partial<Record<"cm" | "tcg" | "ck", number>>;
}

const DAY_MS = 86400000;

export function dayOfDate(date: string): number {
	return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

export function dateOfDay(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is SeriesRecord {
	return Array.isArray(value) && value.length >= 3 && typeof value[0] === "number" && typeof value[1] === "number";
}

/** Every day that has data, as [day, cents]. */
export function decodeRecord(rec: SeriesRecord): [number, number][] {
	const start = rec[0];
	const end = rec[1];
	const out: [number, number][] = [];
	let idx = 2;
	let cur: number | null = null;
	for (let day = start; day <= end; day++) {
		while (idx < rec.length) {
			const change = rec[idx] as [number, number | null];
			if (change[0] > day - start) break;
			cur = change[1];
			idx++;
		}
		if (cur !== null) out.push([day, cur]);
	}
	return out;
}

/** The parsed content of a shard file, or undefined when it is not one we can read (another format version, damaged). */
export function parseShard(json: unknown): PriceHistoryShard | undefined {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
	const { _: meta, ...cards } = json as Record<string, unknown>;
	if (typeof meta !== "object" || meta === null) return undefined;
	const { v, asOf, newDays } = meta as { v?: unknown; asOf?: unknown; newDays?: unknown };
	if (v !== SHARD_FORMAT_VERSION || typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return undefined;
	return { asOf, cards: cards as PriceHistoryShard["cards"], newDays: parseNewDays(newDays, dayOfDate(asOf)) };
}

/** Only what makes sense is kept: a known vendor, a real date, not later than the as-of day. Anything else is ignored (the badge then reads the last two points). */
function parseNewDays(value: unknown, asOfDay: number): PriceHistoryShard["newDays"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const out: NonNullable<PriceHistoryShard["newDays"]> = {};
	for (const code of ["cm", "tcg", "ck"] as const) {
		const date = (value as Record<string, unknown>)[code];
		if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
		const day = dayOfDate(date);
		if (Number.isFinite(day) && day <= asOfDay) out[code] = day;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const VENDORS: { code: "ck" | "tcg" | "cm"; vendor: CardbaseVendor; currency: string }[] = [
	{ code: "ck", vendor: "cardkingdom", currency: "USD" },
	{ code: "tcg", vendor: "tcgplayer", currency: "USD" },
	{ code: "cm", vendor: "cardmarket", currency: "EUR" },
];
// Mana Pool ("mp") is collected by the job but NOT published (2026-10-15: nothing reads it, 25 % of the bytes, the least reliable vendor): the
// files hold these three vendors only, and the chart's vendor set is cardbase's (see cardbase.ts).

const FINISH_CODES: Record<CardbaseFinish, string> = { normal: "n", foil: "f", etched: "e" };

/** A series that stopped more than this many days before the files' as-of day is no longer a CURRENT price. */
const LIVE_TOLERANCE_DAYS = 1;
/** The day-change arrow compares with the latest price up to this many days before the vendor's last real day (a day MTGJSON did not publish is a gap for every card). */
const DAY_CHANGE_LOOK_BACK_DAYS = 3;
/** A vendor whose list has not really moved for this many days has no "change since yesterday" to show (same threshold as the movers' stale-data notice). */
const VENDOR_STALE_DAYS = 3;

/**
 * The change "since yesterday" read at the vendor's latest day of real changes: that day's price against the latest price in the DAY_CHANGE_LOOK_BACK_DAYS
 * before it (normally the day before; MTGJSON sometimes publishes nothing for a whole day, every series then has a hole there and the day after it still
 * has something to be compared with). null = nothing to show: the vendor's list has not moved for VENDOR_STALE_DAYS (an old change is not "since
 * yesterday"), the card has no price that day, or none in the days before it (a card relisted today after days away is not compared with last week's price).
 */
function dayChangeAt(days: [number, number][], newDay: number, asOfDay: number): { previous: number; current: number } | null {
	if (asOfDay - newDay >= VENDOR_STALE_DAYS) return null;
	let previous: number | undefined;
	let current: number | undefined;
	// `days` is in ascending order: of the days before newDay that are close enough, the last one seen is the latest.
	for (const [day, cents] of days) {
		if (day === newDay) current = cents;
		else if (day < newDay && newDay - day <= DAY_CHANGE_LOOK_BACK_DAYS) previous = cents;
	}
	return previous !== undefined && current !== undefined ? { previous: previous / 100, current: current / 100 } : null;
}

/**
 * What the chart, the Cardmarket column and the day-change badges read, built from one card of a shard. undefined
 * when the shard has nothing for this card and finish (the caller then asks cardbase instead). It answers exactly the finish it is asked: which
 * finish a card is looked up as (a foil-only printing followed as "regular" is a foil) is core/price.ts effectiveFinish, applied by the callers.
 */
export function buildPriceHistory(shard: PriceHistoryShard, scryfallId: string, finish: CardbaseFinish): CardbasePriceHistory | undefined {
	const records = shard.cards[scryfallId];
	if (!records) return undefined;
	const asOfDay = dayOfDate(shard.asOf);
	const series: CardbasePriceSeries[] = [];
	let first = Infinity;
	for (const { code, vendor, currency } of VENDORS) {
		const rec = records[`${code}.${FINISH_CODES[finish]}`];
		if (!isRecord(rec)) continue;
		const days = decodeRecord(rec);
		if (days.length === 0) continue;
		first = Math.min(first, days[0][0]);
		series.push({
			vendor,
			finish,
			currency,
			// A vendor that stopped listing the card days ago must not pass its last price off as today's.
			live: rec[1] >= asOfDay - LIVE_TOLERANCE_DAYS,
			points: days.map(([day, cents]) => ({ date: dateOfDay(day), price: cents / 100 })),
			// Only when the file says which day the vendor really moved on; otherwise absent, and the badge compares the last two points.
			...(shard.newDays?.[code] !== undefined ? { dayChange: dayChangeAt(days, shard.newDays[code], asOfDay) } : {}),
		});
	}
	if (series.length === 0) return undefined;
	return { scryfallId, series, historyBegins: dateOfDay(first), asOf: shard.asOf, source: "price-history" };
}
