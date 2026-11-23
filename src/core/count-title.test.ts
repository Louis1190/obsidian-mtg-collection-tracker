import { describe, expect, it } from "vitest";
import { formatCountTitle, formatPrintingsCount } from "./count-title";

describe("formatPrintingsCount", () => {
	it("shows the total when nothing is typed", () => {
		expect(formatPrintingsCount(12, 12, false)).toBe("12 printings");
		expect(formatPrintingsCount(1, 1, false)).toBe("1 printing");
	});

	it("says what a typed filter keeps against the total, the plural following the total", () => {
		expect(formatPrintingsCount(3, 12, true)).toBe("3 of 12 printings");
		expect(formatPrintingsCount(0, 12, true)).toBe("0 of 12 printings");
		expect(formatPrintingsCount(1, 1, true)).toBe("1 of 1 printing");
		expect(formatPrintingsCount(1, 12, true)).toBe("1 of 12 printings");
		expect(formatPrintingsCount(12, 12, true)).toBe("12 of 12 printings");
	});

	it("says nothing while the printings are not known yet", () => {
		expect(formatPrintingsCount(0, 0, false)).toBe("");
	});
});

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
