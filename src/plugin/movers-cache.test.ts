import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake network that answers by address: our files, or cardbase's /movers. Each address has a script of steps (the last one repeats).
const net = vi.hoisted(() => ({ routes: new Map<string, (() => unknown)[]>(), urls: [] as string[] }));
vi.mock("obsidian", () => ({
	arrayBufferToBase64: () => "",
	requestUrl: async (params: { url: string }) => {
		net.urls.push(params.url);
		const key = [...net.routes.keys()].find((k) => params.url.includes(k));
		const steps = key ? net.routes.get(key)! : [() => ({ status: 404 })];
		const step = steps.length > 1 ? steps.shift()! : steps[0];
		return step();
	},
}));

import { CARDBASE_SOURCE, type CardbaseMoversResult } from "../api/cardbase";
import { getCardbaseMovers } from "./cardbase-cache";
import type MTGCollectionPlugin from "../plugin";

const OWN = "https://hist.test/movers/";
const CARDBASE = "api.cardbase.dev/v1/movers";
const row = (name: string, over: Record<string, unknown> = {}) => ({ scryfall_id: `id-${name}`, name, vendor: "tcgplayer", finish: "foil", currency: "USD", price_from: 10, price_to: 20, change_pct: 100, ...over });
const body = (period: string, names: string[], asOf = "2026-10-13") => ({ data: { period, gainers: names.map((n) => row(n)), losers: [] }, meta: { as_of: asOf } });
const reply = (b: unknown) => () => {
	const bytes = new TextEncoder().encode(JSON.stringify(b));
	return { status: 200, headers: {}, json: b, arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
const fail = (code = 500) => () => ({ status: code, headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) });
const route = (key: string, ...steps: (() => unknown)[]) => net.routes.set(key, steps);
const asked = (part: string) => net.urls.filter((u) => u.includes(part)).length;

// `ownEnabled` = a service address is set; `canGunzip` = the device can read the shard files (a movers list is plain JSON and does not need it).
function fakePlugin(ownEnabled = true, canGunzip = true) {
	return {
		settings: { cardbaseApiKey: "" },
		cardbaseMoversCache: new Map(),
		ownMoversFailedUntil: new Map(),
		priceHistoryBaseUrl: ownEnabled ? "https://hist.test" : "",
		ownPriceHistoryEnabled: () => ownEnabled && canGunzip,
		getPriceHistoryBase: async () => "https://hist.test",
	} as unknown as MTGCollectionPlugin;
}
// The retry waits 300 ms between attempts: run the fake clock while the call is under way.
async function get(plugin: MTGCollectionPlugin, period: "1d" | "7d" | "30d" = "1d", vendor?: "tcgplayer"): Promise<CardbaseMoversResult | undefined> {
	const pending = getCardbaseMovers.call(plugin, period, vendor);
	await vi.advanceTimersByTimeAsync(1000);
	return pending;
}

beforeEach(() => {
	net.routes = new Map();
	net.urls = [];
	vi.useFakeTimers({ now: new Date("2026-10-15T10:00:00Z") });
	CARDBASE_SOURCE.enabled = true; // the fallback is what the first block tests; the second block switches it off, as shipped
});
afterEach(() => {
	vi.useRealTimers();
	CARDBASE_SOURCE.enabled = false;
});

describe("Home's market movers: our own files first, cardbase when they cannot be read", () => {
	it("reads our own file and never asks cardbase", async () => {
		route("hist.test/movers/1d-all.json", reply(body("1d", ["Mover"])));
		const r = await get(fakePlugin());
		expect(r?.source).toBe("price-history");
		expect(r?.gainers.map((m) => m.name)).toEqual(["Mover"]);
		expect(net.urls).toEqual([`${OWN}1d-all.json`]);
	});

	it("asks for the file of the chosen vendor", async () => {
		route("hist.test/movers/7d-tcgplayer.json", reply(body("7d", ["V"])));
		await get(fakePlugin(), "7d", "tcgplayer");
		expect(net.urls).toEqual([`${OWN}7d-tcgplayer.json`]);
	});

	it("takes an empty list for an answer: nothing moved enough is not a reason to ask cardbase", async () => {
		route("hist.test/movers/1d-all.json", reply({ data: { period: "1d", gainers: [], losers: [] }, meta: { as_of: "2026-10-13" } }));
		const r = await get(fakePlugin());
		expect(r).toMatchObject({ gainers: [], losers: [], source: "price-history" });
		expect(asked(CARDBASE)).toBe(0);
	});

	it("tries our file twice, then asks cardbase, which still answers in the old shape (no source)", async () => {
		route("hist.test/movers/1d-all.json", fail(), fail());
		route(CARDBASE, reply({ data: { gainers: [row("Old")], losers: [] }, meta: { as_of: "2026-09-09" } }));
		const r = await get(fakePlugin());
		expect(asked("hist.test")).toBe(2);
		expect(asked(CARDBASE)).toBe(1);
		expect(r?.source).toBeUndefined();
		expect(r?.asOf).toBe("2026-09-09");
	});

	it("is a cardbase-only block when our source is off (no request to our host at all)", async () => {
		route(CARDBASE, reply({ data: { gainers: [row("Old")], losers: [] }, meta: { as_of: "2026-09-09" } }));
		const r = await get(fakePlugin(false));
		expect(asked("hist.test")).toBe(0);
		expect(r?.gainers.map((m) => m.name)).toEqual(["Old"]);
	});

	it("keeps asking cardbase's raw top 100, as before", async () => {
		route("hist.test", fail());
		route(CARDBASE, reply({ data: { gainers: [], losers: [] }, meta: {} }));
		await get(fakePlugin());
		expect(net.urls.find((u) => u.includes(CARDBASE))).toContain("limit=100");
	});

	it("does not ask a host that just failed again for 30 seconds, while cardbase is asked", async () => {
		const plugin = fakePlugin();
		route("hist.test/movers/1d-all.json", fail());
		route(CARDBASE, fail());
		expect(await get(plugin)).toBeUndefined();
		const before = asked("hist.test");
		net.urls = [];
		expect(await get(plugin)).toBeUndefined();
		expect(before).toBe(2);
		expect(asked("hist.test")).toBe(0); // paused
		expect(asked(CARDBASE)).toBe(2); // cardbase is still tried
		await vi.advanceTimersByTimeAsync(31_000);
		net.urls = [];
		await get(plugin);
		expect(asked("hist.test")).toBe(2); // the pause is over
	});

	it("serves a list for 3 hours, then reads it again", async () => {
		const plugin = fakePlugin();
		route("hist.test/movers/1d-all.json", reply(body("1d", ["First"])), reply(body("1d", ["Second"])));
		expect((await get(plugin))?.gainers[0].name).toBe("First");
		await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 59 * 60 * 1000);
		expect((await get(plugin))?.gainers[0].name).toBe("First");
		expect(asked("hist.test")).toBe(1);
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		expect((await get(plugin))?.gainers[0].name).toBe("Second");
		expect(asked("hist.test")).toBe(2);
	});

	it("keeps each period and vendor apart", async () => {
		const plugin = fakePlugin();
		route("movers/1d-all.json", reply(body("1d", ["Day"])));
		route("movers/7d-all.json", reply(body("7d", ["Week"])));
		expect((await get(plugin, "1d"))?.gainers[0].name).toBe("Day");
		expect((await get(plugin, "7d"))?.gainers[0].name).toBe("Week");
		expect((await get(plugin, "1d"))?.gainers[0].name).toBe("Day");
		expect(asked("hist.test")).toBe(2);
	});

	it("keeps a vendor's list apart from the combined one of the same period", async () => {
		const plugin = fakePlugin();
		route("movers/1d-all.json", reply(body("1d", ["Everyone"])));
		route("movers/1d-tcgplayer.json", reply(body("1d", ["OneVendor"])));
		expect((await get(plugin, "1d"))?.gainers[0].name).toBe("Everyone");
		expect((await get(plugin, "1d", "tcgplayer"))?.gainers[0].name).toBe("OneVendor");
		expect((await get(plugin, "1d"))?.gainers[0].name).toBe("Everyone");
	});

	it("serves the last list it read, however old, when nothing answers any more", async () => {
		const plugin = fakePlugin();
		route("hist.test/movers/1d-all.json", reply(body("1d", ["Kept"])));
		await get(plugin);
		route("hist.test/movers/1d-all.json", fail());
		route(CARDBASE, fail());
		await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
		expect((await get(plugin))?.gainers[0].name).toBe("Kept");
	});
});

