import { describe, it, expect } from "vitest";
import {
	deepEqual,
	mergeSettings,
	MergeReport,
	applySettingsInPlace,
	snapshotKeys,
	snapshotScalars,
	recordScalarStamps,
	settingsEqual,
	recordTombstones,
	TOMBSTONE_TTL_MS,
	Tombstones,
} from "./settings-merge";

type Obj = Record<string, any>;

const card = (id: string, extra: Obj = {}): Obj => ({
	id,
	name: `Card ${id}`,
	count: 1,
	condition: "NM",
	priceUsd: "1.00",
	dateAdded: 100,
	dateModified: 100,
	...extra,
});

const deckCard = (scryfallId: string, extra: Obj = {}): Obj => ({
	scryfallId,
	name: `DC ${scryfallId}`,
	count: 1,
	dateAdded: 100,
	dateModified: 100,
	...extra,
});

function settings(extra: Obj = {}): Obj {
	return {
		collection: [],
		lists: [],
		decks: [],
		wantlist: [],
		wantlists: [],
		savedSearchFilters: [],
		priceCurrency: "usd",
		...extra,
	};
}

const ids = (arr: Obj[]) => arr.map((e) => e.id);

// mergeSettings returns an "unknown" object (the module doesn't know the
// shape of the settings): we retype it here so the assertions stay readable.
function run(base: Obj | null, local: Obj, remote: Obj): { merged: Obj; report: MergeReport } {
	const res = mergeSettings(base, local, remote);
	return { merged: res.merged as Obj, report: res.report };
}

describe("deepEqual", () => {
	it("treats undefined properties like absent ones", () => {
		expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
		expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
		expect(deepEqual({ a: 1 }, { a: 1, b: 0 })).toBe(false);
	});
	it("ignores key order, not array order", () => {
		expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
		expect(deepEqual([1, 2], [2, 1])).toBe(false);
	});
	it("distinguishes arrays from objects and null from objects", () => {
		expect(deepEqual([], {})).toBe(false);
		expect(deepEqual(null, {})).toBe(false);
	});
});

describe("mergeSettings — presence", () => {
	it("keeps entities that exist on one side only (never deduces a deletion from absence)", () => {
		const local = settings({ collection: [card("a"), card("x")] });
		const remote = settings({ collection: [card("a"), card("y")] });
		const { merged } = run(null, local, remote);
		expect(ids(merged.collection).sort()).toEqual(["a", "x", "y"]);
	});

	it("keeps local order first, then appends what came from the other device", () => {
		const local = settings({ collection: [card("b"), card("a")] });
		const remote = settings({ collection: [card("a"), card("c")] });
		expect(ids(run(null, local, remote).merged.collection)).toEqual(["b", "a", "c"]);
	});

	it("honors a remote tombstone for an entity that has not been modified since", () => {
		const local = settings({ collection: [card("a"), card("x", { dateModified: 100 })] });
		const remote = settings({ collection: [card("a")], syncTombstones: { collection: { x: 500 } } });
		const { merged, report } = run(null, local, remote);
		expect(ids(merged.collection)).toEqual(["a"]);
		expect(report.removed).toBe(1);
		expect(merged.syncTombstones).toEqual({ collection: { x: 500 } });
	});

	it("honors a LOCAL tombstone against a stale copy still present remotely", () => {
		const local = settings({ collection: [card("a")], syncTombstones: { collection: { x: 500 } } });
		const remote = settings({ collection: [card("a"), card("x", { dateModified: 100 })] });
		const { merged, report } = run(null, local, remote);
		expect(ids(merged.collection)).toEqual(["a"]);
		expect(report.removed).toBe(0); // never held locally
		expect(report.needsWrite).toBe(true); // remote still has the stale copy
	});

	it("an edit made AFTER the deletion wins over the tombstone", () => {
		const local = settings({ collection: [card("x", { dateModified: 900 })] });
		const remote = settings({ collection: [], syncTombstones: { collection: { x: 500 } } });
		expect(ids(run(null, local, remote).merged.collection)).toEqual(["x"]);
	});

	it("does not resurrect a card when the remote simply skipped a version (no base needed)", () => {
		// The iPad saw a version where Y existed, the Mac deleted it: without a tombstone,
		// the iPad cannot know that it isn't "a card it added".
		const ipad = settings({ collection: [card("a"), card("y", { dateModified: 200 })] });
		const mac = settings({ collection: [card("a")], syncTombstones: { collection: { y: 300 } } });
		expect(ids(run(null, ipad, mac).merged.collection)).toEqual(["a"]);
	});

	it("an empty or brand-new remote can never wipe the local data", () => {
		const local = settings({ collection: [card("a"), card("b")], lists: [{ id: "L", name: "Mine" }] });
		const remote = settings();
		const { merged } = run(settings({ collection: [card("a"), card("b")] }), local, remote);
		expect(ids(merged.collection)).toEqual(["a", "b"]);
		expect(ids(merged.lists)).toEqual(["L"]);
	});

	it("tombstones also delete entities without any timestamp (lists)", () => {
		const local = settings({ lists: [{ id: "L1", name: "Old" }] });
		const remote = settings({ syncTombstones: { lists: { L1: 10 } } });
		expect(run(null, local, remote).merged.lists).toEqual([]);
	});
});

