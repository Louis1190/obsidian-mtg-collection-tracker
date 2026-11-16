import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// wantlist-mutations.ts imports api/scryfall.ts, which imports `requestUrl` from "obsidian" (types only, no runtime).
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import * as wantlistMutations from "./wantlist-mutations";
import { colCard, idsOf, makePlugin, saves, scry, totalCount, wantCard } from "./__tests__/plugin-harness";
import type { Obj, TestPlugin } from "./__tests__/plugin-harness";

// Characterization tests (audit of 2026-11-15, lot 2): what the wantlist functions do TODAY. wantlist-inbox.test.ts
// already covers the protection of the Inbox in delete/rename/merge; this file covers the rest.

const NOW = 5000;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const inbox = { id: "inbox", name: "Inbox", dateCreated: 1, isInbox: true };
const wA = { id: "wA", name: "Alpha", dateCreated: 2 };
const wB = { id: "wB", name: "Beta", dateCreated: 3 };

function plugin(wantlist: Obj[] = [], extra: Obj = {}): TestPlugin {
	return makePlugin([wantlistMutations], { wantlists: [inbox, wA, wB], wantlist, ...extra });
}
const w = (id: string, over: Obj = {}) => wantCard({ id, listId: "wA", ...over });
const row = (p: TestPlugin, id: string): Obj => p.settings.wantlist.find((c: Obj) => c.id === id)!;

describe("finding and creating wantlists", () => {
	it("getOrCreateWantlistByName returns an existing one by name, creates the others, 'Unsorted' for an empty name", () => {
		const p = plugin();
		expect(p.getOrCreateWantlistByName("Alpha")).toBe(p.settings.wantlists[1]);
		expect(p.settings.wantlists).toHaveLength(3);
		expect(p.getOrCreateWantlistByName("Gamma").name).toBe("Gamma");
		expect(p.getOrCreateWantlistByName("").name).toBe("Unsorted");
		expect(saves(p)).toBe(0);
	});

	it("createWantlist saves, createWantlistSilent does not", () => {
		const p = plugin();
		const a = p.createWantlist("One");
		const b = p.createWantlistSilent("Two");
		expect(a).toMatchObject({ name: "One", dateCreated: NOW });
		expect(a.id).not.toBe(b.id);
		expect(saves(p)).toBe(1);
		expect(p.settings.wantlists.map((x: Obj) => x.name)).toEqual(["Inbox", "Alpha", "Beta", "One", "Two"]);
	});
});

describe("adding a card (addCardToWantlist)", () => {
	it("creates a row with the card's data, the finish and the wantlist, and no language or condition", () => {
		const p = plugin();
		const r = p.addCardToWantlist(scry("s1", { name: "Sol Ring" }), "wA", { finish: "foiled" });
		expect(r).toMatchObject({
			scryfallId: "s1",
			name: "Sol Ring",
			setCode: "lea",
			count: 1,
			finish: "foiled",
			listId: "wA",
			dateAdded: NOW,
			dateModified: NOW,
			imageUrl: "https://img/s1-normal.jpg",
			priceUsdFoil: "2.00",
			oracleText: "Rules text of s1",
		});
		expect(r).not.toHaveProperty("language");
		expect(r).not.toHaveProperty("condition");
		expect(p.recentlyAddedWantlistCardIds.has(r.id)).toBe(true);
		expect(saves(p)).toBe(1);
	});

	it("the same card, wantlist and finish adds to the count; another finish or wantlist is another row", () => {
		const p = plugin();
		const first = p.addCardToWantlist(scry("s1"), "wA", { finish: "regular" });
		vi.setSystemTime(NOW + 50);
		expect(p.addCardToWantlist(scry("s1"), "wA", { finish: "regular" })).toBe(first);
		expect(first).toMatchObject({ count: 2, dateModified: NOW + 50, dateAdded: NOW });
		p.addCardToWantlist(scry("s1"), "wA", { finish: "foiled" });
		p.addCardToWantlist(scry("s1"), "wB", { finish: "regular" });
		expect(p.settings.wantlist).toHaveLength(3);
	});
});

