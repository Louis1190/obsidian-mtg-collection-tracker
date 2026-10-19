import { afterEach, describe, expect, it, vi } from "vitest";

const preloaded = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../ui/image-preload", () => ({ preloadImages: (urls: string[]) => preloaded.calls.push(urls) }));

import { prefetchNeighborImages } from "./neighbor-prefetch";
import type MTGCollectionPlugin from "../plugin";

const card = (name: string, image: string, art = `${image}-art`) => ({ name, imageUrl: `https://img.test/${image}`, artCropUrl: `https://img.test/${art}` });

function fakePlugin() {
	return {
		settings: {
			collection: [card("Sol Ring", "sol-a"), card("Sol Ring", "sol-b"), card("Counterspell", "cs-a")],
			wantlist: [card("Sol Ring", "sol-w")],
			decks: [{ cards: [card("Sol Ring", "sol-d"), card("Counterspell", "cs-d")] }],
		},
	} as unknown as MTGCollectionPlugin;
}
const list = [card("Island", "i"), card("Sol Ring", "sol-a"), card("Counterspell", "cs-a")];

afterEach(() => {
	preloaded.calls.length = 0;
	Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});

describe("the pictures of the neighbouring cards", () => {
	it("hands the preloader the artworks, the cards' own images and two other copies of the same name", () => {
		prefetchNeighborImages.call(fakePlugin(), list, 0);
		const urls = preloaded.calls[0];
		expect(urls.slice(0, 2)).toEqual(["https://img.test/sol-a-art", "https://img.test/cs-a-art"]);
		expect(urls).toContain("https://img.test/sol-a");
		// two other Sol Ring pictures, not the card's own and not more than two (collection b, then the wantlist's, in the order gathered)
		expect(urls.filter((u) => u.includes("sol-") && !u.endsWith("-art") && !u.endsWith("sol-a"))).toEqual(["https://img.test/sol-b", "https://img.test/sol-w"]);
		expect(urls).toContain("https://img.test/cs-d"); // a copy in a deck counts
	});

	it("does nothing when the device asks to save data", () => {
		Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
		prefetchNeighborImages.call(fakePlugin(), list, 0);
		expect(preloaded.calls).toHaveLength(0);
	});
});
