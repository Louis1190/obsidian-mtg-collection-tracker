import { afterEach, describe, expect, it, vi } from "vitest";
import type { PricedCard } from "./price";
import {
	computeCollectionValue,
	dayToTime,
	formatCompactMoney,
	formatDayLabel,
	isValidDay,
	localDayKey,
	mergeValueHistories,
	readValuePoints,
	recordValuePoint,
	seriesForPeriod,
	seriesNeedsYear,
	valueBounds,
	valueChange,
	valueIn,
	type ValuePoint,
} from "./value-history";

const card = (over: Partial<PricedCard> = {}): PricedCard => ({
	finish: "regular",
	priceUsd: "",
	priceUsdFoil: "",
	priceEur: "",
	priceEurFoil: "",
	priceUsdEtched: "",
	priceEurEtched: "",
	count: 1,
	...over,
});

const pt = (day: string, usd: number, over: Partial<ValuePoint> = {}): ValuePoint => ({
	day,
	usd,
	eur: usd * 0.9,
	cards: 10,
	dateModified: 1000,
	...over,
});

// Noon, so that no timezone moves the calendar day.
const at = (day: string): number => new Date(`${day}T12:00:00`).getTime();

afterEach(() => vi.useRealTimers());

describe("days", () => {
	it("writes the LOCAL calendar day", () => {
		expect(localDayKey(new Date(2026, 10, 22, 23, 59).getTime())).toBe("2026-11-22");
		expect(localDayKey(new Date(2026, 0, 5, 0, 1).getTime())).toBe("2026-01-05");
	});

	it("accepts real days only", () => {
		expect(isValidDay("2026-11-22")).toBe(true);
		expect(isValidDay("2024-02-29")).toBe(true);
		expect(isValidDay("2026-02-29")).toBe(false);
		expect(isValidDay("2026-13-01")).toBe(false);
		expect(isValidDay("2026-1-1")).toBe(false);
		expect(isValidDay("__proto__")).toBe(false);
		expect(isValidDay(20261122)).toBe(false);
		expect(isValidDay(undefined)).toBe(false);
	});

	it("turns a day into evenly spaced timestamps", () => {
		expect(dayToTime("2026-11-23") - dayToTime("2026-11-22")).toBe(86_400_000);
		expect(dayToTime("2026-03-29") - dayToTime("2026-03-28")).toBe(86_400_000);
		expect(dayToTime("nope")).toBeNaN();
	});
});

describe("computeCollectionValue", () => {
	it("totals both currencies and the number of copies", () => {
		const v = computeCollectionValue([
			card({ priceUsd: "10.00", priceEur: "9.00", count: 2 }),
			card({ priceUsd: "0.50", priceEur: "0.40", count: 4 }),
		]);
		expect(v).toEqual({ usd: 22, eur: 19.6, cards: 6 });
	});

	it("follows the finish, like the displayed price", () => {
		const v = computeCollectionValue([
			card({ finish: "foiled", priceUsd: "1.00", priceUsdFoil: "5.00", priceEur: "1.00", priceEurFoil: "4.00" }),
			card({ finish: "etched", priceUsd: "1.00", priceUsdEtched: "7.00", priceEur: "1.00", priceEurEtched: "6.00" }),
		]);
		expect(v.usd).toBe(12);
		expect(v.eur).toBe(10);
	});

	it("leaves proxies and unpriced cards out of the value but not out of the count", () => {
		const v = computeCollectionValue([
			card({ finish: "proxy", priceUsd: "100.00", priceEur: "90.00", count: 3 }),
			card({ count: 2 }),
		]);
		expect(v).toEqual({ usd: 0, eur: 0, cards: 5 });
	});

	it("values a printing that exists only in foil at its foil price", () => {
		const v = computeCollectionValue([card({ priceUsdFoil: "3.00", priceEurFoil: "2.50" })]);
		expect(v).toEqual({ usd: 3, eur: 2.5, cards: 1 });
	});

	it("is not thrown off by a broken count", () => {
		const v = computeCollectionValue([card({ priceUsd: "2.00", count: Number.NaN }), card({ priceUsd: "1.00" })]);
		expect(v.usd).toBe(1);
		expect(v.cards).toBe(1);
	});

	it("rounds to cents, not to binary noise", () => {
		const v = computeCollectionValue([card({ priceUsd: "0.10", count: 3 })]);
		expect(v.usd).toBe(0.3);
	});

	it("is empty for no cards", () => {
		expect(computeCollectionValue([])).toEqual({ usd: 0, eur: 0, cards: 0 });
	});
});

