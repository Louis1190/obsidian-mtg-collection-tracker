import { beforeEach, describe, expect, it, vi } from "vitest";

// A scripted fake network: each request consumes the next step (the last one repeats). Simpler, here, than a
// vi.fn() whose state (mockReset / rejecting implementation) behaves surprisingly in vitest 4.
const net = vi.hoisted(() => ({ steps: [] as (() => unknown)[], calls: [] as unknown[] }));
vi.mock("obsidian", () => ({
	Platform: { isMobileApp: false },
	requestUrl: async (params: unknown) => {
		net.calls.push(params);
		const step = net.steps.length > 1 ? net.steps.shift()! : net.steps[0];
		return step();
	},
}));
import { fetchCardKingdomPricelist } from "./card-kingdom";
import { fetchManaPoolPricelist } from "./manapool";
import {
	fetchCardbaseMovers,
	fetchCardbasePriceHistory,
	fetchCardbasePrintingCardmarketId,
	fetchCardmarketNativePrices,
	testCardbaseConnection,
} from "./cardbase";
import { requestUrlOrNull } from "./safe-request";

const transportError = () => new Error("Request Failed. SSLHandshakeException: Trust anchor for certification path not found.");
const response = (status: number, json: unknown = {}) => () => ({ status, json, headers: {} });
const down = () => { throw transportError(); };
const script = (...steps: (() => unknown)[]) => { net.steps = steps; };

beforeEach(() => { net.steps = []; net.calls = []; });

describe("requestUrlOrNull", () => {
	it("returns the response, asking requestUrl not to throw on HTTP statuses", async () => {
		script(response(404));
		const res = await requestUrlOrNull({ url: "https://example.test/x" });
		expect(res?.status).toBe(404);
		expect(net.calls).toEqual([{ url: "https://example.test/x", throw: false }]);
	});

	it("returns null instead of rejecting when the request cannot be made at all (offline, TLS inspection)", async () => {
		script(down);
		await expect(requestUrlOrNull({ url: "https://example.test/x" })).resolves.toBeNull();
	});
});

// Each fetcher promises "a failure value, never an exception": this is what the interface ("—", "No price
// history available yet.", greyed-out column) knows how to display. A transport error must lead there like a
// non-200 status.
describe("the data-source fetchers resolve to their failure value when the network is down", () => {
	it("Card Kingdom and Mana Pool pricelists: an empty map", async () => {
		script(down);
		expect((await fetchCardKingdomPricelist()).size).toBe(0);
		expect((await fetchManaPoolPricelist()).size).toBe(0);
	});

	it("cardbase price history, Cardmarket id, native prices and movers: undefined", async () => {
		script(down);
		await expect(fetchCardbasePriceHistory("sid", "", "normal", 30)).resolves.toBeUndefined();
		await expect(fetchCardbasePrintingCardmarketId("sid", "")).resolves.toBeUndefined();
		await expect(fetchCardmarketNativePrices(1, "", 30)).resolves.toBeUndefined();
		await expect(fetchCardbaseMovers("", "1d", undefined, 100)).resolves.toBeUndefined();
	});

	it("the cardbase key test says \"error\" (the key is not at fault), not an exception", async () => {
		script(down);
		await expect(testCardbaseConnection("key")).resolves.toBe("error");
	});

	it("an HTTP status keeps meaning what it meant (404 = no Cardmarket id, 401 = bad key, 200 = data)", async () => {
		script(response(404));
		await expect(fetchCardbasePrintingCardmarketId("sid", "")).resolves.toBeNull();
		script(response(200, { data: { cardmarket_id: 4242 } }));
		await expect(fetchCardbasePrintingCardmarketId("sid", "")).resolves.toBe(4242);
		script(response(500));
		await expect(fetchCardbasePrintingCardmarketId("sid", "")).resolves.toBeUndefined();
		script(response(401));
		await expect(testCardbaseConnection("key")).resolves.toBe("rejected");
		script(response(200, { data: { gainers: [], losers: [] }, meta: { as_of: "2026-10-05" } }));
		await expect(fetchCardbaseMovers("", "1d", undefined, 100)).resolves.toMatchObject({ period: "1d", asOf: "2026-10-05" });
	});
});
