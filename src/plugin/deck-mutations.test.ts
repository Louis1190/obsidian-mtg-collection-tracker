import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// deck-mutations.ts imports api/scryfall.ts (which imports `requestUrl` from "obsidian": types only, no runtime). Copying
// a deck card into a list or a wantlist asks Scryfall for the card's data: that one function is replaced.
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
vi.mock("../api/scryfall", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/scryfall")>()),
	fetchScryfallCollection: vi.fn(),
}));

import { fetchScryfallCollection } from "../api/scryfall";
import { mergeSettings } from "../core/settings-merge";
import * as deckMutations from "./deck-mutations";
import { colCard, deckCard, makePlugin, saves, scry, totalCount, wantCard } from "./__tests__/plugin-harness";
import type { Obj, TestPlugin } from "./__tests__/plugin-harness";

// Characterization tests (audit of 2026-11-15, lot 2): what the deck functions do TODAY. A deck card has no id of its
// own: it is found by scryfallId (and, for some functions, its board and its Commander status).

const NOW = 5000;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	vi.mocked(fetchScryfallCollection).mockReset();
});
afterEach(() => vi.useRealTimers());

const fetchMock = vi.mocked(fetchScryfallCollection);

// A deck row; a key given as `undefined` is really absent (like a row written before that field existed).
function dc(scryfallId: string, over: Obj = {}): Obj {
	const r = deckCard({ scryfallId, ...over });
	for (const k of Object.keys(over)) if (over[k] === undefined) delete r[k];
	return r;
}
const deck = (id: string, cards: Obj[] = [], over: Obj = {}) => ({ id, name: `Deck ${id}`, cards, dateCreated: 1, ...over });

function plugin(decks: Obj[] = [deck("d1")], extra: Obj = {}): TestPlugin {
	return makePlugin([deckMutations], { decks, ...extra });
}
const cardsOf = (p: TestPlugin, deckId = "d1"): Obj[] => p.settings.decks.find((d: Obj) => d.id === deckId)!.cards;
const card = (p: TestPlugin, scryfallId: string, deckId = "d1"): Obj => cardsOf(p, deckId).find((c) => c.scryfallId === scryfallId)!;
const commander = { deckFunctionOverride: "Commander" };

describe("creating, copying and deleting decks", () => {
	it("createDeck adds an empty deck with a fresh id, today's date and its format, and saves", () => {
		const p = plugin([]);
		const d = p.createDeck("Elves", "commander");
		expect(d).toMatchObject({ name: "Elves", cards: [], dateCreated: NOW, format: "commander" });
		expect(p.settings.decks).toEqual([d]);
		expect(saves(p)).toBe(1);
		expect(p.createDeck("No format").format).toBeUndefined();
	});

	it("createDeckSilent does the same without saving", () => {
		const p = plugin([]);
		p.createDeckSilent("Quiet");
		expect(p.settings.decks).toHaveLength(1);
		expect(saves(p)).toBe(0);
	});

	it("setDeckFormat, setDeckCoverCard, setDeckIcon, renameDeck change one deck; an unknown deck is ignored", () => {
		const p = plugin([deck("d1"), deck("d2")]);
		p.setDeckFormat("d1", "modern");
		p.setDeckCoverCard("d1", "s9");
		p.setDeckIcon("d1", { type: "mana", value: "g" } as never);
		p.renameDeck("d1", "Renamed");
		expect(p.settings.decks[0]).toMatchObject({ format: "modern", coverCardId: "s9", deckIcon: { type: "mana", value: "g" }, name: "Renamed" });
		expect(p.settings.decks[1]).toMatchObject({ name: "Deck d2" });
		p.setDeckFormat("d1", undefined);
		p.setDeckCoverCard("d1", undefined);
		expect(p.settings.decks[0].format).toBeUndefined();
		expect(p.settings.decks[0].coverCardId).toBeUndefined();
		const before = saves(p);
		p.setDeckFormat("nope", "x");
		p.renameDeck("nope", "x");
		p.setDeckIcon("nope", undefined);
		p.setDeckCoverCard("nope", "x");
		p.clearDeck("nope");
		expect(saves(p)).toBe(before);
	});

	it("clearDeck empties the cards and keeps the deck", () => {
		const p = plugin([deck("d1", [dc("s1"), dc("s2")])]);
		p.clearDeck("d1");
		expect(p.settings.decks).toHaveLength(1);
		expect(cardsOf(p)).toEqual([]);
	});

	it("deleteDeck and bulkDeleteDecks remove the decks (the cards go with them)", () => {
		const p = plugin([deck("d1"), deck("d2"), deck("d3")]);
		p.deleteDeck("d1");
		expect(p.settings.decks.map((d: Obj) => d.id)).toEqual(["d2", "d3"]);
		p.bulkDeleteDecks(["d2", "zzz"]);
		expect(p.settings.decks.map((d: Obj) => d.id)).toEqual(["d3"]);
	});

	it("copyDeck makes an independent copy named '<name> copy', with the same format, whose cards can change without touching the source", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 })], { format: "commander", name: "Goblins" })]);
		const c = p.copyDeck("d1");
		expect(c).toMatchObject({ name: "Goblins copy", format: "commander", dateCreated: NOW });
		expect(c.id).not.toBe("d1");
		expect(c.cards).toEqual(cardsOf(p, "d1"));
		c.cards[0].count = 99;
		expect(card(p, "s1").count).toBe(2);
		expect(p.settings.decks).toHaveLength(2);
	});

	it("copyDeck of an unknown deck makes an empty 'Deck copy'", () => {
		const p = plugin([]);
		expect(p.copyDeck("nope")).toMatchObject({ name: "Deck copy", cards: [] });
	});
});

