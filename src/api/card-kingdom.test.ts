import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ requestCalls: 0, response: undefined as undefined | (() => unknown) }));
vi.mock("obsidian", () => ({
	Platform: { isMobileApp: false },
	requestUrl: async () => {
		net.requestCalls++;
		return net.response!();
	},
}));

import { cardKingdomKey, fetchCardKingdomPricelist } from "./card-kingdom";

// A pricelist designed to trip up stream reading: accents (multi-byte UTF-8 sequences that a cut can split),
// quotes and backslashes in names, braces inside a string, nested objects, rows to discard (zero price, no url,
// no scryfall_id), a scryfall_id+finish duplicate (the first row wins) and the same card in foil.
const ROWS = [
	{ id: 1, scryfall_id: "aaaa", url: "mtg/lea/black-lotus", name: "Black Lotus", is_foil: "false", price_retail: "9999.99", condition_values: { nm_price: "9999.99" } },
	{ id: 2, scryfall_id: "aaaa", url: "/mtg/lea/black-lotus-foil", name: "Black Lotus", is_foil: "true", price_retail: "12000.00" },
	{ id: 3, scryfall_id: "aaaa", url: "mtg/lea/black-lotus-dup", name: "Black Lotus (duplicate)", is_foil: "false", price_retail: "1.00" },
	{ id: 4, scryfall_id: "bbbb", url: "mtg/x/lim-duls-vault", name: "Lim-Dûl's Vault — \"Æther\" {braces} \\ back", is_foil: "false", price_retail: "0.45", note: "} and ] inside" },
	{ id: 5, scryfall_id: "cccc", url: "mtg/x/free", name: "Zero", is_foil: "false", price_retail: "0.00" },
	{ id: 6, scryfall_id: "dddd", name: "No url", is_foil: "false", price_retail: "3.00" },
	{ id: 7, url: "mtg/x/no-id", name: "No id", is_foil: "false", price_retail: "3.00" },
	{ id: 8, scryfall_id: "eeee", url: "mtg/x/bad", name: "Bad price", is_foil: "false", price_retail: "n/a" },
	{ id: 9, scryfall_id: "ffff", url: "mtg/x/日本語", name: "日本語のカード", is_foil: "false", price_retail: "2.50" },
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
	net.response = () => ({ status: 200, json: JSON.parse(DOC), headers: {} });
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the Card Kingdom pricelist read in one piece (desktop)", () => {
	it("keeps the real prices, one entry per card and finish, the first of any duplicates, with absolute urls", async () => {
		const map = await fetchCardKingdomPricelist();
		expect([...map.keys()].sort()).toEqual([cardKingdomKey("aaaa", false), cardKingdomKey("aaaa", true), cardKingdomKey("bbbb", false), cardKingdomKey("ffff", false)].sort());
		expect(map.get(cardKingdomKey("aaaa", false))).toEqual({ priceRetail: 9999.99, url: "https://www.cardkingdom.com/mtg/lea/black-lotus" });
		expect(map.get(cardKingdomKey("aaaa", true))?.url).toBe("https://www.cardkingdom.com/mtg/lea/black-lotus-foil");
		expect(net.requestCalls).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
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
			expect([...streamed.entries()]).toEqual([...whole.entries()]);
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
		expect((await fetchCardKingdomPricelist({ stream: true })).get(cardKingdomKey("aaaa", false))?.url).toBe("https://shop.example.test/mtg/lea/black-lotus");
		const noMeta = JSON.stringify({ data: [ROWS[0]] });
		fetchMock.mockResolvedValueOnce(streamedResponse(noMeta, []));
		expect((await fetchCardKingdomPricelist({ stream: true })).get(cardKingdomKey("aaaa", false))?.url).toBe("https://www.cardkingdom.com/mtg/lea/black-lotus");
	});

	it("an empty map — never a partial one — when anything goes wrong", async () => {
		// network cut mid-response: the partial Map would be kept for the session and would make it look as if some
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
