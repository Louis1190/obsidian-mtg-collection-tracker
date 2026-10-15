import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts every request that would leave the plugin.
const net = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("obsidian", () => ({
	requestUrl: async (params: { url: string }) => {
		net.urls.push(params.url);
		return { status: 200, json: { data: {} }, headers: {}, arrayBuffer: new ArrayBuffer(0) };
	},
}));

import {
	CARDBASE_SOURCE,
	fetchCardbaseMovers,
	fetchCardbasePriceHistory,
	fetchCardbasePrintingCardmarketId,
	fetchCardmarketNativePrices,
	testCardbaseConnection,
} from "./cardbase";

const callAll = async () => [
	await fetchCardbasePriceHistory("abc00001", "key", "normal", 365),
	await fetchCardbasePrintingCardmarketId("abc00001", "key"),
	await fetchCardmarketNativePrices(123, "key", 365),
	await fetchCardbaseMovers("key", "1d", undefined, 100),
	await testCardbaseConnection("key"),
];

beforeEach(() => { net.urls = []; });
afterEach(() => { CARDBASE_SOURCE.enabled = false; });

describe("the switch of the whole cardbase.dev source", () => {
	it("is OFF as shipped (turning it back on is a deliberate change of this one line and of this test)", () => {
		expect(CARDBASE_SOURCE.enabled).toBe(false);
	});

	it("off: no function of the file sends anything, and each answers its failure value", async () => {
		CARDBASE_SOURCE.enabled = false;
		const answers = await callAll();
		expect(net.urls).toEqual([]);
		expect(answers).toEqual([undefined, undefined, undefined, undefined, "error"]);
	});

	it("on: the same five calls do reach api.cardbase.dev, so the switch is the only thing that was keeping them quiet", async () => {
		CARDBASE_SOURCE.enabled = true;
		await callAll();
		expect(net.urls).toHaveLength(5);
		expect(net.urls.every((u) => u.startsWith("https://api.cardbase.dev/v1/"))).toBe(true);
	});
});