describe("merging duplicates and decks", () => {
	it("mergeDeckDuplicates adds the quantities of identical rows (same card, board and Commander status) into the oldest", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2, dateAdded: 30 }), dc("s1", { count: 3, dateAdded: 10 }), dc("s2")])]);
		expect(p.mergeDeckDuplicates("d1")).toEqual({ merged: 1, removed: 1 });
		expect(cardsOf(p)).toHaveLength(2);
		expect(card(p, "s1")).toMatchObject({ count: 5, dateAdded: 10, dateModified: NOW });
		expect(saves(p)).toBe(1);
	});

	it("a Commander and an ordinary row of the same card, or two boards, are not duplicates", () => {
		const p = plugin([deck("d1", [dc("s1"), dc("s1", commander), dc("s1", { category: "sideboard" })])]);
		expect(p.mergeDeckDuplicates("d1")).toEqual({ merged: 0, removed: 0 });
		expect(cardsOf(p)).toHaveLength(3);
		expect(saves(p)).toBe(0);
	});

	it("a row with no category counts as mainboard", () => {
		const p = plugin([deck("d1", [dc("s1", { category: undefined, count: 1 }), dc("s1", { category: "mainboard", count: 1 })])]);
		expect(p.mergeDeckDuplicates("d1")).toEqual({ merged: 1, removed: 1 });
	});

	it("an unknown deck is {0, 0}", () => {
		expect(plugin([]).mergeDeckDuplicates("nope")).toEqual({ merged: 0, removed: 0 });
	});

	it("mergeDecks builds a new deck with copies of the cards, removes the originals, merges the duplicates and conserves the copies", () => {
		const p = plugin([deck("a", [dc("s1", { count: 2, dateAdded: 1 }), dc("s2", { count: 1 })]), deck("b", [dc("s1", { count: 3, dateAdded: 2 })]), deck("keep", [dc("s9")])]);
		const before = totalCount(cardsOf(p, "a")) + totalCount(cardsOf(p, "b"));
		const merged = p.mergeDecks(["a", "b"], "Both");
		expect(p.settings.decks.map((d: Obj) => d.id)).toEqual(["keep", merged.id]);
		expect(merged.name).toBe("Both");
		expect(merged.cards.map((c: Obj) => [c.scryfallId, c.count]).sort()).toEqual([["s1", 5], ["s2", 1]]);
		expect(totalCount(merged.cards)).toBe(before);
	});
});

describe("adding cards to a deck", () => {
	it("addCardToDeck creates a row from a Scryfall card: count 1, dates, no category, no language unless given", () => {
		const p = plugin();
		const r = p.addCardToDeck("d1", scry("s1", { name: "Sol Ring" }))!;
		expect(r).toMatchObject({
			scryfallId: "s1",
			name: "Sol Ring",
			setCode: "lea",
			count: 1,
			dateAdded: NOW,
			dateModified: NOW,
			imageUrl: "https://img/s1-normal.jpg",
			priceUsd: "1.00",
			oracleText: "Rules text of s1",
		});
		expect(r).not.toHaveProperty("language");
		expect(r).not.toHaveProperty("category");
		expect(cardsOf(p)).toEqual([r]);
		expect(p.rememberPrintedName).toHaveBeenCalled();
		expect(p.addCardToDeck("d1", scry("s2"), "fr")).toMatchObject({ language: "fr" });
	});

	it("adding a card the deck already has adds to the count and keeps the language it had", () => {
		const p = plugin();
		const first = p.addCardToDeck("d1", scry("s1"), "fr")!;
		vi.setSystemTime(NOW + 10);
		const again = p.addCardToDeck("d1", scry("s1"), "de")!;
		expect(again).toBe(first);
		expect(first).toMatchObject({ count: 2, language: "fr", dateModified: NOW + 10, dateAdded: NOW });
		expect(cardsOf(p)).toHaveLength(1);
	});

	it("an unknown deck gets nothing", () => {
		const p = plugin();
		expect(p.addCardToDeck("nope", scry("s1"))).toBeUndefined();
		p.addCollectionCardToDeck(colCard() as never, "nope");
		p.addWantlistCardToDeck(wantCard() as never, "nope");
		expect(saves(p)).toBe(0);
	});

	it("addCollectionCardToDeck makes an owned row that takes the real copy's finish, condition and language", () => {
		const p = plugin();
		p.addCollectionCardToDeck(colCard({ scryfallId: "s1", finish: "foiled", condition: "LP", language: "fr" }) as never, "d1");
		expect(card(p, "s1")).toMatchObject({ count: 1, owned: true, finish: "foiled", condition: "LP", language: "fr", dateAdded: NOW, priceUsd: "0.10" });
	});

	it("addCollectionCardToDeck on a card already in the deck adds one and marks it owned", () => {
		const p = plugin([deck("d1", [dc("s1", { owned: false, count: 1 })])]);
		p.addCollectionCardToDeck(colCard({ scryfallId: "s1" }) as never, "d1");
		expect(card(p, "s1")).toMatchObject({ count: 2, owned: true });
	});

	it("addWantlistCardToDeck makes a NOT owned row with the finish but no condition or language", () => {
		const p = plugin();
		p.addWantlistCardToDeck(wantCard({ scryfallId: "s1", finish: "etched" }) as never, "d1");
		const r = card(p, "s1");
		expect(r).toMatchObject({ count: 1, owned: false, finish: "etched" });
		expect(r).not.toHaveProperty("condition");
		expect(r).not.toHaveProperty("language");
	});

	it("addWantlistCardToDeck never demotes an owned row", () => {
		const p = plugin([deck("d1", [dc("s1", { owned: true, count: 1 })])]);
		p.addWantlistCardToDeck(wantCard({ scryfallId: "s1" }) as never, "d1");
		expect(card(p, "s1")).toMatchObject({ count: 2, owned: true });
	});
});

