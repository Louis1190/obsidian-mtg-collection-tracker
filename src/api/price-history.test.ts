import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Scripted fake network, as in safe-request.test.ts: each request takes the next step (the last one repeats).
const net = vi.hoisted(() => ({ steps: [] as (() => unknown)[], calls: [] as { url: string; headers?: Record<string, string> }[] }));
vi.mock("obsidian", () => ({
	arrayBufferToBase64: () => "",
	requestUrl: async (params: { url: string; headers?: Record<string, string> }) => {
		net.calls.push(params);
		const step = net.steps.length > 1 ? net.steps.shift()! : net.steps[0];
		return step();
	},
}));

import { fetchOwnMovers, fetchPriceHistoryShard, fetchSiteManifest, moversFileUrl, parseSiteManifest, priceHistoryReadable, priceHistoryShardName, priceHistoryShardUrl, PRICE_HISTORY_BASE_URL } from "./price-history";

const script = (...steps: (() => unknown)[]) => { net.steps = steps; };
const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const shardJson = JSON.stringify({ _: { v: 1, asOf: "2026-10-13" }, abc12345: { "ck.n": [20737, 20739, [0, 100]] } });
const ok = (bytes: Uint8Array) => () => ({ status: 200, headers: {}, arrayBuffer: buffer(bytes) });
const status = (code: number) => () => ({ status: code, headers: {}, arrayBuffer: new ArrayBuffer(0) });
const down = () => { throw new Error("Request Failed. net::ERR_INTERNET_DISCONNECTED"); };

beforeEach(() => { net.steps = []; net.calls = []; });

describe("the service address", () => {
	it("is the repository's GitHub Pages site, https, without a trailing slash (an empty one switches the feature off)", () => {
		expect(PRICE_HISTORY_BASE_URL).toBe("https://louis1190.github.io/mtg-price-history");
		expect(PRICE_HISTORY_BASE_URL).toMatch(/^https:\/\/[^/]+(\/[^/]+)*$/);
	});
	it("names the file by the first 3 characters of the Scryfall id, whatever the case", () => {
		expect(priceHistoryShardName("B0FAA7F2-b547-42c4-a810-839da50dadfe")).toBe("b0f");
		expect(priceHistoryShardUrl("https://example.test/data/", "b0f")).toBe("https://example.test/data/s/b0f.json.gz");
		expect(priceHistoryShardUrl("https://example.test/data", "b0f")).toBe("https://example.test/data/s/b0f.json.gz");
	});
	it("needs gunzip to read anything", () => {
		expect(priceHistoryReadable()).toBe(true); // Node 24 has DecompressionStream, like Obsidian's Chromium
	});
});

