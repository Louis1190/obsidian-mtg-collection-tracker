import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// collection-mutations.ts imports api/scryfall.ts, which imports `requestUrl` from "obsidian" (types only, no runtime).
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import * as collectionMutations from "./collection-mutations";
import { colCard, idsOf, makePlugin, saves, scry, totalCount, wantCard } from "./__tests__/plugin-harness";
import type { Obj, TestPlugin } from "./__tests__/plugin-harness";

// Characterization tests (audit of 2026-11-15, lot 2): they describe what these functions do TODAY on the user's cards
// and lists. Nothing here was changed in the code to make a test pass.

const NOW = 5000;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const inbox = { id: "inbox", name: "Inbox", dateCreated: 1, isInbox: true };
const listA = { id: "lA", name: "Alpha", dateCreated: 2 };
const listB = { id: "lB", name: "Beta", dateCreated: 3 };

function plugin(collection: Obj[] = [], extra: Obj = {}): TestPlugin {
	return makePlugin([collectionMutations], { lists: [inbox, listA, listB], collection, ...extra });
}
const row = (p: TestPlugin, id: string): Obj => p.settings.collection.find((c: Obj) => c.id === id)!;

describe("lists: creating and finding", () => {
	it("createListSilent adds a list with a fresh id and today's date, and does not save", () => {
		const p = plugin();
		const l = p.createListSilent("Trades");
		expect(l).toMatchObject({ name: "Trades", dateCreated: NOW });
		expect(l.id).toBeTruthy();
		expect(p.settings.lists.at(-1)).toBe(l);
		expect(saves(p)).toBe(0);
	});

	it("createList does the same and saves once", () => {
		const p = plugin();
		const a = p.createList("One");
		const b = p.createList("Two");
		expect(a.id).not.toBe(b.id);
		expect(saves(p)).toBe(2);
		expect(p.settings.lists.map((l: Obj) => l.name)).toEqual(["Inbox", "Alpha", "Beta", "One", "Two"]);
	});

	it("getOrCreateListByName returns the list that has that name, else creates it", () => {
		const p = plugin();
		expect(p.getOrCreateListByName("Alpha")).toBe(p.settings.lists[1]);
		expect(p.settings.lists).toHaveLength(3);
		const created = p.getOrCreateListByName("Gamma");
		expect(created.name).toBe("Gamma");
		expect(p.settings.lists).toHaveLength(4);
	});

	it("getOrCreateListByName falls back to 'Unsorted' for an empty name", () => {
		const p = plugin();
		expect(p.getOrCreateListByName("").name).toBe("Unsorted");
	});
});

