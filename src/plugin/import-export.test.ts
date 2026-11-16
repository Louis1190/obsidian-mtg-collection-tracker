import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// import-export.ts imports api/scryfall.ts (which imports `requestUrl` from "obsidian": types only, no runtime). The
// three functions that talk to Scryfall are replaced; everything else of that module (the CSV parser, the picture
// helpers) is the real one.
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
vi.mock("../api/scryfall", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/scryfall")>()),
	searchScryfall: vi.fn(),
	fetchScryfallCollection: vi.fn(),
	sleep: vi.fn(async () => {}),
}));

import { fetchScryfallCollection, searchScryfall, sleep } from "../api/scryfall";
import type { ScryfallCard } from "../api/scryfall";
import * as collectionMutations from "./collection-mutations";
import * as importExport from "./import-export";
import * as wantlistMutations from "./wantlist-mutations";
import { colCard, deckCard, makePlugin, saves, scry, wantCard } from "./__tests__/plugin-harness";
import type { Obj, TestPlugin } from "./__tests__/plugin-harness";

// Characterization tests (audit of 2026-11-15, lot 2): what the importers do TODAY with a file or a pasted list that
// comes from somewhere else. The quantity clamps, the merge keys, what is "skipped" or "unresolved".

const NOW = 5000;
const searchMock = vi.mocked(searchScryfall);
const fetchMock = vi.mocked(fetchScryfallCollection);
const sleepMock = vi.mocked(sleep);

// "By name" resolution of Scryfall's search: the ids it knows by (lower-cased) name; any other name finds nothing.
function searchKnows(byName: Record<string, string>) {
	searchMock.mockImplementation(async (name: string) => {
		const id = byName[name.toLowerCase()];
		return { cards: id ? [scry(id)] : [], hasMore: false, totalCards: id ? 1 : 0 };
	});
}
// What the grouped fetch answers for the ids it knows, calling the per-batch callback like the real one.
function scryfallKnows(cards: Record<string, Partial<ScryfallCard>> | string[]) {
	const table: Record<string, Partial<ScryfallCard>> = Array.isArray(cards) ? Object.fromEntries(cards.map((id) => [id, {}])) : cards;
	fetchMock.mockImplementation(async (ids: string[]) => new Map<string, ScryfallCard>(ids.filter((id) => id in table).map((id) => [id, scry(id, table[id])])));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	searchMock.mockReset();
	fetchMock.mockReset();
	sleepMock.mockClear();
	searchMock.mockResolvedValue({ cards: [], hasMore: false, totalCards: 0 });
	fetchMock.mockResolvedValue(new Map());
});
afterEach(() => vi.useRealTimers());

function plugin(settings: Obj = {}): TestPlugin {
	return makePlugin([importExport, collectionMutations, wantlistMutations], {
		lists: [{ id: "lA", name: "Alpha", dateCreated: 1 }],
		wantlists: [{ id: "wA", name: "Wanted", dateCreated: 1 }],
		decks: [{ id: "d1", name: "Deck", cards: [], dateCreated: 1 }],
		...settings,
	});
}
const progress = () => vi.fn<(msg: string) => void>();
const deckCards = (p: TestPlugin): Obj[] => p.settings.decks[0].cards;
const byScryfallId = (rows: Obj[], id: string): Obj => rows.find((r) => r.scryfallId === id)!;

