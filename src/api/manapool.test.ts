import { beforeEach, describe, expect, it, vi } from "vitest";

// manapool.ts imports Obsidian's Platform and requestUrl at load. Scripted fake network: the test says what the next request answers.
const net = vi.hoisted(() => ({ calls: 0, response: undefined as undefined | (() => unknown), platform: { isMobileApp: false } }));
vi.mock("obsidian", () => ({
	Platform: net.platform,
	requestUrl: async () => {
		net.calls++;
		return net.response!();
	},
}));

import { fetchManaPoolPricelist, manaPoolCardUrl, pickManaPoolPrice, toManaPoolSeriesFinish } from "./manapool";

// Mana Pool rows carry Scryfall ids: real UUIDs (the pricelist is a table keyed by them, a row with any other id is not kept).
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const bytes = (doc: unknown) => new TextEncoder().encode(typeof doc === "string" ? doc : JSON.stringify(doc)).buffer;
const answer = (doc: unknown) => {
	net.response = () => ({ status: 200, headers: {}, arrayBuffer: bytes(doc) });
};

beforeEach(() => {
	net.calls = 0;
	net.platform.isMobileApp = false;
	answer({ data: [] });
});

describe("manaPoolCardUrl", () => {
	it("is /card/<set>/<number>, lower case, the address Mana Pool redirects to the full page", () => {
		expect(manaPoolCardUrl("LEA", "232")).toBe("https://manapool.com/card/lea/232");
		expect(manaPoolCardUrl("UNH", "116")).toBe("https://manapool.com/card/unh/116");
	});

	it("keeps a number with letters, and encodes what is not safe in a path so that nothing can leave the address", () => {
		expect(manaPoolCardUrl("hml", "12A")).toBe("https://manapool.com/card/hml/12a");
		expect(manaPoolCardUrl("sld", "123★")).toBe("https://manapool.com/card/sld/123%E2%98%85");
		expect(manaPoolCardUrl("x/../y", "1?z#w")).toBe("https://manapool.com/card/x%2F..%2Fy/1%3Fz%23w");
	});

	it("is always https on manapool.com (what openExternalUrl accepts)", () => {
		expect(manaPoolCardUrl("a", "1").startsWith("https://manapool.com/card/")).toBe(true);
	});
});

describe("toManaPoolSeriesFinish", () => {
	it("follows pickManaPoolPrice: etched is etched, foil and surge foil are foil, the rest is normal", () => {
		expect(toManaPoolSeriesFinish("etched")).toBe("etched");
		expect(toManaPoolSeriesFinish("foiled")).toBe("foil");
		expect(toManaPoolSeriesFinish("surged")).toBe("foil");
		expect(toManaPoolSeriesFinish("regular")).toBe("normal");
		expect(toManaPoolSeriesFinish("proxy")).toBe("normal");
	});
});

