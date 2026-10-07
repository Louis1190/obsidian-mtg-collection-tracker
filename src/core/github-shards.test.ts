import { describe, it, expect } from "vitest";
import {
	CORE_SHARD,
	assembleShards,
	encodeShards,
	isEmptyShard,
	isShardFileName,
	shardFileName,
	shardsEqual,
	ShardObj,
} from "./github-shards";
import { settingsEqual } from "./settings-merge";

type Obj = Record<string, any>;

const card = (id: string, listId: string, extra: Obj = {}): Obj => ({
	id,
	scryfallId: `s-${id}`,
	name: `Card ${id}`,
	listId,
	count: 1,
	priceUsd: "1.00",
	dateAdded: 100,
	dateModified: 100,
	...extra,
});
const deckCard = (scryfallId: string, extra: Obj = {}): Obj => ({ scryfallId, name: `D ${scryfallId}`, count: 1, category: "mainboard", dateModified: 100, ...extra });

function sample(): Obj {
	return {
		priceCurrency: "USD",
		accentColor: "#7c3aed",
		lastPriceRefresh: 5000,
		lastAutoBackup: 6000,
		lists: [
			{ id: "l1", name: "Alpha", dateModified: 10 },
			{ id: "l2", name: "Beta", dateModified: 10 },
			{ id: "l3", name: "Empty", dateModified: 10 },
		],
		collection: [card("c3", "l2"), card("c1", "l1"), card("c2", "l1"), card("c4", "l2")],
		wantlists: [{ id: "w1", name: "Want", dateModified: 10 }],
		wantlist: [card("w-a", "w1"), card("w-b", "w1")],
		decks: [
			{ id: "d1", name: "Deck 1", dateModified: 10, cards: [deckCard("z"), deckCard("a", { category: "sideboard" })] },
			{ id: "d2", name: "Empty deck", dateModified: 10, cards: [] },
		],
		savedSearchFilters: [{ id: "f1", name: "Red", dateModified: 10 }],
		syncTombstones: { collection: { gone: 99 } },
		syncStamps: { priceCurrency: 7, lastPriceRefresh: 5000 },
		someFutureSetting: { nested: [1, 2, 3] },
	};
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const shardMap = (state: Obj): Map<string, Obj> => encodeShards(state) as Map<string, Obj>;
const assemble = (shards: ReadonlyMap<string, ShardObj>): Obj => assembleShards(shards) as Obj;

describe("encoding the state into shards", () => {
	it("one common shard, one per list / wantlist with cards, one per deck with cards", () => {
		const shards = shardMap(sample());
		expect([...shards.keys()]).toEqual([
			CORE_SHARD,
			"deck-d1.json.gz",
			"list-l1.json.gz",
			"list-l2.json.gz",
			"wantlist-w1.json.gz",
		]); // no file for the empty list, nor for the empty deck
	});

	it("the common shard holds everything except the cards, and keeps what it does not know", () => {
		const core = shardMap(sample()).get(CORE_SHARD)!;
		expect(core.collection).toBeUndefined();
		expect(core.wantlist).toBeUndefined();
		expect(core.lists).toHaveLength(3);
		expect(core.decks.map((d: Obj) => [d.id, d.cards])).toEqual([
			["d1", []],
			["d2", []],
		]);
		expect(core.syncTombstones).toEqual({ collection: { gone: 99 } });
		expect(core.someFutureSetting).toEqual({ nested: [1, 2, 3] });
		expect(core._shard).toBe(2);
	});

	it("cards are sorted, so the same state gives the same bytes whatever its order", () => {
		const a = sample();
		const b = sample();
		b.collection.reverse();
		b.decks[0].cards.reverse();
		const ta = [...shardMap(a)].map(([n, o]) => `${n}:${JSON.stringify(o)}`);
		const tb = [...shardMap(b)].map(([n, o]) => `${n}:${JSON.stringify(o)}`);
		expect(tb).toEqual(ta);
		expect(shardMap(a).get("list-l1.json.gz")!.collection.map((c: Obj) => c.id)).toEqual(["c1", "c2"]);
	});

	it("a card without a list goes to its own shard instead of being lost", () => {
		const s = sample();
		s.collection.push({ id: "orphan", name: "No list" });
		const shards = shardMap(s);
		expect(shards.has("list-_.json.gz")).toBe(true);
		expect(settingsEqual(assemble(shards), s)).toBe(true);
	});
});

describe("assembling the shards back", () => {
	it("gives back the same state", () => {
		const s = sample();
		const back = assemble(shardMap(s));
		expect(settingsEqual(back, s)).toBe(true);
		expect(back._shard).toBeUndefined();
		expect(back.someFutureSetting).toEqual({ nested: [1, 2, 3] });
		expect(back.decks[0].cards.map((c: Obj) => c.scryfallId).sort()).toEqual(["a", "z"]);
		expect(back.decks[1].cards).toEqual([]);
	});

	it("survives a trip through JSON (what GitHub stores)", () => {
		const s = sample();
		const stored = new Map<string, ShardObj>();
		for (const [name, obj] of shardMap(s)) stored.set(name, JSON.parse(JSON.stringify(obj)));
		expect(settingsEqual(assemble(stored), s)).toBe(true);
	});

	it("a missing shard gives a smaller state, never a wrong one", () => {
		const shards = shardMap(sample());
		shards.delete("list-l2.json.gz");
		const back = assemble(shards);
		expect(back.collection.map((c: Obj) => c.id).sort()).toEqual(["c1", "c2"]);
		expect(back.lists).toHaveLength(3); // the lists themselves are in the common shard
		shards.delete("deck-d1.json.gz");
		expect(assemble(shards).decks[0].cards).toEqual([]);
	});

	it("without the common shard there are no settings, only the cards", () => {
		const shards = shardMap(sample());
		shards.delete(CORE_SHARD);
		const back = assemble(shards);
		expect(back.priceCurrency).toBeUndefined();
		expect(back.lists).toBeUndefined();
		expect(back.decks).toBeUndefined();
		expect(back.collection).toHaveLength(4);
	});

	it("a deck shard for a deck the common shard does not know yet waits", () => {
		const shards = shardMap(sample());
		const core = clone(shards.get(CORE_SHARD)!);
		core.decks = core.decks.filter((d: Obj) => d.id !== "d1");
		shards.set(CORE_SHARD, core);
		expect(assemble(shards).decks.map((d: Obj) => d.id)).toEqual(["d2"]);
	});

	it("a card moved between lists exists in two shards for a while: the newest one wins, on every device", () => {
		const shards = new Map<string, ShardObj>();
		shards.set(CORE_SHARD, { _shard: 2 });
		shards.set("list-a.json.gz", { _shard: 2, collection: [card("x", "a", { dateModified: 100, count: 1 })] });
		shards.set("list-b.json.gz", { _shard: 2, collection: [card("x", "b", { dateModified: 200, count: 2 })] });
		const forward = assemble(shards);
		const reversed = assemble(new Map([...shards].reverse()));
		expect(forward.collection).toHaveLength(1);
		expect(forward.collection[0].listId).toBe("b");
		expect(reversed.collection).toEqual(forward.collection);
		// same date: the same choice everywhere (the greater shard name)
		shards.set("list-b.json.gz", { _shard: 2, collection: [card("x", "b", { dateModified: 100, count: 2 })] });
		expect(assemble(shards).collection[0].listId).toBe("b");
		expect(assemble(new Map([...shards].reverse())).collection[0].listId).toBe("b");
	});

	it("is deterministic for random states", () => {
		let seed = 12345;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		for (let i = 0; i < 200; i++) {
			const lists = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, k) => `l${k}`);
			const s: Obj = {
				priceCurrency: rnd() < 0.5 ? "USD" : "EUR",
				lists: lists.map((id) => ({ id, name: id, dateModified: 1 })),
				collection: Array.from({ length: Math.floor(rnd() * 30) }, (_, k) => card(`c${k}`, lists[Math.floor(rnd() * lists.length)], { count: 1 + Math.floor(rnd() * 4), dateModified: 1 + Math.floor(rnd() * 99) })),
				wantlists: [],
				wantlist: [],
				decks: Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => ({
					id: `d${k}`,
					name: `D${k}`,
					dateModified: 1,
					cards: Array.from({ length: Math.floor(rnd() * 8) }, (_, j) => deckCard(`s${k}-${j}`)),
				})),
			};
			expect(settingsEqual(assemble(shardMap(s)), s)).toBe(true);
		}
	});
});