describe("decklist pasted into a deck (importDecklistToDeck)", () => {
	const list = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n4 Lightning Bolt\n1 Sol Ring (C21) 263\n\nSideboard\n2 Negate";
	const names = { "atraxa, praetors' voice": "s-atraxa", "lightning bolt": "s-bolt", "sol ring": "s-ring", negate: "s-negate" };

	it("throws for an unknown deck, and asks Scryfall nothing for an empty text", async () => {
		const p = plugin();
		await expect(p.importDecklistToDeck("nope", "1 Bolt", progress())).rejects.toThrow("Deck not found.");
		expect(await p.importDecklistToDeck("d1", "", progress())).toEqual({ added: 0, unresolved: [] });
		expect(searchMock).not.toHaveBeenCalled();
		expect(saves(p)).toBe(0);
	});

	it("adds each resolved line with its quantity, board and Commander role, and asks for the ids in one grouped call", async () => {
		searchKnows(names);
		scryfallKnows(["s-atraxa", "s-bolt", "s-ring", "s-negate"]);
		const p = plugin();
		const r = await p.importDecklistToDeck("d1", list, progress());
		expect(r).toEqual({ added: 4, unresolved: [] });
		expect(deckCards(p)).toHaveLength(4);
		expect(byScryfallId(deckCards(p), "s-atraxa")).toMatchObject({ count: 1, deckFunctionOverride: "Commander", dateAdded: NOW, name: "Card s-atraxa" });
		expect(byScryfallId(deckCards(p), "s-atraxa").category).toBeUndefined();
		expect(byScryfallId(deckCards(p), "s-bolt")).toMatchObject({ count: 4 });
		expect(byScryfallId(deckCards(p), "s-bolt").deckFunctionOverride).toBeUndefined();
		expect(byScryfallId(deckCards(p), "s-negate")).toMatchObject({ count: 2, category: "sideboard" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toEqual(["s-atraxa", "s-bolt", "s-ring", "s-negate"]);
		expect(saves(p)).toBe(1);
	});

	it("passes the set and number written on a line to the search, and nothing otherwise", async () => {
		searchKnows(names);
		scryfallKnows(["s-ring", "s-bolt"]);
		const p = plugin();
		await p.importDecklistToDeck("d1", "1 Sol Ring (C21) 263\n4 Lightning Bolt", progress());
		expect(searchMock.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([["Sol Ring", "c21", "263"], ["Lightning Bolt", "", ""]]);
	});

	it("reports a line Scryfall does not know as unresolved (with its text), and does not count it", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt"]);
		const p = plugin();
		const r = await p.importDecklistToDeck("d1", "4 Lightning Bolt\n3 Not A Real Card", progress());
		expect(r).toEqual({ added: 1, unresolved: ["3 Not A Real Card"] });
		expect(deckCards(p)).toHaveLength(1);
	});

	it("a line resolved by the search but missing from the grouped answer is dropped, not counted, not reported", async () => {
		searchKnows(names);
		scryfallKnows([]);
		const p = plugin();
		const r = await p.importDecklistToDeck("d1", "4 Lightning Bolt", progress());
		expect(r).toEqual({ added: 0, unresolved: [] });
		expect(deckCards(p)).toEqual([]);
	});

	it("retries a search that failed once, after a pause; a line that fails twice is unresolved", async () => {
		scryfallKnows(["s-bolt"]);
		let calls = 0;
		searchMock.mockImplementation(async (name: string) => {
			calls++;
			if (name === "Lightning Bolt") {
				if (calls === 1) throw new Error("429");
				return { cards: [scry("s-bolt")], hasMore: false, totalCards: 1 };
			}
			throw new Error("network down");
		});
		const p = plugin();
		const r = await p.importDecklistToDeck("d1", "4 Lightning Bolt\n1 Negate", progress());
		expect(r).toEqual({ added: 1, unresolved: ["1 Negate"] });
		expect(sleepMock).toHaveBeenCalledWith(300);
		expect(sleepMock).toHaveBeenCalledTimes(2);
		expect(searchMock).toHaveBeenCalledTimes(4);
	});

	it("adds to a row already in the deck for the same board and Commander role, and keeps a Commander row apart", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt", "s-atraxa"]);
		const p = plugin({
			decks: [{ id: "d1", name: "D", dateCreated: 1, cards: [deckCard({ scryfallId: "s-bolt", count: 2, dateModified: 1 }), deckCard({ scryfallId: "s-atraxa", count: 1 })] }],
		});
		await p.importDecklistToDeck("d1", "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n4 Lightning Bolt", progress());
		expect(byScryfallId(deckCards(p), "s-bolt")).toMatchObject({ count: 6, dateModified: NOW });
		// the existing Atraxa is NOT a Commander: the imported Commander line is a separate row
		expect(deckCards(p).filter((c) => c.scryfallId === "s-atraxa")).toHaveLength(2);
	});

	it("the same card on two lines of the text ends up as one row with both quantities", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt"]);
		const p = plugin();
		const r = await p.importDecklistToDeck("d1", "2 Lightning Bolt\n3 Lightning Bolt", progress());
		expect(deckCards(p)).toHaveLength(1);
		expect(deckCards(p)[0].count).toBe(5);
		expect(r.added).toBe(2);
		expect(fetchMock.mock.calls[0][0]).toEqual(["s-bolt"]);
	});

	it("reports its progress", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt", "s-ring"]);
		const onProgress = progress();
		await plugin().importDecklistToDeck("d1", "4 Lightning Bolt\n1 Sol Ring", onProgress);
		const messages = onProgress.mock.calls.map((c) => c[0]);
		expect(messages).toContain("Parsed 2 card(s)…");
		expect(messages).toContain("Resolving Lightning Bolt (1/2)…");
		expect(messages).toContain("Resolving Sol Ring (2/2)…");
	});
});