describe("mergeSettings — entity contents", () => {
	it("an entity changed on one device only is taken whole by the other (three-way)", () => {
		const base = settings({ collection: [card("a")] });
		const local = settings({ collection: [card("a")] });
		const remote = settings({ collection: [card("a", { count: 4, condition: "LP", dateModified: 150 })] });
		const [m] = run(base, local, remote).merged.collection;
		expect(m).toMatchObject({ count: 4, condition: "LP" });
	});

	it("a non-timestamped edit (price refresh) on a device that is not behind is kept", () => {
		const base = settings({ collection: [card("a")] });
		const local = settings({ collection: [card("a", { priceUsd: "2.50" })] }); // no date touched
		const remote = settings({ collection: [card("a")] });
		expect(run(base, local, remote).merged.collection[0].priceUsd).toBe("2.50");
	});

	it("a remote entity touched AFTER ours wins even if it looks like the old base (revert)", () => {
		// Setting put back to its original value elsewhere: without the date, it would be taken for "unchanged".
		const base = settings({ collection: [card("a", { condition: "NM", dateModified: 100 })] });
		const local = settings({ collection: [card("a", { condition: "LP", dateModified: 200 })] });
		const remote = settings({ collection: [card("a", { condition: "NM", dateModified: 300 })] });
		expect(run(base, local, remote).merged.collection[0].condition).toBe("NM");
	});

	it("on a real conflict the newer card wins whole (a refreshed price may be dropped, never a count)", () => {
		const base = settings({ collection: [card("a")] });
		const local = settings({ collection: [card("a", { count: 3, dateModified: 300 })] });
		const remote = settings({ collection: [card("a", { priceUsd: "2.50" })] });
		const [m] = run(base, local, remote).merged.collection;
		expect(m.count).toBe(3);
	});

	it("a list is resolved whole by date: the most recent rename wins on both devices", () => {
		const base = settings({ lists: [{ id: "L", name: "Old", dateModified: 100 }] });
		const a = settings({ lists: [{ id: "L", name: "Renamed on A", dateModified: 200 }] });
		const b = settings({ lists: [{ id: "L", name: "Renamed on B", dateModified: 300 }] });
		expect(run(base, a, b).merged.lists[0].name).toBe("Renamed on B");
		expect(run(base, b, a).merged.lists[0].name).toBe("Renamed on B");
	});

	it("deck fields merge one by one (a rename here, a new format there), cards separately", () => {
		const base = settings({ decks: [{ id: "D", name: "Old", format: "", cards: [] }] });
		const local = settings({ decks: [{ id: "D", name: "Renamed", format: "", cards: [] }] });
		const remote = settings({ decks: [{ id: "D", name: "Old", format: "commander", cards: [] }] });
		expect(run(base, local, remote).merged.decks[0]).toMatchObject({ name: "Renamed", format: "commander" });
	});

	it("on a real conflict the most recent dateModified wins", () => {
		const base = settings({ collection: [card("a")] });
		const local = settings({ collection: [card("a", { count: 2, dateModified: 200 })] });
		const remote = settings({ collection: [card("a", { count: 5, dateModified: 400 })] });
		expect(run(base, local, remote).merged.collection[0].count).toBe(5);
		expect(run(base, remote, local).merged.collection[0].count).toBe(5);
	});

	it("resolves a perfect tie identically whichever device merges", () => {
		const base = settings({ collection: [card("a")] });
		const a = settings({ collection: [card("a", { count: 2, dateModified: 200 })] });
		const b = settings({ collection: [card("a", { count: 7, dateModified: 200 })] });
		const ab = run(base, a, b).merged.collection[0];
		const ba = run(base, b, a).merged.collection[0];
		expect(ab.count).toBe(ba.count);
	});

	it("propagates a removed field (e.g. a cleared manual function) when only one side removed it", () => {
		const base = settings({ decks: [{ id: "D", name: "D", cards: [deckCard("s1", { deckFunctionOverride: "Ramp" })] }] });
		const local = settings({ decks: [{ id: "D", name: "D", cards: [deckCard("s1", { deckFunctionOverride: "Ramp" })] }] });
		const remote = settings({ decks: [{ id: "D", name: "D", cards: [deckCard("s1", { deckFunctionOverride: "Ramp" })] }] });
		delete remote.decks[0].cards[0].deckFunctionOverride;
		remote.decks[0].cards[0].dateModified = 300;
		const out = run(base, local, remote).merged.decks[0].cards[0];
		expect(out.deckFunctionOverride).toBeUndefined();
	});

	it("preserves unknown fields written by a newer plugin version", () => {
		const local = settings({ collection: [card("a")] });
		const remote = settings({ collection: [card("a", { futureField: { x: 1 } })], futureSetting: 42 });
		const { merged } = run(null, local, remote);
		expect(merged.collection[0].futureField).toEqual({ x: 1 });
		expect(merged.futureSetting).toBe(42);
	});
});