describe("recordValuePoint", () => {
	const value = { usd: 100, eur: 90, cards: 50 };

	it("adds a day and keeps the history sorted", () => {
		const h: ValuePoint[] = [pt("2026-11-20", 1), pt("2026-11-22", 3)];
		expect(recordValuePoint(h, "2026-11-21", value, 5000)).toBe(true);
		expect(h.map((p) => p.day)).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
		expect(h[1]).toEqual({ day: "2026-11-21", usd: 100, eur: 90, cards: 50, dateModified: 5000 });
	});

	it("does nothing when the day already holds the same figures (no needless sync)", () => {
		const h: ValuePoint[] = [{ day: "2026-11-22", ...value, dateModified: 1000 }];
		expect(recordValuePoint(h, "2026-11-22", value, 9999)).toBe(false);
		expect(h[0].dateModified).toBe(1000);
	});

	it("replaces the day's point when the figures changed, and the write time moves forward", () => {
		const h: ValuePoint[] = [{ day: "2026-11-22", usd: 1, eur: 1, cards: 1, dateModified: 1000 }];
		expect(recordValuePoint(h, "2026-11-22", value, 2000)).toBe(true);
		expect(h).toHaveLength(1);
		expect(h[0]).toEqual({ day: "2026-11-22", ...value, dateModified: 2000 });
	});

	it("beats a point written by a device whose clock is ahead", () => {
		const h: ValuePoint[] = [{ day: "2026-11-22", usd: 1, eur: 1, cards: 1, dateModified: 10_000 }];
		recordValuePoint(h, "2026-11-22", value, 2000);
		expect(h[0].dateModified).toBe(10_001);
	});

	it("records nothing for an empty collection or a bad day", () => {
		const h: ValuePoint[] = [];
		expect(recordValuePoint(h, "2026-11-22", { usd: 0, eur: 0, cards: 0 }, 1)).toBe(false);
		expect(recordValuePoint(h, "2026-02-30", value, 1)).toBe(false);
		expect(recordValuePoint(h, "", value, 1)).toBe(false);
		expect(h).toEqual([]);
	});
});

describe("readValuePoints", () => {
	it("keeps good points, sorted, and drops everything else", () => {
		const raw = [
			pt("2026-11-22", 3),
			pt("2026-11-20", 1),
			null,
			42,
			"x",
			{ day: "2026-11-21" },
			{ ...pt("2026-11-19", 1), usd: -5 },
			{ ...pt("2026-11-18", 1), usd: Number.NaN },
			{ ...pt("2026-11-17", 1), eur: "9" },
			{ ...pt("2026-11-16", 1), cards: Infinity },
			{ ...pt("2026-02-30", 1) },
			{ ...pt("__proto__", 1) },
		];
		expect(readValuePoints(raw).map((p) => p.day)).toEqual(["2026-11-20", "2026-11-22"]);
	});

	it("accepts anything that is not an array", () => {
		expect(readValuePoints(undefined)).toEqual([]);
		expect(readValuePoints({ "2026-11-22": pt("2026-11-22", 1) })).toEqual([]);
		expect(readValuePoints("nope")).toEqual([]);
	});

	it("keeps the newest of a day written twice", () => {
		const out = readValuePoints([pt("2026-11-22", 1, { dateModified: 5 }), pt("2026-11-22", 2, { dateModified: 9 }), pt("2026-11-22", 3, { dateModified: 7 })]);
		expect(out).toHaveLength(1);
		expect(out[0].usd).toBe(2);
	});

	it("settles a tie the same way whatever the order", () => {
		const a = pt("2026-11-22", 1, { dateModified: 5 });
		const b = pt("2026-11-22", 2, { dateModified: 5 });
		expect(readValuePoints([a, b])).toEqual(readValuePoints([b, a]));
	});

	it("reads a missing write time as 0 and copies nothing else", () => {
		const out = readValuePoints([{ day: "2026-11-22", usd: 1, eur: 2, cards: 3, extra: "x", __proto__: { bad: 1 } }]);
		expect(out).toEqual([{ day: "2026-11-22", usd: 1, eur: 2, cards: 3, dateModified: 0 }]);
	});

	it("never returns more than the last 5000 days", () => {
		const raw: ValuePoint[] = [];
		const start = Date.UTC(2000, 0, 1);
		for (let i = 0; i < 5200; i++) {
			const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
			raw.push(pt(d, i));
		}
		const out = readValuePoints(raw);
		expect(out).toHaveLength(5000);
		expect(out[out.length - 1].usd).toBe(5199);
	});
});