describe("quantity, finish and removal", () => {
	it("changeWantlistCardCount adds the delta, never below 1, and calls onDone", () => {
		const p = plugin([w("a", { count: 2 })]);
		const done = vi.fn();
		p.changeWantlistCardCount("a", 3, done);
		expect(row(p, "a")).toMatchObject({ count: 5, dateModified: NOW });
		p.changeWantlistCardCount("a", -99, done);
		expect(row(p, "a").count).toBe(1);
		expect(done).toHaveBeenCalledTimes(2);
	});

	it.each([
		[6, 6],
		[3.7, 3],
		[0, 1],
		[-2, 1],
		[NaN, 1],
	])("setWantlistCardCount(%s) stores %s", (input, stored) => {
		const p = plugin([w("a", { count: 9 })]);
		p.setWantlistCardCount("a", input, () => {});
		expect(row(p, "a").count).toBe(stored);
	});

	it("an unknown id changes nothing and never calls onDone", () => {
		const p = plugin([w("a")]);
		const done = vi.fn();
		p.changeWantlistCardCount("nope", 1, done);
		p.setWantlistCardCount("nope", 5, done);
		p.setWantlistCardFinish("nope", "foiled");
		expect(done).not.toHaveBeenCalled();
		expect(saves(p)).toBe(0);
	});

	it("setWantlistCardFinish sets the finish and bumps the date", () => {
		const p = plugin([w("a")]);
		p.setWantlistCardFinish("a", "etched");
		expect(row(p, "a")).toMatchObject({ finish: "etched", dateModified: NOW });
	});

	it("removeWantlistCard and bulkRemoveWantlistCards remove only the given rows", () => {
		const p = plugin([w("a"), w("b"), w("c"), w("d")]);
		p.removeWantlistCard("a");
		p.bulkRemoveWantlistCards(["c", "zzz"]);
		expect(idsOf(p.settings.wantlist)).toEqual(["b", "d"]);
	});

	it("bulkSetWantlistCardFinish and bulkSetWantlistCardCount touch only the selection (count clamped)", () => {
		const p = plugin([w("a", { count: 3 }), w("b", { count: 3 }), w("c", { count: 3 })]);
		p.bulkSetWantlistCardFinish(["a", "c"], "foiled");
		expect(p.settings.wantlist.map((c: Obj) => c.finish)).toEqual(["foiled", "regular", "foiled"]);
		expect(row(p, "b").dateModified).toBe(1000);
		p.bulkSetWantlistCardCount(["b"], 0);
		p.bulkSetWantlistCardCount(["a"], 4.9);
		expect(p.settings.wantlist.map((c: Obj) => c.count)).toEqual([4, 1, 3]);
	});

	describe("undoAddToWantlist", () => {
		it("takes copies off the row, or deletes it when none would remain", () => {
			const p = plugin([w("a", { scryfallId: "s1", count: 5 })]);
			expect(p.undoAddToWantlist("s1", "wA", "regular", 2)).toBe(row(p, "a"));
			expect(row(p, "a")).toMatchObject({ count: 3, dateModified: NOW });
			expect(p.undoAddToWantlist("s1", "wA", "regular", 3)).toBeUndefined();
			expect(p.settings.wantlist).toEqual([]);
		});

		it("finds the row by card + wantlist + finish only", () => {
			const p = plugin([w("a", { scryfallId: "s1", count: 2 })]);
			expect(p.undoAddToWantlist("s1", "wB", "regular", 1)).toBeUndefined();
			expect(p.undoAddToWantlist("s1", "wA", "foiled", 1)).toBeUndefined();
			expect(p.undoAddToWantlist("other", "wA", "regular", 1)).toBeUndefined();
			expect(row(p, "a").count).toBe(2);
		});
	});
});