describe("mergeSettings — scalars and decks", () => {
	it("three-way on scalar settings: each device's own change survives", () => {
		const base = settings({ priceCurrency: "usd", accentColor: "" });
		const local = settings({ priceCurrency: "usd", accentColor: "red" });
		const remote = settings({ priceCurrency: "eur", accentColor: "" });
		const { merged } = run(base, local, remote);
		expect(merged.accentColor).toBe("red");
		expect(merged.priceCurrency).toBe("eur");
	});

	it("timestamps that must never go back take the max", () => {
		const base = settings({ lastPriceRefresh: 1 });
		const local = settings({ lastPriceRefresh: 10 });
		const remote = settings({ lastPriceRefresh: 20 });
		expect(run(base, local, remote).merged.lastPriceRefresh).toBe(20);
	});

	it("a remote file lacking a setting (older version) never erases it locally", () => {
		const local = settings({ suggestionCountThreshold: 3000 });
		const remote = settings();
		expect(run(null, local, remote).merged.suggestionCountThreshold).toBe(3000);
	});

	it("merges the cards of a deck separately: both devices' additions survive", () => {
		const base = settings({ decks: [{ id: "D", name: "Deck", cards: [deckCard("s0")] }] });
		const local = settings({ decks: [{ id: "D", name: "Deck", cards: [deckCard("s0"), deckCard("s1")] }] });
		const remote = settings({ decks: [{ id: "D", name: "Deck", cards: [deckCard("s0"), deckCard("s2")] }] });
		const cards = run(base, local, remote).merged.decks[0].cards;
		expect(cards.map((c: Obj) => c.scryfallId).sort()).toEqual(["s0", "s1", "s2"]);
	});

	it("a deck rename on one device and a card added on the other both survive", () => {
		const base = settings({ decks: [{ id: "D", name: "Deck", cards: [deckCard("s0")] }] });
		const local = settings({ decks: [{ id: "D", name: "Renamed", cards: [deckCard("s0")] }] });
		const remote = settings({ decks: [{ id: "D", name: "Deck", cards: [deckCard("s0"), deckCard("s2")] }] });
		const deck = run(base, local, remote).merged.decks[0];
		expect(deck.name).toBe("Renamed");
		expect(deck.cards).toHaveLength(2);
	});

	it("a deck card deleted on one device (tombstone) is removed from the other's copy", () => {
		const local = settings({ decks: [{ id: "D", name: "Deck", cards: [deckCard("s0"), deckCard("s1")] }] });
		const remote = settings({
			decks: [{ id: "D", name: "Deck", cards: [deckCard("s0")] }],
			syncTombstones: { "decks.cards": { "D|s1|mainboard|": 500 } },
		});
		const cards = run(null, local, remote).merged.decks[0].cards;
		expect(cards.map((c: Obj) => c.scryfallId)).toEqual(["s0"]);
	});

	it("keeps a Commander row and a mainboard row of the same card as two cards", () => {
		const local = settings({
			decks: [{ id: "D", name: "Deck", cards: [deckCard("s0", { deckFunctionOverride: "Commander" }), deckCard("s0")] }],
		});
		const remote = settings({
			decks: [{ id: "D", name: "Deck", cards: [deckCard("s0", { deckFunctionOverride: "Commander" }), deckCard("s0")] }],
		});
		const out = run(null, local, remote);
		expect(out.merged.decks[0].cards).toHaveLength(2);
		expect(out.report.changedLocal).toBe(false);
		expect(out.report.needsWrite).toBe(false);
	});
});

