import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({}));
vi.mock("../view", () => ({ MTGCollectionView: class {} }));
vi.mock("../api/scryfall", () => ({ fetchScryfallCollection: vi.fn() }));

import { fetchScryfallCollection } from "../api/scryfall";
import * as priceRefresh from "./price-refresh";
import * as valueHistory from "./value-history";
import { colCard, makePlugin, saves, scry } from "./__tests__/plugin-harness";

const prices = (usd: string, eur: string) => scry("s1", { prices: { usd, eur } });

describe("refreshAllPrices and the value history", () => {
	beforeEach(() => {
		vi.mocked(fetchScryfallCollection).mockReset();
	});

	it("records the day's point from the prices it has just applied, and saves once", async () => {
		vi.mocked(fetchScryfallCollection).mockResolvedValue(new Map([["s1", prices("2.00", "1.50")]]));
		const plugin = makePlugin([priceRefresh, valueHistory], {
			collection: [colCard({ id: "a", scryfallId: "s1", priceUsd: "0.10", priceEur: "0.09", count: 4 })],
		});
		await plugin.refreshAllPrices();
		const history = plugin.settings.valueHistory!;
		expect(history).toHaveLength(1);
		// 4 copies at the NEW prices, not the old ones.
		expect(history[0]).toMatchObject({ usd: 8, eur: 6, cards: 4 });
		expect(saves(plugin)).toBe(1);
	});

	it("a refresh that finds nothing new the same day leaves the history as it was", async () => {
		vi.mocked(fetchScryfallCollection).mockResolvedValue(new Map([["s1", prices("2.00", "1.50")]]));
		const plugin = makePlugin([priceRefresh, valueHistory], { collection: [colCard({ id: "a", scryfallId: "s1", count: 1 })] });
		await plugin.refreshAllPrices();
		const first = JSON.stringify(plugin.settings.valueHistory);
		await plugin.refreshAllPrices();
		expect(JSON.stringify(plugin.settings.valueHistory)).toBe(first);
	});

	it("an empty collection fetches nothing and records nothing", async () => {
		const plugin = makePlugin([priceRefresh, valueHistory], { collection: [] });
		await plugin.refreshAllPrices();
		expect(fetchScryfallCollection).not.toHaveBeenCalled();
		expect(plugin.settings.valueHistory).toBeUndefined();
	});
});
