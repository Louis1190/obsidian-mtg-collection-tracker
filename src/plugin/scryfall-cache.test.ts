import { beforeEach, describe, expect, it, vi } from "vitest";

// Scripted fake network (see api/safe-request.test.ts): each request consumes the next step, the last one repeats.
const net = vi.hoisted(() => ({ steps: [] as (() => unknown)[], calls: 0, bodies: [] as string[] }));
vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p,
	requestUrl: async (params: { body?: string }) => {
		net.calls++;
		net.bodies.push(params.body ?? "");
		const step = net.steps.length > 1 ? net.steps.shift()! : net.steps[0];
		return step();
	},
}));
// scryfall-cache.ts only uses the view to find the open views: irrelevant here, and loading it would pull in the
// whole application.
vi.mock("../view", () => ({ MTGCollectionView: class {} }));

import {
	bulkFetchLegalities,
	fetchCardLegalities,
	fetchScryfallImmutableSnapshot,
	getCardLegalities,
	getScryfallImmutableSnapshot,
	getScryfallImmutableSnapshots,
	loadPersistedMapCache,
	prefetchCardTextNeighbors,
	prefetchScryfallImmutableSnapshots,
} from "./scryfall-cache";
import type MTGCollectionPlugin from "../plugin";
import { resetScryfallStrictGateForTests, slimImmutableSnapshot } from "../api/scryfall";

const transportError = () => new Error("Request Failed. ConnectException: Failed to connect");
const down = () => { throw transportError(); };
const okCollection = (cards: unknown[]) => () => ({ status: 200, json: { data: cards }, headers: {} });
const script = (...steps: (() => unknown)[]) => { net.steps = steps; };
const card = (id: string, extra: object = {}) => ({ id, legalities: { modern: "legal" }, oracle_text: "text", set: "lea", rarity: "rare", ...extra });

// A fake plugin: the caches and the "in-flight" requests that these functions read, and their real neighbors.
function fakePlugin() {
	const plugin = {
		legalitiesCache: new Map<string, Record<string, string>>(),
		legalitiesFetchedAt: new Map<string, number>(),
		legalitiesInFlight: new Map<string, Promise<Record<string, string> | null>>(),
		scryfallImmutableCache: new Map<string, unknown>(),
		scryfallImmutableInFlight: new Map<string, Promise<unknown>>(),
		scryfallPrefetchPromises: new WeakSet<Promise<unknown>>(),
		scryfallPrefetchPausedUntil: 0,
		scheduleLegalitiesPersist: vi.fn(),
		scheduleMapCachePersist: vi.fn(),
		isLegalitiesFresh: (id: string) => plugin.legalitiesCache.has(id),
		fetchCardLegalities,
		fetchScryfallImmutableSnapshot,
		getScryfallImmutableSnapshot,
		prefetchScryfallImmutableSnapshots,
	};
	return plugin as unknown as MTGCollectionPlugin & typeof plugin;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { net.steps = []; net.calls = 0; net.bodies = []; });

describe("a network failure is an unavailable card, not a rejected promise", () => {
	it("legalities: null after the retry, nothing cached, and the next try is not blocked", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(getCardLegalities.call(plugin, "c1")).resolves.toBeNull();
		await settle();
		expect(plugin.legalitiesCache.size).toBe(0);
		expect(plugin.legalitiesInFlight.size).toBe(0);
		// the connection comes back: the same card is requested again and works
		script(okCollection([card("c1")]));
		await expect(getCardLegalities.call(plugin, "c1")).resolves.toEqual({ modern: "legal" });
		expect(plugin.legalitiesCache.get("c1")).toEqual({ modern: "legal" });
	}, 10000);

	it("card text, faces, TCGplayer link (the immutable snapshot): null, nothing cached", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(fetchScryfallImmutableSnapshot.call(plugin, "c1")).resolves.toBeNull();
		expect(plugin.scryfallImmutableCache.size).toBe(0);
		script(okCollection([card("c1")]));
		await expect(fetchScryfallImmutableSnapshot.call(plugin, "c1")).resolves.toMatchObject({ oracle_text: "text", set: "lea" });
		expect(plugin.scryfallImmutableCache.has("c1")).toBe(true);
	}, 10000);

	it("one failed attempt is absorbed by the retry, as for an HTTP failure", async () => {
		const plugin = fakePlugin();
		script(down, okCollection([card("c1")]));
		await expect(fetchCardLegalities.call(plugin, "c1")).resolves.toEqual({ modern: "legal" });
	}, 10000);

	it("the bulk legalities pass resolves EVERY pending id (null) and frees them, so no card stays \"in flight\" forever", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(bulkFetchLegalities.call(plugin, ["a", "b", "c"])).resolves.toBe(true);
		await settle();
		expect(plugin.legalitiesInFlight.size).toBe(0);
		expect(plugin.scheduleLegalitiesPersist).toHaveBeenCalled();
		// what the old code blocked: opening the detail of one of them afterwards
		script(okCollection([card("a")]));
		await expect(getCardLegalities.call(plugin, "a")).resolves.toEqual({ modern: "legal" });
	}, 10000);

	it("the bulk pass keeps what arrived before the failure", async () => {
		const plugin = fakePlugin();
		const ids = Array.from({ length: 80 }, (_, i) => "id" + i); // 2 lots de 75
		script(okCollection(ids.slice(0, 75).map((id) => card(id))), down);
		await bulkFetchLegalities.call(plugin, ids);
		await settle();
		expect(plugin.legalitiesCache.size).toBe(75);
		expect(plugin.legalitiesInFlight.size).toBe(0);
	}, 10000);

	it("Home's batched snapshots: the cached ones are returned, the missing ones are simply absent", async () => {
		const plugin = fakePlugin();
		plugin.scryfallImmutableCache.set("known", { set: "lea", oracle_text: "x" });
		script(down);
		const result = await getScryfallImmutableSnapshots.call(plugin, ["known", "unknown"]);
		expect([...result.keys()]).toEqual(["known"]);
	}, 10000);

	it("the success path is unchanged (one request, snapshot cached)", async () => {
		const plugin = fakePlugin();
		script(okCollection([card("c1"), card("c2")]));
		const result = await getScryfallImmutableSnapshots.call(plugin, ["c1", "c2"]);
		expect([...result.keys()].sort()).toEqual(["c1", "c2"]);
		expect(net.calls).toBe(1);
	}, 10000);
});

