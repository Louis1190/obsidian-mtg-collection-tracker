import { describe, it, expect } from "vitest";
import {
	cardsInDeckStatsScope,
	computeManaCurve,
	computeColorBreakdown,
	computeTypeBreakdown,
	computeRarityBreakdown,
	deckMinimumSize,
	getDeckSizeStatus,
	totalStatsCardCount,
} from "./deck-stats";
import type { DeckCard } from "./data-model";

let idCounter = 0;
function makeDeckCard(overrides: Partial<DeckCard> = {}): DeckCard {
	idCounter += 1;
	return {
		scryfallId: `scry${idCounter}`,
		name: `Card ${idCounter}`,
		setCode: "abc",
		setName: "A Set",
		collectorNumber: String(idCounter),
		imageUrl: "",
		artCropUrl: "",
		manaCost: "",
		manaValue: 0,
		typeLine: "Creature — Human",
		rarity: "common",
		artist: "",
		colors: [],
		keywords: [],
		count: 1,
		dateAdded: 0,
		dateModified: 0,
		...overrides,
	};
}

describe("cardsInDeckStatsScope", () => {
	it("keeps mainboard (including the Commander, itself always mainboard), excludes sideboard/maybeboard", () => {
		// Commander is a Function (deckFunctionOverride), not a category, since
		// 2026-09-07 — a Commander card is therefore already, structurally,
		// categorized "mainboard" like the others.
		const cards = [
			makeDeckCard({ name: "Main" }), // category absent = mainboard
			makeDeckCard({ name: "Main2", category: "mainboard" }),
			makeDeckCard({ name: "Cmd", deckFunctionOverride: "Commander" }),
			makeDeckCard({ name: "SB", category: "sideboard" }),
			makeDeckCard({ name: "MB", category: "maybeboard" }),
		];
		const scoped = cardsInDeckStatsScope(cards).map((c) => c.name);
		expect(scoped).toEqual(["Main", "Main2", "Cmd"]);
	});
});

describe("computeManaCurve", () => {
	it("excludes lands entirely", () => {
		const cards = [
			makeDeckCard({ typeLine: "Land", manaValue: 0, count: 17 }),
			makeDeckCard({ typeLine: "Creature", manaValue: 2, count: 1 }),
		];
		const curve = computeManaCurve(cards);
		expect(curve.find((b) => b.cmc === 0)?.count).toBe(0);
		expect(curve.find((b) => b.cmc === 2)?.count).toBe(1);
	});

	it("buckets everything above 6 into a 7+ bucket", () => {
		const cards = [makeDeckCard({ typeLine: "Creature", manaValue: 9, count: 2 })];
		const curve = computeManaCurve(cards);
		const bucket7 = curve.find((b) => b.cmc === 7);
		expect(bucket7?.label).toBe("7+");
		expect(bucket7?.count).toBe(2);
	});

	it("weighs by count, not by number of distinct entries", () => {
		const cards = [makeDeckCard({ typeLine: "Instant", manaValue: 1, count: 4 })];
		const curve = computeManaCurve(cards);
		expect(curve.find((b) => b.cmc === 1)?.count).toBe(4);
	});

	it("always returns all 8 buckets (0 through 7+), even when empty", () => {
		expect(computeManaCurve([])).toHaveLength(8);
	});
});

describe("computeColorBreakdown", () => {
	it("buckets a land as Land, a colorless nonland as Colorless, a single color by name, and 2+ colors as Multicolor", () => {
		const cards = [
			makeDeckCard({ typeLine: "Land", colors: [] }),
			makeDeckCard({ typeLine: "Artifact", colors: [] }),
			makeDeckCard({ typeLine: "Creature", colors: ["G"] }),
			makeDeckCard({ typeLine: "Creature", colors: ["U", "R"] }),
		];
		const breakdown = computeColorBreakdown(cards);
		const byLabel = Object.fromEntries(breakdown.map((s) => [s.label, s.count]));
		expect(byLabel).toEqual({ Green: 1, Multicolor: 1, Colorless: 1, Land: 1 });
	});

	it("weighs by count and orders slices canonically (WUBRG, Multicolor, Colorless, Land)", () => {
		const cards = [
			makeDeckCard({ typeLine: "Land", colors: [], count: 17 }),
			makeDeckCard({ typeLine: "Creature", colors: ["R"], count: 5 }),
			makeDeckCard({ typeLine: "Creature", colors: ["W"], count: 3 }),
		];
		const breakdown = computeColorBreakdown(cards);
		expect(breakdown.map((s) => s.label)).toEqual(["White", "Red", "Land"]);
		expect(breakdown.find((s) => s.label === "Red")?.count).toBe(5);
	});

	it("attaches the established GROUP_LABEL_HEX color for each slice", () => {
		const cards = [makeDeckCard({ typeLine: "Creature", colors: ["U"] })];
		const breakdown = computeColorBreakdown(cards);
		expect(breakdown[0].color).toBe("#4a90d9");
	});
});