describe("decklist pasted into a collection list or a wantlist", () => {
	const names = { "lightning bolt": "s-bolt", "sol ring": "s-ring" };

	it("importDecklistToList creates owned cards with no language or condition, in the list, and lights 'recently added'", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt", "s-ring"]);
		const p = plugin();
		const r = await p.importDecklistToList("lA", "4 Lightning Bolt\n1 Sol Ring\n1 Unknown", progress());
		expect(r).toEqual({ added: 2, updated: 0, unresolved: ["1 Unknown"] });
		expect(p.settings.collection.map((c: Obj) => [c.scryfallId, c.count, c.finish, c.language, c.condition, c.listId])).toEqual([
			["s-bolt", 4, "regular", "", "", "lA"],
			["s-ring", 1, "regular", "", "", "lA"],
		]);
		expect(p.recentlyAddedCollectionCardIds.size).toBe(2);
	});

	it("importDecklistToList adds to an existing regular row with no language or condition, and not to any other", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt"]);
		// the rows that must NOT be merged into come first: only the right key reaches the plain one
		const p = plugin({
			collection: [
				colCard({ id: "fr", scryfallId: "s-bolt", listId: "lA", language: "fr", condition: "", count: 7 }),
				colCard({ id: "lp", scryfallId: "s-bolt", listId: "lA", language: "", condition: "LP", count: 8 }),
				colCard({ id: "plain", scryfallId: "s-bolt", listId: "lA", language: "", condition: "", count: 2 }),
			],
		});
		const r = await p.importDecklistToList("lA", "3 Lightning Bolt", progress());
		expect(r).toMatchObject({ added: 0, updated: 1 });
		expect(p.settings.collection.map((c: Obj) => c.count)).toEqual([7, 8, 5]);
		expect(p.settings.collection[2].dateModified).toBe(NOW);
	});

	it("importDecklistToWantlist adds to an existing REGULAR wanted card only, never to a foil one", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt"]);
		const p = plugin({
			wantlist: [
				wantCard({ id: "foil", scryfallId: "s-bolt", listId: "wA", finish: "foiled", count: 7 }),
				wantCard({ id: "plain", scryfallId: "s-bolt", listId: "wA", finish: "regular", count: 2 }),
			],
		});
		await p.importDecklistToWantlist("wA", "3 Lightning Bolt", progress());
		expect(p.settings.wantlist.map((c: Obj) => c.count)).toEqual([7, 5]);
		const q = plugin({ wantlist: [wantCard({ id: "foil", scryfallId: "s-bolt", listId: "wA", finish: "foiled", count: 7 })] });
		await q.importDecklistToWantlist("wA", "3 Lightning Bolt", progress());
		expect(q.settings.wantlist).toHaveLength(2);
	});

	it("importDecklistToList and importDecklistToWantlist throw for an unknown target", async () => {
		const p = plugin();
		await expect(p.importDecklistToList("nope", "1 Bolt", progress())).rejects.toThrow("List not found.");
		await expect(p.importDecklistToWantlist("nope", "1 Bolt", progress())).rejects.toThrow("Wantlist not found.");
	});

	it("importDecklistToWantlist creates wanted cards (no language/condition) and merges by card + wantlist + finish", async () => {
		searchKnows(names);
		scryfallKnows(["s-bolt", "s-ring"]);
		const p = plugin({ wantlist: [wantCard({ id: "w", scryfallId: "s-bolt", listId: "wA", count: 1 })] });
		const r = await p.importDecklistToWantlist("wA", "4 Lightning Bolt\n1 Sol Ring", progress());
		expect(r).toEqual({ added: 1, updated: 1, unresolved: [] });
		expect(p.settings.wantlist.map((c: Obj) => [c.scryfallId, c.count])).toEqual([["s-bolt", 5], ["s-ring", 1]]);
		expect(p.settings.wantlist[1]).not.toHaveProperty("language");
		expect(p.recentlyAddedWantlistCardIds.size).toBe(2);
	});

	it("an empty text answers its unparsed lines and changes nothing", async () => {
		const p = plugin();
		expect(await p.importDecklistToList("lA", "", progress())).toEqual({ added: 0, updated: 0, unresolved: [] });
		expect(await p.importDecklistToWantlist("wA", "", progress())).toEqual({ added: 0, updated: 0, unresolved: [] });
		expect(saves(p)).toBe(0);
	});
});

