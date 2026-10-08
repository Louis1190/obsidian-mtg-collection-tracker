import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Scripted fake network (see api/safe-request.test.ts).
const net = vi.hoisted(() => ({ steps: [] as (() => unknown)[], calls: 0, platform: { isMobileApp: false } }));
vi.mock("obsidian", () => ({
	Platform: net.platform,
	requestUrl: async () => {
		net.calls++;
		const step = net.steps.length > 1 ? net.steps.shift()! : net.steps[0];
		return step();
	},
}));

import { getCardKingdomPrice, getManaPoolPrice, loadCardKingdomPrices, loadManaPoolPrices } from "./store-prices";
import { manaPoolPricesSupported } from "../api/manapool";
import type MTGCollectionPlugin from "../plugin";

const down = () => { throw new Error("Request Failed. ConnectException: Failed to connect"); };
const ck = () => ({ status: 200, headers: {}, json: { meta: { base_url: "https://www.cardkingdom.com/" }, data: [{ scryfall_id: "c1", is_foil: "false", price_retail: "4.99", url: "/mtg/x/y" }] } });
const mp = () => ({ status: 200, headers: {}, json: { data: [{ scryfall_id: "c1", url: "https://manapool.com/card/x", price_cents: 250, price_cents_foil: 600 }] } });
const script = (...steps: (() => unknown)[]) => { net.steps = steps; };

function fakePlugin() {
	return { cardKingdomPricesCache: null, cardKingdomPricesFetchPromise: null, manaPoolPricesCache: null, manaPoolPricesFetchPromise: null, loadCardKingdomPrices, loadManaPoolPrices } as unknown as MTGCollectionPlugin;
}

beforeEach(() => { net.steps = []; net.calls = 0; });

// These pricelists are loaded ONCE per session. A rejected promise kept in the cache stayed there for the whole
// session: a cut at the first click deprived the card of its prices until Obsidian restarted.
describe("the store pricelists after a network failure", () => {
	it("Card Kingdom: an empty answer now, the next card opened tries again and gets the prices", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(getCardKingdomPrice.call(plugin, "c1", false)).resolves.toBeUndefined();
		expect(plugin.cardKingdomPricesCache).toBeNull();
		script(ck);
		await expect(getCardKingdomPrice.call(plugin, "c1", false)).resolves.toMatchObject({ priceRetail: 4.99 });
	});

	it("Mana Pool: the same", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(getManaPoolPrice.call(plugin, "c1", "regular")).resolves.toBeUndefined();
		expect(plugin.manaPoolPricesCache).toBeNull();
		script(mp);
		await expect(loadManaPoolPrices.call(plugin)).resolves.toBeInstanceOf(Map);
		expect((await loadManaPoolPrices.call(plugin)).size).toBeGreaterThan(0);
	});

	it("a successful load is kept for the session (one request)", async () => {
		const plugin = fakePlugin();
		script(ck);
		await getCardKingdomPrice.call(plugin, "c1", false);
		await getCardKingdomPrice.call(plugin, "c1", true);
		expect(net.calls).toBe(1);
	});
});

// Phone / tablet: a 65 MB (Card Kingdom) or 49 MB (Mana Pool) pricelist passed through requestUrl is
// base64-encoded there then returned at once, and the Obsidian app crashes for lack of memory ON OPENING A
// SHEET. Card Kingdom is read there as a stream (fetch); Mana Pool (no CORS, no per-card access) isn't loaded
// there at all.
describe("on a phone or tablet", () => {
	const fetchMock = vi.fn();
	const body = (text: string) => {
		const bytes = new TextEncoder().encode(text);
		let done = false;
		return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: bytes })) }) } };
	};
	const CK_DOC = JSON.stringify({ meta: { base_url: "https://www.cardkingdom.com/" }, data: [{ scryfall_id: "c1", is_foil: "false", price_retail: "4.99", url: "/mtg/x/y" }] });

	beforeEach(() => {
		net.platform.isMobileApp = true;
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		net.platform.isMobileApp = false;
		vi.unstubAllGlobals();
	});

	it("Card Kingdom is read as a stream and requestUrl is never called", async () => {
		const plugin = fakePlugin();
		fetchMock.mockResolvedValueOnce(body(CK_DOC));
		await expect(getCardKingdomPrice.call(plugin, "c1", false)).resolves.toMatchObject({ priceRetail: 4.99, url: "https://www.cardkingdom.com/mtg/x/y" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(net.calls).toBe(0);
	});

	it("a stream that fails is retried by the next card, like a failed download on desktop", async () => {
		const plugin = fakePlugin();
		fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await expect(getCardKingdomPrice.call(plugin, "c1", false)).resolves.toBeUndefined();
		fetchMock.mockResolvedValueOnce(body(CK_DOC));
		await expect(getCardKingdomPrice.call(plugin, "c1", false)).resolves.toMatchObject({ priceRetail: 4.99 });
	});

	it("Mana Pool is not loaded: no request of any kind, and the box can tell the user why", async () => {
		const plugin = fakePlugin();
		script(mp);
		await expect(getManaPoolPrice.call(plugin, "c1", "regular")).resolves.toBeUndefined();
		expect(net.calls).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(manaPoolPricesSupported()).toBe(false);
		net.platform.isMobileApp = false;
		expect(manaPoolPricesSupported()).toBe(true);
	});
});

describe("on a computer", () => {
	it("Card Kingdom still goes through requestUrl, Mana Pool is loaded", async () => {
		const plugin = fakePlugin();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		script(ck);
		await getCardKingdomPrice.call(plugin, "c1", false);
		script(mp);
		await expect(getManaPoolPrice.call(plugin, "c1", "regular")).resolves.toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(net.calls).toBe(2);
		vi.unstubAllGlobals();
	});
});