describe("quantity and removal", () => {
	it("changeDeckCardCount adds the delta and calls onDone", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 })])]);
		const done = vi.fn();
		p.changeDeckCardCount("d1", "s1", 3, done);
		expect(card(p, "s1").count).toBe(5);
		expect(done).toHaveBeenCalledTimes(1);
		expect(saves(p)).toBe(1);
	});

	it("changeDeckCardCount stops at 0, not 1 (unlike the collection and the wantlist): a card at 0 stays in the deck", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 })])]);
		p.changeDeckCardCount("d1", "s1", -10, () => {});
		expect(card(p, "s1").count).toBe(0);
		expect(cardsOf(p)).toHaveLength(1);
	});

	it("an unknown deck or card changes nothing and never calls onDone", () => {
		const p = plugin([deck("d1", [dc("s1")])]);
		const done = vi.fn();
		p.changeDeckCardCount("nope", "s1", 1, done);
		p.changeDeckCardCount("d1", "nope", 1, done);
		expect(done).not.toHaveBeenCalled();
		expect(saves(p)).toBe(0);
	});

	it("removeDeckCard removes EVERY row of that card from the deck, whatever its board", () => {
		const p = plugin([deck("d1", [dc("s1"), dc("s1", { category: "sideboard" }), dc("s2")])]);
		p.removeDeckCard("d1", "s1");
		expect(cardsOf(p).map((c) => c.scryfallId)).toEqual(["s2"]);
	});

	it("bulkRemoveDeckCards removes the selection from the given deck only", () => {
		const p = plugin([deck("d1", [dc("s1"), dc("s2"), dc("s3")]), deck("d2", [dc("s1")])]);
		p.bulkRemoveDeckCards("d1", ["s1", "s3"]);
		expect(cardsOf(p).map((c) => c.scryfallId)).toEqual(["s2"]);
		expect(cardsOf(p, "d2")).toHaveLength(1);
	});

	it("bulkSetDeckCardCount sets the same clamped count (min 1) on the selection with one date", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 4 }), dc("s2", { count: 4 }), dc("s3", { count: 4 })])]);
		p.bulkSetDeckCardCount("d1", ["s1", "s3"], 0);
		expect(cardsOf(p).map((c) => c.count)).toEqual([1, 4, 1]);
		p.bulkSetDeckCardCount("d1", ["s2"], 7.9);
		expect(card(p, "s2")).toMatchObject({ count: 7, dateModified: NOW });
		expect(card(p, "s1").dateModified).toBe(NOW);
	});

	describe("undoAddToDeck", () => {
		it("takes copies off the row, or deletes it when none would remain", () => {
			const p = plugin([deck("d1", [dc("s1", { count: 5 })])]);
			expect(p.undoAddToDeck("s1", "d1", 2)).toBe(card(p, "s1"));
			expect(card(p, "s1")).toMatchObject({ count: 3, dateModified: NOW });
			expect(p.undoAddToDeck("s1", "d1", 3)).toBeUndefined();
			expect(cardsOf(p)).toEqual([]);
		});

		it("answers undefined for an unknown deck or card", () => {
			const p = plugin([deck("d1", [dc("s1")])]);
			expect(p.undoAddToDeck("s1", "nope", 1)).toBeUndefined();
			expect(p.undoAddToDeck("nope", "d1", 1)).toBeUndefined();
			expect(cardsOf(p)).toHaveLength(1);
		});
	});
});

