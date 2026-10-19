import { describe, expect, it } from "vitest";
import { NEIGHBOR_COPY_IMAGES, isFetchableImageUrl, neighborImageUrls, neighborIndexes } from "./neighbor-prefetch";

const card = (n: number, over: Record<string, string> = {}) => ({
	name: `Card ${n}`,
	artCropUrl: `https://img.test/art/${n}.jpg`,
	imageUrl: `https://img.test/normal/${n}.jpg`,
	...over,
});
const cards = Array.from({ length: 20 }, (_, i) => card(i));
const noCopies = () => [];

describe("neighborIndexes", () => {
	it("goes outwards from the displayed card, next before previous, `window` each side", () => {
		expect(neighborIndexes(10, 20, 3)).toEqual([11, 9, 12, 8, 13, 7]);
	});

	it("stops at both ends of the list", () => {
		expect(neighborIndexes(0, 20, 3)).toEqual([1, 2, 3]);
		expect(neighborIndexes(19, 20, 3)).toEqual([18, 17, 16]);
		expect(neighborIndexes(1, 3, 5)).toEqual([2, 0]);
	});

	it("a list of one card has no neighbour", () => {
		expect(neighborIndexes(0, 1, 5)).toEqual([]);
	});
});

describe("neighborImageUrls", () => {
	it("asks for every neighbour's artwork first (nearest first), then their own full images", () => {
		const urls = neighborImageUrls(cards, 10, 2, noCopies);
		expect(urls).toEqual([
			"https://img.test/art/11.jpg",
			"https://img.test/art/9.jpg",
			"https://img.test/art/12.jpg",
			"https://img.test/art/8.jpg",
			"https://img.test/normal/11.jpg",
			"https://img.test/normal/9.jpg",
			"https://img.test/normal/12.jpg",
			"https://img.test/normal/8.jpg",
		]);
	});

	it("never asks for the displayed card itself", () => {
		const urls = neighborImageUrls(cards, 10, 5, noCopies);
		expect(urls.some((u) => u.endsWith("/10.jpg"))).toBe(false);
		expect(urls).toHaveLength(20); // 10 neighbours x (art + normal)
	});

	it("adds up to two other copies of the same name after each neighbour's own image", () => {
		const copies = (name: string) => (name === "Card 11" ? ["https://img.test/other/a.jpg", "https://img.test/other/b.jpg", "https://img.test/other/c.jpg"] : []);
		const urls = neighborImageUrls(cards, 10, 1, copies);
		expect(NEIGHBOR_COPY_IMAGES).toBe(2);
		expect(urls).toEqual([
			"https://img.test/art/11.jpg",
			"https://img.test/art/9.jpg",
			"https://img.test/normal/11.jpg",
			"https://img.test/other/a.jpg",
			"https://img.test/other/b.jpg",
			"https://img.test/normal/9.jpg",
		]);
	});

	it("skips an artwork that is only the whole-card scan, an empty address, and a repeated one", () => {
		const list = [
			card(0),
			card(1, { artCropUrl: "https://img.test/normal/1.jpg" }), // no real art crop: the same picture as imageUrl
			card(2, { imageUrl: "" }),
			card(3, { imageUrl: "https://img.test/normal/1.jpg" }), // same picture as card 1's
		];
		const urls = neighborImageUrls(list, 0, 3, noCopies);
		expect(urls).toEqual(["https://img.test/art/2.jpg", "https://img.test/art/3.jpg", "https://img.test/normal/1.jpg"]);
	});

	it("accepts the loopback host (the Android test setup) and nothing else that is not https", () => {
		expect(isFetchableImageUrl("http://localhost:8099/art.jpg?x=1")).toBe(true);
		expect(isFetchableImageUrl("http://127.0.0.1/art.jpg")).toBe(true);
		expect(isFetchableImageUrl("http://localhost.evil.test/art.jpg")).toBe(false);
		expect(isFetchableImageUrl("http://img.test/a.jpg")).toBe(false);
		expect(isFetchableImageUrl("https://cards.scryfall.io/art_crop/front/1/2/x.jpg")).toBe(true);
	});

	it("only ever downloads from https addresses", () => {
		const list = [card(0), card(1, { artCropUrl: "http://img.test/a.jpg", imageUrl: "javascript:alert(1)" }), card(2, { artCropUrl: "data:image/png;base64,AAAA" })];
		const urls = neighborImageUrls(list, 0, 2, () => ["file:///etc/passwd", "ftp://x/y.jpg"]);
		expect(urls.every((u) => u.startsWith("https://"))).toBe(true);
		expect(urls).toEqual(["https://img.test/normal/2.jpg"]);
	});
});
