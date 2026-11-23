import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ requestCalls: 0, response: undefined as undefined | (() => unknown) }));
vi.mock("obsidian", () => ({
	Platform: { isMobileApp: false },
	requestUrl: async () => {
		net.requestCalls++;
		return net.response!();
	},
}));

import { fetchCardKingdomPricelist, type CardKingdomPricelist } from "./card-kingdom";

// Card Kingdom rows carry Scryfall ids: real UUIDs (the pricelist is a table keyed by them, a row with any other id is not kept).
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PROBES = [A, B, C, D, E, F, "00000000-0000-4000-8000-000000000000"];
// Everything a pricelist says about the probe ids, in both finishes: two pricelists that give this are the same pricelist.
const dump = (list: CardKingdomPricelist) => PROBES.flatMap((id) => [false, true].map((foil) => [id, foil, list.get(id, foil)]));

// A pricelist designed to trip up stream reading: accents (multi-byte UTF-8 sequences that a cut can split),
// quotes and backslashes in names, braces inside a string, nested objects, rows to discard (zero price, no url,
// no scryfall_id), a scryfall_id+finish duplicate (the first row wins) and the same card in foil.
const ROWS = [
	{ id: 1, scryfall_id: A, url: "mtg/lea/black-lotus", name: "Black Lotus", is_foil: "false", price_retail: "9999.99", condition_values: { nm_price: "9999.99" } },
	{ id: 2, scryfall_id: A, url: "/mtg/lea/black-lotus-foil", name: "Black Lotus", is_foil: "true", price_retail: "12000.00" },
	{ id: 3, scryfall_id: A, url: "mtg/lea/black-lotus-dup", name: "Black Lotus (duplicate)", is_foil: "false", price_retail: "1.00" },
	{ id: 4, scryfall_id: B, url: "mtg/x/lim-duls-vault", name: "Lim-Dûl's Vault — \"Æther\" {braces} \\ back", is_foil: "false", price_retail: "0.45", note: "} and ] inside" },
	{ id: 5, scryfall_id: C, url: "mtg/x/free", name: "Zero", is_foil: "false", price_retail: "0.00" },
	{ id: 6, scryfall_id: D, name: "No url", is_foil: "false", price_retail: "3.00" },
	{ id: 7, url: "mtg/x/no-id", name: "No id", is_foil: "false", price_retail: "3.00" },
	{ id: 8, scryfall_id: E, url: "mtg/x/bad", name: "Bad price", is_foil: "false", price_retail: "n/a" },
	{ id: 9, scryfall_id: F, url: "mtg/x/日本語", name: "日本語のカード", is_foil: "false", price_retail: "2.50" },
	{ id: 10, scryfall_id: "not-a-uuid", url: "mtg/x/odd-id", name: "An id no card has", is_foil: "false", price_retail: "1.25" },
];
const DOC = JSON.stringify({ meta: { created_at: "2026-10-05 14:08:33", base_url: "https://www.cardkingdom.com/" }, data: ROWS });

// A fetch response whose body is cut into BYTE chunks at the given positions (so sometimes in the middle of a character).
function streamedResponse(text: string, cuts: number[], failAfterChunk?: number) {
	const bytes = new TextEncoder().encode(text);
	const edges = [0, ...cuts.filter((c) => c > 0 && c < bytes.length), bytes.length];
	const chunks = edges.slice(1).map((end, i) => bytes.slice(edges[i], end));
	let i = 0;
	return {
		ok: true,
		status: 200,
		body: {
			getReader: () => ({
				read: async () => {
					if (failAfterChunk !== undefined && i >= failAfterChunk) throw new Error("network dropped mid-response");
					return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined };
				},
			}),
		},
	};
}

