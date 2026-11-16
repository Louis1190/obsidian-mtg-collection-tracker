import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// scryfall-cache.ts imports api/scryfall.ts (which imports `requestUrl` from "obsidian": types only, no runtime) and the view
// (only to find the open views): neither is needed here.
vi.mock("obsidian", () => ({ normalizePath: (p: string) => p, requestUrl: vi.fn() }));
vi.mock("../view", () => ({ MTGCollectionView: class {} }));

import * as scryfallCache from "./scryfall-cache";
import { colCard, deckCard, makePlugin, wantCard } from "./__tests__/plugin-harness";
import type { Obj, TestPlugin } from "./__tests__/plugin-harness";

// What the legalities cache keeps on disk and in memory (audit of 2026-11-15, lot 3). On a real 4,900-card collection the
// file held 20,363 entries (11.4 MB): 15,450 of them for cards that were in no list, wantlist or deck and whose data was
// older than the 7-day TTL, never dropped because nothing ever removed an entry. The rule now: an entry is kept when the
// card is held somewhere (even expired: an expired entry is still SERVED at once while the refresh runs, see
// isLegalitiesFresh) or when it is still fresh.

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const DIR = ".obsidian/plugins/mtg";
const FILE = `${DIR}/legalities-cache.json`;
const legal = { modern: "legal", standard: "not_legal" };
const entry = (ageDays: number, legalities: Record<string, string> = legal) => ({ legalities, fetchedAt: NOW - ageDays * DAY });

function adapterWith(files: Record<string, string>) {
	const store = new Map(Object.entries(files));
	return {
		store,
		exists: async (p: string) => store.has(p),
		read: async (p: string) => {
			if (!store.has(p)) throw new Error("ENOENT");
			return store.get(p)!;
		},
		write: vi.fn(async (p: string, text: string) => {
			store.set(p, text);
		}),
	};
}

function plugin(disk: Record<string, unknown> | string | null, settings: Obj = {}): TestPlugin & { adapter: ReturnType<typeof adapterWith> } {
	const adapter = adapterWith(disk === null ? {} : { [FILE]: typeof disk === "string" ? disk : JSON.stringify(disk) });
	const p = makePlugin([scryfallCache], {
		collection: [colCard({ scryfallId: "own-fresh" }), colCard({ id: "c2", scryfallId: "own-expired" })],
		wantlist: [wantCard({ scryfallId: "wanted-expired" })],
		decks: [{ id: "d", name: "D", dateCreated: 1, cards: [deckCard({ scryfallId: "deck-expired" })] }],
		...settings,
	}) as TestPlugin & { adapter: ReturnType<typeof adapterWith> };
	Object.assign(p, {
		legalitiesCache: new Map<string, Record<string, string>>(),
		legalitiesFetchedAt: new Map<string, number>(),
		legalitiesPersistTimer: null,
		manifest: { dir: DIR },
		app: { vault: { adapter } },
		scheduleLegalitiesPersist: vi.fn(),
		adapter,
	});
	return p;
}