describe("changeWantlistCardPrinting", () => {
	it("takes the new printing's data and keeps quantity, finish, wantlist and the date added", () => {
		const p = plugin([w("a", { count: 3, finish: "foiled", dateAdded: 77 })]);
		p.changeWantlistCardPrinting("a", scry("s2", { name: "Other", set: "m10", set_name: "Magic 2010", collector_number: "5" }));
		expect(row(p, "a")).toMatchObject({
			id: "a",
			scryfallId: "s2",
			name: "Other",
			setCode: "m10",
			setName: "Magic 2010",
			collectorNumber: "5",
			count: 3,
			finish: "foiled",
			listId: "wA",
			dateAdded: 77,
			dateModified: NOW,
			imageUrl: "https://img/s2-normal.jpg",
		});
	});

	it("ignores an unknown id", () => {
		const p = plugin([w("a")]);
		p.changeWantlistCardPrinting("nope", scry("s2"));
		expect(saves(p)).toBe(0);
		expect(row(p, "a").scryfallId).toBe("s1");
	});
});

describe("wantlist settings", () => {
	const cards = () => [w("a", { listId: "wA" }), w("b", { listId: "wB" }), w("i", { listId: "inbox" })];

	it("deleteWantlist removes the wantlist and its cards, not the others'", () => {
		const p = plugin(cards());
		p.deleteWantlist("wA");
		expect(p.settings.wantlists.map((x: Obj) => x.id)).toEqual(["inbox", "wB"]);
		expect(idsOf(p.settings.wantlist)).toEqual(["b", "i"]);
	});

	it("bulkDeleteWantlists removes the selection with its cards but keeps the Inbox", () => {
		const p = plugin(cards());
		p.bulkDeleteWantlists(["wA", "wB", "inbox"]);
		expect(p.settings.wantlists.map((x: Obj) => x.id)).toEqual(["inbox"]);
		expect(idsOf(p.settings.wantlist)).toEqual(["i"]);
	});

	it("clearWantlist empties it but keeps the wantlist", () => {
		const p = plugin(cards());
		p.clearWantlist("wA");
		expect(idsOf(p.settings.wantlist)).toEqual(["b", "i"]);
		expect(p.settings.wantlists).toHaveLength(3);
	});

	it("renameWantlist renames, except the Inbox", () => {
		const p = plugin();
		p.renameWantlist("wA", "New");
		p.renameWantlist("inbox", "Hacked");
		expect(p.settings.wantlists.map((x: Obj) => x.name)).toEqual(["Inbox", "New", "Beta"]);
	});

	it("cover card and icon can be set and cleared; an unknown wantlist is ignored", () => {
		const p = plugin();
		p.setWantlistCoverCard("wA", "c9");
		p.setWantlistIcon("wA", { type: "mana", value: "u" } as never);
		expect(p.settings.wantlists[1]).toMatchObject({ coverCardId: "c9", listIcon: { type: "mana", value: "u" } });
		p.setWantlistCoverCard("wA", undefined);
		p.setWantlistIcon("wA", undefined);
		expect(p.settings.wantlists[1].coverCardId).toBeUndefined();
		expect(p.settings.wantlists[1].listIcon).toBeUndefined();
		const before = saves(p);
		p.setWantlistCoverCard("nope", "x");
		p.setWantlistIcon("nope", undefined);
		expect(saves(p)).toBe(before);
	});
});

