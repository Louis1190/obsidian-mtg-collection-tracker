import { describe, it, expect } from "vitest";
import {
	isDeckCardOwned,
	isDeckCommander,
	deckBoardTabMatches,
	DECK_BOARD_TABS,
	genId,
	DEFAULT_SETTINGS,
	DeckCard,
} from "./data-model";

function makeDeckCard(overrides: Partial<DeckCard> = {}): DeckCard {
	return {
		scryfallId: "abc",
		name: "Test Card",
		setCode: "tst",
		setName: "Test Set",
		collectorNumber: "1",
		imageUrl: "",
		artCropUrl: "",
		manaCost: "",
		manaValue: 0,
		typeLine: "",
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

describe("isDeckCardOwned", () => {
	it("is true when owned is explicitly true", () => {
		expect(isDeckCardOwned(makeDeckCard({ owned: true }))).toBe(true);
	});

	it("is false only when owned is explicitly false", () => {
		expect(isDeckCardOwned(makeDeckCard({ owned: false }))).toBe(false);
	});

	it("treats a missing owned field (pre-existing entries) as owned", () => {
		expect(isDeckCardOwned(makeDeckCard({ owned: undefined }))).toBe(true);
	});
});

describe("isDeckCommander", () => {
	// Commander is a Function (deckFunctionOverride), not a category, since
	// 2026-09-07 — never auto-detectable (no rule of detectDeckCardFunction
	// can guess "this is THE commander of THIS deck"), hence only through this
	// explicit manual designation.
	it("is true only when deckFunctionOverride is exactly 'Commander'", () => {
		expect(isDeckCommander(makeDeckCard({ deckFunctionOverride: "Commander" }))).toBe(true);
	});

	it("is false when deckFunctionOverride is absent, even for a category-'mainboard' card", () => {
		expect(isDeckCommander(makeDeckCard({ category: "mainboard" }))).toBe(false);
	});

	it("is false for any other Function value, including a real auto-detectable one", () => {
		expect(
			isDeckCommander(
				makeDeckCard({ typeLine: "Sorcery", oracleText: "Draw two cards." })
			)
		).toBe(false);
		expect(isDeckCommander(makeDeckCard({ deckFunctionOverride: "Ramp" }))).toBe(false);
	});
});

describe("deckBoardTabMatches", () => {
	it("matches a card's real category to the identically-named tab", () => {
		expect(deckBoardTabMatches(makeDeckCard({ category: "mainboard" }), "mainboard")).toBe(true);
		expect(deckBoardTabMatches(makeDeckCard({ category: "sideboard" }), "sideboard")).toBe(true);
		expect(deckBoardTabMatches(makeDeckCard({ category: "maybeboard" }), "maybeboard")).toBe(true);
	});

	it("never cross-matches a different board", () => {
		expect(deckBoardTabMatches(makeDeckCard({ category: "sideboard" }), "mainboard")).toBe(false);
		expect(deckBoardTabMatches(makeDeckCard({ category: "maybeboard" }), "sideboard")).toBe(false);
	});

	it("treats a missing category as mainboard, same as getDeckCardCategory's own default", () => {
		expect(deckBoardTabMatches(makeDeckCard({}), "mainboard")).toBe(true);
		expect(deckBoardTabMatches(makeDeckCard({}), "sideboard")).toBe(false);
	});

	// The Commander/Mainboard merge (explicitly confirmed) is already covered
	// for good by this case: a Commander is structurally a "mainboard"
	// category card (never a 4th value), so already covered by the "missing
	// category" test above and this one.
	it("matches a Commander card (deckFunctionOverride, still category mainboard) under the 'mainboard' tab", () => {
		const commander = makeDeckCard({ deckFunctionOverride: "Commander" });
		expect(deckBoardTabMatches(commander, "mainboard")).toBe(true);
		expect(deckBoardTabMatches(commander, "sideboard")).toBe(false);
	});
});

describe("DECK_BOARD_TABS", () => {
	it("offers exactly the 3 real boards, Commander not among them", () => {
		expect(DECK_BOARD_TABS.map((t) => t.value)).toEqual(["mainboard", "sideboard", "maybeboard"]);
	});
});

describe("genId", () => {
	it("returns a non-empty string", () => {
		expect(typeof genId()).toBe("string");
		expect(genId().length).toBeGreaterThan(0);
	});

	it("returns a different id on each call", () => {
		const ids = new Set(Array.from({ length: 50 }, () => genId()));
		expect(ids.size).toBe(50);
	});
});

describe("DEFAULT_SETTINGS", () => {
	it("starts with empty collections and lists", () => {
		expect(DEFAULT_SETTINGS.collection).toEqual([]);
		expect(DEFAULT_SETTINGS.lists).toEqual([]);
		expect(DEFAULT_SETTINGS.decks).toEqual([]);
		expect(DEFAULT_SETTINGS.wantlist).toEqual([]);
		expect(DEFAULT_SETTINGS.wantlists).toEqual([]);
	});

	it("defaults price currency to usd and view modes to list", () => {
		expect(DEFAULT_SETTINGS.priceCurrency).toBe("usd");
		expect(DEFAULT_SETTINGS.collectionViewMode).toBe("list");
		expect(DEFAULT_SETTINGS.deckViewMode).toBe("list");
		expect(DEFAULT_SETTINGS.wantlistViewMode).toBe("list");
	});

	it("defaults the Home Market trends choices to 24h and all vendors", () => {
		// "" (not undefined) for "all vendors": must survive the JSON serialization of data.json.
		expect(DEFAULT_SETTINGS.homeMoversPeriod).toBe("1d");
		expect(DEFAULT_SETTINGS.homeMoversVendor).toBe("");
		expect(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)).homeMoversVendor).toBe("");
	});
});
