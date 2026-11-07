import { describe, it, expect, vi } from "vitest";

// The mutation files import api/scryfall.ts, which imports `requestUrl` from
// "obsidian" (types only, no runtime): same stand-in as scryfall.test.ts.
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import type MTGCollectionPlugin from "../plugin";
import { addCardToCollection } from "./collection-mutations";
import { addCardToDeck } from "./deck-mutations";
import { addCardToWantlist } from "./wantlist-mutations";
import { languageCodeOfPrint, withPrintLanguage } from "../core/foreign-print";
import type { ScryfallCard } from "../api/scryfall";
import type { AddCardOptions } from "../modals/shared-search-ui";

// What the add-cards search hands to the three flows for a card typed by its
// French name: the ENGLISH print (resolveEnglishPrints) carrying the hit's
// language. Live shapes of 2026-11-07, Rocky Rebuke TLA 193.
const frenchHit: ScryfallCard = {
	id: "ec459210",
	name: "Rocky Rebuke",
	set: "tla",
	set_name: "Avatar: The Last Airbender",
	collector_number: "193",
	rarity: "common",
	type_line: "Instant",
	lang: "fr",
	printed_name: "Blâme de pierre",
	image_uris: { normal: "https://cards.scryfall.io/normal/fr/ec459210.jpg" },
	prices: {},
};
const englishPrint: ScryfallCard = {
	...frenchHit,
	id: "52fd910f",
	lang: "en",
	printed_name: undefined,
	image_uris: { normal: "https://cards.scryfall.io/normal/en/52fd910f.jpg" },
	prices: { usd: "0.20", usd_foil: "0.23", eur: "0.08" },
};
const found = withPrintLanguage(frenchHit, englishPrint);

function fakePlugin() {
	return {
		settings: { collection: [] as any[], decks: [{ id: "deck1", cards: [] as any[] }], wantlist: [] as any[] },
		recentlyAddedCollectionCardIds: new Set<string>(),
		recentlyAddedWantlistCardIds: new Set<string>(),
		saveSettings: vi.fn(async () => {}),
		rememberPrintedName: vi.fn(),
	} as unknown as MTGCollectionPlugin & { settings: { collection: any[]; decks: any[]; wantlist: any[] } };
}

describe("a card found by its French name, added to a collection", () => {
	it("is stored with the English id, the English name and picture, a price, and the language 'fr'", () => {
		const plugin = fakePlugin();
		const options: AddCardOptions = { finish: "regular", language: languageCodeOfPrint(found), condition: "" };

		const row = addCardToCollection.call(plugin, found, "list1", options);

		expect(row.scryfallId).toBe("52fd910f");
		expect(row.name).toBe("Rocky Rebuke");
		expect(row.imageUrl).toContain("/en/");
		expect(row.language).toBe("fr");
		expect(row.priceUsd).toBe("0.20");
		expect(row.priceEur).toBe("0.08");
		// the printed name came with the hit: remembered, so no request will be needed to show it
		expect(plugin.rememberPrintedName).toHaveBeenCalledWith(found);
	});

	it("is a different row from the English copy of the same card, and a second French copy adds to the first", () => {
		const plugin = fakePlugin();
		const english: AddCardOptions = { finish: "regular", language: "", condition: "" };
		const french: AddCardOptions = { finish: "regular", language: "fr", condition: "" };

		addCardToCollection.call(plugin, englishPrint, "list1", english);
		const first = addCardToCollection.call(plugin, found, "list1", french);
		const second = addCardToCollection.call(plugin, found, "list1", french);

		expect(plugin.settings.collection).toHaveLength(2);
		expect(second).toBe(first);
		expect(first.count).toBe(2);
	});
});

describe("the same card added to a deck and a wantlist", () => {
	it("gets the English id and its price in both", () => {
		const plugin = fakePlugin();
		const deckRow = addCardToDeck.call(plugin, "deck1", found, "fr");
		const wantRow = addCardToWantlist.call(plugin, found, "wl1", { finish: "regular" });

		expect(deckRow?.scryfallId).toBe("52fd910f");
		expect(deckRow?.priceUsd).toBe("0.20");
		expect(plugin.rememberPrintedName).toHaveBeenCalledWith(found);
		expect(wantRow.scryfallId).toBe("52fd910f");
		expect(wantRow.priceUsd).toBe("0.20");
	});

	it("records the language on a new deck row only, and leaves a row without one when none is given", () => {
		const plugin = fakePlugin();
		expect(addCardToDeck.call(plugin, "deck1", found, "fr")?.language).toBe("fr");
		// same row again, as an English copy: keeps what it had (a deck row is keyed by scryfallId alone)
		expect(addCardToDeck.call(plugin, "deck1", found)?.language).toBe("fr");

		const other = fakePlugin();
		const row = addCardToDeck.call(other, "deck1", englishPrint);
		expect(row?.language).toBeUndefined();
		expect("language" in (row as object)).toBe(false);
	});
});