// A setting set before 1.0.503 has no timestamp; a NEW device has the default values: with no base or timestamp,
// alphabetical order decided ("usd" > "eur"), and the currency of the whole collection flipped to USD.
describe("mergeSettings — a value nobody touched never beats the one the user chose", () => {
	const DEFAULTS: Obj = { priceCurrency: "usd", accentColor: "" };
	const merge = (base: Obj | null, local: Obj, remote: Obj, defaults: Obj | undefined = DEFAULTS) =>
		mergeSettings(base, local, remote, undefined, defaults) as { merged: Obj; report: MergeReport };

	it("a new device (the default) joining a setting chosen long ago adopts it, whichever side it is on", () => {
		const fresh = settings({ priceCurrency: "usd" });
		const old = settings({ priceCurrency: "eur" }); // set before stamps existed: no syncStamps
		expect(merge(null, fresh, old).merged.priceCurrency).toBe("eur"); // the fresh device merging the old one's file
		expect(merge(null, old, fresh).merged.priceCurrency).toBe("eur"); // the old device meeting the fresh one's
	});

	it("converges and stays quiet: after adopting it, the fresh device has nothing to send back", () => {
		const fresh = settings({ priceCurrency: "usd" });
		const old = settings({ priceCurrency: "eur" });
		const first = merge(null, fresh, old);
		expect(first.merged.priceCurrency).toBe("eur");
		expect(first.report.needsWrite).toBe(false); // GitHub / the other device already holds exactly that
		const again = merge(old, first.merged, old);
		expect(again.report.changedLocal).toBe(false);
		expect(again.report.needsWrite).toBe(false);
	});

	it("two values that both differ from the default keep the old tie-break (the same on every device)", () => {
		const a = settings({ accentColor: "red" });
		const b = settings({ accentColor: "blue" });
		const ab = merge(null, a, b).merged.accentColor;
		const ba = merge(null, b, a).merged.accentColor;
		expect(ab).toBe(ba);
		expect(["red", "blue"]).toContain(ab);
	});

	it("two defaults are just equal", () => {
		const out = merge(null, settings(), settings());
		expect(out.merged.priceCurrency).toBe("usd");
		expect(out.report.changedLocal).toBe(false);
		expect(out.report.needsWrite).toBe(false);
	});

	it("an explicit choice is never overridden: a stamp beats the rule, and so does a base", () => {
		// The user deliberately went back to the default on this device (stamped), the other still has the old value.
		const local = settings({ priceCurrency: "usd", syncStamps: { priceCurrency: 500 } });
		const remote = settings({ priceCurrency: "eur" });
		expect(merge(null, local, remote).merged.priceCurrency).toBe("usd");
		// Three-way: only the remote moved away from the base, so the remote wins even though the local one is the default.
		const base = settings({ priceCurrency: "usd" });
		expect(merge(base, settings({ priceCurrency: "usd" }), settings({ priceCurrency: "eur" })).merged.priceCurrency).toBe("eur");
		// Three-way: only the local one moved (to the default) away from a non-default base: it stays.
		const base2 = settings({ priceCurrency: "eur" });
		expect(merge(base2, settings({ priceCurrency: "usd" }), settings({ priceCurrency: "eur" })).merged.priceCurrency).toBe("usd");
	});

	it("without the defaults, nothing changes (the parameter is optional)", () => {
		const fresh = settings({ priceCurrency: "usd" });
		const old = settings({ priceCurrency: "eur" });
		const a = merge(null, fresh, old, undefined).merged.priceCurrency;
		const b = merge(null, old, fresh, undefined).merged.priceCurrency;
		expect(a).toBe(b); // still symmetric, as before — just not the value the user chose
	});

	it("only knows the keys it has a default for", () => {
		const out = merge(null, settings({ someFutureSetting: "x" }), settings({ someFutureSetting: "y" }));
		expect(["x", "y"]).toContain(out.merged.someFutureSetting);
	});
});