describe("mergeValueHistories (a restored backup)", () => {
	it("keeps what was recorded since the backup and adds the days only the backup knows", () => {
		const current = [pt("2026-11-20", 20), pt("2026-11-21", 21)];
		const backup = [pt("2026-11-10", 10), pt("2026-11-20", 99, { dateModified: 1 })];
		const out = mergeValueHistories(current, backup);
		expect(out.map((p) => [p.day, p.usd])).toEqual([
			["2026-11-10", 10],
			["2026-11-20", 20],
			["2026-11-21", 21],
		]);
	});

	it("is the same whichever way round", () => {
		const a = [pt("2026-11-20", 1, { dateModified: 3 }), pt("2026-11-21", 5)];
		const b = [pt("2026-11-20", 2, { dateModified: 3 }), pt("2026-11-22", 6)];
		expect(mergeValueHistories(a, b)).toEqual(mergeValueHistories(b, a));
	});

	it("takes either side being missing", () => {
		expect(mergeValueHistories(undefined, [pt("2026-11-20", 1)])).toHaveLength(1);
		expect(mergeValueHistories([pt("2026-11-20", 1)], undefined)).toHaveLength(1);
		expect(mergeValueHistories(undefined, undefined)).toEqual([]);
	});
});

describe("seriesForPeriod", () => {
	const now = at("2026-11-22");
	const live = { usd: 500, eur: 450, cards: 77 };
	const recorded = [pt("2025-10-01", 1), pt("2026-08-01", 2), pt("2026-10-01", 3), pt("2026-11-01", 4), pt("2026-11-22", 99)];

	it("ends on the LIVE total, which replaces today's recorded point", () => {
		const s = seriesForPeriod(recorded, live, "all", now);
		const last = s[s.length - 1];
		expect(last).toMatchObject({ day: "2026-11-22", usd: 500, eur: 450, cards: 77 });
		expect(s.filter((p) => p.day === "2026-11-22")).toHaveLength(1);
	});

	it("cuts each period at its length", () => {
		expect(seriesForPeriod(recorded, live, "30d", now).map((p) => p.day)).toEqual(["2026-11-01", "2026-11-22"]);
		expect(seriesForPeriod(recorded, live, "90d", now).map((p) => p.day)).toEqual(["2026-10-01", "2026-11-01", "2026-11-22"]);
		// 2025-10-01 is 417 days back: past a year.
		expect(seriesForPeriod(recorded, live, "1y", now).map((p) => p.day)).toEqual(["2026-08-01", "2026-10-01", "2026-11-01", "2026-11-22"]);
		expect(seriesForPeriod(recorded, live, "all", now)).toHaveLength(5);
	});

	it("includes the day exactly one period back", () => {
		const s = seriesForPeriod([pt("2026-10-23", 1)], live, "30d", now);
		expect(s.map((p) => p.day)).toEqual(["2026-10-23", "2026-11-22"]);
		const t = seriesForPeriod([pt("2026-10-22", 1)], live, "30d", now);
		expect(t.map((p) => p.day)).toEqual(["2026-11-22"]);
	});

	it("is a lone live point with no history, and nothing for an empty collection", () => {
		expect(seriesForPeriod([], live, "90d", now).map((p) => p.day)).toEqual(["2026-11-22"]);
		expect(seriesForPeriod([], { usd: 0, eur: 0, cards: 0 }, "90d", now)).toEqual([]);
	});

	it("does not touch what it is given", () => {
		const input = [pt("2026-11-22", 99)];
		seriesForPeriod(input, live, "all", now);
		expect(input[0].usd).toBe(99);
	});
});