describe("rules text of the neighbouring cards is fetched ahead, within Scryfall's rules", () => {
	const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
	const askedIds = (): string[] => net.bodies.flatMap((b) => (JSON.parse(b).identifiers as { id: string }[]).map((x) => x.id));

	it("asks for the 5 cards on each side of the displayed one, in ONE grouped request, never the displayed card itself", async () => {
		const plugin = fakePlugin();
		script(okCollection(ids.map((id) => card(id))));
		await prefetchCardTextNeighbors.call(plugin, ids, 10);
		expect(net.calls).toBe(1);
		expect(askedIds().sort()).toEqual(["c5", "c6", "c7", "c8", "c9", "c11", "c12", "c13", "c14", "c15"].sort());
		expect(plugin.scryfallImmutableCache.size).toBe(10);
		expect(plugin.scheduleMapCachePersist).toHaveBeenCalled();
	}, 10000);

	it("stops at the ends of the list", async () => {
		const plugin = fakePlugin();
		script(okCollection(ids.map((id) => card(id))));
		await prefetchCardTextNeighbors.call(plugin, ids, 0);
		expect(askedIds().sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
	}, 10000);

	it("costs nothing for cards already known or already being fetched (no request at all)", async () => {
		const plugin = fakePlugin();
		ids.forEach((id) => plugin.scryfallImmutableCache.set(id, { set: "lea" }));
		script(okCollection([]));
		await prefetchCardTextNeighbors.call(plugin, ids, 10);
		expect(net.calls).toBe(0);
		// walking one card forward later only needs the newcomer at the far end
		plugin.scryfallImmutableCache.delete("c16");
		script(okCollection([card("c16")]));
		await prefetchCardTextNeighbors.call(plugin, ids, 11);
		expect(net.calls).toBe(1);
		expect(askedIds()).toEqual(["c16"]);
	}, 10000);

	it("keeps the legalities that come in the same answer (what the Legal formats box would fetch itself)", async () => {
		const plugin = fakePlugin();
		script(okCollection([card("c1", { legalities: { modern: "banned" } }), card("c2")]));
		await prefetchScryfallImmutableSnapshots.call(plugin, ["c1", "c2"]);
		expect(plugin.legalitiesCache.get("c1")).toEqual({ modern: "banned" });
		expect(plugin.legalitiesFetchedAt.has("c1")).toBe(true);
		expect(plugin.scheduleLegalitiesPersist).toHaveBeenCalled();
		expect(net.calls).toBe(1);
	}, 10000);

	it("a card reached while its prefetch is under way waits for it instead of sending a second request", async () => {
		const plugin = fakePlugin();
		script(okCollection([card("c1"), card("c2")]));
		const prefetch = prefetchScryfallImmutableSnapshots.call(plugin, ["c1", "c2"]);
		const reached = getScryfallImmutableSnapshot.call(plugin, "c1");
		await expect(reached).resolves.toMatchObject({ oracle_text: "text" });
		await prefetch;
		expect(net.calls).toBe(1);
		expect(plugin.scryfallImmutableInFlight.size).toBe(0);
	}, 10000);

	it("after a prefetch that brings back nothing, no new one is sent for 30 s (a service that is not answering is left alone)", async () => {
		const plugin = fakePlugin();
		script(down);
		await prefetchScryfallImmutableSnapshots.call(plugin, ["c1", "c2"]);
		expect(net.calls).toBe(1);
		await prefetchScryfallImmutableSnapshots.call(plugin, ["c3", "c4"]);
		expect(net.calls).toBe(1); // paused
		const later = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 31_000);
		script(okCollection([card("c3")]));
		await prefetchScryfallImmutableSnapshots.call(plugin, ["c3", "c4"]);
		expect(net.calls).toBe(2); // asked again once the pause is over
		expect(plugin.scryfallPrefetchPausedUntil).toBeLessThan(performance.now() + 1); // and that one did bring something back: no new pause
		later.mockRestore();
		resetScryfallStrictGateForTests(); // the clock above ran 31 s ahead: its reservation must not outlive it
	}, 10000);

	it("a failed prefetch frees its cards and is not taken for an answer: the card is asked again the normal way", async () => {
		const plugin = fakePlugin();
		script(down, okCollection([card("c1")]));
		const prefetch = prefetchScryfallImmutableSnapshots.call(plugin, ["c1", "c2"]);
		const reached = getScryfallImmutableSnapshot.call(plugin, "c1");
		await expect(reached).resolves.toMatchObject({ oracle_text: "text" });
		await prefetch;
		await settle();
		expect(plugin.scryfallImmutableInFlight.size).toBe(0);
		expect(plugin.scryfallImmutableCache.has("c1")).toBe(true);
		expect(plugin.scryfallImmutableCache.has("c2")).toBe(false); // nothing is cached for a card nobody got
	}, 10000);
});

