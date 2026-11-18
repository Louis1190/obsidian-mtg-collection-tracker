import { describe, expect, it } from "vitest";
import { combinePrinted, parsePrinted } from "./printed";

const real = (s: string) => s.split(" / ");

describe("parsePrinted on real OCR output", () => {
	it("reads number, set and language from a clean read", () => {
		expect(parsePrinted(real("c 0082 / SPM *FR te NARENDRA"))).toEqual({ number: "82", set: "spm", lang: "fr", rarity: "C" });
		expect(parsePrinted(real("Cc 0047 / SPM + FR t& Davin P,"))).toEqual({ number: "47", set: "spm", lang: "fr", rarity: null });
		expect(parsePrinted(real("R 0046 / SPM + FR t& Bora"))).toEqual({ number: "46", set: "spm", lang: "fr", rarity: "R" });
		expect(parsePrinted(real("YU 0042 / SPM +FR te DoMEN"))).toEqual({ number: "42", set: "spm", lang: "fr", rarity: null });
	});
	it("tolerates a stray mark before the rarity and a lost first letter of the set code", () => {
		expect(parsePrinted(real(". 0197 / PMR tw lonas Di }"))).toEqual({ number: "197", set: "pmr", lang: null, rarity: null });
		expect(parsePrinted(real("' 0188 / PM +FR te Wri GUAN"))).toEqual({ number: "188", set: "pm", lang: "fr", rarity: null });
		expect(parsePrinted(real("0086 / PM: FR & Piotr Dua."))).toEqual({ number: "86", set: "pm", lang: "fr", rarity: null });
	});
	it("keeps the set when the language is garbled, from the line under the number", () => {
		expect(parsePrinted(real(". 0197 / PMePR tw lonas Di b"))).toEqual({ number: "197", set: "pm", lang: null, rarity: null });
	});
	it("reads a token with a letter that looks like a digit, and gives up on one that does not", () => {
		expect(parsePrinted(["C O082", "SPM * FR"])?.number).toBe("82");
		expect(parsePrinted(["C 00B8", "SPM * FR"])?.number).toBe("88");
		expect(parsePrinted(["008é", "PM: FR"])?.number).toBeNull();
	});
});

describe("parsePrinted: the rarity letter and tokens", () => {
	it("reads the rarity letter before the number, with or without a space, and from either side of a total", () => {
		expect(parsePrinted(["T 0004", "TSPM * FR"])).toEqual({ number: "4", set: "tspm", lang: "fr", rarity: "T" });
		expect(parsePrinted(["T0004", "TSPM * FR"])).toEqual({ number: "4", set: "tspm", lang: "fr", rarity: "T" });
		expect(parsePrinted(["U0123", "SPM * FR"])?.rarity).toBe("U");
		expect(parsePrinted(["123/249 M", "ISD * DE"])?.rarity).toBe("M");
		expect(parsePrinted(["lower c 0082", "SPM * FR"])?.rarity).toBeNull(); // not a number line: too long
		expect(parsePrinted(["0004", "TSPM * FR"])?.rarity).toBeNull();
	});
	it("keeps a token's number when the T lost from the set code comes with it (the set reads SPM, the rarity says T)", () => {
		expect(parsePrinted(["T 0004", "SPM * FR"])).toEqual({ number: "4", set: "spm", lang: "fr", rarity: "T" });
	});
	it("does not take a letter glued to junk for a rarity, nor let the touching prefix open the door to junk before a number", () => {
		expect(parsePrinted(["yvo0042", "SPM * FR"])?.number).toBeNull();
		expect(parsePrinted(["Cc 0047", "SPM * FR"])?.rarity).toBeNull();
	});
});

