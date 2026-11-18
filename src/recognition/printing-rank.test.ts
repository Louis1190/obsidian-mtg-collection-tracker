import { describe, expect, it } from "vitest";
import type { PrintedInfo } from "./printed";
import { matchPrinting, rankPrintings } from "./printing-rank";

const p = (id: string, set: string, collector_number: string) => ({ id, set, collector_number });
// The three printings of Masked Meower, newest first, as Scryfall gives them (the plugin proposed the first, the card is the second)
const MEOWER = [p("msc807", "msc", "807"), p("spm82", "spm", "82"), p("om1-96", "om1", "96")];
const read = (number: string | null, set: string | null, lang: string | null = "fr"): PrintedInfo => ({ number, set, lang, rarity: null });

describe("matchPrinting", () => {
	it("tells exact, number only, a slip away, set only and nothing apart", () => {
		expect(matchPrinting(MEOWER[1], read("82", "spm"))).toBe("exact");
		expect(matchPrinting(MEOWER[1], read("82", "xyz"))).toBe("number");
		expect(matchPrinting(MEOWER[1], read("82", null))).toBe("number");
		expect(matchPrinting(MEOWER[1], read("83", "spm"))).toBe("close");
		expect(matchPrinting(MEOWER[1], read("83", "xyz"))).toBe("none");
		expect(matchPrinting(MEOWER[1], read(null, "spm"))).toBe("set");
		expect(matchPrinting(MEOWER[0], read("82", "spm"))).toBe("none");
		expect(matchPrinting(MEOWER[1], null)).toBe("none");
	});
	it("takes a set code with its first or last letter lost for the set", () => {
		expect(matchPrinting(MEOWER[1], read("82", "pm"))).toBe("exact");
		expect(matchPrinting(MEOWER[1], read("82", "sp"))).toBe("exact");
		expect(matchPrinting(MEOWER[1], read("82", "p"))).toBe("number"); // one letter is not enough to say anything
	});
	it("compares collector numbers by their digits: leading zeros, a suffix letter or a star do not matter", () => {
		expect(matchPrinting(p("a", "spm", "0082"), read("82", "spm"))).toBe("exact");
		expect(matchPrinting(p("a", "spm", "82a"), read("82", "spm"))).toBe("exact");
		expect(matchPrinting(p("a", "spm", "★82"), read("82", "spm"))).toBe("exact");
	});
	it("calls a number one slip away close only when the set agrees, and never two slips", () => {
		expect(matchPrinting(p("a", "spm", "88"), read("86", "spm"))).toBe("close");
		expect(matchPrinting(p("a", "spm", "88"), read("8", "spm"))).toBe("close"); // a digit lost
		expect(matchPrinting(p("a", "spm", "88"), read("188", "spm"))).toBe("close"); // a digit added
		expect(matchPrinting(p("a", "spm", "88"), read("66", "spm"))).toBe("set");
		expect(matchPrinting(p("a", "spm", "88"), read("86", null))).toBe("none");
	});
});

describe("rankPrintings", () => {
	it("puts the printing the card carries first, the others after it in Scryfall's order", () => {
		const { ordered, best } = rankPrintings(MEOWER, () => 0, read("82", "spm"));
		expect(ordered.map((x) => x.id)).toEqual(["spm82", "msc807", "om1-96"]);
		expect(best).toBe("exact");
	});
	it("leaves the order alone when nothing was read, and says so", () => {
		const { ordered, best } = rankPrintings(MEOWER, () => 0, null);
		expect(ordered.map((x) => x.id)).toEqual(["msc807", "spm82", "om1-96"]);
		expect(best).toBe("none");
		expect(rankPrintings([], () => 0, read("1", "x")).best).toBe("none");
	});
	it("puts an exact match first even when it belongs to a name the title ranked second", () => {
		const unstable = [p("msc789", "msc", "789"), p("spm47", "spm", "47")];
		const experiment = [p("om1-1", "om1", "1")];
		const all = [...experiment, ...unstable];
		const idx = (x: { id: string }) => (x.id === "om1-1" ? 0 : 1);
		const { ordered } = rankPrintings(all, idx, read("47", "spm"));
		expect(ordered.map((x) => x.id)).toEqual(["spm47", "om1-1", "msc789"]);
	});
	it("keeps the title's order of names for weaker agreements, so a number alone does not reorder the cards", () => {
		const first = [p("a1", "aaa", "10"), p("a2", "aaa", "11")];
		const second = [p("b1", "bbb", "47")];
		const idx = (x: { id: string }) => (x.id.startsWith("a") ? 0 : 1);
		// "47" matches the second name's printing by number only (the set read does not match): the first name still leads
		const { ordered, best } = rankPrintings([...first, ...second], idx, read("47", "zzz"));
		expect(ordered.map((x) => x.id)).toEqual(["a1", "a2", "b1"]);
		expect(best).toBe("none");
	});
	it("inside one name ranks number only, then a slip away, then the set, then the rest", () => {
		const prints = [p("none", "x1", "5"), p("set", "spm", "5"), p("close", "spm", "89"), p("number", "x2", "88"), p("exact", "spm", "88")];
		const { ordered } = rankPrintings(prints, () => 0, read("88", "spm"));
		expect(ordered.map((x) => x.id)).toEqual(["exact", "number", "close", "set", "none"]);
	});
	it("does not lose or repeat a printing", () => {
		const { ordered } = rankPrintings(MEOWER, (x) => (x.id === "spm82" ? 2 : 0), read("96", null));
		expect([...ordered.map((x) => x.id)].sort()).toEqual(["msc807", "om1-96", "spm82"]);
	});
	it("among exact matches puts the plainest first: the set as read and the number as read, before a promo set or a suffixed number", () => {
		const prints = [p("promo", "pspm", "46s"), p("promo-set", "pspm", "46"), p("suffix", "spm", "46s"), p("plain", "spm", "46")];
		const { ordered } = rankPrintings(prints, () => 0, read("46", "spm"));
		expect(ordered.map((x) => x.id)).toEqual(["plain", "promo-set", "suffix", "promo"]);
	});
	it("does not let looseness reorder printings that are not exact matches", () => {
		const prints = [p("a", "x1", "5"), p("b", "x2", "6")];
		expect(rankPrintings(prints, () => 0, read("99", "zzz")).ordered.map((x) => x.id)).toEqual(["a", "b"]);
	});
});