describe("valueChange", () => {
	const s = [pt("2026-10-01", 100), pt("2026-11-01", 90), pt("2026-11-22", 125)];

	it("goes from the first point to the last, in the asked currency", () => {
		expect(valueChange(s, "usd")).toEqual({ amount: 25, percent: 25, since: "2026-10-01" });
		const eur = valueChange(s, "eur")!;
		expect(eur.amount).toBe(22.5);
		expect(eur.percent).toBeCloseTo(25, 5);
	});

	it("is negative for a fall", () => {
		const c = valueChange([pt("2026-10-01", 200), pt("2026-11-01", 150)], "usd")!;
		expect(c.amount).toBe(-50);
		expect(c.percent).toBe(-25);
	});

	it("has no percentage from a zero start, and no change under two points", () => {
		expect(valueChange([pt("2026-10-01", 0), pt("2026-11-01", 5)], "usd")!.percent).toBeNull();
		expect(valueChange([pt("2026-10-01", 5)], "usd")).toBeNull();
		expect(valueChange([], "usd")).toBeNull();
	});

	it("reads the currency it is asked for", () => {
		expect(valueIn({ usd: 1, eur: 2, cards: 0 }, "usd")).toBe(1);
		expect(valueIn({ usd: 1, eur: 2, cards: 0 }, "eur")).toBe(2);
	});
});

describe("valueBounds", () => {
	it("does not start at zero and leaves room around the curve", () => {
		const b = valueBounds([1000, 1100]);
		expect(b.min).toBeGreaterThan(900);
		expect(b.min).toBeLessThan(1000);
		expect(b.max).toBeGreaterThan(1100);
	});

	it("never goes below zero", () => {
		expect(valueBounds([0, 1]).min).toBe(0);
	});

	it("gives a flat curve a range anyway", () => {
		const b = valueBounds([500, 500, 500]);
		expect(b.max).toBeGreaterThan(b.min);
	});

	it("has a default for no values", () => {
		expect(valueBounds([])).toEqual({ min: 0, max: 1 });
	});
});

describe("labels", () => {
	it("formats compact amounts", () => {
		expect(formatCompactMoney(87.4, "usd")).toBe("$87");
		expect(formatCompactMoney(1234, "usd")).toBe("$1.2k");
		expect(formatCompactMoney(1000, "eur")).toBe("€1k");
		expect(formatCompactMoney(18_700, "usd")).toBe("$19k");
		expect(formatCompactMoney(1_234_000, "eur")).toBe("€1.23M");
		expect(formatCompactMoney(0, "usd")).toBe("$0");
	});

	it("formats a day without letting the timezone move it", () => {
		expect(formatDayLabel("2026-11-22")).toBe("Nov 22");
		expect(formatDayLabel("2026-01-01", true)).toBe("Jan 1, 2026");
		expect(formatDayLabel("garbage")).toBe("garbage");
	});

	it("puts the year on the axis only when it matters", () => {
		expect(seriesNeedsYear([pt("2026-09-01", 1), pt("2026-11-22", 2)])).toBe(false);
		expect(seriesNeedsYear([pt("2025-12-30", 1), pt("2026-01-02", 2)])).toBe(true);
		expect(seriesNeedsYear([pt("2026-01-01", 1), pt("2026-12-31", 2)])).toBe(true);
		expect(seriesNeedsYear([pt("2026-01-01", 1)])).toBe(false);
	});
});