describe("computeTypeBreakdown", () => {
	it("buckets under the primary type and weighs by count", () => {
		const cards = [
			makeDeckCard({ typeLine: "Legendary Creature — Human Wizard", count: 2 }),
			makeDeckCard({ typeLine: "Instant", count: 1 }),
			makeDeckCard({ typeLine: "Basic Land — Forest", count: 17 }),
		];
		const breakdown = computeTypeBreakdown(cards);
		const byLabel = Object.fromEntries(breakdown.map((s) => [s.label, s.count]));
		expect(byLabel).toEqual({ Creature: 2, Instant: 1, Land: 17 });
	});

	it("sorts by descending count", () => {
		const cards = [
			makeDeckCard({ typeLine: "Instant", count: 1 }),
			makeDeckCard({ typeLine: "Land", count: 17 }),
			makeDeckCard({ typeLine: "Creature", count: 5 }),
		];
		const breakdown = computeTypeBreakdown(cards);
		expect(breakdown.map((s) => s.label)).toEqual(["Land", "Creature", "Instant"]);
	});
});

describe("totalStatsCardCount", () => {
	it("sums count across all cards", () => {
		expect(totalStatsCardCount([makeDeckCard({ count: 3 }), makeDeckCard({ count: 4 })])).toBe(7);
	});

	it("is 0 for an empty array", () => {
		expect(totalStatsCardCount([])).toBe(0);
	});
});

describe("computeRarityBreakdown", () => {
	it("buckets by rarity and weighs by count", () => {
		const cards = [
			makeDeckCard({ rarity: "common", count: 17 }),
			makeDeckCard({ rarity: "rare", count: 2 }),
			makeDeckCard({ rarity: "mythic", count: 1 }),
		];
		const breakdown = computeRarityBreakdown(cards);
		const byLabel = Object.fromEntries(breakdown.map((s) => [s.label, s.count]));
		expect(byLabel).toEqual({ Common: 17, Rare: 2, Mythic: 1 });
	});

	it("orders slices common to mythic (RARITY_ORDER), not by descending count", () => {
		const cards = [
			makeDeckCard({ rarity: "mythic", count: 1 }),
			makeDeckCard({ rarity: "common", count: 17 }),
			makeDeckCard({ rarity: "rare", count: 2 }),
		];
		const breakdown = computeRarityBreakdown(cards);
		expect(breakdown.map((s) => s.label)).toEqual(["Common", "Rare", "Mythic"]);
	});

	it("treats a missing/uppercase rarity as lowercase common", () => {
		const cards = [makeDeckCard({ rarity: "", count: 1 }), makeDeckCard({ rarity: "COMMON", count: 2 })];
		const breakdown = computeRarityBreakdown(cards);
		expect(breakdown).toEqual([{ label: "Common", count: 3, color: "#9a9a9a" }]);
	});
});

describe("deckMinimumSize", () => {
	it("is 100 for Commander-like formats", () => {
		expect(deckMinimumSize("commander")).toBe(100);
		expect(deckMinimumSize("duel")).toBe(100);
		expect(deckMinimumSize("paupercommander")).toBe(100);
		expect(deckMinimumSize("predh")).toBe(100);
	});

	it("is 60 for any other format, or when the format is unset", () => {
		expect(deckMinimumSize("modern")).toBe(60);
		expect(deckMinimumSize(undefined)).toBe(60);
	});
});

describe("getDeckSizeStatus", () => {
	it("flags a Commander deck under 100 mainboard cards as below minimum", () => {
		const deck = { format: "commander", cards: [makeDeckCard({ count: 42 })] };
		const status = getDeckSizeStatus(deck);
		expect(status).toEqual({ mainboardCount: 42, minimum: 100, isBelowMinimum: true });
	});

	it("does not count sideboard/maybeboard cards toward the total", () => {
		const deck = {
			format: undefined,
			cards: [makeDeckCard({ count: 59 }), makeDeckCard({ count: 5, category: "sideboard" })],
		};
		const status = getDeckSizeStatus(deck);
		expect(status).toEqual({ mainboardCount: 59, minimum: 60, isBelowMinimum: true });
	});

	it("is not below minimum once the mainboard reaches the threshold", () => {
		const deck = { format: undefined, cards: [makeDeckCard({ count: 60 })] };
		expect(getDeckSizeStatus(deck).isBelowMinimum).toBe(false);
	});
});
