import { describe, it, expect } from "vitest";
import {
	isDeckCardOwned,
	isDeckCommander,
	deckBoardTabMatches,
	DECK_BOARD_TABS,
	genId,
	DEFAULT_SETTINGS,
	DeckCard,
	Wantlist,
	INBOX_WANTLIST_ID,
	ensureInboxWantlistIn,
	healInboxes,
	type CollectionList,
} from "./data-model";
import type { CollectionCard } from "./card-model";
import { isShardFileName, shardFileName } from "./github-shards";

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

describe("ensureInboxWantlistIn", () => {
	it("creates the Inbox at the head, with the fixed id and the flag", () => {
		const wantlists: Wantlist[] = [{ id: "w1", name: "Trades" }];
		expect(ensureInboxWantlistIn(wantlists, 1234)).toBe(true);
		expect(wantlists).toHaveLength(2);
		expect(wantlists[0]).toEqual({ id: INBOX_WANTLIST_ID, name: "Inbox", dateCreated: 1234, isInbox: true });
		expect(wantlists[1].id).toBe("w1");
	});

	it("creates it in an empty list too (a brand-new installation)", () => {
		const wantlists: Wantlist[] = [];
		expect(ensureInboxWantlistIn(wantlists)).toBe(true);
		expect(wantlists.map((w) => w.isInbox)).toEqual([true]);
	});

	it("does nothing once a wantlist carries the flag, whatever its id", () => {
		const wantlists: Wantlist[] = [{ id: "legacy", name: "Inbox", isInbox: true }];
		expect(ensureInboxWantlistIn(wantlists)).toBe(false);
		expect(wantlists).toEqual([{ id: "legacy", name: "Inbox", isInbox: true }]);
	});

	it("is idempotent: a second call creates nothing", () => {
		const wantlists: Wantlist[] = [];
		ensureInboxWantlistIn(wantlists);
		expect(ensureInboxWantlistIn(wantlists)).toBe(false);
		expect(wantlists).toHaveLength(1);
	});

	it("never duplicates the id: an unflagged wantlist already holding it is flagged instead", () => {
		const wantlists: Wantlist[] = [{ id: INBOX_WANTLIST_ID, name: "Inbox" }];
		expect(ensureInboxWantlistIn(wantlists)).toBe(true);
		expect(wantlists).toEqual([{ id: INBOX_WANTLIST_ID, name: "Inbox", isInbox: true }]);
	});

	it("uses an id that GitHub sync accepts as a shard file name", () => {
		// wantlist-<id>.json.gz — the engine ignores any other name in the folder.
		expect(isShardFileName(shardFileName("wantlist", INBOX_WANTLIST_ID))).toBe(true);
		expect(shardFileName("wantlist", INBOX_WANTLIST_ID)).toBe("wantlist-inbox.json.gz");
	});
});

