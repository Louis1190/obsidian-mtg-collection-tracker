import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// cardbase.ts imports Obsidian's requestUrl at load; nothing here makes a request.
vi.mock("obsidian", () => ({ requestUrl: async () => ({ status: 500 }) }));

import { getCardbaseDayChange, getCardbaseLatestPrice } from "../api/cardbase";
import {
	buildPriceHistory,
	dateOfDay,
	dayOfDate,
	decodeRecord,
	parseShard,
	type PriceHistoryShard,
	type SeriesRecord,
} from "./price-history";

// Written by tools/price-history/golden.mjs with the TOOL's codec: 100 series (a single point, flat, holes, zero
// prices, 91 days, big prices) next to the points each must decode to. tools/ is never imported from src/, so this
// file is what keeps the plugin's TypeScript decoder and the tool's from drifting apart.
const golden = JSON.parse(readFileSync(new URL("./price-history.golden.json", import.meta.url), "utf8")) as {
	record: SeriesRecord;
	points: [number, number][];
}[];

describe("decodeRecord", () => {
	it("decodes every series the tool encoded, point for point", () => {
		expect(golden.length).toBeGreaterThanOrEqual(100);
		const wrong = golden.filter((g) => JSON.stringify(decodeRecord(g.record)) !== JSON.stringify(g.points));
		expect(wrong).toEqual([]);
	});

	it("keeps a hole a hole: no price on the missing days, and the price comes back after it", () => {
		// 100: 150, 101: 150, 102-103: nothing, 104: 150 again, end 104
		const rec: SeriesRecord = [100, 104, [0, 150], [2, null], [4, 150]];
		expect(decodeRecord(rec)).toEqual([[100, 150], [101, 150], [104, 150]]);
	});

	it("a free card (price 0) is a price, not a hole", () => {
		expect(decodeRecord([100, 101, [0, 0]])).toEqual([[100, 0], [101, 0]]);
	});

	it("days stop at `end`: later days have no data", () => {
		expect(decodeRecord([100, 102, [0, 5], [1, 7]])).toEqual([[100, 5], [101, 7], [102, 7]]);
	});
});

describe("day conversions", () => {
	it("round-trip, and match the tool (2026-10-13 is day 20739)", () => {
		expect(dayOfDate("2026-10-13")).toBe(20739);
		expect(dateOfDay(20739)).toBe("2026-10-13");
		expect(dateOfDay(dayOfDate("2024-02-29"))).toBe("2024-02-29");
	});
});

describe("parseShard", () => {
	const card = { "ck.n": [20700, 20700, [0, 100]] };
	it("reads a shard of the format we know", () => {
		const shard = parseShard({ _: { v: 1, asOf: "2026-10-13" }, abc: card });
		expect(shard?.asOf).toBe("2026-10-13");
		expect(Object.keys(shard?.cards ?? {})).toEqual(["abc"]);
	});
	it("refuses what it cannot read, instead of guessing", () => {
		expect(parseShard({ abc: card })).toBeUndefined(); // no header
		expect(parseShard({ _: { v: 2, asOf: "2026-10-13" }, abc: card })).toBeUndefined(); // a newer format
		expect(parseShard({ _: { v: 1, asOf: "yesterday" }, abc: card })).toBeUndefined();
		expect(parseShard({ _: { v: 1 }, abc: card })).toBeUndefined();
		expect(parseShard({ _: "x" })).toBeUndefined();
		expect(parseShard(null)).toBeUndefined();
		expect(parseShard([])).toBeUndefined();
		expect(parseShard("text")).toBeUndefined();
	});
});