// What every importer shares: a search that fails gets one more try after a pause, and a line that is not a card at
// all is handed back to the person. Run on the three decklist importers and the three CSV importers.
describe("what all the importers do the same way", () => {
	const csvHeader = "Quantity,Card Name,Set Code,Number,Finish,Language,Condition,Scryfall ID";
	const importers: [string, (p: TestPlugin, onProgress: (m: string) => void) => Promise<Obj>, string][] = [
		["importDecklistToDeck", (p, pr) => p.importDecklistToDeck("d1", "4 Bolt", pr), "decklist"],
		["importDecklistToList", (p, pr) => p.importDecklistToList("lA", "4 Bolt", pr), "decklist"],
		["importDecklistToWantlist", (p, pr) => p.importDecklistToWantlist("wA", "4 Bolt", pr), "decklist"],
		["importDeckCsv", (p, pr) => p.importDeckCsv("d1", `${csvHeader}\n1,Bolt,,,,,,`, pr), "csv"],
		["importCsv", (p, pr) => p.importCsv(`${csvHeader}\n1,Bolt,,,,,,`, pr, "lA"), "csv"],
		["importWantlistCsv", (p, pr) => p.importWantlistCsv(`${csvHeader}\n1,Bolt,,,,,,`, pr, "wA"), "csv"],
	];

	it.each(importers)("%s retries a search that failed once, after a pause of 300 ms", async (_name, run) => {
		scryfallKnows(["s1"]);
		let n = 0;
		searchMock.mockImplementation(async () => {
			if (n++ === 0) throw new Error("429");
			return { cards: [scry("s1")], hasMore: false, totalCards: 1 };
		});
		const r = await run(plugin(), progress());
		expect(r.added).toBe(1);
		expect(sleepMock).toHaveBeenCalledWith(300);
		expect(searchMock).toHaveBeenCalledTimes(2);
	});

	it.each(importers)("%s gives up on a card whose search fails twice, and still finishes", async (_name, run) => {
		searchMock.mockRejectedValue(new Error("offline"));
		const p = plugin();
		const r = await run(p, progress());
		expect(r.added).toBe(0);
		expect(searchMock).toHaveBeenCalledTimes(2);
		expect(saves(p)).toBe(1);
	});

	it.each(importers.filter((i) => i[2] === "decklist"))("%s hands back a line that is not a card instead of dropping it", async (name) => {
		searchKnows({ bolt: "s1" });
		scryfallKnows(["s1"]);
		const text = "4 Bolt\n(C21) 263";
		const p = plugin();
		const call: Record<string, () => Promise<Obj>> = {
			importDecklistToDeck: () => p.importDecklistToDeck("d1", text, progress()),
			importDecklistToList: () => p.importDecklistToList("lA", text, progress()),
			importDecklistToWantlist: () => p.importDecklistToWantlist("wA", text, progress()),
		};
		const r = await call[name]();
		expect(r.unresolved).toEqual(["(C21) 263"]);
		expect(r.added).toBe(1);
	});
});

