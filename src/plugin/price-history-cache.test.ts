import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ steps: [] as (() => unknown)[], urls: [] as string[] }));
vi.mock("obsidian", () => ({
	arrayBufferToBase64: () => "",
	requestUrl: async (params: { url: string }) => {
		net.urls.push(params.url);
		const step = net.steps.length > 1 ? net.steps.shift()! : net.steps[0];
		return step();
	},
}));

import { CARDBASE_SOURCE, type CardbaseFinish, type CardbasePriceHistory } from "../api/cardbase";
import { getCardbaseCardmarketId, getCardbasePriceHistory, getCardbasePriceHistoryWithNativeCardmarket, getCardmarketNativePrices, prefetchCardbaseNeighbors } from "./cardbase-cache";
import { getOwnPriceHistory, getPriceHistoryBase, getPriceHistoryShard, ownPriceHistoryEnabled } from "./price-history-cache";
import type MTGCollectionPlugin from "../plugin";

const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const shardOf = (...ids: string[]) => {
	const body: Record<string, unknown> = { _: { v: 1, asOf: "2026-10-13" } };
	for (const id of ids) body[id] = { "tcg.n": [20737, 20739, [0, 200], [2, 250]] };
	return () => ({ status: 200, headers: {}, arrayBuffer: buffer(gzipSync(JSON.stringify(body))) });
};
const status = (code: number) => () => ({ status: code, headers: {}, arrayBuffer: new ArrayBuffer(0) });
const script = (...steps: (() => unknown)[]) => { net.steps = steps; };

// The real functions, called with a plain object standing in for the plugin (the `this` parameter technique).
// By default the files' address is already settled (the first block of tests is about the shards, not about where they are);
// the block about site.json passes `priceHistoryPointer: null` to start from "not asked yet".
const device: Record<string, unknown> = {}; // the device's local storage
function fakePlugin(baseUrl = "https://hist.test", extra: Record<string, unknown> = {}) {
	return {
		priceHistoryBaseUrl: baseUrl,
		priceHistoryShardCache: new Map(),
		priceHistoryShardInFlight: new Map(),
		priceHistoryShardFailedUntil: new Map(),
		priceHistoryPointer: { base: baseUrl, until: Number.POSITIVE_INFINITY },
		priceHistoryPointerInFlight: null,
		app: { loadLocalStorage: (k: string) => device[k] ?? null, saveLocalStorage: (k: string, v: unknown) => { device[k] = v; } },
		ownPriceHistoryEnabled,
		getPriceHistoryBase,
		getPriceHistoryShard,
		getOwnPriceHistory,
		...extra,
	} as unknown as MTGCollectionPlugin;
}
const json = (body: unknown) => () => ({ status: 200, headers: {}, arrayBuffer: buffer(new TextEncoder().encode(JSON.stringify(body))) });
const manifestUrls = () => net.urls.filter((u) => u.endsWith("/site.json"));

beforeEach(() => { net.steps = []; net.urls = []; for (const k of Object.keys(device)) delete device[k]; vi.useFakeTimers({ now: new Date("2026-10-14T10:00:00Z") }); });
afterEach(() => { vi.useRealTimers(); });