describe("parsePrinted formats", () => {
	it("reads the 2015-2022 format with a total", () => {
		expect(parsePrinted(["082/274 R", "M15 • EN Steve Argyle"])).toEqual({ number: "82", set: "m15", lang: "en", rarity: "R" });
		expect(parsePrinted(["R 123/249", "ISD * DE"])).toEqual({ number: "123", set: "isd", lang: "de", rarity: "R" });
	});
	it("maps the printed language codes the plugin knows, and ignores the others", () => {
		expect(parsePrinted(["C 0010", "WOE • JA"])?.lang).toBe("ja");
		expect(parsePrinted(["C 0010", "WOE • CS"])?.lang).toBe("zhs");
		expect(parsePrinted(["C 0010", "WOE • XX"])?.lang).toBeNull();
	});
	it("never takes a year or a long line for a number", () => {
		expect(parsePrinted(["© 1993-2010 Wizards of the Coast, Inc."])).toBeNull();
		expect(parsePrinted(["2025", "SPM • FR"])?.number).toBeNull();
		expect(parsePrinted(["0 2025 Wizards of the Coast"])).toBeNull();
		expect(parsePrinted(["C 0000", "SPM • FR"])?.number).toBeNull();
	});
	it("keeps a number above 1990 when it is zero-padded or beyond the years", () => {
		expect(parsePrinted(["R 0123", "SLD • EN"])?.number).toBe("123");
		expect(parsePrinted(["R 2500", "SLD • EN"])?.number).toBe("2500");
	});
	it("answers null for noise and for nothing", () => {
		expect(parsePrinted([])).toBeNull();
		expect(parsePrinted(["\" o / —"])).toBeNull();
		expect(parsePrinted(["ee FR hfe ee Sy eGo"])).toBeNull();
	});
	it("finds the number line wherever it comes in the lines", () => {
		expect(parsePrinted(["SPM * FR", "C 0082"])).toEqual({ number: "82", set: "spm", lang: "fr", rarity: "C" });
	});
});

describe("combinePrinted", () => {
	it("takes each field from the value most reads agree on, so one slipped digit does not decide", () => {
		const a = { number: "86", set: "pm", lang: "fr", rarity: null };
		const b = { number: "88", set: "spm", lang: "fr", rarity: null };
		const c = { number: "88", set: "pm", lang: null, rarity: null };
		expect(combinePrinted([a, b, c])).toEqual({ number: "88", set: "spm", lang: "fr", rarity: null });
	});
	it("lets a set code read with a letter lost support the whole code, and takes the longest of the best supported", () => {
		const read = (set: string | null) => ({ number: "82", set, lang: "fr", rarity: null });
		expect(combinePrinted([read("pm"), read("pm"), read("spm")])?.set).toBe("spm");
		expect(combinePrinted([read("pm"), read("spm"), read("spm")])?.set).toBe("spm");
		// two different codes that do not contain one another: the better supported wins
		expect(combinePrinted([read("m15"), read("m15"), read("isd")])?.set).toBe("m15");
		expect(combinePrinted([read(null), read("spm")])?.set).toBe("spm");
		// equally supported codes that do not contain one another: the longer (more letters read) first, then the earlier read
		expect(combinePrinted([read("xyz"), read("abcd")])?.set).toBe("abcd");
		expect(combinePrinted([read("abc"), read("xyz")])?.set).toBe("abc");
	});
	it("does not let one stray letter in front of a set code beat the code read in full more often (HOB x3, MHOB x1)", () => {
		const read = (set: string | null) => ({ number: "83", set, lang: "en", rarity: "R" });
		expect(combinePrinted([read("hob"), read("mhob"), read("hob"), read("hob")])?.set).toBe("hob");
		expect(combinePrinted([read("mhob"), read("hob"), read("hob")])?.set).toBe("hob");
		// order of the reads does not matter
		expect(combinePrinted([read("hob"), read("hob"), read("mhob")])?.set).toBe("hob");
		// a lone stray letter against ONE full read is a tie: the longer stays (as before), the wide reread decides
		expect(combinePrinted([read("hob"), read("mhob")])?.set).toBe("mhob");
		// the other way round: a 4-letter code (a promo set) read twice against the 3 letters it contains read once
		expect(combinePrinted([read("spm"), read("pspm"), read("pspm")])?.set).toBe("pspm");
		// and a code read with two letters is never a whole code, however often it is read
		expect(combinePrinted([read("pm"), read("pm"), read("pm"), read("spm")])?.set).toBe("spm");
	});
	it("takes the first read on a tie, skips reads that found nothing, and answers null when none did", () => {
		expect(combinePrinted([null, { number: "82", set: null, lang: null, rarity: null }, { number: "83", set: null, lang: null, rarity: null }])?.number).toBe("82");
		expect(combinePrinted([null, null])).toBeNull();
		expect(combinePrinted([])).toBeNull();
	});
	it("votes the rarity like the other fields", () => {
		const read = (rarity: string | null) => ({ number: "4", set: "tspm", lang: "fr", rarity });
		expect(combinePrinted([read("T"), read(null), read("T")])?.rarity).toBe("T");
		expect(combinePrinted([read("T"), read("C"), read("C")])?.rarity).toBe("C"); // a letter read twice wins over the first read
		expect(combinePrinted([read(null), read("T")])?.rarity).toBe("T"); // reads that found no letter carry no vote
		expect(combinePrinted([read(null), read(null)])?.rarity).toBeNull();
	});
});