describe("healInboxes", () => {
	const inbox = (id: string, dateCreated?: number, extra: Partial<CollectionList> = {}): CollectionList => ({
		id,
		name: "Inbox",
		isInbox: true,
		...(dateCreated === undefined ? {} : { dateCreated }),
		...extra,
	});
	const list = (id: string, name = id): CollectionList => ({ id, name, dateCreated: 5 });
	const card = (id: string, listId: string, dateModified = 100) => ({ id, listId, dateModified }) as CollectionCard;
	const state = (lists: CollectionList[], collection: CollectionCard[], syncTombstones?: Record<string, Record<string, number>>) => ({
		lists,
		collection,
		syncTombstones,
	});

	it("leaves a single Inbox, and every card, untouched", () => {
		const s = state([list("a"), inbox("x", 10), list("b")], [card("c1", "x"), card("c2", "a")]);
		const before = JSON.stringify(s);
		expect(healInboxes(s, 5000)).toEqual({ dropped: [], moved: 0 });
		expect(JSON.stringify(s)).toBe(before);
	});

	it("does nothing without an Inbox (ensureInboxList's job), even with cards pointing at deleted lists", () => {
		const s = state([list("a")], [card("c1", "gone")], { lists: { gone: 1 } });
		expect(healInboxes(s, 5000)).toEqual({ dropped: [], moved: 0 });
		expect(s.collection[0].listId).toBe("gone");
	});

	it("keeps the OLDEST Inbox, gives it the cards of the other, and drops the other", () => {
		const s = state(
			[inbox("fresh", 2000), list("a"), inbox("mac", 1000)],
			[card("c1", "mac"), card("c2", "fresh"), card("c3", "a"), card("c4", "fresh", 4000)]
		);
		expect(healInboxes(s, 9000)).toEqual({ dropped: ["fresh"], moved: 2 });
		expect(s.lists.map((l) => l.id)).toEqual(["a", "mac"]);
		expect(s.lists.filter((l) => l.isInbox).map((l) => l.id)).toEqual(["mac"]);
		expect(s.collection.map((c) => c.listId)).toEqual(["mac", "mac", "a", "mac"]);
	});

	it("stamps a moved card so the move beats the stale copy another device may hold; untouched cards keep their date", () => {
		const s = state(
			[inbox("mac", 1000), inbox("fresh", 2000)],
			[card("m", "fresh", 100), card("future", "fresh", 20_000), card("stay", "mac", 100)]
		);
		healInboxes(s, 9000);
		expect(s.collection.find((c) => c.id === "m")!.dateModified).toBe(9000);
		// a card dated after "now" (a drifting clock) still moves strictly forward
		expect(s.collection.find((c) => c.id === "future")!.dateModified).toBe(20_001);
		expect(s.collection.find((c) => c.id === "stay")!.dateModified).toBe(100);
	});

	it("breaks a tie on dateCreated by id, whatever the order of the array", () => {
		for (const order of [["b", "a", "c"], ["c", "b", "a"], ["a", "c", "b"]]) {
			const s = state(order.map((id) => inbox(id, 1000)), [card("k1", "c"), card("k2", "b")]);
			expect(healInboxes(s, 9000).dropped.sort()).toEqual(["b", "c"]);
			expect(s.lists.map((l) => l.id)).toEqual(["a"]);
			expect(s.collection.map((c) => c.listId)).toEqual(["a", "a"]);
		}
	});

	it("treats an Inbox with no dateCreated as the oldest (it predates the field)", () => {
		const s = state([inbox("dated", 1), inbox("undated")], []);
		healInboxes(s, 9000);
		expect(s.lists.map((l) => l.id)).toEqual(["undated"]);
	});

	it("handles three Inboxes, and is idempotent", () => {
		const s = state([inbox("c", 3), inbox("a", 1), inbox("b", 2)], [card("k1", "c"), card("k2", "b")]);
		expect(healInboxes(s, 9000)).toEqual({ dropped: ["c", "b"], moved: 2 });
		expect(s.collection.map((c) => c.listId)).toEqual(["a", "a"]);
		const once = JSON.stringify(s);
		expect(healInboxes(s, 12_000)).toEqual({ dropped: [], moved: 0 });
		expect(JSON.stringify(s)).toBe(once);
	});

	it("is the same whichever device runs it (same keeper, same cards)", () => {
		const make = (order: string[]) =>
			state(order.map((id) => inbox(id, id === "old" ? 10 : 20)), [card("k1", "new"), card("k2", "old")]);
		const a = make(["old", "new"]);
		const b = make(["new", "old"]);
		healInboxes(a, 9000);
		healInboxes(b, 9500);
		expect(a.lists.map((l) => l.id)).toEqual(b.lists.map((l) => l.id));
		expect(a.collection.map((c) => c.listId)).toEqual(b.collection.map((c) => c.listId));
	});

	it("keeps the keeper's own cards where they are and never touches other lists' cards", () => {
		const s = state([inbox("k", 1), inbox("x", 2), list("a")], [card("c1", "k"), card("c2", "a"), card("c3", "x")]);
		healInboxes(s, 9000);
		expect(s.collection.map((c) => [c.listId, c.dateModified])).toEqual([["k", 100], ["a", 100], ["k", 9000]]);
	});

	it("two flagged lists sharing one id (a hand edit): the survivor keeps the id, nothing is reported dropped", () => {
		const s = state([inbox("same", 1), inbox("same", 2)], [card("c1", "same")]);
		expect(healInboxes(s, 9000)).toEqual({ dropped: [], moved: 0 });
		expect(s.lists).toHaveLength(1);
		expect(s.collection[0].listId).toBe("same");
	});

	describe("cards left pointing at a deleted list", () => {
		it("adopts a card whose list is gone AND has a deletion record (the tombstone of a dropped Inbox reached a device that had added cards to it)", () => {
			const s = state([inbox("keeper", 1)], [card("late", "dropped"), card("ok", "keeper")], { lists: { dropped: 7000 } });
			expect(healInboxes(s, 9000)).toEqual({ dropped: [], moved: 1 });
			expect(s.collection.map((c) => c.listId)).toEqual(["keeper", "keeper"]);
			expect(s.collection[0].dateModified).toBe(9000);
		});

		it("leaves alone a card pointing at a list that was never deleted (no record): inconsistent data is not guessed at", () => {
			const s = state([inbox("keeper", 1)], [card("odd", "never-existed")], { lists: { other: 7000 } });
			expect(healInboxes(s, 9000)).toEqual({ dropped: [], moved: 0 });
			expect(s.collection[0].listId).toBe("never-existed");
		});

		it("leaves alone a card whose list exists even though a tombstone with that id lingers (the list came back)", () => {
			const s = state([inbox("keeper", 1), list("back")], [card("c", "back")], { lists: { back: 7000 } });
			expect(healInboxes(s, 9000)).toEqual({ dropped: [], moved: 0 });
			expect(s.collection[0].listId).toBe("back");
		});

		it("a tombstone for another kind of entity with the same key does not count", () => {
			const s = state([inbox("keeper", 1)], [card("c", "gone")], { decks: { gone: 7000 } });
			expect(healInboxes(s, 9000).moved).toBe(0);
		});
	});
});