describe("duplicates and merging wantlists", () => {
	it("findWantlistDuplicateGroups groups card + wantlist + finish, oldest first, and ignores singles", () => {
		const p = plugin([
			w("late", { dateAdded: 30 }),
			w("early", { dateAdded: 10 }),
			w("other-finish", { finish: "foiled" }),
			w("other-list", { listId: "wB" }),
			w("other-card", { scryfallId: "z" }),
		]);
		const groups = p.findWantlistDuplicateGroups();
		expect(groups).toHaveLength(1);
		expect(idsOf(groups[0])).toEqual(["early", "late"]);
	});

	it("mergeWantlistDuplicateGroup adds quantities into the first and deletes the rest; a group of one is left alone", () => {
		const p = plugin([w("a", { count: 2, dateAdded: 1 }), w("b", { count: 3, dateAdded: 2 }), w("c", { count: 4, dateAdded: 3 })]);
		const [group] = p.findWantlistDuplicateGroups();
		expect(p.mergeWantlistDuplicateGroup(group)).toEqual({ removed: 2 });
		expect(idsOf(p.settings.wantlist)).toEqual(["a"]);
		expect(row(p, "a")).toMatchObject({ count: 9, dateModified: NOW });
		expect(p.mergeWantlistDuplicateGroup([row(p, "a")] as never)).toEqual({ removed: 0 });
		expect(p.mergeWantlistDuplicateGroup([w("ghost"), w("x")] as never)).toEqual({ removed: 0 });
	});

	it("mergeWantlistDuplicates works on one wantlist and reports the groups and rows merged", () => {
		const p = plugin([w("a1", { dateAdded: 1 }), w("a2", { dateAdded: 2 }), w("b1", { listId: "wB", dateAdded: 1 }), w("b2", { listId: "wB", dateAdded: 2 })]);
		expect(p.mergeWantlistDuplicates("wA")).toEqual({ merged: 1, removed: 1 });
		expect(idsOf(p.settings.wantlist)).toEqual(["a1", "b1", "b2"]);
	});

	it("mergeWantlists moves everything into a new wantlist, deletes the originals, merges the duplicates and conserves the copies", () => {
		const p = plugin([w("a", { count: 2, dateAdded: 1 }), w("b", { listId: "wB", count: 5, dateAdded: 2 }), w("c", { scryfallId: "z", listId: "wB", count: 1 }), w("i", { scryfallId: "y", listId: "inbox" })]);
		const before = totalCount(p.settings.wantlist);
		const merged = p.mergeWantlists(["wA", "wB", "inbox"], "All");
		expect(p.settings.wantlists.map((x: Obj) => x.id)).toEqual(["inbox", merged.id]);
		expect(p.settings.wantlist.filter((c: Obj) => c.listId === merged.id)).toHaveLength(2);
		expect(row(p, "a")).toMatchObject({ count: 7, listId: merged.id });
		expect(row(p, "i").listId).toBe("inbox");
		expect(totalCount(p.settings.wantlist)).toBe(before);
	});
});