describe("setting a field of a deck card", () => {
	it.each([
		["setDeckCardFinish", "finish", "etched"],
		["setDeckCardCondition", "condition", "MT"],
		["setDeckCardLanguage", "language", "ja"],
		["setDeckCardCategory", "category", "sideboard"],
		["setDeckCardFunction", "deckFunctionOverride", "Ramp"],
	] as const)("%s sets %s, bumps the date and saves; an unknown deck or card is ignored", (method, field, value) => {
		const p = plugin([deck("d1", [dc("s1")])]);
		(p as Obj)[method]("d1", "s1", value);
		expect(card(p, "s1")[field]).toBe(value);
		expect(card(p, "s1").dateModified).toBe(NOW);
		expect(saves(p)).toBe(1);
		(p as Obj)[method]("nope", "s1", value);
		(p as Obj)[method]("d1", "nope", value);
		expect(saves(p)).toBe(1);
	});

	it("setDeckCardFunction(undefined) goes back to automatic detection", () => {
		const p = plugin([deck("d1", [dc("s1", commander)])]);
		p.setDeckCardFunction("d1", "s1", undefined);
		expect(card(p, "s1").deckFunctionOverride).toBeUndefined();
	});

	it("setDeckCardGrading sets or clears the three grading fields and leaves the custom price", () => {
		const p = plugin([deck("d1", [dc("s1", { customPrice: "5" })])]);
		p.setDeckCardGrading("d1", "s1", "CGC", 10, "Pristine");
		expect(card(p, "s1")).toMatchObject({ gradingCompany: "CGC", gradingGrade: 10, gradingLabel: "Pristine", customPrice: "5" });
		p.setDeckCardGrading("d1", "s1", undefined, undefined, undefined);
		expect(card(p, "s1")).toMatchObject({ gradingCompany: undefined, gradingGrade: undefined, gradingLabel: undefined });
	});

	it("setDeckCardCustomPrice trims and turns a blank into 'none'", () => {
		const p = plugin([deck("d1", [dc("s1")])]);
		p.setDeckCardCustomPrice("d1", "s1", " 12.5 ");
		expect(card(p, "s1").customPrice).toBe("12.5");
		p.setDeckCardCustomPrice("d1", "s1", "  ");
		expect(card(p, "s1").customPrice).toBeUndefined();
	});

	it("when a card is in the deck on two boards, only the FIRST row is changed (the accepted ambiguity of these setters)", () => {
		const p = plugin([deck("d1", [dc("s1", { category: "sideboard" }), dc("s1", { category: "mainboard" })])]);
		p.setDeckCardFinish("d1", "s1", "foiled");
		expect(cardsOf(p).map((c) => c.finish)).toEqual(["foiled", "regular"]);
	});

	it.each([
		["bulkSetDeckCardCondition", "condition", "PL"],
		["bulkSetDeckCardLanguage", "language", "it"],
		["bulkSetDeckCardFinish", "finish", "foiled"],
		["bulkSetDeckCardCategory", "category", "maybeboard"],
		["bulkSetDeckCardFunction", "deckFunctionOverride", "Removal"],
	] as const)("%s changes every row of the selected cards, only them, with one date", (method, field, value) => {
		const p = plugin([deck("d1", [dc("s1"), dc("s2"), dc("s3")]), deck("d2", [dc("s1")])]);
		(p as Obj)[method]("d1", ["s1", "s3"], value);
		expect(cardsOf(p).map((c) => c[field] === value)).toEqual([true, false, true]);
		expect(card(p, "s1").dateModified).toBe(NOW);
		expect(card(p, "s2").dateModified).toBe(1000);
		expect(card(p, "s1", "d2")[field] === value).toBe(false);
		expect(saves(p)).toBe(1);
	});
});

describe("changeDeckCardPrinting", () => {
	it("finds the row by card AND board, takes the new printing's data and keeps count, board and the physical copy's attributes", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 3, category: "sideboard", finish: "foiled", condition: "LP", language: "fr", owned: true, dateAdded: 77 }), dc("s1", { count: 1 })])]);
		p.changeDeckCardPrinting("d1", "s1", "sideboard", scry("s2", { name: "Other", set: "m10", set_name: "Magic 2010" }));
		expect(cardsOf(p)[0]).toMatchObject({ scryfallId: "s2", name: "Other", setCode: "m10", setName: "Magic 2010", count: 3, category: "sideboard", finish: "foiled", condition: "LP", language: "fr", owned: true, dateAdded: 77, dateModified: NOW, imageUrl: "https://img/s2-normal.jpg" });
		expect(cardsOf(p)[1]).toMatchObject({ scryfallId: "s1", count: 1 });
	});

	it("merges into a row that already has the chosen printing on the same board and Commander status", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 }), dc("s2", { count: 5 })])]);
		p.changeDeckCardPrinting("d1", "s1", "mainboard", scry("s2"));
		expect(cardsOf(p)).toHaveLength(1);
		expect(card(p, "s2")).toMatchObject({ count: 7, dateModified: NOW });
	});

	it("does NOT merge a Commander row into an ordinary row of the chosen printing (nor the other way round)", () => {
		const p = plugin([deck("d1", [dc("s1", commander), dc("s2")])]);
		p.changeDeckCardPrinting("d1", "s1", "mainboard", scry("s2"));
		expect(cardsOf(p)).toHaveLength(2);
		const q = plugin([deck("d1", [dc("s1"), dc("s2", { category: "sideboard" })])]);
		q.changeDeckCardPrinting("d1", "s1", "mainboard", scry("s2"));
		expect(cardsOf(q)).toHaveLength(2);
	});

	it("ignores an unknown deck, card or board", () => {
		const p = plugin([deck("d1", [dc("s1")])]);
		p.changeDeckCardPrinting("nope", "s1", "mainboard", scry("s2"));
		p.changeDeckCardPrinting("d1", "nope", "mainboard", scry("s2"));
		p.changeDeckCardPrinting("d1", "s1", "sideboard", scry("s2"));
		expect(saves(p)).toBe(0);
		expect(card(p, "s1")).toBeDefined();
	});
});