describe("buildPriceHistory", () => {
	const asOf = "2026-10-13"; // day 20739
	const shard: PriceHistoryShard = {
		asOf,
		cards: {
			sid1: {
				// Card Kingdom: 3 days, price moves yesterday -> today
				"ck.n": [20737, 20739, [0, 100], [2, 125]],
				// TCGplayer: stopped 3 days before the as-of day
				"tcg.n": [20700, 20736, [0, 200], [10, 250]],
				// Cardmarket (EUR), live, and a foil series
				"cm.n": [20738, 20739, [0, 1000], [1, 1100]],
				"cm.f": [20738, 20739, [0, 5000]],
				// Mana Pool is in the files but has no curve
				"mp.n": [20738, 20739, [0, 90]],
				// Damaged: must be ignored, not crash
				"ck.f": "garbage" as unknown as SeriesRecord,
			},
			onlyFoil: { "ck.f": [20739, 20739, [0, 700]] },
		},
	};

	it("builds the shape the chart and the price columns read, vendor by vendor", () => {
		const h = buildPriceHistory(shard, "sid1", "normal")!;
		expect(h.scryfallId).toBe("sid1");
		expect(h.source).toBe("price-history");
		expect(h.asOf).toBe("2026-10-13");
		expect(h.historyBegins).toBe(dateOfDay(20700));
		expect(h.series.map((s) => [s.vendor, s.currency, s.finish])).toEqual([
			["cardkingdom", "USD", "normal"],
			["tcgplayer", "USD", "normal"],
			["cardmarket", "EUR", "normal"],
		]);
		const ck = h.series[0];
		expect(ck.points).toEqual([
			{ date: "2026-10-11", price: 1 },
			{ date: "2026-10-12", price: 1 },
			{ date: "2026-10-13", price: 1.25 },
		]);
	});

	it("picks the series of the requested finish only", () => {
		const foil = buildPriceHistory(shard, "sid1", "foil")!;
		expect(foil.series.map((s) => s.vendor)).toEqual(["cardmarket"]);
		expect(foil.series[0].points.at(-1)?.price).toBe(50);
		expect(buildPriceHistory(shard, "sid1", "etched")).toBeUndefined();
	});

	it("says which series are still a current price: a vendor that stopped listing days ago is history only", () => {
		const h = buildPriceHistory(shard, "sid1", "normal")!;
		expect(h.series.map((s) => [s.vendor, s.live])).toEqual([
			["cardkingdom", true],
			["tcgplayer", false],
			["cardmarket", true],
		]);
		// ... and the readers of the price columns respect it
		expect(getCardbaseLatestPrice(h, "tcgplayer")).toBeUndefined();
		expect(getCardbaseDayChange(h, "tcgplayer")).toBeUndefined();
		expect(getCardbaseLatestPrice(h, "cardkingdom")).toEqual({ price: 1.25, currency: "USD" });
		expect(getCardbaseDayChange(h, "cardkingdom")?.direction).toBe("up");
		expect(getCardbaseLatestPrice(h, "cardmarket")).toEqual({ price: 11, currency: "EUR" });
	});

	it("a vendor one day behind (MTGJSON lag) still counts as current", () => {
		const lag: PriceHistoryShard = { asOf, cards: { c: { "cm.n": [20730, 20738, [0, 100]] } } };
		expect(buildPriceHistory(lag, "c", "normal")!.series[0].live).toBe(true);
		const late: PriceHistoryShard = { asOf, cards: { c: { "cm.n": [20730, 20737, [0, 100]] } } };
		expect(buildPriceHistory(late, "c", "normal")!.series[0].live).toBe(false);
	});

	it("is undefined for a card the shard does not hold, so the caller can ask cardbase", () => {
		expect(buildPriceHistory(shard, "nope", "normal")).toBeUndefined();
	});

	it("answers exactly the finish it is asked: a foil-only printing is asked as a foil by the callers (effectiveFinish, core/price.ts), not guessed here", () => {
		expect(buildPriceHistory(shard, "onlyFoil", "normal")).toBeUndefined();
		expect(buildPriceHistory(shard, "onlyFoil", "foil")!.series.map((s) => [s.vendor, s.finish])).toEqual([["cardkingdom", "foil"]]);
		expect(buildPriceHistory(shard, "onlyFoil", "etched")).toBeUndefined();
	});

	it("does not touch the behaviour of cardbase's own histories (no `live` flag = as before)", () => {
		const cardbase = {
			scryfallId: "x",
			series: [{ vendor: "tcgplayer" as const, finish: "normal" as const, currency: "USD", points: [{ date: "2026-09-08", price: 2 }, { date: "2026-09-09", price: 3 }] }],
		};
		expect(getCardbaseLatestPrice(cardbase, "tcgplayer")).toEqual({ price: 3, currency: "USD" });
		expect(getCardbaseDayChange(cardbase, "tcgplayer")).toEqual({ changePct: 50, direction: "up" });
	});
});

// Written by tools/price-history/golden.mjs: one shard file exactly as the tool writes it, header with `newDays` included.
const goldenShard = JSON.parse(readFileSync(new URL("./price-history-shard.golden.json", import.meta.url), "utf8")) as unknown;