describe("adding a card (addCardToCollection)", () => {
	const options = { finish: "regular", language: "en", condition: "NM" } as const;

	it("creates a row with the card's data, the chosen finish/language/condition and the list", () => {
		const p = plugin();
		const r = p.addCardToCollection(scry("s1", { name: "Lightning Bolt" }), "lA", options);
		expect(r).toMatchObject({
			scryfallId: "s1",
			name: "Lightning Bolt",
			setCode: "lea",
			setName: "Limited Edition Alpha",
			collectorNumber: "1",
			rarity: "rare",
			manaValue: 2,
			count: 1,
			finish: "regular",
			language: "en",
			condition: "NM",
			listId: "lA",
			dateAdded: NOW,
			dateModified: NOW,
			imageUrl: "https://img/s1-normal.jpg",
			artCropUrl: "https://img/s1-art.jpg",
			priceUsd: "1.00",
			priceEurFoil: "1.80",
			oracleText: "Rules text of s1",
			borderColor: "black",
		});
		expect(p.settings.collection).toEqual([r]);
		expect(p.recentlyAddedCollectionCardIds.has(r.id)).toBe(true);
		expect(saves(p)).toBe(1);
	});

	it("adding the same card again, same list/finish/language/condition, raises the count instead of adding a row", () => {
		const p = plugin();
		const first = p.addCardToCollection(scry("s1"), "lA", options);
		vi.setSystemTime(NOW + 100);
		const second = p.addCardToCollection(scry("s1"), "lA", options);
		expect(second).toBe(first);
		expect(p.settings.collection).toHaveLength(1);
		expect(first.count).toBe(2);
		expect(first.dateModified).toBe(NOW + 100);
		expect(first.dateAdded).toBe(NOW);
	});

	it.each([
		["another list", "lB", options],
		["another finish", "lA", { ...options, finish: "foiled" }],
		["another language", "lA", { ...options, language: "fr" }],
		["another condition", "lA", { ...options, condition: "LP" }],
	] as const)("%s is a separate row", (_label, listId, opts) => {
		const p = plugin();
		p.addCardToCollection(scry("s1"), "lA", options);
		p.addCardToCollection(scry("s1"), listId, opts);
		expect(p.settings.collection).toHaveLength(2);
	});

	it("tells the printed-name cache about the card it was handed", () => {
		const p = plugin();
		const card = scry("s1");
		p.addCardToCollection(card, "lA", options);
		expect(p.rememberPrintedName).toHaveBeenCalledWith(card);
	});

	it("keeps empty strings, not undefined, for what the card does not have", () => {
		const p = plugin();
		const bare = scry("s9", { mana_cost: undefined, cmc: undefined, artist: undefined, colors: undefined, prices: undefined, border_color: undefined });
		const r = p.addCardToCollection(bare, "lA", options);
		expect(r).toMatchObject({ manaCost: "", manaValue: 0, artist: "", colors: [], priceUsd: "", priceEur: "", borderColor: "" });
	});
});