describe("deck to deck", () => {
	it("copyDeckCardToDeck adds a copy with fresh dates to the other deck and keeps the original", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2, category: "sideboard", dateAdded: 10 })]), deck("d2")]);
		p.copyDeckCardToDeck("d1", "s1", "sideboard", "d2");
		expect(cardsOf(p, "d1")).toHaveLength(1);
		expect(cardsOf(p, "d2")[0]).toMatchObject({ scryfallId: "s1", count: 2, category: "sideboard", dateAdded: NOW, dateModified: NOW });
		expect(cardsOf(p, "d2")[0]).not.toBe(cardsOf(p, "d1")[0]);
	});

	it("copying into the same deck is a no-op (it would double and delete the card otherwise)", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 })])]);
		p.copyDeckCardToDeck("d1", "s1", "mainboard", "d1");
		p.moveDeckCardToDeck("d1", "s1", "mainboard", "d1");
		expect(cardsOf(p)).toHaveLength(1);
		expect(card(p, "s1").count).toBe(2);
		expect(saves(p)).toBe(0);
	});

	it("adds to a row of the other deck with the same board and Commander status, and keeps a Commander apart", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 })]), deck("d2", [dc("s1", { count: 5 })])]);
		p.copyDeckCardToDeck("d1", "s1", "mainboard", "d2");
		expect(cardsOf(p, "d2")).toHaveLength(1);
		expect(card(p, "s1", "d2")).toMatchObject({ count: 7, dateModified: NOW });
		const q = plugin([deck("d1", [dc("s1", commander)]), deck("d2", [dc("s1")])]);
		q.copyDeckCardToDeck("d1", "s1", "mainboard", "d2");
		expect(cardsOf(q, "d2")).toHaveLength(2);
	});

	it("ignores an unknown deck, card or board", () => {
		const p = plugin([deck("d1", [dc("s1")]), deck("d2")]);
		p.copyDeckCardToDeck("nope", "s1", "mainboard", "d2");
		p.copyDeckCardToDeck("d1", "s1", "mainboard", "nope");
		p.copyDeckCardToDeck("d1", "zzz", "mainboard", "d2");
		p.copyDeckCardToDeck("d1", "s1", "sideboard", "d2");
		expect(cardsOf(p, "d2")).toEqual([]);
		expect(saves(p)).toBe(0);
	});

	it("moveDeckCardToDeck takes the card out of the source and conserves the copies", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 }), dc("s2")]), deck("d2", [dc("s1", { count: 5 })])]);
		p.moveDeckCardToDeck("d1", "s1", "mainboard", "d2");
		expect(cardsOf(p, "d1").map((c) => c.scryfallId)).toEqual(["s2"]);
		expect(card(p, "s1", "d2").count).toBe(7);
	});

	// Regression tests for a defect found by the audit of 2026-11-15 (lot 2) and fixed in the same series: the move copied
	// ONE row (card + board) but removed the card from the source with removeDeckCard, which removes EVERY row of that
	// card whatever its board, so a card that was in the deck both on the mainboard and in the sideboard lost the row
	// that was never moved.
	it("moving the mainboard copy of a card leaves its sideboard copy in the source deck", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 1 }), dc("s1", { count: 2, category: "sideboard" })]), deck("d2")]);
		p.moveDeckCardToDeck("d1", "s1", "mainboard", "d2");
		expect(cardsOf(p, "d1")).toHaveLength(1);
		expect(cardsOf(p, "d1")[0]).toMatchObject({ category: "sideboard", count: 2 });
		expect(cardsOf(p, "d2")).toHaveLength(1);
		expect(cardsOf(p, "d2")[0].category).toBeUndefined();
	});

	it("whichever of the card's rows comes first in the deck, only the row of the moved board goes", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2, category: "sideboard" }), dc("s1", { count: 1 }), dc("s1", { count: 4, category: "maybeboard" })]), deck("d2")]);
		p.moveDeckCardToDeck("d1", "s1", "mainboard", "d2");
		expect(cardsOf(p, "d1").map((c) => [c.category, c.count])).toEqual([["sideboard", 2], ["maybeboard", 4]]);
		expect(cardsOf(p, "d2").map((c) => c.count)).toEqual([1]);
	});

	it("moving an ordinary row leaves the same card's Commander row (same board) where it is", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 1 }), dc("s1", { count: 1, ...commander })]), deck("d2")]);
		p.moveDeckCardToDeck("d1", "s1", "mainboard", "d2");
		// the lookup is the copy's own (the first row of that card on that board): exactly the row that was copied goes
		expect(cardsOf(p, "d1")).toHaveLength(1);
		expect(cardsOf(p, "d1")[0]).toMatchObject({ deckFunctionOverride: "Commander" });
		expect(cardsOf(p, "d2")[0].deckFunctionOverride).toBeUndefined();
	});

	it("conserves every copy of the card across both decks", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 1 }), dc("s1", { count: 2, category: "sideboard" })]), deck("d2", [dc("s1", { count: 5 })])]);
		const before = totalCount([...cardsOf(p, "d1"), ...cardsOf(p, "d2")]);
		p.moveDeckCardToDeck("d1", "s1", "mainboard", "d2");
		expect(totalCount([...cardsOf(p, "d1"), ...cardsOf(p, "d2")])).toBe(before);
	});

	it("moving to a deck that does not exist keeps the card where it is (nothing landed, so nothing is removed)", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2 })])]);
		p.moveDeckCardToDeck("d1", "s1", "mainboard", "gone");
		expect(cardsOf(p)).toHaveLength(1);
		expect(card(p, "s1").count).toBe(2);
		expect(saves(p)).toBe(0);
	});

	it("copyDeckCardToDeck says whether the card landed", () => {
		const p = plugin([deck("d1", [dc("s1")]), deck("d2")]);
		expect(p.copyDeckCardToDeck("d1", "s1", "mainboard", "d2")).toBe(true);
		expect(p.copyDeckCardToDeck("d1", "s1", "mainboard", "d1")).toBe(false);
		expect(p.copyDeckCardToDeck("d1", "s1", "mainboard", "gone")).toBe(false);
		expect(p.copyDeckCardToDeck("gone", "s1", "mainboard", "d2")).toBe(false);
		expect(p.copyDeckCardToDeck("d1", "zzz", "mainboard", "d2")).toBe(false);
		expect(p.copyDeckCardToDeck("d1", "s1", "sideboard", "d2")).toBe(false);
	});
});