describe("Home's market movers with the cardbase.dev source switched off (as shipped)", () => {
	beforeEach(() => {
		CARDBASE_SOURCE.enabled = false;
	});

	it("is off by default: nothing in this file turns it on for the others", () => {
		CARDBASE_SOURCE.enabled = false;
		expect(CARDBASE_SOURCE.enabled).toBe(false);
	});

	it("reads our own file as usual", async () => {
		route("hist.test/movers/1d-all.json", reply(body("1d", ["Mover"])));
		expect((await get(fakePlugin()))?.gainers.map((m) => m.name)).toEqual(["Mover"]);
		expect(asked(CARDBASE)).toBe(0);
	});

	it("when our file cannot be read there is NOTHING else to ask: no request to cardbase, no list", async () => {
		route("hist.test/movers/1d-all.json", fail(), fail());
		route(CARDBASE, reply({ data: { gainers: [row("Old")], losers: [] }, meta: { as_of: "2026-09-09" } }));
		expect(await get(fakePlugin())).toBeUndefined();
		expect(asked(CARDBASE)).toBe(0);
		expect(asked("hist.test")).toBe(2);
	});

	it("gives up as soon as our own two tries are over: no pointless pause for a second source that is not there", async () => {
		route("hist.test/movers/1d-all.json", fail(), fail());
		const settled = vi.fn();
		const pending = getCardbaseMovers.call(fakePlugin(), "1d", undefined).then(settled);
		await vi.advanceTimersByTimeAsync(300); // exactly the pause between our two tries
		expect(settled).toHaveBeenCalled();
		await pending;
	});

	it("a device that cannot gunzip still reads the lists: they are plain JSON, only the shard files need gunzip", async () => {
		route("hist.test/movers/1d-all.json", reply(body("1d", ["Plain"])));
		const r = await get(fakePlugin(true, false));
		expect(r?.gainers.map((m) => m.name)).toEqual(["Plain"]);
		expect(net.urls).toEqual([`${OWN}1d-all.json`]);
	});

	it("with no service address at all: no request at all", async () => {
		route(CARDBASE, reply({ data: { gainers: [row("Old")], losers: [] }, meta: {} }));
		expect(await get(fakePlugin(false))).toBeUndefined();
		expect(net.urls).toEqual([]);
	});

	it("still serves the last list it read when our file stops answering", async () => {
		const plugin = fakePlugin();
		route("hist.test/movers/1d-all.json", reply(body("1d", ["Kept"])));
		await get(plugin);
		route("hist.test/movers/1d-all.json", fail());
		await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
		expect((await get(plugin))?.gainers[0].name).toBe("Kept");
		expect(asked(CARDBASE)).toBe(0);
	});
});