describe("which shards differ", () => {
	const differing = (a: Obj, b: Obj): string[] => {
		const A = shardMap(a);
		const B = shardMap(b);
		const names = new Set([...A.keys(), ...B.keys()]);
		return [...names].filter((n) => !shardsEqual(n, A.get(n), B.get(n))).sort();
	};

	it("nothing differs for the same state", () => {
		expect(differing(sample(), sample())).toEqual([]);
	});

	it("editing a card touches only its list's shard", () => {
		const b = sample();
		b.collection.find((c: Obj) => c.id === "c3")!.count = 9;
		b.collection.find((c: Obj) => c.id === "c3")!.dateModified = 200;
		expect(differing(sample(), b)).toEqual(["list-l2.json.gz"]);
	});

	it("moving a card touches the two lists, and nothing else", () => {
		const b = sample();
		const c = b.collection.find((x: Obj) => x.id === "c1")!;
		c.listId = "l2";
		c.dateModified = 300;
		expect(differing(sample(), b)).toEqual(["list-l1.json.gz", "list-l2.json.gz"]);
	});

	it("adding a card to a deck touches only that deck's shard", () => {
		const b = sample();
		b.decks[0].cards.push(deckCard("new"));
		expect(differing(sample(), b)).toEqual(["deck-d1.json.gz"]);
	});

	it("a card added to an empty deck creates its shard; emptying a deck makes the old shard differ", () => {
		const b = sample();
		b.decks[1].cards.push(deckCard("first"));
		expect(differing(sample(), b)).toEqual(["deck-d2.json.gz"]);
		const c = sample();
		c.decks[0].cards = [];
		expect(differing(sample(), c)).toEqual(["deck-d1.json.gz"]);
	});

	it("renaming a list or a deck, or changing a setting, touches only the common shard", () => {
		const b = sample();
		b.lists[0].name = "Renamed";
		b.lists[0].dateModified = 50;
		expect(differing(sample(), b)).toEqual([CORE_SHARD]);
		const c = sample();
		c.priceCurrency = "EUR";
		expect(differing(sample(), c)).toEqual([CORE_SHARD]);
	});

	it("a deletion shows in the common shard (tombstone) and in the list's shard", () => {
		const b = sample();
		b.collection = b.collection.filter((c: Obj) => c.id !== "c4");
		b.syncTombstones.collection.c4 = 500;
		expect(differing(sample(), b)).toEqual([CORE_SHARD, "list-l2.json.gz"]);
	});

	it("prices alone never make a shard differ, and neither do the refresh and backup dates", () => {
		const b = sample();
		for (const c of b.collection) {
			c.priceUsd = "99.00";
			c.priceEurFoil = "5.00";
		}
		b.lastPriceRefresh = 9_999_999;
		b.lastAutoBackup = 8_888_888;
		b.syncStamps.lastPriceRefresh = 9_999_999;
		b.syncStamps.lastAutoBackup = 8_888_888;
		expect(differing(sample(), b)).toEqual([]);
	});

	it("the order of cards and of keys does not matter", () => {
		const b = sample();
		b.collection.reverse();
		b.collection = b.collection.map((c: Obj) => Object.fromEntries(Object.entries(c).reverse()));
		expect(differing(sample(), b)).toEqual([]);
	});

	it("an empty shard is the same as a missing one — but a remote shard that still has cards is not", () => {
		const empty = { _shard: 2, collection: [] };
		expect(shardsEqual("list-x.json.gz", undefined, empty)).toBe(true);
		expect(shardsEqual("list-x.json.gz", empty, undefined)).toBe(true);
		expect(isEmptyShard(empty)).toBe(true);
		expect(shardsEqual("list-x.json.gz", undefined, { _shard: 2, collection: [card("c", "x")] })).toBe(false);
		expect(shardsEqual("deck-x.json.gz", undefined, { _shard: 2, decks: [{ id: "x", cards: [] }] })).toBe(true);
		expect(shardsEqual("deck-x.json.gz", undefined, { _shard: 2, decks: [{ id: "x", cards: [deckCard("a")] }] })).toBe(false);
	});

	it("the common shard is never 'missing': it differs from nothing", () => {
		const core = shardMap(sample()).get(CORE_SHARD)!;
		expect(shardsEqual(CORE_SHARD, undefined, core)).toBe(false);
		expect(shardsEqual(CORE_SHARD, undefined, undefined)).toBe(true);
	});
});