describe("fetchPriceHistoryShard", () => {
	it("downloads and reads a gzipped shard, asking for the right file with the plugin's User-Agent", async () => {
		script(ok(gzipSync(shardJson)));
		const shard = await fetchPriceHistoryShard("https://example.test", "ABC12345-0000");
		expect(shard?.asOf).toBe("2026-10-13");
		expect(Object.keys(shard?.cards ?? {})).toEqual(["abc12345"]);
		expect(net.calls).toHaveLength(1);
		expect(net.calls[0].url).toBe("https://example.test/s/abc.json.gz");
		expect(net.calls[0].headers?.["User-Agent"]).toMatch(/^ObsidianMTGCollectionTracker\//);
	});

	it("also reads a shard a CDN has already decompressed", async () => {
		script(ok(new TextEncoder().encode(shardJson)));
		expect((await fetchPriceHistoryShard("https://example.test", "abc"))?.asOf).toBe("2026-10-13");
	});

	it("404 means the files do not know the card: null, not a failure", async () => {
		script(status(404));
		expect(await fetchPriceHistoryShard("https://example.test", "abc")).toBeNull();
	});

	it("any other failure is undefined and never throws: offline, 429, 500, garbage, a format we do not know", async () => {
		for (const step of [down, status(429), status(500), status(403), ok(new Uint8Array([1, 2, 3, 4])), ok(gzipSync("{not json")), ok(gzipSync(JSON.stringify({ _: { v: 9, asOf: "2026-10-13" } }))), ok(gzipSync(Buffer.from([0x1f, 0x8b, 0, 0])))]) {
			script(step);
			expect(await fetchPriceHistoryShard("https://example.test", "abc")).toBeUndefined();
		}
	});
});

describe("site.json: where the files are", () => {
	it("accepts \"right here\" in every spelling, and a plain https address (trailing slash dropped)", () => {
		expect(parseSiteManifest({ v: 1, shards: "" })).toEqual({ shards: "" });
		expect(parseSiteManifest({ v: 1 })).toEqual({ shards: "" });
		expect(parseSiteManifest({ v: 1, shards: null })).toEqual({ shards: "" });
		expect(parseSiteManifest({ v: 1, shards: "https://cdn.example.test/prices/" })).toEqual({ shards: "https://cdn.example.test/prices" });
		expect(parseSiteManifest({ v: 1, shards: "https://prices.example.pages.dev" })).toEqual({ shards: "https://prices.example.pages.dev" });
	});
	it("refuses anything that could send requests somewhere surprising", () => {
		for (const shards of [
			"http://cdn.example.test/h", // not https
			`https://user:pass${"@"}cdn.example.test/h`, // credentials (built so that the public copy's leak scan does not mistake it for an e-mail address)
			"https://cdn.example.test/h?x=1", // a query
			"https://cdn.example.test/h#frag",
			"https://localhost/h", // no dot in the host
			"https://192.168.0.10/h", // an IP address
			"https://[::1]/h",
			"ftp://cdn.example.test/h",
			"//cdn.example.test/h",
			"cdn.example.test/h",
			"https://" + "a".repeat(300) + ".test/h", // absurdly long
			12,
			{},
		]) expect(parseSiteManifest({ v: 1, shards }), String(JSON.stringify(shards))).toBeNull();
	});
	it("refuses another version, or something that is not an object", () => {
		for (const bad of [null, undefined, "x", 3, [], { shards: "" }, { v: 2, shards: "" }, { v: "1", shards: "" }]) expect(parseSiteManifest(bad)).toBeNull();
	});
	it("is read from <address>/site.json: the manifest, null for 404, undefined for every failure", async () => {
		const json = (o: unknown) => () => ({ status: 200, headers: {}, arrayBuffer: buffer(new TextEncoder().encode(JSON.stringify(o))) });
		script(json({ v: 1, shards: "https://cdn.example.test/h" }));
		await expect(fetchSiteManifest("https://example.test/data/")).resolves.toEqual({ shards: "https://cdn.example.test/h" });
		expect(net.calls[0].url).toBe("https://example.test/data/site.json");
		expect(net.calls[0].headers?.["User-Agent"]).toMatch(/ObsidianMTGCollectionTracker/);
		script(status(404));
		await expect(fetchSiteManifest("https://example.test/data")).resolves.toBeNull();
		for (const failing of [status(500), status(429), down, json({ v: 9 }), () => ({ status: 200, headers: {}, arrayBuffer: buffer(new TextEncoder().encode("<html>")) }), () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(10_000) })]) {
			script(failing);
			await expect(fetchSiteManifest("https://example.test/data")).resolves.toBeUndefined();
		}
	});
});

describe("what a shard answer may be", () => {
	const gz = (text: string) => gzipSync(text);
	it("a bomb that decompresses to valid JSON far beyond any shard is a failure, not a memory problem", async () => {
		const big = JSON.stringify({ _: { v: 1, asOf: "2026-10-13" }, pad: "A".repeat(20 * 1024 * 1024) }); // 20 MB of JSON, ~20 KB gzipped
		const bomb = gz(big);
		expect(bomb.length).toBeLessThan(200 * 1024);
		script(ok(bomb));
		await expect(fetchPriceHistoryShard("https://example.test", "abc12345")).resolves.toBeUndefined();
	});
	it("a plain answer far bigger than a shard is refused even when it is perfectly valid JSON", async () => {
		const valid = JSON.stringify({ _: { v: 1, asOf: "2026-10-13" }, pad: "A".repeat(3 * 1024 * 1024) });
		script(() => ({ status: 200, headers: {}, arrayBuffer: buffer(new TextEncoder().encode(valid)) }));
		await expect(fetchPriceHistoryShard("https://example.test", "abc12345")).resolves.toBeUndefined();
		const small = JSON.stringify({ _: { v: 1, asOf: "2026-10-13" }, pad: "A".repeat(1024 * 1024) }); // the same shape, under the limit
		script(() => ({ status: 200, headers: {}, arrayBuffer: buffer(new TextEncoder().encode(small)) }));
		await expect(fetchPriceHistoryShard("https://example.test", "abc12345")).resolves.toBeDefined();
	});
	it("a normal shard, and one ten times bigger than today's, are still read", async () => {
		script(ok(gz(shardJson)));
		await expect(fetchPriceHistoryShard("https://example.test", "abc12345")).resolves.toMatchObject({ asOf: "2026-10-13" });
		const body: Record<string, unknown> = { _: { v: 1, asOf: "2026-10-13" } };
		for (let i = 0; i < 6000; i++) body[`abc${i.toString(16).padStart(5, "0")}`] = { "ck.n": [20737, 20739, [0, 100], [1, 120], [2, 140]], "tcg.n": [20737, 20739, [0, 100]] };
		const big = JSON.stringify(body);
		expect(big.length).toBeGreaterThan(500 * 1024);
		script(ok(gz(big)));
		await expect(fetchPriceHistoryShard("https://example.test", "abc12345")).resolves.toBeDefined();
	});
});