describe("copying and moving between wantlists", () => {
	it("copyWantlistCardToWantlist creates a copy with a new id and date and keeps the original", () => {
		const p = plugin([w("a", { count: 2, dateAdded: 10 })]);
		p.copyWantlistCardToWantlist("a", "wB");
		expect(p.settings.wantlist).toHaveLength(2);
		expect(row(p, "a")).toMatchObject({ listId: "wA", dateAdded: 10 });
		expect(p.settings.wantlist[1]).toMatchObject({ scryfallId: "s1", listId: "wB", count: 2, dateAdded: NOW, dateModified: NOW });
		expect(p.settings.wantlist[1].id).not.toBe("a");
		expect(p.recentlyAddedWantlistCardIds.size).toBe(0);
	});

	it("copyWantlistCardToWantlist sums into an identical wanted card, and copying into its own wantlist duplicates", () => {
		const p = plugin([w("a", { count: 2 }), w("b", { listId: "wB", count: 5 })]);
		p.copyWantlistCardToWantlist("a", "wB");
		expect(row(p, "b").count).toBe(7);
		const q = plugin([w("a", { count: 2 })]);
		q.copyWantlistCardToWantlist("a", "wA");
		expect(q.settings.wantlist).toHaveLength(2);
		expect(totalCount(q.settings.wantlist)).toBe(4);
	});

	it("moveWantlistCardToWantlist conserves the copies whether it merges or recreates", () => {
		const merging = plugin([w("a", { count: 2 }), w("b", { listId: "wB", count: 5 })]);
		merging.moveWantlistCardToWantlist("a", "wB");
		expect(idsOf(merging.settings.wantlist)).toEqual(["b"]);
		expect(row(merging, "b").count).toBe(7);
		const recreating = plugin([w("a", { count: 2 })]);
		recreating.moveWantlistCardToWantlist("a", "wB");
		expect(recreating.settings.wantlist).toHaveLength(1);
		expect(recreating.settings.wantlist[0]).toMatchObject({ listId: "wB", count: 2 });
	});

	it("an unknown card is ignored", () => {
		const p = plugin([w("a")]);
		p.copyWantlistCardToWantlist("nope", "wB");
		p.moveWantlistCardToWantlist("nope", "wB");
		expect(p.settings.wantlist).toHaveLength(1);
	});

	describe("bulkMoveWantlistCardsToWantlist", () => {
		it("changes the wantlist of the selected cards in place (same rows, same ids)", () => {
			const p = plugin([w("a"), w("b", { scryfallId: "s2" }), w("c", { scryfallId: "s3" })]);
			p.bulkMoveWantlistCardsToWantlist(["a", "b"], "wB");
			expect(p.settings.wantlist.map((c: Obj) => [c.id, c.listId])).toEqual([["a", "wB"], ["b", "wB"], ["c", "wA"]]);
			expect(row(p, "a").dateModified).toBe(NOW);
		});

		it("merges into an identical card already in the target and removes the moved one", () => {
			const p = plugin([w("a", { count: 2 }), w("t", { listId: "wB", count: 5 })]);
			p.bulkMoveWantlistCardsToWantlist(["a"], "wB");
			expect(idsOf(p.settings.wantlist)).toEqual(["t"]);
			expect(row(p, "t").count).toBe(7);
		});

		it("two identical cards moved together end up as one row with both quantities", () => {
			const p = plugin([w("a", { count: 2 }), w("b", { count: 3 })]);
			p.bulkMoveWantlistCardsToWantlist(["a", "b"], "wB");
			expect(p.settings.wantlist).toHaveLength(1);
			expect(p.settings.wantlist[0]).toMatchObject({ listId: "wB", count: 5 });
		});

		// Regression tests for a defect found by the audit of 2026-11-15 (lot 2) and fixed in the same series: moving a
		// card to the wantlist it is already in, when an identical card sat there too, added the moved card's quantity to
		// that one WITHOUT removing the moved card (its listId already equalled the target): copies appeared from nothing
		// (5 became 7). A card already in the target is now left exactly as it is.
		it("moving into the wantlist a card is already in does not create copies", () => {
			const p = plugin([w("a", { count: 2 }), w("t", { count: 3 })]);
			const before = totalCount(p.settings.wantlist);
			p.bulkMoveWantlistCardsToWantlist(["a"], "wA");
			expect(totalCount(p.settings.wantlist)).toBe(before);
			expect(p.settings.wantlist.map((c: Obj) => [c.id, c.count])).toEqual([["a", 2], ["t", 3]]);
		});

		it("a card already in the target is left untouched (no date change, no save needed for it)", () => {
			const p = plugin([w("a", { count: 2, dateModified: 100 })]);
			p.bulkMoveWantlistCardsToWantlist(["a"], "wA");
			expect(row(p, "a")).toMatchObject({ listId: "wA", count: 2, dateModified: 100 });
		});

		it("cards from several wantlists moved together still merge into the one already in the target, conserving the copies", () => {
			const p = plugin([w("inTarget", { listId: "wB", count: 4 }), w("fromA", { listId: "wA", count: 2 }), w("fromInbox", { listId: "inbox", count: 1 })]);
			const before = totalCount(p.settings.wantlist);
			p.bulkMoveWantlistCardsToWantlist(["inTarget", "fromA", "fromInbox"], "wB");
			expect(p.settings.wantlist.map((c: Obj) => [c.id, c.listId, c.count])).toEqual([["inTarget", "wB", 7]]);
			expect(totalCount(p.settings.wantlist)).toBe(before);
		});
	});
});