describe("file names", () => {
	it("are safe whatever the identifier, and never collide", () => {
		expect(shardFileName("list", "mt8kv8azco9k5w")).toBe("list-mt8kv8azco9k5w.json.gz");
		const odd = shardFileName("list", "a/b c..\\é");
		expect(odd).toMatch(/^list-[A-Za-z0-9_~-]+\.json\.gz$/); // nothing a file system or a URL would choke on
		expect(isShardFileName(odd)).toBe(true);
		expect(shardFileName("list", "a/b")).not.toBe(shardFileName("list", "a_b"));
		expect(shardFileName("list", "x")).not.toBe(shardFileName("deck", "x"));
	});

	it("tell shards from the other files of the folder", () => {
		expect(isShardFileName("core.json.gz")).toBe(true);
		expect(isShardFileName("list-abc.json.gz")).toBe(true);
		expect(isShardFileName("wantlist-abc.json.gz")).toBe(true);
		expect(isShardFileName("deck-abc.json.gz")).toBe(true);
		expect(isShardFileName("data.json.gz")).toBe(false); // the single file of the previous versions
		expect(isShardFileName("data.json")).toBe(false);
		expect(isShardFileName("README.md")).toBe(false);
		expect(isShardFileName("list-.json.gz")).toBe(false);
	});
});