describe("the vendors' latest real day (newDays)", () => {
	const D = dayOfDate("2026-10-13"); // 20739
	// Cardmarket repeated 10-12 on 10-13: its price rose by 100 every day up to 10-12 (1600 on the 11th, 1700 on the 12th), and the 13th is the
	// 12th again, for this card as for every card. Eight days of history, so that "N days ago" always has a price.
	const staircase: SeriesRecord = [D - 8, D, ...Array.from({ length: 8 }, (_, k) => [k, 1000 + 100 * k] as [number, number])];
	const repeated = (extra: Record<string, unknown> = {}): PriceHistoryShard => ({
		asOf: "2026-10-13",
		newDays: { cm: D - 1, tcg: D, ck: D },
		cards: {
			c: {
				"cm.n": staircase,
				"tcg.n": [D - 3, D, [0, 200], [3, 250]], // moved today
				"ck.n": [D - 3, D, [0, 300]], // flat
				...extra,
			},
		},
	});
	const change = (shard: PriceHistoryShard, vendor: "cardmarket" | "tcgplayer" | "cardkingdom", id = "c") => getCardbaseDayChange(buildPriceHistory(shard, id, "normal"), vendor);

	it("reads the change at the vendor's last real day, not on the repeated one", () => {
		const r = change(repeated(), "cardmarket");
		expect(r?.direction).toBe("up");
		expect(r?.changePct).toBeCloseTo(6.25, 5); // 1600 -> 1700
		// A vendor that did move today is read today, as before.
		expect(change(repeated(), "tcgplayer")?.changePct).toBeCloseTo(25, 5);
		expect(change(repeated(), "cardkingdom")?.direction).toBe("flat");
	});

	it("is what the badge used to miss: without the file saying so, the last two points are identical", () => {
		const { newDays: _ignored, ...old } = repeated();
		expect(change(old, "cardmarket")?.direction).toBe("flat");
		const h = buildPriceHistory(old, "c", "normal")!;
		expect(h.series.every((s) => !("dayChange" in s))).toBe(true);
	});

	it("shows nothing once the vendor's list has not really moved for 3 days (not \"since yesterday\" any more), still something at 2", () => {
		expect(change({ ...repeated(), newDays: { cm: D - 2, tcg: D, ck: D } }, "cardmarket")?.changePct).toBeCloseTo((100 / 1500) * 100, 5);
		expect(change({ ...repeated(), newDays: { cm: D - 3, tcg: D, ck: D } }, "cardmarket")).toBeUndefined();
		expect(change({ ...repeated(), newDays: { cm: D - 5, tcg: D, ck: D } }, "cardmarket")).toBeUndefined();
	});

	it("needs a price the day before: a card relisted today has no yesterday, and is not compared with last week", () => {
		const relisted = repeated({ "ck.n": [D - 5, D, [0, 100], [2, null], [5, 150]] }); // listed until D-4, back on D
		expect(change(relisted, "cardkingdom")).toBeUndefined();
		expect(buildPriceHistory(relisted, "c", "normal")?.series.find((x) => x.vendor === "cardkingdom")?.dayChange).toBeNull();
		// What the last two points would have said, and what the badge did before: +50 %.
		const { newDays: _ignored, ...old } = relisted;
		expect(change(old, "cardkingdom")?.changePct).toBeCloseTo(50, 5);
	});

	it("reads a card that DID move on the repeated day at the vendor's day too: under 2 % of a list moving does not make it a new day", () => {
		// 1700 on the 12th, 1900 on the 13th for this card alone: the badge still says 1600 -> 1700, as for every other card of that list.
		const moved = repeated({ "cm.n": [D - 8, D, ...Array.from({ length: 8 }, (_, k) => [k, 1000 + 100 * k] as [number, number]), [8, 1900]] });
		expect(change(moved, "cardmarket")?.changePct).toBeCloseTo(6.25, 5);
	});

	it("looks through a day MTGJSON published nothing: the day after it is still compared with the day before it", () => {
		// 1000, 1100, 1200 (D-5..D-3, 1200 still D-2), nothing on D-1 (the gap), 1500 on D: the change is 1200 -> 1500.
		const gap = (days: number) => ({ asOf: "2026-10-13", newDays: { cm: D, tcg: D, ck: D }, cards: { c: { "cm.n": [D - 5, D, [0, 1000], [1, 1100], [2, 1200], [5 - days, null], [5, 1500]] as SeriesRecord } } }) as PriceHistoryShard;
		expect(change(gap(1), "cardmarket")?.changePct).toBeCloseTo(25, 5);
		// A gap of 2 days (price 3 days before): still found. A gap of 3 days (4 days before): nothing, as for a card relisted today.
		const long = (hole: number) => ({ asOf: "2026-10-13", newDays: { cm: D, tcg: D, ck: D }, cards: { c: { "cm.n": [D - 5, D, [0, 1000], [5 - hole, null], [5, 1500]] as SeriesRecord } } }) as PriceHistoryShard;
		expect(change(long(2), "cardmarket")?.changePct).toBeCloseTo(50, 5);
		expect(change(long(3), "cardmarket")).toBeUndefined();
	});

	it("still says nothing for a series that is no longer a current price", () => {
		const stopped = repeated({ "tcg.n": [D - 9, D - 4, [0, 200], [3, 250]] });
		expect(change(stopped, "tcgplayer")).toBeUndefined();
	});

	it("leaves a vendor the file does not mention on the last two points", () => {
		const shard = { ...repeated(), newDays: { cm: D - 1 } };
		expect(change(shard, "tcgplayer")?.changePct).toBeCloseTo(25, 5);
		expect(change(shard, "cardmarket")?.changePct).toBeCloseTo(6.25, 5);
	});

	it("is read from the header: a known vendor, a real date, not later than the as-of day; anything else is ignored", () => {
		const parse = (newDays: unknown) => parseShard({ _: { v: 1, asOf: "2026-10-13", newDays }, c: {} })?.newDays;
		expect(parse({ cm: "2026-10-12", tcg: "2026-10-13", ck: "2026-10-08" })).toEqual({ cm: D - 1, tcg: D, ck: D - 5 });
		expect(parse({ cm: "2026-10-12", mp: "2026-10-12", xx: "2026-10-12" })).toEqual({ cm: D - 1 });
		expect(parse({ cm: "yesterday", tcg: 20738, ck: "2026-13-45" })).toBeUndefined();
		expect(parse({ cm: "2026-10-14" })).toBeUndefined(); // after the as-of day: impossible
		expect(parse({ cm: "2026-10-13" })).toEqual({ cm: D });
		for (const junk of [null, "cm", ["2026-10-12"], 12, {}, undefined]) expect(parse(junk)).toBeUndefined();
		// And the file itself is still read: a header without the field is today's format.
		expect(parseShard({ _: { v: 1, asOf: "2026-10-13" }, c: {} })?.asOf).toBe("2026-10-13");
	});

	it("reads the file exactly as the tool writes it", () => {
		const shard = parseShard(goldenShard);
		expect(shard?.asOf).toBe("2026-10-13");
		expect(shard?.newDays).toEqual({ cm: D - 1, tcg: D, ck: D - 5 });
		expect(Object.keys(shard?.cards ?? {})).toEqual(["card0"]);
	});
});