describe("CSV into a collection (importCsv)", () => {
	const header = "Quantity,Card Name,Set Code,Number,Finish,Language,Condition,Scryfall ID";

	it("throws for an empty file, a file with only a header, and a file with no name column (naming the columns found)", async () => {
		const p = plugin();
		await expect(p.importCsv("", progress())).rejects.toThrow("Empty or invalid CSV file.");
		await expect(p.importCsv(header, progress())).rejects.toThrow("Empty or invalid CSV file.");
		await expect(p.importCsv("Qty,Edition\n1,Alpha", progress())).rejects.toThrow("Columns found: Qty, Edition");
		expect(saves(p)).toBe(0);
	});

	it("imports rows that carry a Scryfall id without searching, into the given list", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		const r = await p.importCsv(`${header}\n3,Lightning Bolt,lea,161,foil,fr,LP,s1`, progress(), "lA");
		expect(r).toEqual({ added: 1, updated: 0, skipped: 0 });
		expect(searchMock).not.toHaveBeenCalled();
		expect(p.settings.collection[0]).toMatchObject({
			scryfallId: "s1",
			name: "Card s1",
			listId: "lA",
			count: 3,
			finish: "foiled",
			language: "fr",
			condition: "LP",
			dateAdded: NOW,
			imageUrl: "https://img/s1-normal.jpg",
		});
		expect(p.recentlyAddedCollectionCardIds.size).toBe(1);
		expect(saves(p)).toBe(1);
	});

	it("without a target list, files each card in a list named after its set, creating it", async () => {
		scryfallKnows({ s1: { set_name: "Alpha" }, s2: { set_name: "Magic 2010" } });
		const p = plugin();
		await p.importCsv(`${header}\n1,A,lea,1,,,,s1\n1,B,m10,2,,,,s2`, progress());
		const alpha = p.settings.lists.find((l: Obj) => l.name === "Alpha")!;
		const m10 = p.settings.lists.find((l: Obj) => l.name === "Magic 2010")!;
		expect(p.settings.lists).toHaveLength(2);
		expect(byScryfallId(p.settings.collection, "s1").listId).toBe(alpha.id);
		expect(byScryfallId(p.settings.collection, "s2").listId).toBe(m10.id);
	});

	it.each([
		["0", 1],
		["-4", 1],
		["abc", 1],
		["", 1],
		["2.9", 2],
		["12", 12],
	])("a quantity of %j is imported as %s (never zero or negative)", async (qty, stored) => {
		scryfallKnows(["s1"]);
		const p = plugin();
		await p.importCsv(`${header}\n${qty},Bolt,,,,,,s1`, progress(), "lA");
		expect(p.settings.collection[0].count).toBe(stored);
	});

	it("understands the other spellings of the columns, case and spaces aside", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		await p.importCsv("Count, NAME ,SetCode,Collector Number,Foil,Lang,Condition,ScryfallID\n2,Bolt,lea,161,yes,DE,PL,s1", progress(), "lA");
		expect(p.settings.collection[0]).toMatchObject({ count: 2, finish: "foiled", language: "de", condition: "PL" });
	});

	it("an unknown language or finish falls back to 'no language' / regular", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		await p.importCsv(`${header}\n1,Bolt,,,sparkly,Klingon,,s1`, progress(), "lA");
		expect(p.settings.collection[0]).toMatchObject({ finish: "regular", language: "" });
	});

	it("reads grading and custom price columns, keeping only a known company and a numeric grade", async () => {
		scryfallKnows(["s1", "s2"]);
		const p = plugin();
		await p.importCsv("Name,Scryfall ID,Grading Company,Grade,Grading Label,Custom Price\nBolt,s1,PSA,9.5,Gem Mint,45.5\nBolt,s2,Acme,n/a,,", progress(), "lA");
		expect(byScryfallId(p.settings.collection, "s1")).toMatchObject({ gradingCompany: "PSA", gradingGrade: 9.5, gradingLabel: "Gem Mint", customPrice: "45.5" });
		const s2 = byScryfallId(p.settings.collection, "s2");
		expect(s2.gradingCompany).toBeUndefined();
		expect(s2.gradingGrade).toBeUndefined();
	});

	it("adds the quantity to a row already in the list with the same card, finish, language and condition, and refreshes its price", async () => {
		scryfallKnows({ s1: { prices: { usd: "9.99" } } });
		const p = plugin({ collection: [colCard({ id: "have", scryfallId: "s1", listId: "lA", finish: "foiled", language: "fr", condition: "LP", count: 2, priceUsd: "1.00" })] });
		const r = await p.importCsv(`${header}\n3,Bolt,,,foil,fr,LP,s1`, progress(), "lA");
		expect(r).toEqual({ added: 0, updated: 1, skipped: 0 });
		expect(p.settings.collection).toHaveLength(1);
		expect(p.settings.collection[0]).toMatchObject({ count: 5, priceUsd: "9.99", dateModified: NOW });
		expect(p.recentlyAddedCollectionCardIds.has("have")).toBe(true);
	});

	it.each([
		["finish", "regular,fr,LP"],
		["language", "foil,de,LP"],
		["condition", "foil,fr,NM"],
	])("a row that differs only by %s is a separate row", async (_label, cells) => {
		scryfallKnows(["s1"]);
		const p = plugin({ collection: [colCard({ id: "have", scryfallId: "s1", listId: "lA", finish: "foiled", language: "fr", condition: "LP", count: 2 })] });
		await p.importCsv(`${header}\n1,Bolt,,,${cells},s1`, progress(), "lA");
		expect(p.settings.collection).toHaveLength(2);
	});

	it("resolves a row with no Scryfall id by name, set and number; a row Scryfall does not know is skipped", async () => {
		searchKnows({ bolt: "s1" });
		scryfallKnows(["s1"]);
		const p = plugin();
		const r = await p.importCsv(`${header}\n1,Bolt,lea,161,,,,\n1,Not A Card,xxx,1,,,,`, progress(), "lA");
		expect(r).toEqual({ added: 1, updated: 0, skipped: 1 });
		expect(searchMock.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([["Bolt", "lea", "161"], ["Not A Card", "xxx", "1"]]);
		expect(p.settings.collection).toHaveLength(1);
	});

	it("ignores a row with no name, and imports a name that has a comma or a quote in it", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		const r = await p.importCsv(`${header}\n2,,,,,,,s1\n1,"Urza, Lord ""High"" Artificer",,,,,,s1`, progress(), "lA");
		expect(r.added).toBe(1);
		expect(p.settings.collection[0].count).toBe(1);
	});

	it("retries a failed search once, after a pause", async () => {
		scryfallKnows(["s1"]);
		let n = 0;
		searchMock.mockImplementation(async () => {
			if (n++ === 0) throw new Error("429");
			return { cards: [scry("s1")], hasMore: false, totalCards: 1 };
		});
		const p = plugin();
		const r = await p.importCsv(`${header}\n1,Bolt,,,,,,`, progress(), "lA");
		expect(r).toMatchObject({ added: 1, skipped: 0 });
		expect(sleepMock).toHaveBeenCalledWith(300);
	});

	it("a row whose card Scryfall's grouped answer lacks is still imported, from the CSV's own data", async () => {
		scryfallKnows([]);
		const p = plugin();
		await p.importCsv(`${header}\n2,Bolt,LEA,161,,,,s1`, progress(), "lA");
		expect(p.settings.collection[0]).toMatchObject({ scryfallId: "s1", name: "Bolt", setCode: "lea", collectorNumber: "161", count: 2, imageUrl: "", manaValue: 0 });
	});

	// Regression tests for a defect found by the audit of 2026-11-15 (lot 2) and fixed in the same series.
	// `(scry?.set ?? row.setCode).toLowerCase()` threw when Scryfall did not answer for a row AND that row was shorter
	// than the header (a cell of the set-code column missing): the import stopped half way with "Cannot read properties
	// of undefined" and the rows added before stayed in memory, to be saved by the next save. A missing cell is now an
	// empty cell (`cell()` in import-export.ts), in the three CSV importers.
	it("a row shorter than the header, for a card Scryfall does not answer for, does not abort the import", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		const csv = "Name,Scryfall ID,Set Code\nBolt,s1,lea\nShort row,unknown-id";
		await expect(p.importCsv(csv, progress(), "lA")).resolves.toMatchObject({ added: 2 });
		expect(p.settings.collection.map((c: Obj) => [c.name, c.setCode])).toEqual([["Card s1", "lea"], ["Short row", ""]]);
		expect(saves(p)).toBe(1);
	});

	it("a missing cell is an empty cell for every text column, as if the row had been padded", async () => {
		scryfallKnows([]);
		const csv = "Name,Scryfall ID,Set Code,Set,Number,Rarity,Type Line,Mana Cost,Condition\nShort row,unknown-id";
		const p = plugin();
		await p.importCsv(csv, progress(), "lA");
		expect(p.settings.collection[0]).toMatchObject({ name: "Short row", setCode: "", setName: "", collectorNumber: "", rarity: "", typeLine: "", manaCost: "", condition: "" });
	});

	it("a short row merges with an existing card exactly like the same row with empty trailing cells", async () => {
		scryfallKnows(["s1"]);
		const header = "Name,Scryfall ID,Language,Condition";
		const make = () => plugin({ collection: [colCard({ id: "have", scryfallId: "s1", listId: "lA", finish: "regular", language: "", condition: "", count: 2 })] });
		const short = make();
		await short.importCsv(`${header}\nBolt,s1`, progress(), "lA");
		const padded = make();
		await padded.importCsv(`${header}\nBolt,s1,,`, progress(), "lA");
		expect(short.settings.collection).toHaveLength(1);
		expect(short.settings.collection[0].count).toBe(3);
		expect(short.settings.collection).toEqual(padded.settings.collection);
	});

	it("importWantlistCsv and importDeckCsv do not abort on a short row either", async () => {
		scryfallKnows(["s1"]);
		const csv = "Name,Scryfall ID,Set Code\nBolt,s1,lea\nShort row,unknown-id";
		const w = plugin();
		await expect(w.importWantlistCsv(csv, progress(), "wA")).resolves.toMatchObject({ added: 2 });
		expect(w.settings.wantlist.map((c: Obj) => c.setCode)).toEqual(["lea", ""]);
		const d = plugin();
		await expect(d.importDeckCsv("d1", csv, progress())).resolves.toMatchObject({ added: 2 });
		expect(deckCards(d).map((c) => c.setCode)).toEqual(["lea", ""]);
	});

	it("a row whose set-code cell is present is unchanged: still lower-cased and trimmed", async () => {
		scryfallKnows([]);
		const p = plugin();
		await p.importCsv("Name,Scryfall ID,Set Code,Number\nBolt,unknown, LEA ,  161 ", progress(), "lA");
		expect(p.settings.collection[0]).toMatchObject({ setCode: "lea", collectorNumber: "161" });
	});
});