const fetchMock = vi.fn();
beforeEach(() => {
	net.requestCalls = 0;
	net.response = () => ({ status: 200, arrayBuffer: new TextEncoder().encode(DOC).buffer, headers: {} });
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the Card Kingdom pricelist read in one piece (desktop)", () => {
	it("keeps the real prices, one entry per card and finish, the first of any duplicates, with absolute urls", async () => {
		const list = await fetchCardKingdomPricelist();
		expect(list.size).toBe(4);
		expect(list.get(A, false)).toEqual({ priceRetail: 9999.99, url: "https://www.cardkingdom.com/mtg/lea/black-lotus" });
		expect(list.get(A, true)?.url).toBe("https://www.cardkingdom.com/mtg/lea/black-lotus-foil"); // the leading slash of the row is not doubled
		expect(list.get(B, false)).toEqual({ priceRetail: 0.45, url: "https://www.cardkingdom.com/mtg/x/lim-duls-vault" });
		expect(list.get(F, false)).toEqual({ priceRetail: 2.5, url: "https://www.cardkingdom.com/mtg/x/日本語" }); // multi-byte text survives
		// what is not kept: the foil of a card with no foil row, a duplicate, a zero or invalid price, a row with no url, no id or an id no card has
		expect(list.get(B, true)).toBeUndefined();
		for (const id of [C, D, E, "00000000-0000-4000-8000-000000000000", "not-a-uuid", ""]) {
			expect(list.get(id, false), id).toBeUndefined();
			expect(list.get(id, true), id).toBeUndefined();
		}
		expect(net.requestCalls).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("an id is found whatever its case", async () => {
		const list = await fetchCardKingdomPricelist();
		expect(list.get(A.toUpperCase(), false)).toEqual(list.get(A, false));
	});

	it("reads the body as bytes, never as JSON text (a whole parse built 152,000 row objects at once)", async () => {
		const body = new TextEncoder().encode(DOC);
		const guarded = {
			status: 200,
			headers: {},
			arrayBuffer: body.buffer,
			get json(): unknown {
				throw new Error("the whole body must not be parsed in one piece");
			},
			get text(): string {
				throw new Error("the whole body must not be turned into one string");
			},
		};
		net.response = () => guarded;
		expect((await fetchCardKingdomPricelist()).size).toBe(4);
	});

	it("an empty pricelist — never a partial one — when the body is not a pricelist, a row is not JSON, or the request fails", async () => {
		net.response = () => ({ status: 200, arrayBuffer: new TextEncoder().encode('{"error":"maintenance"}').buffer, headers: {} });
		expect((await fetchCardKingdomPricelist()).size).toBe(0);
		const broken = '{"meta":{},"data":[{"scryfall_id":"' + A + '","url":"x","price_retail":"1.00"},{"scryfall_id":}]}';
		net.response = () => ({ status: 200, arrayBuffer: new TextEncoder().encode(broken).buffer, headers: {} });
		expect((await fetchCardKingdomPricelist()).size).toBe(0);
		net.response = () => ({ status: 503, arrayBuffer: new ArrayBuffer(0), headers: {} });
		expect((await fetchCardKingdomPricelist()).size).toBe(0);
		net.response = () => {
			throw new Error("Request Failed. ConnectException");
		};
		expect((await fetchCardKingdomPricelist()).size).toBe(0);
	});

	it("a pricelist with rows but none worth keeping is a failure too (the caller must try again, not keep it)", async () => {
		const useless = JSON.stringify({ meta: {}, data: [ROWS[4], ROWS[5], ROWS[7]] });
		net.response = () => ({ status: 200, arrayBuffer: new TextEncoder().encode(useless).buffer, headers: {} });
		expect((await fetchCardKingdomPricelist()).size).toBe(0);
	});
});

describe("the same pricelist read as a stream (phone, tablet)", () => {
	it("gives exactly the same entries as the whole read, however the bytes are cut — even inside a multi-byte character", async () => {
		const whole = await fetchCardKingdomPricelist();
		const total = new TextEncoder().encode(DOC).length;
		expect(whole.size).toBeGreaterThan(0);
		for (let cut = 1; cut < total; cut += 3) {
			fetchMock.mockResolvedValueOnce(streamedResponse(DOC, [cut]));
			const streamed = await fetchCardKingdomPricelist({ stream: true });
			expect(streamed.size).toBe(whole.size);
			expect(dump(streamed)).toEqual(dump(whole));
		}
	});

	it("never goes through requestUrl (its base64 copy of a 65 MB body is what crashed the app), and only asks for JSON", async () => {
		fetchMock.mockResolvedValueOnce(streamedResponse(DOC, [100, 5000]));
		await fetchCardKingdomPricelist({ stream: true });
		expect(net.requestCalls).toBe(0);
		expect(fetchMock).toHaveBeenCalledWith("https://api.cardkingdom.com/api/v2/pricelist", { headers: { Accept: "application/json" } });
	});

	it("uses the base url of the pricelist's meta when it has one, the default otherwise", async () => {
		const other = JSON.stringify({ meta: { base_url: "https:\/\/shop.example.test\/" }, data: [ROWS[0]] });
		fetchMock.mockResolvedValueOnce(streamedResponse(other, [10]));
		expect((await fetchCardKingdomPricelist({ stream: true })).get(A, false)?.url).toBe("https://shop.example.test/mtg/lea/black-lotus");
		const noMeta = JSON.stringify({ data: [ROWS[0]] });
		fetchMock.mockResolvedValueOnce(streamedResponse(noMeta, []));
		expect((await fetchCardKingdomPricelist({ stream: true })).get(A, false)?.url).toBe("https://www.cardkingdom.com/mtg/lea/black-lotus");
	});

	it("an empty pricelist — never a partial one — when anything goes wrong", async () => {
		// network cut mid-response: the partial pricelist would be kept for the session and would make it look as if some
		// cards have no price
		fetchMock.mockResolvedValueOnce(streamedResponse(DOC, [200, 400, 600], 2));
		expect((await fetchCardKingdomPricelist({ stream: true })).size).toBe(0);
		// no network at all (fetch rejects: offline, CORS, TLS)
		fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		expect((await fetchCardKingdomPricelist({ stream: true })).size).toBe(0);
		// statut d'erreur
		fetchMock.mockResolvedValueOnce({ ok: false, status: 503, body: null });
		expect((await fetchCardKingdomPricelist({ stream: true })).size).toBe(0);
		// a response that doesn't have the shape of a pricelist
		fetchMock.mockResolvedValueOnce(streamedResponse('{"error":"maintenance"}', []));
		expect((await fetchCardKingdomPricelist({ stream: true })).size).toBe(0);
	});
});