describe("quantity", () => {
	it("changeCollectionCardCount adds the delta, bumps dateModified, saves and calls onDone", () => {
		const p = plugin([colCard({ count: 3 })]);
		const done = vi.fn();
		p.changeCollectionCardCount("c1", 2, done);
		expect(row(p, "c1")).toMatchObject({ count: 5, dateModified: NOW });
		expect(saves(p)).toBe(1);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("changeCollectionCardCount never goes below 1 (removing a card is the delete button's job)", () => {
		const p = plugin([colCard({ count: 2 })]);
		p.changeCollectionCardCount("c1", -10, () => {});
		expect(row(p, "c1").count).toBe(1);
	});

	it("an unknown id changes nothing, saves nothing and never calls onDone", () => {
		const p = plugin([colCard()]);
		const done = vi.fn();
		p.changeCollectionCardCount("nope", 1, done);
		p.setCollectionCardCount("nope", 4, done);
		expect(done).not.toHaveBeenCalled();
		expect(saves(p)).toBe(0);
		expect(row(p, "c1").count).toBe(1);
	});

	it.each([
		[7, 7],
		[2.9, 2],
		[0, 1],
		[-3, 1],
		[NaN, 1],
		[Infinity, 1],
	])("setCollectionCardCount(%s) stores %s", (input, stored) => {
		const p = plugin([colCard({ count: 4 })]);
		p.setCollectionCardCount("c1", input, () => {});
		// Infinity: Math.floor(Infinity) is Infinity, which is truthy: the characterization says what it really does
		expect(row(p, "c1").count).toBe(input === Infinity ? Infinity : stored);
	});

	it("bulkSetCollectionCardCount applies the same clamp to every selected row and only to them", () => {
		const p = plugin([colCard({ id: "a", count: 4 }), colCard({ id: "b", count: 4 }), colCard({ id: "c", count: 4 })]);
		p.bulkSetCollectionCardCount(["a", "c"], 0);
		expect(p.settings.collection.map((c: Obj) => c.count)).toEqual([1, 4, 1]);
		p.bulkSetCollectionCardCount(["b"], 6.8);
		expect(row(p, "b").count).toBe(6);
	});
});

describe("single-field setters", () => {
	it.each([
		["setCollectionCardLanguage", "language", "fr"],
		["setCollectionCardCondition", "condition", "MT"],
		["setCollectionCardFinish", "finish", "etched"],
	] as const)("%s sets %s, bumps dateModified and saves; an unknown id does nothing", (method, field, value) => {
		const p = plugin([colCard()]);
		(p as Obj)[method]("c1", value);
		expect(row(p, "c1")[field]).toBe(value);
		expect(row(p, "c1").dateModified).toBe(NOW);
		expect(saves(p)).toBe(1);
		(p as Obj)[method]("missing", "x");
		expect(saves(p)).toBe(1);
	});

	it("setCollectionCardGrading sets the three grading fields and can clear them with undefined", () => {
		const p = plugin([colCard({ customPrice: "12" })]);
		p.setCollectionCardGrading("c1", "PSA", 9.5, "Gem");
		expect(row(p, "c1")).toMatchObject({ gradingCompany: "PSA", gradingGrade: 9.5, gradingLabel: "Gem", customPrice: "12", dateModified: NOW });
		p.setCollectionCardGrading("c1", undefined, undefined, undefined);
		expect(row(p, "c1")).toMatchObject({ gradingCompany: undefined, gradingGrade: undefined, gradingLabel: undefined, customPrice: "12" });
	});

	it("setCollectionCardCustomPrice trims, treats blank as 'no custom price', and leaves grading alone", () => {
		const p = plugin([colCard({ gradingCompany: "BGS", gradingGrade: 9 })]);
		p.setCollectionCardCustomPrice("c1", "  45.50 ");
		expect(row(p, "c1").customPrice).toBe("45.50");
		p.setCollectionCardCustomPrice("c1", "   ");
		expect(row(p, "c1").customPrice).toBeUndefined();
		expect(row(p, "c1")).toMatchObject({ gradingCompany: "BGS", gradingGrade: 9 });
	});

	it("bulk setters change only the selected rows, with one shared date, and save once", () => {
		const rows = [colCard({ id: "a" }), colCard({ id: "b" }), colCard({ id: "c" })];
		for (const [method, field, value] of [
			["bulkSetCollectionCardCondition", "condition", "PL"],
			["bulkSetCollectionCardLanguage", "language", "de"],
			["bulkSetCollectionCardFinish", "finish", "foiled"],
		] as const) {
			const p = plugin(structuredClone(rows));
			(p as Obj)[method](["a", "c"], value);
			expect(p.settings.collection.map((c: Obj) => c[field])).toEqual([value, colCard()[field], value]);
			expect(row(p, "a").dateModified).toBe(NOW);
			expect(row(p, "b").dateModified).toBe(1000);
			expect(saves(p)).toBe(1);
		}
	});
});

describe("removing and undoing", () => {
	it("removeCollectionCard removes only that row", () => {
		const p = plugin([colCard({ id: "a" }), colCard({ id: "b" })]);
		p.removeCollectionCard("a");
		expect(idsOf(p.settings.collection)).toEqual(["b"]);
		expect(saves(p)).toBe(1);
	});

	it("bulkRemoveCollectionCards removes the selection", () => {
		const p = plugin([colCard({ id: "a" }), colCard({ id: "b" }), colCard({ id: "c" })]);
		p.bulkRemoveCollectionCards(["a", "c", "unknown"]);
		expect(idsOf(p.settings.collection)).toEqual(["b"]);
	});

	describe("undoAddToCollection (the 'Add history' panel taking back what this session added)", () => {
		const key = { finish: "regular", language: "en", condition: "NM" } as const;

		it("takes `delta` copies off a row and leaves the rest", () => {
			const p = plugin([colCard({ count: 5 })]);
			const r = p.undoAddToCollection("s1", "l1", key, 2);
			expect(r).toBe(row(p, "c1"));
			expect(r!.count).toBe(3);
			expect(r!.dateModified).toBe(NOW);
		});

		it("deletes the row when nothing would remain, and answers undefined", () => {
			const p = plugin([colCard({ count: 2 })]);
			expect(p.undoAddToCollection("s1", "l1", key, 2)).toBeUndefined();
			expect(p.settings.collection).toEqual([]);
			const q = plugin([colCard({ count: 2 })]);
			expect(q.undoAddToCollection("s1", "l1", key, 5)).toBeUndefined();
			expect(q.settings.collection).toEqual([]);
		});

		it("finds the row by card + list + finish + language + condition, never by id", () => {
			const p = plugin([colCard({ count: 3 })]);
			expect(p.undoAddToCollection("s1", "OTHER LIST", key, 1)).toBeUndefined();
			expect(p.undoAddToCollection("s1", "l1", { ...key, finish: "foiled" }, 1)).toBeUndefined();
			expect(p.undoAddToCollection("s1", "l1", { ...key, language: "fr" }, 1)).toBeUndefined();
			expect(p.undoAddToCollection("s1", "l1", { ...key, condition: "PO" }, 1)).toBeUndefined();
			expect(row(p, "c1").count).toBe(3);
			expect(saves(p)).toBe(0);
		});
	});
});

describe("changeCollectionCardPrinting", () => {
	it("moves the card onto another printing: new identity, text, images and prices", () => {
		const p = plugin([colCard({ count: 4, finish: "foiled", language: "fr", condition: "LP", gradingCompany: "PSA", gradingGrade: 8, customPrice: "9" })]);
		p.changeCollectionCardPrinting("c1", scry("s2", { name: "New name", set: "m10", set_name: "Magic 2010", collector_number: "77", rarity: "mythic" }));
		expect(row(p, "c1")).toMatchObject({
			scryfallId: "s2",
			name: "New name",
			setCode: "m10",
			setName: "Magic 2010",
			collectorNumber: "77",
			rarity: "mythic",
			imageUrl: "https://img/s2-normal.jpg",
			priceUsd: "1.00",
			oracleText: "Rules text of s2",
			dateModified: NOW,
		});
	});

	it("keeps what belongs to the physical copy: quantity, finish, language, condition, list, dates of adding, grading, custom price", () => {
		const p = plugin([colCard({ count: 4, finish: "foiled", language: "fr", condition: "LP", gradingCompany: "PSA", gradingGrade: 8, gradingLabel: "x", customPrice: "9" })]);
		p.changeCollectionCardPrinting("c1", scry("s2"));
		expect(row(p, "c1")).toMatchObject({
			id: "c1",
			count: 4,
			finish: "foiled",
			language: "fr",
			condition: "LP",
			listId: "l1",
			dateAdded: 1000,
			gradingCompany: "PSA",
			gradingGrade: 8,
			gradingLabel: "x",
			customPrice: "9",
		});
	});

	it("falls back to empty strings when the new printing lacks a field, and ignores an unknown id", () => {
		const p = plugin([colCard()]);
		p.changeCollectionCardPrinting("c1", scry("s2", { prices: undefined, artist: undefined, released_at: undefined }));
		expect(row(p, "c1")).toMatchObject({ priceUsd: "", priceEur: "", artist: "", releasedAt: "" });
		const before = saves(p);
		p.changeCollectionCardPrinting("nope", scry("s3"));
		expect(saves(p)).toBe(before);
	});
});

describe("duplicates", () => {
	const dup = (id: string, over: Obj = {}) => colCard({ id, scryfallId: "sX", listId: "lA", ...over });

	it("findListDuplicateGroups groups identical card+list+finish+language+condition, oldest first, singles excluded", () => {
		const p = plugin([dup("late", { dateAdded: 30 }), dup("early", { dateAdded: 10 }), dup("mid", { dateAdded: 20 }), dup("alone", { scryfallId: "other" })]);
		const groups = p.findListDuplicateGroups();
		expect(groups).toHaveLength(1);
		expect(idsOf(groups[0])).toEqual(["early", "mid", "late"]);
	});

	it.each([
		["another finish", { finish: "foiled" }],
		["another language", { language: "fr" }],
		["another condition", { condition: "LP" }],
		["another list", { listId: "lB" }],
	])("%s is not a duplicate", (_label, over) => {
		const p = plugin([dup("a"), dup("b", over)]);
		expect(p.findListDuplicateGroups()).toEqual([]);
	});

	it("mergeListDuplicateGroup adds the quantities into the first row and deletes the others", () => {
		const p = plugin([dup("a", { count: 2, dateAdded: 1 }), dup("b", { count: 3, dateAdded: 2 }), dup("c", { count: 1, dateAdded: 3 }), dup("x", { scryfallId: "z" })]);
		const [group] = p.findListDuplicateGroups();
		const r = p.mergeListDuplicateGroup(group);
		expect(r).toEqual({ removed: 2 });
		expect(idsOf(p.settings.collection)).toEqual(["a", "x"]);
		expect(row(p, "a")).toMatchObject({ count: 6, dateModified: NOW });
		expect(saves(p)).toBe(1);
	});

	it("mergeListDuplicateGroup does nothing for a group of one, or when its first row is gone", () => {
		const p = plugin([dup("a")]);
		expect(p.mergeListDuplicateGroup([row(p, "a")] as never)).toEqual({ removed: 0 });
		expect(p.mergeListDuplicateGroup([])).toEqual({ removed: 0 });
		expect(p.mergeListDuplicateGroup([dup("ghost"), dup("a")] as never)).toEqual({ removed: 0 });
		expect(saves(p)).toBe(0);
		expect(p.settings.collection).toHaveLength(1);
	});

	it("mergeListDuplicates merges only the duplicates of the given list and counts them", () => {
		const p = plugin([
			dup("a1", { dateAdded: 1 }),
			dup("a2", { dateAdded: 2 }),
			dup("b1", { listId: "lB", dateAdded: 1 }),
			dup("b2", { listId: "lB", dateAdded: 2 }),
			dup("k1", { scryfallId: "k", dateAdded: 1 }),
			dup("k2", { scryfallId: "k", dateAdded: 2 }),
		]);
		expect(p.mergeListDuplicates("lA")).toEqual({ merged: 2, removed: 2 });
		expect(idsOf(p.settings.collection)).toEqual(["a1", "b1", "b2", "k1"]);
		expect(p.mergeListDuplicates("lA")).toEqual({ merged: 0, removed: 0 });
	});
});

describe("deleting, emptying and renaming lists", () => {
	const cards = () => [colCard({ id: "a", listId: "lA" }), colCard({ id: "b", listId: "lB" }), colCard({ id: "i", listId: "inbox" })];

	it("deleteList removes the list and its cards, and only those", () => {
		const p = plugin(cards());
		p.deleteList("lA");
		expect(p.settings.lists.map((l: Obj) => l.id)).toEqual(["inbox", "lB"]);
		expect(idsOf(p.settings.collection)).toEqual(["b", "i"]);
	});

	it("deleteList refuses the Inbox, even when called directly", () => {
		const p = plugin(cards());
		p.deleteList("inbox");
		expect(p.settings.lists).toHaveLength(3);
		expect(p.settings.collection).toHaveLength(3);
		expect(saves(p)).toBe(0);
	});

	it("clearList removes the cards and keeps the list (the Inbox included)", () => {
		const p = plugin(cards());
		p.clearList("inbox");
		expect(idsOf(p.settings.collection)).toEqual(["a", "b"]);
		expect(p.settings.lists).toHaveLength(3);
	});

	it("bulkDeleteLists deletes the selection with its cards but never the Inbox", () => {
		const p = plugin(cards());
		p.bulkDeleteLists(["lA", "inbox", "lB"]);
		expect(p.settings.lists.map((l: Obj) => l.id)).toEqual(["inbox"]);
		expect(idsOf(p.settings.collection)).toEqual(["i"]);
	});

	it("renameList renames, except the Inbox", () => {
		const p = plugin();
		p.renameList("lA", "Renamed");
		p.renameList("inbox", "Hacked");
		expect(p.settings.lists.map((l: Obj) => l.name)).toEqual(["Inbox", "Renamed", "Beta"]);
		expect(saves(p)).toBe(1);
	});

	it("cover card and icon can be set and cleared, and an unknown list is ignored", () => {
		const p = plugin();
		p.setListCoverCard("lA", "card9");
		p.setListIcon("lA", { type: "mana", value: "r" } as never);
		expect(p.settings.lists[1]).toMatchObject({ coverCardId: "card9", listIcon: { type: "mana", value: "r" } });
		p.setListCoverCard("lA", undefined);
		p.setListIcon("lA", undefined);
		expect(p.settings.lists[1].coverCardId).toBeUndefined();
		expect(p.settings.lists[1].listIcon).toBeUndefined();
		const before = saves(p);
		p.setListCoverCard("nope", "x");
		p.setListIcon("nope", undefined);
		expect(saves(p)).toBe(before);
	});
});

describe("mergeLists", () => {
	it("moves every card of the merged lists into a new list, deletes the originals and keeps the other lists", () => {
		const p = plugin([colCard({ id: "a", listId: "lA" }), colCard({ id: "b", scryfallId: "s2", listId: "lB" }), colCard({ id: "i", scryfallId: "s3", listId: "inbox" })]);
		const merged = p.mergeLists(["lA", "lB"], "Together");
		expect(merged.name).toBe("Together");
		expect(p.settings.lists.map((l: Obj) => l.id)).toEqual(["inbox", merged.id]);
		expect(p.settings.collection.map((c: Obj) => c.listId)).toEqual([merged.id, merged.id, "inbox"]);
		expect(idsOf(p.settings.collection)).toEqual(["a", "b", "i"]);
	});

	it("merges the cards that become identical, adding their quantities", () => {
		const p = plugin([colCard({ id: "a", listId: "lA", count: 2, dateAdded: 1 }), colCard({ id: "b", listId: "lB", count: 3, dateAdded: 2 })]);
		const merged = p.mergeLists(["lA", "lB"], "Together");
		expect(p.settings.collection).toHaveLength(1);
		expect(p.settings.collection[0]).toMatchObject({ id: "a", count: 5, listId: merged.id });
	});

	it("never deletes or empties the Inbox, even when it is in the selection", () => {
		const p = plugin([colCard({ id: "i", listId: "inbox" }), colCard({ id: "a", scryfallId: "s2", listId: "lA" })]);
		const merged = p.mergeLists(["inbox", "lA"], "Together");
		expect(p.settings.lists.some((l: Obj) => l.id === "inbox")).toBe(true);
		expect(row(p, "i").listId).toBe("inbox");
		expect(row(p, "a").listId).toBe(merged.id);
	});

	it("conserves the total number of copies", () => {
		const cards = [
			colCard({ id: "a", listId: "lA", count: 2, dateAdded: 1 }),
			colCard({ id: "b", listId: "lB", count: 5, dateAdded: 2 }),
			colCard({ id: "c", scryfallId: "s2", listId: "lA", count: 4 }),
			colCard({ id: "d", scryfallId: "s2", listId: "lB", count: 1, finish: "foiled" }),
		];
		const p = plugin(cards);
		const before = totalCount(p.settings.collection);
		p.mergeLists(["lA", "lB"], "Together");
		expect(totalCount(p.settings.collection)).toBe(before);
	});
});

describe("copying and moving a card", () => {
	it("copyCollectionCardToList adds a new row in the target, keeps the original and gives the copy a new id and date", () => {
		const p = plugin([colCard({ count: 3, dateAdded: 10 })]);
		p.copyCollectionCardToList("c1", "lB");
		expect(p.settings.collection).toHaveLength(2);
		expect(row(p, "c1")).toMatchObject({ listId: "l1", count: 3, dateAdded: 10 });
		const copy = p.settings.collection[1];
		expect(copy).toMatchObject({ scryfallId: "s1", listId: "lB", count: 3, dateAdded: NOW, dateModified: NOW, finish: "regular", language: "en", condition: "NM" });
		expect(copy.id).not.toBe("c1");
		// A copy is not a "brand-new addition": the 'Recently added' group is not fed
		expect(p.recentlyAddedCollectionCardIds.size).toBe(0);
	});

	it("copyCollectionCardToList adds the quantity to an identical row already in the target", () => {
		const p = plugin([colCard({ id: "a", count: 2 }), colCard({ id: "b", listId: "lB", count: 5 })]);
		p.copyCollectionCardToList("a", "lB");
		expect(p.settings.collection).toHaveLength(2);
		expect(row(p, "b")).toMatchObject({ count: 7, dateModified: NOW });
	});

	it("copying a card into its own list makes a deliberate duplicate instead of doubling it in place", () => {
		const p = plugin([colCard({ count: 2 })]);
		p.copyCollectionCardToList("c1", "l1");
		expect(p.settings.collection).toHaveLength(2);
		expect(row(p, "c1").count).toBe(2);
		expect(totalCount(p.settings.collection)).toBe(4);
	});

	it("an unknown card is ignored", () => {
		const p = plugin([colCard()]);
		p.copyCollectionCardToList("nope", "lB");
		p.copyCollectionCardToWantlist("nope", "w");
		p.moveCollectionCardToList("nope", "lB");
		expect(p.settings.collection).toHaveLength(1);
		expect(p.settings.wantlist).toHaveLength(0);
	});

	it("moveCollectionCardToList leaves the copies in the target only, never losing or doubling any", () => {
		const p = plugin([colCard({ id: "a", count: 2 }), colCard({ id: "b", listId: "lB", count: 5 })]);
		const before = totalCount(p.settings.collection);
		p.moveCollectionCardToList("a", "lB");
		expect(idsOf(p.settings.collection)).toEqual(["b"]);
		expect(row(p, "b").count).toBe(7);
		expect(totalCount(p.settings.collection)).toBe(before);
	});

	it("moveCollectionCardToList to a list with no such card re-creates it there and removes the original", () => {
		const p = plugin([colCard({ id: "a", count: 2 })]);
		p.moveCollectionCardToList("a", "lB");
		expect(p.settings.collection).toHaveLength(1);
		expect(p.settings.collection[0]).toMatchObject({ listId: "lB", count: 2, scryfallId: "s1" });
		expect(p.settings.collection[0].id).not.toBe("a");
	});

	it("copyCollectionCardToWantlist carries the card's data but not language/condition, and sums into an identical wanted card", () => {
		const p = plugin([colCard({ count: 2, finish: "foiled", language: "fr", condition: "LP" })]);
		p.copyCollectionCardToWantlist("c1", "wl1");
		expect(p.settings.wantlist).toHaveLength(1);
		const w = p.settings.wantlist[0];
		expect(w).toMatchObject({ scryfallId: "s1", listId: "wl1", count: 2, finish: "foiled", name: "Old name", priceUsd: "0.10", dateAdded: NOW });
		expect(w).not.toHaveProperty("language");
		expect(w).not.toHaveProperty("condition");
		p.copyCollectionCardToWantlist("c1", "wl1");
		expect(p.settings.wantlist).toHaveLength(1);
		expect(p.settings.wantlist[0].count).toBe(4);
	});

	it("copyCollectionCardToWantlist keeps a different finish as a different wanted card", () => {
		const p = plugin([colCard({ id: "a", finish: "regular" }), colCard({ id: "b", finish: "foiled" })], { wantlist: [wantCard({ listId: "wl1", finish: "regular" })] });
		p.copyCollectionCardToWantlist("b", "wl1");
		expect(p.settings.wantlist).toHaveLength(2);
	});

	it("moveCollectionCardToWantlist removes the owned card once it is wanted", () => {
		const p = plugin([colCard({ id: "a", count: 2 })]);
		p.moveCollectionCardToWantlist("a", "wl1");
		expect(p.settings.collection).toEqual([]);
		expect(p.settings.wantlist[0]).toMatchObject({ count: 2, listId: "wl1" });
	});
});