describe("CSV into a wantlist (importWantlistCsv)", () => {
	const header = "Quantity,Card Name,Set Code,Number,Finish,Language,Condition,Scryfall ID";

	it("throws like the collection import for an invalid file", async () => {
		const p = plugin();
		await expect(p.importWantlistCsv("", progress())).rejects.toThrow("Empty or invalid CSV file.");
		await expect(p.importWantlistCsv("Qty\n1", progress())).rejects.toThrow("Columns found: Qty");
	});

	it("imports into the given wantlist and ignores the language and condition columns", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		const r = await p.importWantlistCsv(`${header}\n3,Bolt,lea,161,etched,fr,LP,s1`, progress(), "wA");
		expect(r).toEqual({ added: 1, updated: 0, skipped: 0 });
		expect(p.settings.wantlist[0]).toMatchObject({ scryfallId: "s1", listId: "wA", count: 3, finish: "etched" });
		expect(p.settings.wantlist[0]).not.toHaveProperty("language");
		expect(p.settings.wantlist[0]).not.toHaveProperty("condition");
	});

	it("without a target, files each card in a wantlist named after its set", async () => {
		scryfallKnows({ s1: { set_name: "Alpha" } });
		const p = plugin();
		await p.importWantlistCsv(`${header}\n1,Bolt,lea,1,,,,s1`, progress());
		const created = p.settings.wantlists.find((w: Obj) => w.name === "Alpha")!;
		expect(p.settings.wantlist[0].listId).toBe(created.id);
	});

	it("adds the quantity to a wanted card with the same card, wantlist and finish", async () => {
		scryfallKnows(["s1"]);
		const p = plugin({ wantlist: [wantCard({ id: "w", scryfallId: "s1", listId: "wA", finish: "regular", count: 2 })] });
		const r = await p.importWantlistCsv(`${header}\n3,Bolt,,,,en,NM,s1`, progress(), "wA");
		expect(r).toEqual({ added: 0, updated: 1, skipped: 0 });
		expect(p.settings.wantlist[0].count).toBe(5);
		const q = plugin({ wantlist: [wantCard({ id: "w", scryfallId: "s1", listId: "wA", finish: "foiled", count: 2 })] });
		await q.importWantlistCsv(`${header}\n3,Bolt,,,regular,,,s1`, progress(), "wA");
		expect(q.settings.wantlist).toHaveLength(2);
	});

	it.each([
		["0", 1],
		["-1", 1],
		["x", 1],
		["4", 4],
	])("a quantity of %j is imported as %s", async (qty, stored) => {
		scryfallKnows(["s1"]);
		const p = plugin();
		await p.importWantlistCsv(`${header}\n${qty},Bolt,,,,,,s1`, progress(), "wA");
		expect(p.settings.wantlist[0].count).toBe(stored);
	});

	it("skips what Scryfall does not know", async () => {
		const p = plugin();
		const r = await p.importWantlistCsv(`${header}\n1,Not A Card,,,,,,`, progress(), "wA");
		expect(r).toEqual({ added: 0, updated: 0, skipped: 1 });
	});
});