describe("getCardbaseDayChange on cardbase's own histories (no live flag, no dayChange: the last two points, as always)", () => {
	const hist = (points: number[], extra: Record<string, unknown> = {}) => ({
		scryfallId: "c",
		series: [{ vendor: "cardmarket" as const, finish: "normal" as const, currency: "EUR", points: points.map((price, i) => ({ date: `2026-10-0${i + 1}`, price })), ...extra }],
	});
	it("compares the last two points", () => {
		expect(getCardbaseDayChange(hist([10, 12, 15]), "cardmarket")).toEqual({ changePct: 25, direction: "up" });
		expect(getCardbaseDayChange(hist([10, 8]), "cardmarket")).toEqual({ changePct: -20, direction: "down" });
		expect(getCardbaseDayChange(hist([10, 10]), "cardmarket")).toEqual({ changePct: 0, direction: "flat" });
	});
	it("has nothing to say with fewer than two points, a price of 0 yesterday, another vendor, no history or a series that is no longer current", () => {
		expect(getCardbaseDayChange(hist([10]), "cardmarket")).toBeUndefined();
		expect(getCardbaseDayChange(hist([]), "cardmarket")).toBeUndefined();
		expect(getCardbaseDayChange(hist([0, 5]), "cardmarket")).toBeUndefined();
		expect(getCardbaseDayChange(hist([10, 12]), "tcgplayer")).toBeUndefined();
		expect(getCardbaseDayChange(undefined, "cardmarket")).toBeUndefined();
		expect(getCardbaseDayChange(hist([10, 12], { live: false }), "cardmarket")).toBeUndefined();
	});
});