describe("what is kept of a card's pictures and shop links (the cache file is read whole and rewritten whole)", () => {
	const fat = {
		image_uris: { small: "s", normal: "n", large: "l", png: "p", art_crop: "a", border_crop: "b" },
		purchase_uris: { tcgplayer: "t", cardmarket: "c", cardhoarder: "h" },
	};
	const slimUris = { image_uris: { small: "s", normal: "n", art_crop: "a" }, purchase_uris: { tcgplayer: "t" } };
	// toEqual on the two objects: toMatchObject accepts extra keys, which is exactly what a snapshot left fat has.
	const expectSlim = (entry: unknown) => {
		const e = entry as { image_uris?: unknown; purchase_uris?: unknown };
		expect(e.image_uris).toEqual(slimUris.image_uris);
		expect(e.purchase_uris).toEqual(slimUris.purchase_uris);
	};

	it("each of the three ways a snapshot is stored cuts it down (one card, a batch, a prefetch)", async () => {
		const plugin = fakePlugin();
		script(okCollection([card("one", fat), card("two", fat), card("three", fat)]));
		await fetchScryfallImmutableSnapshot.call(plugin, "one");
		script(okCollection([card("two", fat)]));
		await getScryfallImmutableSnapshots.call(plugin, ["two"]);
		script(okCollection([card("three", fat)]));
		await prefetchScryfallImmutableSnapshots.call(plugin, ["three"]);
		for (const id of ["one", "two", "three"]) expectSlim(plugin.scryfallImmutableCache.get(id));
	}, 10000);

	// A fake adapter holding the persisted file.
	function withFile(content: Record<string, unknown>) {
		const plugin = fakePlugin() as MTGCollectionPlugin & { immutableCacheFilePath: (f: string) => string | null; app: unknown };
		(plugin as unknown as Record<string, unknown>).immutableCacheFilePath = (f: string) => `dir/${f}`;
		(plugin as unknown as Record<string, unknown>).app = {
			vault: { adapter: { exists: async () => true, read: async () => JSON.stringify(content) } },
		};
		return plugin;
	}
	const isObj = (v: unknown) => v === null || (typeof v === "object" && !Array.isArray(v));
	const slim = (v: unknown) => (v === null ? v : slimImmutableSnapshot(v as never));

	it("a file written by an earlier version is cut down on load, and rewritten once so the old size does not stay on disk", async () => {
		const plugin = withFile({ a: { set: "lea", ...fat }, b: { set: "m10", ...fat } });
		await loadPersistedMapCache.call(plugin, "f.json", plugin.scryfallImmutableCache, isObj, slim);
		expectSlim(plugin.scryfallImmutableCache.get("a"));
		expectSlim(plugin.scryfallImmutableCache.get("b"));
		expect(plugin.scryfallImmutableCache.get("a")).toMatchObject({ set: "lea" }); // the rest of the entry is untouched
		expect(plugin.scheduleMapCachePersist).toHaveBeenCalledTimes(1);
		expect(plugin.scheduleMapCachePersist).toHaveBeenCalledWith("f.json", plugin.scryfallImmutableCache);
	});

	it("a file that is already slim is not rewritten (no write at every start)", async () => {
		const plugin = withFile({ a: { set: "lea", ...slimUris } });
		await loadPersistedMapCache.call(plugin, "f.json", plugin.scryfallImmutableCache, isObj, slim);
		expect(plugin.scryfallImmutableCache.size).toBe(1);
		expect(plugin.scheduleMapCachePersist).not.toHaveBeenCalled();
	});

	it("without a normalizer the loader behaves as before: same entries, no rewrite", async () => {
		const plugin = withFile({ a: { set: "lea", ...fat }, bad: "not an object" });
		await loadPersistedMapCache.call(plugin, "f.json", plugin.scryfallImmutableCache, isObj);
		expect(plugin.scryfallImmutableCache.get("a")).toMatchObject(fat);
		expect(plugin.scryfallImmutableCache.has("bad")).toBe(false);
		expect(plugin.scheduleMapCachePersist).not.toHaveBeenCalled();
	});
});