describe("CSV into one deck (importDeckCsv)", () => {
	const header = "Quantity,Card Name,Set Code,Number,Finish,Language,Condition,Scryfall ID";

	it("throws for an unknown deck, an empty file and a file with no name column", async () => {
		const p = plugin();
		await expect(p.importDeckCsv("nope", `${header}\n1,Bolt,,,,,,s1`, progress())).rejects.toThrow("Deck not found.");
		await expect(p.importDeckCsv("d1", "", progress())).rejects.toThrow("Empty or invalid CSV file.");
		await expect(p.importDeckCsv("d1", "Qty\n1", progress())).rejects.toThrow("Columns found: Qty");
	});

	it("adds each row as a mainboard card with the file's finish, language, condition, grading and custom price", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		const r = await p.importDeckCsv("d1", "Quantity,Card Name,Finish,Language,Condition,Grading Company,Grade,Custom Price,Scryfall ID\n2,Bolt,foil,fr,LP,BGS,9,12,s1", progress());
		expect(r).toEqual({ added: 1, updated: 0, skipped: 0 });
		expect(deckCards(p)[0]).toMatchObject({ scryfallId: "s1", count: 2, finish: "foiled", language: "fr", condition: "LP", gradingCompany: "BGS", gradingGrade: 9, customPrice: "12", dateAdded: NOW });
		expect(deckCards(p)[0].category).toBeUndefined();
	});

	it("adds to an existing MAINBOARD row of the card without touching its finish, language or condition, and refreshes its price", async () => {
		scryfallKnows({ s1: { prices: { usd: "7.00" } } });
		const p = plugin({ decks: [{ id: "d1", name: "D", dateCreated: 1, cards: [deckCard({ scryfallId: "s1", count: 2, finish: "etched", language: "de", condition: "NM", priceUsd: "1.00" })] }] });
		const r = await p.importDeckCsv("d1", `${header}\n3,Bolt,,,foil,fr,LP,s1`, progress());
		expect(r).toEqual({ added: 0, updated: 1, skipped: 0 });
		expect(deckCards(p)).toHaveLength(1);
		expect(deckCards(p)[0]).toMatchObject({ count: 5, finish: "etched", language: "de", condition: "NM", priceUsd: "7.00", dateModified: NOW });
	});

	it("does not add to a sideboard row of the same card: that is another board", async () => {
		scryfallKnows(["s1"]);
		const p = plugin({ decks: [{ id: "d1", name: "D", dateCreated: 1, cards: [deckCard({ scryfallId: "s1", count: 2, category: "sideboard" })] }] });
		await p.importDeckCsv("d1", `${header}\n1,Bolt,,,,,,s1`, progress());
		expect(deckCards(p)).toHaveLength(2);
	});

	it("an unknown language or finish falls back to none / regular, and an unknown grading company or a non-numeric grade is ignored", async () => {
		scryfallKnows(["s1"]);
		const p = plugin();
		await p.importDeckCsv("d1", "Name,Finish,Language,Grading Company,Grade,Scryfall ID\nBolt,sparkly,Klingon,Acme,n/a,s1", progress());
		expect(deckCards(p)[0]).toMatchObject({ finish: "regular", language: "" });
		expect(deckCards(p)[0].gradingCompany).toBeUndefined();
		expect(deckCards(p)[0].gradingGrade).toBeUndefined();
	});

	it("resolves a row with no Scryfall id by name and skips what Scryfall does not know", async () => {
		searchKnows({ bolt: "s1" });
		scryfallKnows(["s1"]);
		const p = plugin();
		const r = await p.importDeckCsv("d1", `${header}\n1,Bolt,lea,161,,,,\n1,Nothing,,,,,,`, progress());
		expect(r).toEqual({ added: 1, updated: 0, skipped: 1 });
	});

	it.each([
		["0", 1],
		["-9", 1],
		["many", 1],
		["3", 3],
	])("a quantity of %j is imported as %s", async (qty, stored) => {
		scryfallKnows(["s1"]);
		const p = plugin();
		await p.importDeckCsv("d1", `${header}\n${qty},Bolt,,,,,,s1`, progress());
		expect(deckCards(p)[0].count).toBe(stored);
	});
});

describe("saved search filters", () => {
	it("saveSearchFilter stores a COPY of the chips, so the window changing its own list later changes nothing", () => {
		const p = plugin();
		const tokens = ["red", "rare"];
		const f = p.saveSearchFilter("Red rares", tokens, { order: "usd", dir: "desc" });
		tokens.push("mythic");
		expect(f).toMatchObject({ label: "Red rares", tokens: ["red", "rare"], sortOverride: { order: "usd", dir: "desc" } });
		expect(f.id).toBeTruthy();
		expect(p.settings.savedSearchFilters).toEqual([f]);
		expect(saves(p)).toBe(1);
		expect(p.saveSearchFilter("None", [], null).sortOverride).toBeNull();
	});

	it("deleteSearchFilter removes only that filter", () => {
		const p = plugin();
		const a = p.saveSearchFilter("A", ["x"], null);
		const b = p.saveSearchFilter("B", ["y"], null);
		p.deleteSearchFilter(a.id);
		expect(p.settings.savedSearchFilters).toEqual([b]);
		p.deleteSearchFilter("unknown");
		expect(p.settings.savedSearchFilters).toEqual([b]);
	});
});