describe("the Mana Pool pricelist (computer)", () => {
	it("keeps every price of a row, as cents, and the address as it came", async () => {
		answer({
			meta: { as_of: "2026-11-22" },
			data: [{ scryfall_id: A, url: "https://manapool.com/card/lea/232/black-lotus", price_cents: 250, price_cents_nm: 400, price_cents_foil: 600, price_cents_nm_foil: 700, price_cents_etched: 800, price_cents_nm_etched: 900 }],
		});
		const list = await fetchManaPoolPricelist();
		expect(list.size).toBe(1);
		expect(list.get(A)).toEqual({
			url: "https://manapool.com/card/lea/232/black-lotus",
			priceCents: 250,
			priceCentsNm: 400,
			priceCentsFoil: 600,
			priceCentsNmFoil: 700,
			priceCentsEtched: 800,
			priceCentsNmEtched: 900,
		});
		expect(net.calls).toBe(1);
	});

	it("a price that is zero, negative, missing, null, not a number, or absurd is no price (null), never 0", async () => {
		answer({ data: [{ scryfall_id: A, url: "u", price_cents: 0, price_cents_nm: -5, price_cents_foil: null, price_cents_nm_foil: "12", price_cents_etched: 3e10, price_cents_nm_etched: 0.3 }] });
		const entry = (await fetchManaPoolPricelist()).get(A);
		expect(entry).toEqual({ url: "u", priceCents: null, priceCentsNm: null, priceCentsFoil: null, priceCentsNmFoil: null, priceCentsEtched: null, priceCentsNmEtched: null });
	});

	it("whole cents: a fraction is rounded, the largest cell value is kept", async () => {
		answer({ data: [{ scryfall_id: A, url: "u", price_cents: 249.6, price_cents_nm: 2 ** 31 - 1, price_cents_foil: 1 }] });
		expect((await fetchManaPoolPricelist()).get(A)).toMatchObject({ priceCents: 250, priceCentsNm: 2 ** 31 - 1, priceCentsFoil: 1 });
	});

	it("one row per printing, the first of any duplicates; a row without id or address, or with an id no card has, is not kept", async () => {
		answer({
			data: [
				{ scryfall_id: A, url: "first", price_cents: 100 },
				{ scryfall_id: A, url: "second", price_cents: 999 },
				{ scryfall_id: B, price_cents: 100 },
				{ url: "no-id", price_cents: 100 },
				{ scryfall_id: "not-a-uuid", url: "odd", price_cents: 100 },
				{ scryfall_id: C, url: "c", price_cents: 300 },
			],
		});
		const list = await fetchManaPoolPricelist();
		expect(list.size).toBe(2);
		expect(list.get(A)).toMatchObject({ url: "first", priceCents: 100 });
		expect(list.get(C)).toMatchObject({ url: "c", priceCents: 300 });
		for (const id of [B, "not-a-uuid", "", "00000000-0000-4000-8000-000000000000"]) expect(list.get(id), id).toBeUndefined();
		expect(list.get(A.toUpperCase())).toEqual(list.get(A));
	});

	it("reads the body as bytes (multi-byte addresses included), never as one parsed document", async () => {
		const doc = JSON.stringify({ data: [{ scryfall_id: A, url: "https://manapool.com/card/x/1/日本語-Æther", price_cents: 100 }] });
		net.response = () => ({
			status: 200,
			headers: {},
			arrayBuffer: bytes(doc),
			get json(): unknown {
				throw new Error("the whole body must not be parsed in one piece");
			},
			get text(): string {
				throw new Error("the whole body must not be turned into one string");
			},
		});
		expect((await fetchManaPoolPricelist()).get(A)?.url).toBe("https://manapool.com/card/x/1/日本語-Æther");
	});

	it("an empty pricelist — never a partial one — when the request fails, the status is not 200, the body is not a pricelist or a row is not JSON", async () => {
		net.response = () => ({ status: 503, headers: {}, arrayBuffer: new ArrayBuffer(0) });
		expect((await fetchManaPoolPricelist()).size).toBe(0);
		net.response = () => {
			throw new Error("Request Failed. ConnectException");
		};
		expect((await fetchManaPoolPricelist()).size).toBe(0);
		answer({ error: "maintenance" });
		expect((await fetchManaPoolPricelist()).size).toBe(0);
		answer('{"data":[{"scryfall_id":"' + A + '","url":"u","price_cents":100},{"scryfall_id":}]}');
		expect((await fetchManaPoolPricelist()).size).toBe(0);
		answer({ data: [{ scryfall_id: "not-a-uuid", url: "u", price_cents: 1 }] }); // rows, but none that can ever be asked for
		expect((await fetchManaPoolPricelist()).size).toBe(0);
	});

	it("is not even asked for on a phone or tablet (the app would run out of memory): no request, an empty pricelist", async () => {
		net.platform.isMobileApp = true;
		answer({ data: [{ scryfall_id: A, url: "u", price_cents: 100 }] });
		const list = await fetchManaPoolPricelist();
		expect(list.size).toBe(0);
		expect(list.get(A)).toBeUndefined();
		expect(net.calls).toBe(0);
	});
});

describe("pickManaPoolPrice", () => {
	const entry = { url: "u", priceCents: 250, priceCentsNm: 400, priceCentsFoil: 600, priceCentsNmFoil: null, priceCentsEtched: null, priceCentsNmEtched: 900 };

	it("Near Mint first, the lowest price of any condition when no Near Mint copy is in stock (and it says so)", () => {
		expect(pickManaPoolPrice(entry, "regular")).toEqual({ priceCents: 400, isNearMint: true, url: "u" });
		expect(pickManaPoolPrice(entry, "foiled")).toEqual({ priceCents: 600, isNearMint: false, url: "u" });
		expect(pickManaPoolPrice(entry, "surged")).toEqual({ priceCents: 600, isNearMint: false, url: "u" }); // a surge foil is a foil
		expect(pickManaPoolPrice(entry, "etched")).toEqual({ priceCents: 900, isNearMint: true, url: "u" });
	});

	it("nothing when the finish has no price at all", () => {
		expect(pickManaPoolPrice({ ...entry, priceCentsEtched: null, priceCentsNmEtched: null }, "etched")).toBeUndefined();
	});
});

