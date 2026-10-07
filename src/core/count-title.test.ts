import { describe, expect, it } from "vitest";
import { formatCountTitle } from "./count-title";

describe("formatCountTitle", () => {
	it("works for the cards title inside an open list/deck/wantlist", () => {
		expect(formatCountTitle("card", 95, 95, false)).toBe("Cards: 95 cards");
		expect(formatCountTitle("card", 14, 95, true)).toBe("Cards: 14 of 95 cards match");
		expect(formatCountTitle("card", 0, 1, true)).toBe("Cards: 0 of 1 card matches");
	});

	it("shows the plain total when nothing is searched", () => {
		expect(formatCountTitle("list", 12, 12, false)).toBe("Lists: 12 lists");
		expect(formatCountTitle("deck", 5, 5, false)).toBe("Decks: 5 decks");
		expect(formatCountTitle("wantlist", 3, 3, false)).toBe("Wantlists: 3 wantlists");
	});

	it("uses the singular for a single item and handles zero", () => {
		expect(formatCountTitle("list", 1, 1, false)).toBe("Lists: 1 list");
		expect(formatCountTitle("deck", 0, 0, false)).toBe("Decks: 0 decks");
	});

	it("switches to \"x of y … match\" while searching", () => {
		expect(formatCountTitle("list", 3, 12, true)).toBe("Lists: 3 of 12 lists match");
		expect(formatCountTitle("deck", 1, 5, true)).toBe("Decks: 1 of 5 decks match");
		expect(formatCountTitle("wantlist", 0, 3, true)).toBe("Wantlists: 0 of 3 wantlists match");
	});

	it("still announces a search that keeps everything", () => {
		expect(formatCountTitle("list", 12, 12, true)).toBe("Lists: 12 of 12 lists match");
	});

	it("agrees the verb with a singular total", () => {
		expect(formatCountTitle("deck", 0, 1, true)).toBe("Decks: 0 of 1 deck matches");
		expect(formatCountTitle("deck", 1, 1, true)).toBe("Decks: 1 of 1 deck matches");
	});
});
