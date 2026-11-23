import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({}));

import * as valueHistory from "./value-history";
import { colCard, makePlugin, saves } from "./__tests__/plugin-harness";
import { localDayKey, type ValuePoint } from "../core/value-history";

// Noon: no timezone moves the calendar day.
const at = (day: string): number => new Date(`${day}T12:00:00`).getTime();

const plugin = (settings: Record<string, unknown> = {}) =>
	makePlugin([valueHistory], {
		collection: [colCard({ id: "a", priceUsd: "10.00", priceEur: "9.00", count: 2 }), colCard({ id: "b", scryfallId: "s2", priceUsd: "1.00", priceEur: "0.80", count: 3 })],
		...settings,
	});

afterEach(() => vi.useRealTimers());

describe("recordCollectionValue", () => {
	it("writes today's point from the prices the cards carry, creating the history", () => {
		const p = plugin();
		expect(p.settings.valueHistory).toBeUndefined();
		const now = at("2026-11-22");
		expect(p.recordCollectionValue(now)).toBe(true);
		expect(p.settings.valueHistory).toEqual([{ day: "2026-11-22", usd: 23, eur: 20.4, cards: 5, dateModified: now }]);
	});

	it("does not save by itself (the price refresh saves once)", () => {
		const p = plugin();
		p.recordCollectionValue(at("2026-11-22"));
		expect(saves(p)).toBe(0);
	});

	it("a second refresh the same day with the same prices changes nothing", () => {
		const p = plugin();
		const now = at("2026-11-22");
		p.recordCollectionValue(now);
		const before = JSON.stringify(p.settings.valueHistory);
		expect(p.recordCollectionValue(now + 3_600_000)).toBe(false);
		expect(JSON.stringify(p.settings.valueHistory)).toBe(before);
	});

	it("a second refresh the same day with new prices rewrites that day only", () => {
		const p = plugin();
		p.recordCollectionValue(at("2026-11-21"));
		p.recordCollectionValue(at("2026-11-22"));
		p.settings.collection[0].priceUsd = "20.00";
		expect(p.recordCollectionValue(at("2026-11-22") + 60_000)).toBe(true);
		const h = p.settings.valueHistory as ValuePoint[];
		expect(h.map((x) => [x.day, x.usd])).toEqual([
			["2026-11-21", 23],
			["2026-11-22", 43],
		]);
	});

	it("writes nothing for an empty collection", () => {
		const p = plugin({ collection: [] });
		expect(p.recordCollectionValue(at("2026-11-22"))).toBe(false);
		expect(p.settings.valueHistory).toBeUndefined();
	});

	it("takes the local calendar day of the moment", () => {
		const p = plugin();
		const late = new Date(2026, 10, 22, 23, 50).getTime();
		p.recordCollectionValue(late);
		expect(p.settings.valueHistory?.[0].day).toBe(localDayKey(late));
		expect(p.settings.valueHistory?.[0].day).toBe("2026-11-22");
	});

	it("survives a history that came from a file with junk in it, and does not copy the junk on", () => {
		const p = plugin({ valueHistory: [null, 42, { day: "2026-11-20", usd: 5, eur: 4, cards: 1, dateModified: 1 }, { day: "bad" }] });
		expect(p.recordCollectionValue(at("2026-11-22"))).toBe(true);
		expect((p.settings.valueHistory as ValuePoint[]).map((x) => x.day)).toEqual(["2026-11-20", "2026-11-22"]);
	});

	it("survives a history that is not even an array", () => {
		const p = plugin({ valueHistory: { oops: true } });
		expect(p.recordCollectionValue(at("2026-11-22"))).toBe(true);
		expect(p.settings.valueHistory).toHaveLength(1);
	});
});

describe("seedValueHistory", () => {
	it("gives the day of the last price refresh its point, from the prices already stored", () => {
		const refreshed = at("2026-11-21");
		const p = plugin({ lastPriceRefresh: refreshed });
		expect(p.seedValueHistory(at("2026-11-22"))).toBe(true);
		expect(p.settings.valueHistory).toEqual([{ day: "2026-11-21", usd: 23, eur: 20.4, cards: 5, dateModified: at("2026-11-22") }]);
		expect(saves(p)).toBe(1);
	});

	it("does nothing once a point exists, so it never runs twice", () => {
		const p = plugin({ lastPriceRefresh: at("2026-11-21") });
		p.seedValueHistory(at("2026-11-22"));
		expect(p.seedValueHistory(at("2026-11-23"))).toBe(false);
		expect(saves(p)).toBe(1);
		expect(p.settings.valueHistory).toHaveLength(1);
	});

	it("does nothing on a device that already received a history from another one", () => {
		const received = [{ day: "2026-10-01", usd: 1, eur: 1, cards: 1, dateModified: 1 }];
		const p = plugin({ lastPriceRefresh: at("2026-11-21"), valueHistory: received });
		expect(p.seedValueHistory(at("2026-11-22"))).toBe(false);
		expect(p.settings.valueHistory).toEqual(received);
		expect(saves(p)).toBe(0);
	});

	it("does nothing for a collection that was never refreshed, or an empty one", () => {
		expect(plugin({ lastPriceRefresh: 0 }).seedValueHistory(at("2026-11-22"))).toBe(false);
		const empty = plugin({ lastPriceRefresh: at("2026-11-21"), collection: [] });
		expect(empty.seedValueHistory(at("2026-11-22"))).toBe(false);
		expect(empty.settings.valueHistory).toBeUndefined();
		expect(saves(empty)).toBe(0);
	});

	it("replaces a history that holds nothing readable", () => {
		const p = plugin({ lastPriceRefresh: at("2026-11-21"), valueHistory: [{ day: "bad" }] });
		expect(p.seedValueHistory(at("2026-11-22"))).toBe(true);
		expect(p.settings.valueHistory).toHaveLength(1);
	});
});