describe("our own price history source", () => {
	it("is off with no service address: no request, no history, whatever is asked", async () => {
		const plugin = fakePlugin("");
		expect(ownPriceHistoryEnabled.call(plugin)).toBe(false);
		script(shardOf("abc00000"));
		await expect(getOwnPriceHistory.call(plugin, "abc00000", "normal")).resolves.toBeUndefined();
		expect(net.urls).toEqual([]);
	});

	it("downloads a card's shard once: the next cards of that file, and three asks at the same time, share it", async () => {
		const plugin = fakePlugin();
		script(shardOf("abc00001", "abc00002"));
		const [a, b, c] = await Promise.all([
			getOwnPriceHistory.call(plugin, "abc00001", "normal"),
			getOwnPriceHistory.call(plugin, "abc00001", "normal"),
			getOwnPriceHistory.call(plugin, "abc00001", "normal"),
		]);
		expect([a?.scryfallId, b?.scryfallId, c?.scryfallId]).toEqual(["abc00001", "abc00001", "abc00001"]);
		expect(a?.series[0].points.at(-1)).toEqual({ date: "2026-10-13", price: 2.5 });
		await getOwnPriceHistory.call(plugin, "abc00002", "normal");
		expect(net.urls).toEqual(["https://hist.test/s/abc.json.gz"]);
	});

	it("a card the files do not know is a confirmed answer, remembered: not asked again", async () => {
		const plugin = fakePlugin();
		script(status(404));
		await expect(getOwnPriceHistory.call(plugin, "abc00001", "normal")).resolves.toBeUndefined();
		await expect(getOwnPriceHistory.call(plugin, "abc00009", "normal")).resolves.toBeUndefined();
		expect(net.urls).toHaveLength(1);
	});

	it("after a failure it tries once more, then leaves the file alone for 30 seconds, then tries again", async () => {
		const plugin = fakePlugin();
		script(status(500));
		const first = getOwnPriceHistory.call(plugin, "abc00001", "normal");
		await vi.advanceTimersByTimeAsync(400); // the 300 ms pause of the retry
		await expect(first).resolves.toBeUndefined();
		expect(net.urls).toHaveLength(2);
		// The card detail asks three times per card: none of them reaches the network now.
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		await getOwnPriceHistory.call(plugin, "abc00001", "foil");
		expect(net.urls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(31_000);
		script(shardOf("abc00001"));
		await expect(getOwnPriceHistory.call(plugin, "abc00001", "normal")).resolves.toMatchObject({ scryfallId: "abc00001" });
		expect(net.urls).toHaveLength(3);
	});

	it("reads a file again once it is 6 hours old: a session left open must not keep the prices of its first day", async () => {
		const plugin = fakePlugin();
		script(shardOf("abc00001"));
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		await vi.advanceTimersByTimeAsync(5 * 3600 * 1000);
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		expect(net.urls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2 * 3600 * 1000);
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		expect(net.urls).toHaveLength(2);
	});

	it("an out-of-date file is still served when reading it again fails, and the next try is paused", async () => {
		const plugin = fakePlugin();
		script(shardOf("abc00001"));
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		await vi.advanceTimersByTimeAsync(7 * 3600 * 1000);
		script(status(500));
		const again = getOwnPriceHistory.call(plugin, "abc00001", "normal");
		await vi.advanceTimersByTimeAsync(400);
		await expect(again).resolves.toMatchObject({ scryfallId: "abc00001" }); // not undefined: cardbase's frozen figures would be worse
		const asked = net.urls.length;
		await expect(getOwnPriceHistory.call(plugin, "abc00001", "normal")).resolves.toMatchObject({ scryfallId: "abc00001" });
		expect(net.urls).toHaveLength(asked); // paused for 30 s: no new request
		await vi.advanceTimersByTimeAsync(31_000);
		script(shardOf("abc00001"));
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		expect(net.urls).toHaveLength(asked + 1);
	});

	it("a card the files did not know (a confirmed 404) is asked again after 6 hours too: it may have been added", async () => {
		const plugin = fakePlugin();
		script(status(404));
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		await vi.advanceTimersByTimeAsync(7 * 3600 * 1000);
		script(shardOf("abc00001"));
		await expect(getOwnPriceHistory.call(plugin, "abc00001", "normal")).resolves.toMatchObject({ scryfallId: "abc00001" });
	});

	it("keeps at most 64 files for the session, dropping the one used least recently", async () => {
		const plugin = fakePlugin();
		script(shardOf());
		for (let i = 0; i < 70; i++) await getPriceHistoryShard.call(plugin, `${i.toString(16).padStart(3, "0")}00000`);
		expect(plugin.priceHistoryShardCache.size).toBe(64);
		expect(plugin.priceHistoryShardCache.has("000")).toBe(false);
		expect(plugin.priceHistoryShardCache.has("045")).toBe(true);
	});
});

describe("where the files are: site.json next to them", () => {
	const fresh = (extra: Record<string, unknown> = {}) => fakePlugin("https://hist.test", { priceHistoryPointer: null, ...extra });

	it("is asked first, once, and the files come from the address it names", async () => {
		const plugin = fresh();
		script(json({ v: 1, shards: "https://cdn.example.test/h/" }), shardOf("abc00001"));
		await getOwnPriceHistory.call(plugin, "abc00001", "normal");
		expect(net.urls).toEqual(["https://hist.test/site.json", "https://cdn.example.test/h/s/abc.json.gz"]);
		await getOwnPriceHistory.call(plugin, "def00001", "normal");
		expect(manifestUrls()).toHaveLength(1);
	});

	it("three cards asked at the same time cause ONE request for it", async () => {
		const plugin = fresh();
		script(json({ v: 1, shards: "" }), shardOf("abc00001", "def00001", "012000001"));
		await Promise.all(["abc00001", "def00001", "012000001"].map((id) => getOwnPriceHistory.call(plugin, id, "normal")));
		expect(manifestUrls()).toHaveLength(1);
	});

	it("\"right here\" (empty) and no file at all (404) both mean the entry point", async () => {
		for (const first of [json({ v: 1, shards: "" }), status(404)]) {
			net.urls = [];
			const plugin = fresh();
			script(first, shardOf("abc00001"));
			await getOwnPriceHistory.call(plugin, "abc00001", "normal");
			expect(net.urls).toEqual(["https://hist.test/site.json", "https://hist.test/s/abc.json.gz"]);
		}
	});

	it("is asked again after 6 hours, not before", async () => {
		const plugin = fresh();
		script(json({ v: 1, shards: "" }), shardOf("abc00001"));
		await getPriceHistoryBase.call(plugin);
		await vi.advanceTimersByTimeAsync(5 * 3600 * 1000);
		await getPriceHistoryBase.call(plugin);
		expect(manifestUrls()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2 * 3600 * 1000);
		await getPriceHistoryBase.call(plugin);
		expect(manifestUrls()).toHaveLength(2);
	});

	it("when it cannot be read, the entry point is used and it is asked again after 5 minutes", async () => {
		const plugin = fresh();
		script(status(500));
		await expect(getPriceHistoryBase.call(plugin)).resolves.toBe("https://hist.test");
		await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
		await getPriceHistoryBase.call(plugin);
		expect(manifestUrls()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		await getPriceHistoryBase.call(plugin);
		expect(manifestUrls()).toHaveLength(2);
	});

	it("a manifest that is not acceptable is ignored: plain http, another version, junk", async () => {
		for (const bad of [{ v: 1, shards: "http://cdn.example.test/h" }, { v: 2, shards: "https://cdn.example.test/h" }, "text", { v: 1, shards: 12 }]) {
			const plugin = fresh();
			script(json(bad));
			await expect(getPriceHistoryBase.call(plugin)).resolves.toBe("https://hist.test");
		}
	});

	it("after a move it keeps the new address when the host is down at the next start (the last good one is kept on the device)", async () => {
		const first = fresh();
		script(json({ v: 1, shards: "https://cdn.example.test/h" }));
		await expect(getPriceHistoryBase.call(first)).resolves.toBe("https://cdn.example.test/h");
		// A new session of the plugin on the same device: the entry point answers with an error.
		const next = fresh();
		script(status(503));
		await expect(getPriceHistoryBase.call(next)).resolves.toBe("https://cdn.example.test/h");
	});

	it("and forgets it when site.json says \"right here\" again", async () => {
		const first = fresh();
		script(json({ v: 1, shards: "https://cdn.example.test/h" }));
		await getPriceHistoryBase.call(first);
		const back = fresh();
		script(json({ v: 1, shards: "" }));
		await expect(getPriceHistoryBase.call(back)).resolves.toBe("https://hist.test");
		const next = fresh();
		script(status(503));
		await expect(getPriceHistoryBase.call(next)).resolves.toBe("https://hist.test");
	});

	it("a damaged value left on the device is not trusted", async () => {
		device["mtg-price-history-shards-base"] = "http://evil.example.test/h";
		const plugin = fresh();
		script(status(503));
		await expect(getPriceHistoryBase.call(plugin)).resolves.toBe("https://hist.test");
	});

	it("a running session that already knew the address keeps it when a later ask fails", async () => {
		const plugin = fresh();
		script(json({ v: 1, shards: "https://cdn.example.test/h" }));
		await getPriceHistoryBase.call(plugin);
		await vi.advanceTimersByTimeAsync(7 * 3600 * 1000);
		script(status(500));
		await expect(getPriceHistoryBase.call(plugin)).resolves.toBe("https://cdn.example.test/h");
	});

	it("is not asked at all when the feature is off", async () => {
		const plugin = fakePlugin("");
		script(json({ v: 1, shards: "https://cdn.example.test/h" }));
		await expect(getOwnPriceHistory.call(plugin, "abc00001", "normal")).resolves.toBeUndefined();
		expect(net.urls).toEqual([]);
	});
});

describe("the card detail's entry point, with and without our files (the cardbase.dev source switched ON, for what it still does when it is)", () => {
	beforeEach(() => { CARDBASE_SOURCE.enabled = true; });
	afterEach(() => { CARDBASE_SOURCE.enabled = false; });
	const cardbaseHistory = { scryfallId: "abc00001", series: [], asOf: "2026-09-09" } as CardbasePriceHistory;
	const own = { scryfallId: "abc00001", series: [], asOf: "2026-10-13", source: "price-history" } as CardbasePriceHistory;
	function entryPlugin(enabled: boolean, ownResult: CardbasePriceHistory | undefined) {
		const calls = { own: 0, cardbase: 0, cardmarketId: 0 };
		const plugin = {
			ownPriceHistoryEnabled: () => enabled,
			getOwnPriceHistory: async () => { calls.own++; return ownResult; },
			getCardbasePriceHistory: async () => { calls.cardbase++; return cardbaseHistory; },
			getCardbaseCardmarketId: async () => { calls.cardmarketId++; return null; },
			cardbasePrefetchWindow: () => 2,
			cardbasePriceHistoryCache: new Map(),
		} as unknown as MTGCollectionPlugin;
		return { plugin, calls };
	}

	it("on and answering: our history, cardbase never asked", async () => {
		const { plugin, calls } = entryPlugin(true, own);
		await expect(getCardbasePriceHistoryWithNativeCardmarket.call(plugin, "abc00001", "normal")).resolves.toBe(own);
		expect(calls).toEqual({ own: 1, cardbase: 0, cardmarketId: 0 });
	});

	it("on but with nothing for this card: cardbase answers, exactly as before", async () => {
		const { plugin, calls } = entryPlugin(true, undefined);
		await expect(getCardbasePriceHistoryWithNativeCardmarket.call(plugin, "abc00001", "normal")).resolves.toBe(cardbaseHistory);
		expect(calls).toEqual({ own: 1, cardbase: 1, cardmarketId: 1 });
	});

	it("off: our source is never asked, the old path is the only one", async () => {
		const { plugin, calls } = entryPlugin(false, own);
		await expect(getCardbasePriceHistoryWithNativeCardmarket.call(plugin, "abc00001", "normal")).resolves.toBe(cardbaseHistory);
		expect(calls).toEqual({ own: 0, cardbase: 1, cardmarketId: 1 });
	});

	it("neighbours: on, only the window around the card is preloaded, from our files; off, from cardbase as before", async () => {
		const items = Array.from({ length: 20 }, (_, i) => ({ scryfallId: `id${i}`, finish: "normal" as CardbaseFinish }));
		const asked: string[] = [];
		const on = { ownPriceHistoryEnabled: () => true, getOwnPriceHistory: async (id: string) => { asked.push(`own:${id}`); }, getCardbasePriceHistory: async (id: string) => { asked.push(`cardbase:${id}`); }, cardbasePrefetchWindow: () => 2, cardbasePriceHistoryCache: new Map() } as unknown as MTGCollectionPlugin;
		await prefetchCardbaseNeighbors.call(on, items, 10);
		expect(asked.sort()).toEqual(["own:id11", "own:id12", "own:id8", "own:id9"]);
		asked.length = 0;
		const off = { ownPriceHistoryEnabled: () => false, getOwnPriceHistory: async (id: string) => { asked.push(`own:${id}`); }, getCardbasePriceHistory: async (id: string) => { asked.push(`cardbase:${id}`); }, cardbasePrefetchWindow: () => 2, cardbasePriceHistoryCache: new Map() } as unknown as MTGCollectionPlugin;
		const run = prefetchCardbaseNeighbors.call(off, items, 10);
		await vi.advanceTimersByTimeAsync(2000);
		await run;
		expect(asked.sort()).toEqual(["cardbase:id11", "cardbase:id12", "cardbase:id8", "cardbase:id9"]);
	});
});

describe("the same entry points with the cardbase.dev source switched OFF (as shipped)", () => {
	const own = { scryfallId: "abc00001", series: [], asOf: "2026-10-13", source: "price-history" } as CardbasePriceHistory;
	beforeEach(() => { CARDBASE_SOURCE.enabled = false; });
	function entryPlugin(enabled: boolean, ownResult: CardbasePriceHistory | undefined) {
		const calls = { own: 0, cardbase: 0, cardmarketId: 0, native: 0 };
		const plugin = {
			ownPriceHistoryEnabled: () => enabled,
			getOwnPriceHistory: async () => { calls.own++; return ownResult; },
			getCardbasePriceHistory: async () => { calls.cardbase++; return undefined; },
			getCardbaseCardmarketId: async () => { calls.cardmarketId++; return null; },
			getCardmarketNativePrices: async () => { calls.native++; return undefined; },
			cardbasePrefetchWindow: () => 2,
			cardbasePriceHistoryCache: new Map(),
		} as unknown as MTGCollectionPlugin;
		return { plugin, calls };
	}

	it("is off as shipped", () => {
		expect(CARDBASE_SOURCE.enabled).toBe(false);
	});

	it("our history answers, as ever", async () => {
		const { plugin, calls } = entryPlugin(true, own);
		await expect(getCardbasePriceHistoryWithNativeCardmarket.call(plugin, "abc00001", "normal")).resolves.toBe(own);
		expect(calls).toEqual({ own: 1, cardbase: 0, cardmarketId: 0, native: 0 });
	});

	it("a card our files know nothing about has no history, and nothing else is asked", async () => {
		const { plugin, calls } = entryPlugin(true, undefined);
		await expect(getCardbasePriceHistoryWithNativeCardmarket.call(plugin, "abc00001", "normal")).resolves.toBeUndefined();
		expect(calls).toEqual({ own: 1, cardbase: 0, cardmarketId: 0, native: 0 });
	});

	it("with our source off too (a device that cannot gunzip): no history, and still nothing asked", async () => {
		const { plugin, calls } = entryPlugin(false, own);
		await expect(getCardbasePriceHistoryWithNativeCardmarket.call(plugin, "abc00001", "normal")).resolves.toBeUndefined();
		expect(calls).toEqual({ own: 0, cardbase: 0, cardmarketId: 0, native: 0 });
	});

	it("neighbours: our files are still preloaded; with our source off there is nothing to preload", async () => {
		const items = Array.from({ length: 20 }, (_, i) => ({ scryfallId: `id${i}`, finish: "normal" as CardbaseFinish }));
		const asked: string[] = [];
		const make = (enabled: boolean) => ({ ownPriceHistoryEnabled: () => enabled, getOwnPriceHistory: async (id: string) => { asked.push(`own:${id}`); }, getCardbasePriceHistory: async (id: string) => { asked.push(`cardbase:${id}`); }, cardbasePrefetchWindow: () => 2, cardbasePriceHistoryCache: new Map() }) as unknown as MTGCollectionPlugin;
		await prefetchCardbaseNeighbors.call(make(true), items, 10);
		expect(asked.sort()).toEqual(["own:id11", "own:id12", "own:id8", "own:id9"]);
		asked.length = 0;
		await prefetchCardbaseNeighbors.call(make(false), items, 10);
		expect(asked).toEqual([]);
	});

	it("the three cardbase getters answer their \"nothing\" at once, without touching their caches or retrying", async () => {
		const plugin = {
			cardbasePriceHistoryCache: new Map(),
			cardbasePriceHistoryInFlight: new Map(),
			fetchCardbasePriceHistoryWithRetry: async () => { throw new Error("must not be called"); },
			cardmarketIdCache: new Map(),
			cardmarketIdInFlight: new Map(),
			fetchCardmarketIdWithRetry: async () => { throw new Error("must not be called"); },
			cardmarketNativePricesCache: new Map(),
			cardmarketNativePricesInFlight: new Map(),
			fetchCardmarketNativePricesWithRetry: async () => { throw new Error("must not be called"); },
		} as unknown as MTGCollectionPlugin;
		await expect(getCardbasePriceHistory.call(plugin, "abc00001", "normal")).resolves.toBeUndefined();
		await expect(getCardbaseCardmarketId.call(plugin, "abc00001")).resolves.toBeNull();
		await expect(getCardmarketNativePrices.call(plugin, 123)).resolves.toBeUndefined();
	});
});