describe("mergeSettings — report", () => {
	it("adoption of a strictly newer remote needs no write", () => {
		const base = settings({ collection: [card("a")] });
		const local = settings({ collection: [card("a")] });
		const remote = settings({ collection: [card("a"), card("b")] });
		const { report } = run(base, local, remote);
		expect(report).toMatchObject({ added: 1, removed: 0, changedLocal: true, needsWrite: false });
	});

	it("local-only changes need a write but change nothing locally", () => {
		const base = settings({ collection: [card("a")] });
		const local = settings({ collection: [card("a"), card("c")] });
		const remote = settings({ collection: [card("a")] });
		const { report } = run(base, local, remote);
		expect(report).toMatchObject({ added: 0, changedLocal: false, needsWrite: true });
	});

	it("both changed: both flags set", () => {
		const local = settings({ collection: [card("a"), card("c")] });
		const remote = settings({ collection: [card("a"), card("b")] });
		const { report } = run(null, local, remote);
		expect(report).toMatchObject({ added: 1, changedLocal: true, needsWrite: true });
	});

	it("does not mutate its inputs", () => {
		const local = settings({ collection: [card("a")] });
		const remote = settings({ collection: [card("a", { count: 9, dateModified: 999 }), card("b")] });
		const snapLocal = JSON.stringify(local);
		const snapRemote = JSON.stringify(remote);
		run(null, local, remote);
		expect(JSON.stringify(local)).toBe(snapLocal);
		expect(JSON.stringify(remote)).toBe(snapRemote);
	});
});

describe("snapshotKeys / recordTombstones", () => {
	it("records a tombstone for what disappeared since the last snapshot", () => {
		const s = settings({ collection: [card("a"), card("b")], lists: [{ id: "L" }] });
		const prev = snapshotKeys(s);
		s.collection = [card("a")];
		expect(recordTombstones(s, prev, 1000)).toBe(1);
		expect(s.syncTombstones).toEqual({ collection: { b: 1000 } });
	});

	it("records nested deck-card deletions, but not for a deck that vanished entirely", () => {
		const s = settings({
			decks: [
				{ id: "D1", cards: [deckCard("s0"), deckCard("s1")] },
				{ id: "D2", cards: [deckCard("t0")] },
			],
		});
		const prev = snapshotKeys(s);
		s.decks = [{ id: "D1", cards: [deckCard("s0")] }];
		recordTombstones(s, prev, 1000);
		expect(s.syncTombstones).toEqual({
			decks: { D2: 1000 },
			"decks.cards": { "D1|s1|mainboard|": 1000 },
		});
	});

	it("removes the tombstone of an entity that reappears (restored backup) and makes it newer than the deletion", () => {
		const s = settings({ collection: [card("a")], syncTombstones: { collection: { a: 500 } } });
		const prev = { collection: new Set<string>() } as Record<string, Set<string>>;
		recordTombstones(s, prev, 1000);
		expect(s.syncTombstones).toBeUndefined();
		// Without this, another device that keeps the tombstone would make it disappear again.
		expect(s.collection[0].dateModified).toBe(1000);
		const other = settings({ syncTombstones: { collection: { a: 500 } } });
		expect(ids(run(null, s, other).merged.collection)).toEqual(["a"]);
	});

	it("also revives a reappearing deck card and a reappearing list", () => {
		const s = settings({
			lists: [{ id: "L", name: "Back" }],
			decks: [{ id: "D", cards: [deckCard("s0", { dateModified: 10 })] }],
			syncTombstones: { lists: { L: 500 }, "decks.cards": { "D|s0|mainboard|": 500 } },
		});
		const prev: Record<string, Set<string>> = { lists: new Set(), decks: new Set(["D"]), "decks.cards": new Set() };
		recordTombstones(s, prev, 1000);
		expect(s.lists[0].dateModified).toBe(1000);
		expect(s.decks[0].cards[0].dateModified).toBe(1000);
	});

	it("purges tombstones older than the TTL and drops the empty container", () => {
		const s = settings({ syncTombstones: { collection: { old: 1, recent: 10 * TOMBSTONE_TTL_MS } } as Tombstones });
		recordTombstones(s, snapshotKeys(s), 10 * TOMBSTONE_TTL_MS + 5);
		expect(s.syncTombstones).toEqual({ collection: { recent: 10 * TOMBSTONE_TTL_MS } });
	});

	it("never invents a deletion when a collection is missing or unreadable", () => {
		const s = settings({ collection: [card("a")] });
		const prev = snapshotKeys(s);
		delete (s as Obj).collection;
		expect(recordTombstones(s, prev, 1000)).toBe(0);
	});
});