describe("the movers files", () => {
	const row = (over: Record<string, unknown> = {}) => ({ scryfall_id: "abc12345", name: "Aggravated Assault", vendor: "cardkingdom", finish: "foil", currency: "USD", price_from: 44.99, price_to: 119.99, change_pct: 166.7, ...over });
	const body = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({ data: { period: "7d", gainers: [row()], losers: [row({ scryfall_id: "def67890", name: "Chandra, Pyromaster", vendor: "tcgplayer", finish: "normal", price_from: 149.99, price_to: 37.99, change_pct: -74.67 })], ...data }, meta: { as_of: "2026-10-13" }, ...over });
	const text = (b: unknown) => ok(new TextEncoder().encode(JSON.stringify(b)));

	it("names the file after the period and the vendor, \"all\" when none is chosen", () => {
		expect(moversFileUrl("https://example.test/data/", "1d", undefined)).toBe("https://example.test/data/movers/1d-all.json");
		expect(moversFileUrl("https://example.test/data", "30d", "cardmarket")).toBe("https://example.test/data/movers/30d-cardmarket.json");
	});

	it("reads a list with the cardbase parser, says where it comes from and which day it is as of", async () => {
		script(text(body()));
		const r = await fetchOwnMovers("https://example.test", "7d", "tcgplayer");
		expect(net.calls[0].url).toBe("https://example.test/movers/7d-tcgplayer.json");
		expect(net.calls[0].headers?.["User-Agent"]).toMatch(/^ObsidianMTGCollectionTracker\//);
		expect(r?.source).toBe("price-history");
		expect(r?.asOf).toBe("2026-10-13");
		expect(r?.period).toBe("7d");
		expect(r?.gainers).toEqual([{ scryfallId: "abc12345", name: "Aggravated Assault", vendor: "cardkingdom", finish: "foil", currency: "USD", priceFrom: 44.99, priceTo: 119.99, changePct: 166.7 }]);
		expect(r?.losers.map((m) => m.name)).toEqual(["Chandra, Pyromaster"]);
	});

	it("an empty list is an answer (nothing moved enough), not a failure", async () => {
		script(text(body({}, { gainers: [], losers: [] })));
		const r = await fetchOwnMovers("https://example.test", "7d", undefined);
		expect(r).toMatchObject({ gainers: [], losers: [], source: "price-history" });
	});

	it("drops a row it cannot use (an unknown vendor or finish, a missing price) and keeps the others", async () => {
		script(text(body({}, { gainers: [row({ vendor: "manapool" }), row({ finish: "gold" }), row({ price_to: undefined }), row({ name: "" }), row({ scryfall_id: "ok000001", name: "Kept" })] })));
		const r = await fetchOwnMovers("https://example.test", "7d", undefined);
		expect(r?.gainers.map((m) => m.name)).toEqual(["Kept"]);
	});

	it("answers undefined, so that cardbase is asked, on a wrong period, no lists, junk, an error status or no network", async () => {
		// An error status that still carries a perfectly good list must not be read: the status decides, not the body.
		const withStatus = (code: number) => () => ({ status: code, headers: {}, arrayBuffer: buffer(new TextEncoder().encode(JSON.stringify(body()))) });
		for (const step of [text(body({}, { period: "1d" })), text({ data: { period: "7d" } }), text({ data: { period: "7d", gainers: "x", losers: [] } }), text({ data: null }), text(null), ok(new TextEncoder().encode("<html>no</html>")), status(404), status(500), withStatus(404), withStatus(500), down]) {
			script(step);
			expect(await fetchOwnMovers("https://example.test", "7d", undefined)).toBeUndefined();
		}
	});

	it("refuses an answer that is far bigger than a list file, and caps the rows", async () => {
		// A perfectly good list followed by 300 KB of blanks: it parses, so only the size says no.
		const padded = new TextEncoder().encode(JSON.stringify(body()) + " ".repeat(300 * 1024));
		script(ok(padded));
		expect(await fetchOwnMovers("https://example.test", "7d", undefined)).toBeUndefined();
		const many = Array.from({ length: 150 }, (_, i) => row({ scryfall_id: `id${i}`, name: `Card ${i}` }));
		script(text(body({}, { gainers: many })));
		expect((await fetchOwnMovers("https://example.test", "7d", undefined))?.gainers).toHaveLength(100);
	});

	it("ignores an as_of that is not a date", async () => {
		script(text(body({ meta: { as_of: "yesterday" } })));
		expect((await fetchOwnMovers("https://example.test", "7d", undefined))?.asOf).toBeUndefined();
		script(text(body({ meta: {} })));
		expect((await fetchOwnMovers("https://example.test", "7d", undefined))?.asOf).toBeUndefined();
	});
});
