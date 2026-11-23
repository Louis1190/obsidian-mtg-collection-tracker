import { cardValue, CURRENCY_LABELS, type PricedCard, type PriceCurrency } from "./price";


export interface ValuePoint {
	/** Local calendar day, "YYYY-MM-DD". */
	day: string;
	usd: number;
	eur: number;
	/** Number of copies held that day (a jump in the curve with no price move is a purchase, not the market). */
	cards: number;
	/** When this point was written (ms); the newest wins when two devices wrote the same day. */
	dateModified: number;
}

export interface CollectionValue {
	usd: number;
	eur: number;
	cards: number;
}

export type ValuePeriod = "30d" | "90d" | "1y" | "all";

export const VALUE_PERIODS: readonly ValuePeriod[] = ["30d", "90d", "1y", "all"];

export const VALUE_PERIOD_LABELS: Record<ValuePeriod, string> = {
	"30d": "30 days",
	"90d": "90 days",
	"1y": "1 year",
	all: "All",
};

const DAY_MS = 24 * 60 * 60 * 1000;

// `null` = no limit.
const VALUE_PERIOD_DAYS: Record<ValuePeriod, number | null> = {
	"30d": 30,
	"90d": 90,
	"1y": 365,
	all: null,
};

// A file edited by hand, or written by another device, could hold any number of points: Home never draws more than
// the last ones (about 13 years of daily points).
const MAX_READ_POINTS = 5000;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The local calendar day of a timestamp, "YYYY-MM-DD". */
export function localDayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** A real calendar day written "YYYY-MM-DD" ("2026-02-30" and "2026-13-01" are not). */
export function isValidDay(day: unknown): day is string {
	if (typeof day !== "string") return false;
	const m = DAY_PATTERN.exec(day);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A day as a UTC timestamp (the x axis only needs the days to be evenly spaced). */
export function dayToTime(day: string): number {
	const m = DAY_PATTERN.exec(day);
	if (!m) return NaN;
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * What the collection is worth now, in both currencies: the same figure each currency's own total shows
 * (`cardValue`: finish, foil-only printings, proxies excluded, a missing price counts for nothing).
 */
export function computeCollectionValue(collection: readonly PricedCard[]): CollectionValue {
	let usd = 0;
	let eur = 0;
	let cards = 0;
	for (const c of collection) {
		const u = cardValue(c, "usd");
		const e = cardValue(c, "eur");
		if (Number.isFinite(u)) usd += u;
		if (Number.isFinite(e)) eur += e;
		if (Number.isFinite(c.count)) cards += c.count;
	}
	return { usd: round2(usd), eur: round2(eur), cards };
}

export function valueIn(point: CollectionValue, currency: PriceCurrency): number {
	return currency === "eur" ? point.eur : point.usd;
}

// Points as they come from `data.json`, another device or a backup: anything that is not a well-formed point is
// dropped (a bad entry must never break Home), the same day twice keeps the newest, the result is sorted by day.
export function readValuePoints(raw: unknown): ValuePoint[] {
	if (!Array.isArray(raw)) return [];
	const byDay = new Map<string, ValuePoint>();
	for (const e of raw) {
		if (e === null || typeof e !== "object") continue;
		const o = e as Record<string, unknown>;
		const { day, usd, eur, cards } = o;
		if (!isValidDay(day)) continue;
		if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) continue;
		if (typeof eur !== "number" || !Number.isFinite(eur) || eur < 0) continue;
		if (typeof cards !== "number" || !Number.isFinite(cards) || cards < 0) continue;
		const dateModified = typeof o.dateModified === "number" && Number.isFinite(o.dateModified) ? o.dateModified : 0;
		const point: ValuePoint = { day, usd, eur, cards, dateModified };
		const prev = byDay.get(day);
		if (!prev || newerPoint(point, prev)) byDay.set(day, point);
	}
	const out = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
	return out.length > MAX_READ_POINTS ? out.slice(out.length - MAX_READ_POINTS) : out;
}

// true = `a` wins over `b`. Newest write first; on a tie the larger figures, a rule that depends only on the data
// so that every device settles the same way.
function newerPoint(a: ValuePoint, b: ValuePoint): boolean {
	if (a.dateModified !== b.dateModified) return a.dateModified > b.dateModified;
	if (a.usd !== b.usd) return a.usd > b.usd;
	if (a.eur !== b.eur) return a.eur > b.eur;
	return a.cards > b.cards;
}

/** Two histories as one (a restored backup does not erase what was recorded since it was made). */
export function mergeValueHistories(a: unknown, b: unknown): ValuePoint[] {
	return readValuePoints([...readValuePoints(a), ...readValuePoints(b)]);
}

/**
 * Writes `day`'s point into `history` (in place, sorted by day). Returns whether anything changed: an identical
 * point is left alone, so a second refresh the same day does not make the sync send the data again. Nothing is
 * recorded for an empty collection or an invalid day.
 */
export function recordValuePoint(history: ValuePoint[], day: string, value: CollectionValue, now: number): boolean {
	if (!isValidDay(day) || value.cards <= 0) return false;
	const i = history.findIndex((p) => p.day === day);
	if (i >= 0) {
		const prev = history[i];
		if (prev.usd === value.usd && prev.eur === value.eur && prev.cards === value.cards) return false;
		// Never earlier than what is already there: another device's clock may be ahead of ours.
		const dateModified = Math.max(now, (Number.isFinite(prev.dateModified) ? prev.dateModified : 0) + 1);
		history[i] = { day, usd: value.usd, eur: value.eur, cards: value.cards, dateModified };
		return true;
	}
	history.push({ day, usd: value.usd, eur: value.eur, cards: value.cards, dateModified: now });
	history.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
	return true;
}

/**
 * What Home draws: the recorded points of the period, with TODAY's point replaced by the live total, so the end of
 * the curve is always the figure the Overview shows (the collection may have changed since the last refresh).
 * `points` must come from `readValuePoints`.
 */
export function seriesForPeriod(
	points: readonly ValuePoint[],
	live: CollectionValue,
	period: ValuePeriod,
	now: number
): ValuePoint[] {
	const today = localDayKey(now);
	const all = points.filter((p) => p.day !== today);
	if (live.cards > 0) all.push({ day: today, usd: live.usd, eur: live.eur, cards: live.cards, dateModified: now });
	all.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
	const days = VALUE_PERIOD_DAYS[period];
	if (days === null) return all;
	const start = dayToTime(today) - days * DAY_MS;
	return all.filter((p) => dayToTime(p.day) >= start);
}

export interface ValueChange {
	amount: number;
	/** null when the first value was 0 (no percentage means anything then). */
	percent: number | null;
	/** The day the comparison starts from. */
	since: string;
}

/** First to last point of the series, in one currency; null with fewer than two points. */
export function valueChange(series: readonly ValuePoint[], currency: PriceCurrency): ValueChange | null {
	if (series.length < 2) return null;
	const first = series[0];
	const last = series[series.length - 1];
	const from = valueIn(first, currency);
	const amount = round2(valueIn(last, currency) - from);
	return { amount, percent: from > 0 ? (amount / from) * 100 : null, since: first.day };
}

export interface ValueBounds {
	min: number;
	max: number;
}

/**
 * The vertical range of the curve: not from zero (a collection that moves 2 % would draw a flat line), with a
 * margin above and below so the line never touches the frame.
 */
export function valueBounds(values: readonly number[]): ValueBounds {
	if (values.length === 0) return { min: 0, max: 1 };
	let lo = Infinity;
	let hi = -Infinity;
	for (const v of values) {
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	const pad = Math.max((hi - lo) * 0.15, hi * 0.01, 0.01);
	return { min: Math.max(0, lo - pad), max: hi + pad };
}

/** "Nov 22", or "Nov 22, 2026" when the year matters. A day is a UTC timestamp (dayToTime), so it is formatted in UTC. */
export function formatDayLabel(day: string, withYear = false): string {
	const t = dayToTime(day);
	if (!Number.isFinite(t)) return day;
	// "en-US" set explicitly: the plugin is in English everywhere, the system language must not leak into one date.
	return new Date(t).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		...(withYear ? { year: "numeric" } : {}),
		timeZone: "UTC",
	});
}

/** The curve covers more than a calendar year, or two of them: the axis dates then carry their year. */
export function seriesNeedsYear(series: readonly ValuePoint[]): boolean {
	if (series.length < 2) return false;
	const first = series[0].day;
	const last = series[series.length - 1].day;
	return first.slice(0, 4) !== last.slice(0, 4) || dayToTime(last) - dayToTime(first) > 300 * DAY_MS;
}

/** "$1.2k", "€3.45M", "$87": the labels of the vertical axis, short because the column is narrow. */
export function formatCompactMoney(amount: number, currency: PriceCurrency): string {
	const symbol = CURRENCY_LABELS[currency].symbol;
	const a = Math.abs(amount);
	const sign = amount < 0 ? "-" : "";
	if (a >= 1_000_000) return `${sign}${symbol}${trimZero((a / 1_000_000).toFixed(2))}M`;
	if (a >= 10_000) return `${sign}${symbol}${Math.round(a / 1000)}k`;
	if (a >= 1000) return `${sign}${symbol}${trimZero((a / 1000).toFixed(1))}k`;
	return `${sign}${symbol}${Math.round(a)}`;
}

function trimZero(s: string): string {
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