describe("applySettingsInPlace", () => {
	it("keeps the identity of surviving entities (open modals keep a live reference)", () => {
		const held = card("a", { count: 1 });
		const target = settings({ collection: [held, card("gone")] });
		const incoming = settings({ collection: [card("a", { count: 7 }), card("new")] });
		applySettingsInPlace(target, incoming);
		expect(target.collection[0]).toBe(held);
		expect(held.count).toBe(7);
		expect(ids(target.collection)).toEqual(["a", "new"]);
	});

	it("keeps the identity of the arrays themselves", () => {
		const arr: Obj[] = [card("a")];
		const target = settings({ collection: arr });
		applySettingsInPlace(target, settings({ collection: [card("a"), card("b")] }));
		expect(target.collection).toBe(arr);
		expect(arr).toHaveLength(2);
	});

	it("updates nested deck cards in place and removes the ones that disappeared", () => {
		const held = deckCard("s0", { count: 1 });
		const target = settings({ decks: [{ id: "D", name: "Old", cards: [held, deckCard("s1")] }] });
		const deckObj = target.decks[0];
		applySettingsInPlace(
			target,
			settings({ decks: [{ id: "D", name: "New", cards: [deckCard("s0", { count: 3 })] }] })
		);
		expect(target.decks[0]).toBe(deckObj);
		expect(deckObj.name).toBe("New");
		expect(deckObj.cards).toEqual([held]);
		expect(held.count).toBe(3);
	});

	it("removes a field that no longer exists on the incoming entity", () => {
		const held = card("a", { gradingCompany: "PSA" });
		const target = settings({ collection: [held] });
		applySettingsInPlace(target, settings({ collection: [card("a")] }));
		expect("gradingCompany" in held).toBe(false);
	});

	it("is a no-op (no churn) when nothing differs", () => {
		const a = card("a");
		const arr = [a];
		const target = settings({ collection: arr });
		applySettingsInPlace(target, settings({ collection: [card("a")] }));
		expect(target.collection).toBe(arr);
		expect(arr[0]).toBe(a);
	});

	it("round-trips with mergeSettings: applying the merge result yields the merged state", () => {
		const base = settings({ collection: [card("a")] });
		const local = settings({ collection: [card("a", { condition: "LP", dateModified: 200 }), card("l")], priceCurrency: "eur" });
		const remote = settings({ collection: [card("a", { count: 3, dateModified: 150 }), card("r")] });
		const { merged } = run(base, local, remote);
		applySettingsInPlace(local, merged);
		expect(deepEqual(local, merged)).toBe(true);
	});
});

describe("device-local settings are outside the merge", () => {
	it("are never merged, compared or stamped", () => {
		const local = settings({ collectionViewMode: "card", navCollapsed: true, priceCurrency: "usd" });
		const remote = settings({ collectionViewMode: "grid", navCollapsed: false, priceCurrency: "eur" });
		const { merged, report } = run(null, local, remote);
		expect(merged.collectionViewMode).toBeUndefined();
		expect(merged.navCollapsed).toBeUndefined();
		// A shared setting is still merged normally (conflict with no date: canonical order, hence "usd").
		expect(merged.priceCurrency).toBe("usd");
		expect(report.changedLocal).toBe(false);
		const same = { ...local, collectionViewMode: "list", navCollapsed: false };
		expect(settingsEqual(local, same)).toBe(true);
		expect(Object.keys(snapshotScalars(local))).not.toContain("collectionViewMode");
	});

	it("a preference change alone is not a change: no stamp, nothing to write", () => {
		const local = settings({ deckSortBy: "name" });
		const prev = snapshotScalars(local);
		local.deckSortBy = "price";
		expect(recordScalarStamps(local, prev, 1000)).toBe(0);
		expect(local.syncStamps).toBeUndefined();
		const { report } = run(null, local, settings({ deckSortBy: "name" }));
		expect(report).toMatchObject({ changedLocal: false, needsWrite: false });
	});

	it("an old-version file that still carries them leaves the local values alone", () => {
		const local = settings({ collectionViewMode: "card" });
		const remote = settings({ collectionViewMode: "grid", collection: [card("a")] });
		const { merged } = run(null, local, remote);
		applySettingsInPlace(local, merged);
		expect(local.collectionViewMode).toBe("card");
		expect(ids(local.collection)).toEqual(["a"]);
	});
});