describe("from the wantlist to the collection", () => {
	const owned = (over: Obj = {}) => colCard({ id: "o1", scryfallId: "s1", listId: "lA", finish: "regular", language: "fr", condition: "LP", count: 2, ...over });

	it("copyWantlistCardToList adds an owned card with no language or condition, and keeps the wanted one", () => {
		const p = plugin([w("a", { count: 3, finish: "foiled" })], { collection: [] });
		p.copyWantlistCardToList("a", "lA");
		expect(p.settings.wantlist).toHaveLength(1);
		expect(p.settings.collection).toHaveLength(1);
		expect(p.settings.collection[0]).toMatchObject({ scryfallId: "s1", listId: "lA", count: 3, finish: "foiled", language: "", condition: "", name: "Old name", dateAdded: NOW });
		expect(p.recentlyAddedCollectionCardIds.size).toBe(0);
	});

	it("copyWantlistCardToList only merges into an owned row that also has no language and no condition", () => {
		const p = plugin([w("a", { count: 3 })], { collection: [owned({ language: "", condition: "", count: 2 }), owned({ id: "o2", language: "fr", condition: "LP", count: 9 })] });
		p.copyWantlistCardToList("a", "lA");
		expect(p.settings.collection).toHaveLength(2);
		expect(p.settings.collection.map((c: Obj) => c.count)).toEqual([5, 9]);
		const q = plugin([w("a", { count: 3 })], { collection: [owned()] });
		q.copyWantlistCardToList("a", "lA");
		expect(q.settings.collection).toHaveLength(2);
	});

	it("moveWantlistCardToCollection ('Mark as acquired') creates the owned card with the chosen condition and language and removes the wanted one", () => {
		const p = plugin([w("a", { count: 2, finish: "foiled" })], { collection: [] });
		p.moveWantlistCardToCollection("a", "lA", "NM", "en");
		expect(p.settings.wantlist).toEqual([]);
		expect(p.settings.collection[0]).toMatchObject({ scryfallId: "s1", listId: "lA", count: 2, finish: "foiled", condition: "NM", language: "en" });
		expect(saves(p)).toBe(1);
	});

	it("moveWantlistCardToCollection merges into an owned card with the same finish, condition and language", () => {
		const p = plugin([w("a", { count: 2 })], { collection: [owned({ language: "en", condition: "NM", count: 4 })] });
		p.moveWantlistCardToCollection("a", "lA", "NM", "en");
		expect(p.settings.collection).toHaveLength(1);
		expect(p.settings.collection[0]).toMatchObject({ count: 6, dateModified: NOW });
		expect(p.settings.wantlist).toEqual([]);
	});

	it.each([
		["another condition only", { language: "en", condition: "LP" }],
		["another language only", { language: "fr", condition: "NM" }],
		["another finish only", { language: "en", condition: "NM", finish: "foiled" }],
		["another list only", { language: "en", condition: "NM", listId: "lB" }],
		["another card only", { language: "en", condition: "NM", scryfallId: "other" }],
	])("moveWantlistCardToCollection keeps %s as a separate owned row", (_label, over) => {
		const p = plugin([w("a", { count: 2 })], { collection: [owned({ ...over, count: 4 })] });
		p.moveWantlistCardToCollection("a", "lA", "NM", "en");
		expect(p.settings.collection.map((c: Obj) => c.count)).toEqual([4, 2]);
	});

	it("moveWantlistCardsToCollection moves several cards with a single save, ignoring unknown ids", () => {
		const p = plugin([w("a", { count: 1 }), w("b", { scryfallId: "s2", count: 2 }), w("c", { scryfallId: "s3" })], { collection: [] });
		p.moveWantlistCardsToCollection(["a", "b", "ghost"], "lA", "NM", "en");
		expect(p.settings.collection.map((c: Obj) => [c.scryfallId, c.count])).toEqual([["s1", 1], ["s2", 2]]);
		expect(idsOf(p.settings.wantlist)).toEqual(["c"]);
		expect(saves(p)).toBe(1);
	});

	it("moveWantlistCardToCollectionNoSave does the move but does not save", () => {
		const p = plugin([w("a")], { collection: [] });
		p.moveWantlistCardToCollectionNoSave("a", "lA", "NM", "en");
		expect(p.settings.collection).toHaveLength(1);
		expect(saves(p)).toBe(0);
	});

	it("conserves the copies when several wanted cards land on the same owned card", () => {
		const p = plugin([w("a", { count: 2 }), w("b", { count: 3 })], { collection: [owned({ language: "en", condition: "NM", count: 4 })] });
		const before = totalCount(p.settings.wantlist) + totalCount(p.settings.collection);
		p.moveWantlistCardsToCollection(["a", "b"], "lA", "NM", "en");
		expect(p.settings.collection).toHaveLength(1);
		expect(totalCount(p.settings.collection)).toBe(before);
	});
});