describe("deck to collection list or wantlist (asks Scryfall for the card)", () => {
	it("copyDeckCardToList adds to an identical owned row without asking Scryfall", async () => {
		const p = plugin([deck("d1", [dc("s1", { count: 2, finish: "foiled", language: "fr", condition: "LP" })])], {
			collection: [colCard({ id: "o1", scryfallId: "s1", listId: "lA", finish: "foiled", language: "fr", condition: "LP", count: 4 })],
		});
		expect(await p.copyDeckCardToList("d1", "s1", "mainboard", "lA")).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(p.settings.collection).toHaveLength(1);
		expect(p.settings.collection[0]).toMatchObject({ count: 6, dateModified: NOW });
	});

	it("copyDeckCardToList creates the owned card from Scryfall's data with the deck copy's finish, language and condition", async () => {
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1", { name: "Fresh name" })]]));
		const p = plugin([deck("d1", [dc("s1", { count: 3, finish: "foiled", language: "fr", condition: "LP" })])], { collection: [] });
		expect(await p.copyDeckCardToList("d1", "s1", "mainboard", "lA")).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(["s1"]);
		expect(p.settings.collection[0]).toMatchObject({ scryfallId: "s1", name: "Fresh name", listId: "lA", count: 3, finish: "foiled", language: "fr", condition: "LP", dateAdded: NOW, releasedAt: "1993-08-05" });
		expect(cardsOf(p)).toHaveLength(1);
	});

	it.each([
		["finish", { finish: "foiled" }],
		["language", { language: "de" }],
		["condition", { condition: "PO" }],
		["list", { listId: "lB" }],
		["card", { scryfallId: "other" }],
	])("copyDeckCardToList does not add to an owned row that differs by %s", async (_label, over) => {
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		const p = plugin([deck("d1", [dc("s1", { count: 2, finish: "regular", language: "fr", condition: "LP" })])], {
			collection: [colCard({ id: "o1", scryfallId: "s1", listId: "lA", finish: "regular", language: "fr", condition: "LP", count: 4, ...over })],
		});
		await p.copyDeckCardToList("d1", "s1", "mainboard", "lA");
		expect(p.settings.collection.map((c: Obj) => c.count)).toEqual([4, 2]);
	});

	it("a deck card with no finish, language or condition becomes regular / '' / ''", async () => {
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		const p = plugin([deck("d1", [dc("s1", { finish: undefined })])], { collection: [] });
		await p.copyDeckCardToList("d1", "s1", "mainboard", "lA");
		expect(p.settings.collection[0]).toMatchObject({ finish: "regular", language: "", condition: "" });
	});

	it("when Scryfall does not answer, nothing changes and the answer is false", async () => {
		fetchMock.mockResolvedValue(new Map());
		const p = plugin([deck("d1", [dc("s1")])], { collection: [] });
		expect(await p.copyDeckCardToList("d1", "s1", "mainboard", "lA")).toBe(false);
		expect(await p.copyDeckCardToWantlist("d1", "s1", "mainboard", "wA")).toBe(false);
		expect(p.settings.collection).toEqual([]);
		expect(p.settings.wantlist).toEqual([]);
		expect(saves(p)).toBe(0);
	});

	it("an unknown deck, card or board answers false without asking Scryfall", async () => {
		const p = plugin([deck("d1", [dc("s1")])]);
		expect(await p.copyDeckCardToList("nope", "s1", "mainboard", "lA")).toBe(false);
		expect(await p.copyDeckCardToList("d1", "zzz", "mainboard", "lA")).toBe(false);
		expect(await p.copyDeckCardToList("d1", "s1", "sideboard", "lA")).toBe(false);
		expect(await p.copyDeckCardToWantlist("nope", "s1", "mainboard", "wA")).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("moveDeckCardToList removes the card from the deck only once it has really landed in the collection", async () => {
		fetchMock.mockResolvedValue(new Map());
		const p = plugin([deck("d1", [dc("s1")])], { collection: [] });
		await p.moveDeckCardToList("d1", "s1", "mainboard", "lA");
		expect(cardsOf(p)).toHaveLength(1);
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		await p.moveDeckCardToList("d1", "s1", "mainboard", "lA");
		expect(cardsOf(p)).toEqual([]);
		expect(p.settings.collection).toHaveLength(1);
	});

	it("copyDeckCardToWantlist adds a wanted card with the finish (no language or condition), or adds to the one already wanted", async () => {
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		const p = plugin([deck("d1", [dc("s1", { count: 2, finish: "foiled", language: "fr" })])], { wantlist: [] });
		expect(await p.copyDeckCardToWantlist("d1", "s1", "mainboard", "wA")).toBe(true);
		expect(p.settings.wantlist[0]).toMatchObject({ scryfallId: "s1", listId: "wA", count: 2, finish: "foiled" });
		expect(p.settings.wantlist[0]).not.toHaveProperty("language");
		fetchMock.mockClear();
		expect(await p.copyDeckCardToWantlist("d1", "s1", "mainboard", "wA")).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(p.settings.wantlist[0].count).toBe(4);
	});

	it.each([
		["finish", { finish: "foiled" }],
		["wantlist", { listId: "wB" }],
		["card", { scryfallId: "other" }],
	])("copyDeckCardToWantlist does not add to a wanted card that differs by %s", async (_label, over) => {
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		const p = plugin([deck("d1", [dc("s1", { count: 2, finish: "regular" })])], {
			wantlist: [wantCard({ id: "w1", scryfallId: "s1", listId: "wA", finish: "regular", count: 4, ...over })],
		});
		await p.copyDeckCardToWantlist("d1", "s1", "mainboard", "wA");
		expect(p.settings.wantlist.map((c: Obj) => c.count)).toEqual([4, 2]);
	});

	it("moveDeckCardToWantlist removes the card from the deck only once it has landed", async () => {
		fetchMock.mockResolvedValue(new Map());
		const p = plugin([deck("d1", [dc("s1")])], { wantlist: [] });
		await p.moveDeckCardToWantlist("d1", "s1", "mainboard", "wA");
		expect(cardsOf(p)).toHaveLength(1);
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		await p.moveDeckCardToWantlist("d1", "s1", "mainboard", "wA");
		expect(cardsOf(p)).toEqual([]);
	});

	// Same regression as for moveDeckCardToDeck: the card used to be removed from the deck by scryfallId alone.
	it("moving the mainboard copy to a list leaves the card's sideboard copy in the deck", async () => {
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		const p = plugin([deck("d1", [dc("s1"), dc("s1", { category: "sideboard", count: 2 })])], { collection: [] });
		await p.moveDeckCardToList("d1", "s1", "mainboard", "lA");
		expect(cardsOf(p)).toHaveLength(1);
		expect(cardsOf(p)[0]).toMatchObject({ category: "sideboard", count: 2 });
		expect(p.settings.collection).toHaveLength(1);
	});

	it("moving the sideboard copy to a wantlist leaves the card's mainboard copy in the deck", async () => {
		fetchMock.mockResolvedValue(new Map([["s1", scry("s1")]]));
		const p = plugin([deck("d1", [dc("s1", { count: 3 }), dc("s1", { category: "sideboard", count: 2 })])], { wantlist: [] });
		await p.moveDeckCardToWantlist("d1", "s1", "sideboard", "wA");
		expect(cardsOf(p)).toHaveLength(1);
		expect(cardsOf(p)[0]).toMatchObject({ count: 3 });
		expect(cardsOf(p)[0].category).toBeUndefined();
		expect(p.settings.wantlist[0]).toMatchObject({ scryfallId: "s1", count: 2 });
	});
});

// The sync layer settles a deck card by its own dateModified (core/settings-merge.ts: deck cards are `lww`, not
// stamped by the plugin): a mutation that changes a deck card without bumping dateModified can be undone by an older
// copy when there is no common ancestor to say which side changed (a device joining, a restored backup).
describe("deck card changes and the sync merge", () => {
	const docWith = (cards: Obj[]) => ({ collection: [], lists: [], decks: [deck("d1", cards, { dateModified: 10 })] });
	const mergedCard = (local: Obj, remote: Obj) => (mergeSettings(null, local, remote).merged as Obj).decks[0].cards[0];

	it("a change that bumps dateModified survives a merge with the older copy (the reference behaviour)", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 3, dateModified: 100 })])]);
		const stale = structuredClone({ ...docWith(cardsOf(p)) });
		p.setDeckCardFinish("d1", "s1", "foiled");
		vi.setSystemTime(NOW + 1);
		const local = docWith(cardsOf(p));
		expect(mergedCard(local, stale).finish).toBe("foiled");
		expect(mergedCard(stale, local).finish).toBe("foiled");
	});

	// Regression tests for a defect found by the audit of 2026-11-15 (lot 2) and fixed in the same series, shown with the
	// real merge: changeDeckCardCount, and the 'already in the deck' branch of addCollectionCardToDeck and
	// addWantlistCardToDeck, used to change a deck card WITHOUT bumping dateModified. With a common ancestor the edit
	// still won; without one, a decrement was undone by the older copy (3 instead of 1).
	it("a decrement made with changeDeckCardCount survives a merge with the older copy", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 3, dateModified: 100 })])]);
		const stale = docWith(structuredClone(cardsOf(p)));
		p.changeDeckCardCount("d1", "s1", -2, () => {});
		const local = docWith(cardsOf(p));
		expect(mergedCard(local, stale).count).toBe(1);
		expect(mergedCard(stale, local).count).toBe(1);
	});

	it("changeDeckCardCount bumps dateModified like every other deck-card mutation", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 3, dateModified: 100 })])]);
		p.changeDeckCardCount("d1", "s1", 1, () => {});
		expect(card(p, "s1").dateModified).toBe(NOW);
	});

	it("an increment survives a merge with the older copy too", () => {
		const p = plugin([deck("d1", [dc("s1", { count: 1, dateModified: 100 })])]);
		const stale = docWith(structuredClone(cardsOf(p)));
		p.changeDeckCardCount("d1", "s1", 4, () => {});
		const local = docWith(cardsOf(p));
		expect(mergedCard(local, stale).count).toBe(5);
		expect(mergedCard(stale, local).count).toBe(5);
	});

	it("adding a collection card already in the deck bumps dateModified", () => {
		const p = plugin([deck("d1", [dc("s1", { dateModified: 100 })])]);
		p.addCollectionCardToDeck(colCard({ scryfallId: "s1" }) as never, "d1");
		expect(card(p, "s1").dateModified).toBe(NOW);
	});

	it("adding a wanted card already in the deck bumps dateModified", () => {
		const p = plugin([deck("d1", [dc("s1", { dateModified: 100 })])]);
		p.addWantlistCardToDeck(wantCard({ scryfallId: "s1" }) as never, "d1");
		expect(card(p, "s1").dateModified).toBe(NOW);
	});

	it("so does every other mutation of a deck card, which is what the sync merge relies on", () => {
		const mutations: [string, (p: TestPlugin) => void][] = [
			["setDeckCardFinish", (p) => p.setDeckCardFinish("d1", "s1", "foiled")],
			["setDeckCardCondition", (p) => p.setDeckCardCondition("d1", "s1", "NM")],
			["setDeckCardLanguage", (p) => p.setDeckCardLanguage("d1", "s1", "fr")],
			["setDeckCardCategory", (p) => p.setDeckCardCategory("d1", "s1", "sideboard")],
			["setDeckCardFunction", (p) => p.setDeckCardFunction("d1", "s1", "Ramp")],
			["setDeckCardGrading", (p) => p.setDeckCardGrading("d1", "s1", "PSA", 9, "x")],
			["setDeckCardCustomPrice", (p) => p.setDeckCardCustomPrice("d1", "s1", "5")],
			["undoAddToDeck", (p) => p.undoAddToDeck("s1", "d1", 1)],
			["changeDeckCardPrinting", (p) => p.changeDeckCardPrinting("d1", "s1", "mainboard", scry("s2"))],
			["addCardToDeck", (p) => p.addCardToDeck("d1", scry("s1"))],
			["bulkSetDeckCardCount", (p) => p.bulkSetDeckCardCount("d1", ["s1"], 7)],
			["bulkSetDeckCardFinish", (p) => p.bulkSetDeckCardFinish("d1", ["s1"], "foiled")],
		];
		for (const [name, run] of mutations) {
			const p = plugin([deck("d1", [dc("s1", { count: 3, dateModified: 100 })])]);
			run(p);
			const changed = cardsOf(p)[0];
			expect(changed.dateModified, name).toBe(NOW);
		}
	});
});