// What a real session's file looked like: held cards (fresh and expired) among many that nobody holds.
const mixedDisk = () => ({
	"own-fresh": entry(1),
	"own-expired": entry(40),
	"wanted-expired": entry(90),
	"deck-expired": entry(30),
	"stranger-fresh": entry(2),
	"stranger-expired": entry(20),
	"stranger-ancient": entry(300),
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("loadPersistedLegalitiesCache", () => {
	it("keeps the cards held in a list, a wantlist or a deck whatever their age, and the entries still fresh; drops the rest", async () => {
		const p = plugin(mixedDisk());
		await p.loadPersistedLegalitiesCache();
		expect([...p.legalitiesCache.keys()].sort()).toEqual(["deck-expired", "own-expired", "own-fresh", "stranger-fresh", "wanted-expired"]);
		expect([...p.legalitiesFetchedAt.keys()].sort()).toEqual([...p.legalitiesCache.keys()].sort());
	});

	it("an expired entry of a held card is still SERVED right away, and is not 'fresh' (so the refresh still comes)", async () => {
		const p = plugin(mixedDisk());
		await p.loadPersistedLegalitiesCache();
		expect(p.getCachedLegalities("own-expired")).toEqual(legal);
		expect(p.isLegalitiesFresh("own-expired")).toBe(false);
		expect(p.isLegalitiesFresh("own-fresh")).toBe(true);
	});

	it("asks for the file to be rewritten when it dropped something, so it shrinks at once", async () => {
		const p = plugin(mixedDisk());
		await p.loadPersistedLegalitiesCache();
		expect(p.scheduleLegalitiesPersist).toHaveBeenCalledTimes(1);
	});

	it("does not rewrite a file that had nothing to drop", async () => {
		const p = plugin({ "own-fresh": entry(1), "own-expired": entry(40), "stranger-fresh": entry(3) });
		await p.loadPersistedLegalitiesCache();
		expect(p.legalitiesCache.size).toBe(3);
		expect(p.scheduleLegalitiesPersist).not.toHaveBeenCalled();
	});

	it("an entry exactly as old as the TTL is expired (the freshness test is a strict 'younger than')", async () => {
		const p = plugin({ "stranger-edge": entry(7), "stranger-just-fresh": { legalities: legal, fetchedAt: NOW - 7 * DAY + 1 } });
		await p.loadPersistedLegalitiesCache();
		expect([...p.legalitiesCache.keys()]).toEqual(["stranger-just-fresh"]);
	});

	it("keeps every fresh entry when the person holds no card at all, and drops the expired ones", async () => {
		const p = plugin(mixedDisk(), { collection: [], wantlist: [], decks: [] });
		await p.loadPersistedLegalitiesCache();
		expect([...p.legalitiesCache.keys()].sort()).toEqual(["own-fresh", "stranger-fresh"]);
	});

	it("skips malformed entries, and survives a missing, empty or corrupted file", async () => {
		const bad = plugin({ ok: entry(1), noLegalities: { fetchedAt: NOW }, noDate: { legalities: legal }, nothing: null, text: "x" });
		await bad.loadPersistedLegalitiesCache();
		expect([...bad.legalitiesCache.keys()]).toEqual(["ok"]);
		for (const disk of [null, "", "{ not json", "[1,2,3]", "null"]) {
			const p = plugin(disk);
			await expect(p.loadPersistedLegalitiesCache()).resolves.toBeUndefined();
			expect(p.legalitiesCache.size).toBe(0);
		}
	});

	it("does nothing when the plugin has no folder", async () => {
		const p = plugin(mixedDisk());
		(p as Obj).manifest = {};
		await p.loadPersistedLegalitiesCache();
		expect(p.legalitiesCache.size).toBe(0);
	});
});

describe("flushLegalitiesPersist", () => {
	it("writes the kept entries as {legalities, fetchedAt} under the plugin's folder, and none of the forgotten ones", async () => {
		const p = plugin(null);
		const set = (id: string, ageDays: number) => {
			p.legalitiesCache.set(id, legal);
			p.legalitiesFetchedAt.set(id, NOW - ageDays * DAY);
		};
		set("own-fresh", 1);
		set("own-expired", 50);
		set("stranger-fresh", 2);
		set("stranger-expired", 50);
		await p.flushLegalitiesPersist();
		const written = JSON.parse(p.adapter.store.get(FILE)!);
		expect(Object.keys(written).sort()).toEqual(["own-expired", "own-fresh", "stranger-fresh"]);
		expect(written["own-expired"]).toEqual({ legalities: legal, fetchedAt: NOW - 50 * DAY });
	});

	it("also forgets them in memory, so a session left open for weeks stays bounded", async () => {
		const p = plugin(null);
		p.legalitiesCache.set("stranger-expired", legal);
		p.legalitiesFetchedAt.set("stranger-expired", NOW - 50 * DAY);
		p.legalitiesCache.set("own-expired", legal);
		p.legalitiesFetchedAt.set("own-expired", NOW - 50 * DAY);
		await p.flushLegalitiesPersist();
		expect([...p.legalitiesCache.keys()]).toEqual(["own-expired"]);
		expect([...p.legalitiesFetchedAt.keys()]).toEqual(["own-expired"]);
	});

	it("an entry with no date is left out of the file (it cannot be judged), as before", async () => {
		const p = plugin(null);
		p.legalitiesCache.set("own-fresh", legal);
		await p.flushLegalitiesPersist();
		expect(JSON.parse(p.adapter.store.get(FILE)!)).toEqual({});
	});

	it("a failed write is swallowed: the session keeps its in-memory cache", async () => {
		const p = plugin(null);
		p.legalitiesCache.set("own-fresh", legal);
		p.legalitiesFetchedAt.set("own-fresh", NOW);
		p.adapter.write.mockRejectedValueOnce(new Error("disk full"));
		await expect(p.flushLegalitiesPersist()).resolves.toBeUndefined();
		expect(p.legalitiesCache.has("own-fresh")).toBe(true);
	});

	it("a written file loads back as the same cache (round trip)", async () => {
		const first = plugin(mixedDisk());
		await first.loadPersistedLegalitiesCache();
		await first.flushLegalitiesPersist();
		const second = plugin(first.adapter.store.get(FILE)!);
		await second.loadPersistedLegalitiesCache();
		expect([...second.legalitiesCache.keys()].sort()).toEqual([...first.legalitiesCache.keys()].sort());
		expect(second.legalitiesFetchedAt).toEqual(first.legalitiesFetchedAt);
		expect(second.scheduleLegalitiesPersist).not.toHaveBeenCalled();
	});
});
