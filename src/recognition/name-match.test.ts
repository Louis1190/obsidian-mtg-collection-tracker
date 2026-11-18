import { describe, expect, it } from "vitest";
import { buildNameIndex, FACE_PENALTY, levenshtein, matchLine, matchText, normalizeName, PARTIAL_MAX_EXTRA, semiGlobal, trimNoiseWords } from "./name-match";

const NAMES = [
	"Lightning Bolt", "Lightning Helix", "Lightning Greaves", "Urza's Saga", "Urza's Tower", "Æther Vial",
	"Delver of Secrets // Insectile Aberration", "Fog", "Black Lotus", "Blacker Lotus", "Jace, the Mind Sculptor", "Jace, Vryn's Prodigy",
	"Sol Ring", "Sword of Fire and Ice", "Sword of Feast and Famine", "Dark Ritual",
];
const index = buildNameIndex(NAMES, NAMES.map((_, i) => i));
const top = (text: string) => {
	const m = matchText(text.split("\n"), index, { top: 3, minScore: 0.75 })[0];
	return m ? NAMES[m.owner] : null;
};

describe("normalizeName", () => {
	it("drops accents, apostrophes and case, turns every other symbol into a space", () => {
		expect(normalizeName("Brûlure des âmes")).toBe("brulure des ames");
		expect(normalizeName("Urza's Saga")).toBe("urzas saga");
		expect(normalizeName("Jace, the Mind Sculptor")).toBe("jace the mind sculptor");
		expect(normalizeName("Æther Vial")).toBe("aether vial");
		expect(normalizeName("  Fire // Ice ")).toBe("fire ice");
	});
});

describe("distances", () => {
	it("levenshtein counts edits and stops at max + 1", () => {
		expect(levenshtein("kitten", "sitting", 10)).toBe(3);
		expect(levenshtein("abcdef", "uvwxyz", 2)).toBe(3);
		expect(levenshtein("same", "same", 0)).toBe(0);
	});
	it("semiGlobal finds a whole pattern inside any substring, free text around it", () => {
		expect(semiGlobal("bolt", "xx lightning bolt yy")).toBe(0);
		expect(semiGlobal("bolt", "xx lightning bolx yy")).toBe(1);
	});
});

describe("matching the kinds of mistakes an OCR makes", () => {
	it("an exact name scores 1", () => {
		const a = matchText(["Lightning Bolt"], index, { top: 3, minScore: 0.75 });
		expect(NAMES[a[0].owner]).toBe("Lightning Bolt");
		expect(a[0].score).toBe(1);
	});
	it("tolerates a wrong letter and a digit, a dropped apostrophe, case, a comma kept or lost", () => {
		expect(top("Lightnlng Bo1t")).toBe("Lightning Bolt");
		expect(top("Urzas Saga")).toBe("Urza's Saga");
		expect(top("\n~ LIGHTNING BOLT |\nInstant\n")).toBe("Lightning Bolt");
		expect(top("Jace the Mind Sculptor")).toBe("Jace, the Mind Sculptor");
		expect(top("AEther Vial")).toBe("Æther Vial");
	});
	it("finds a name among rules text, followed by noise (a mana cost read as letters) or preceded by it", () => {
		expect(top("Sol Ring\nT: Add CC.\nSome flavor text here")).toBe("Sol Ring");
		expect(top("| Jace the Mind Sculptor —_O4")).toBe("Jace, the Mind Sculptor");
		expect(top("ee Sword of Fire and Ice")).toBe("Sword of Fire and Ice");
	});
	it("a photo shows ONE face of a double-faced card, and finds the card", () => {
		expect(top("Delver of Secrets")).toBe("Delver of Secrets // Insectile Aberration");
	});
	it("keeps two names a few letters apart apart", () => {
		expect(top("Sword of Fire and Ice")).toBe("Sword of Fire and Ice");
		expect(top("Sword of Feast and Famine")).toBe("Sword of Feast and Famine");
	});
	it("refuses a short name inside noise, garbage, an empty line and a line too short", () => {
		expect(top("xx fog yy qq")).toBeNull();
		expect(top("xqzv pl wk")).toBeNull();
		expect(top("")).toBeNull();
		expect(top("ab")).toBeNull();
	});
});

describe("an index of several languages", () => {
	// owner 0: Soul Burn, in English and French; owner 1: Stone Rain; owner 2 and 3: two cards that share a localized name
	const strings = ["Soul Burn", "Brûlure des âmes", "Stone Rain", "Marais", "Marais"];
	const owners = [0, 0, 1, 2, 3];
	const idx = buildNameIndex(strings, owners);

	it("finds a card by its French name as an OCR reads it (accents lost, a letter wrong)", () => {
		const m = matchLine("Bralure des Ames", idx, 3, 0.75);
		expect(m[0].owner).toBe(0);
		expect(m[0].score).toBeCloseTo(1 - 1 / 16, 5);
	});
	it("proposes a card once, with the best score of any of its names", () => {
		const m = matchText(["Soul Burn", "Brulure des ames"], idx);
		expect(m.filter((x) => x.owner === 0)).toHaveLength(1);
		expect(m[0].score).toBe(1);
	});
	it("proposes a double-faced card once even when its combined name and each face match the same line", () => {
		const dfc = buildNameIndex(["Delver of Secrets // Insectile Aberration"], [7]);
		const m = matchLine("Delver of Secrets Insectile Aberration", dfc, 5, 0.75);
		expect(m).toHaveLength(1);
		expect(m[0].owner).toBe(7);
		expect(m[0].score).toBe(1);
	});
	it("proposes both cards when two share a name", () => {
		const m = matchLine("Marais", idx, 3, 0.75);
		expect(m.map((x) => x.owner).sort()).toEqual([2, 3]);
	});
	it("gives the same answer when asked twice (the scratch counters are reset)", () => {
		const a = matchLine("Brulure des ames", idx, 3, 0.75);
		const b = matchLine("Brulure des ames", idx, 3, 0.75);
		expect(b).toEqual(a);
	});
	it("tells a caller the length of the name that matched, to distrust a short one", () => {
		expect(matchLine("Marais", idx, 3, 0.75)[0].key).toBe("marais");
	});
});

describe("a name found inside a longer line", () => {
	const idx = buildNameIndex(["Mishra", "Mishra's Factory", "Wasteland", "Prepare // Fight"], [0, 1, 2, 3]);
	const owners = (line: string) => matchLine(line, idx, 5, 0.75).map((m) => m.owner);

	it("is flagged as partial, and a line that is the whole name is not", () => {
		expect(matchLine("Wasteland gp ee fae", idx, 3, 0.75)[0].partial).toBe(true);
		expect(matchLine("Wasteland", idx, 3, 0.75)[0].partial).toBe(false);
	});

	it("is found when the line carries a mana cost or a little frame noise after it", () => {
		expect(owners("Wasteland gp ee fae")).toContain(2); // 10 letters of noise after a 9 letter name
		expect(owners("Mishra 2 U")).toContain(0);
	});

	it("is NOT found when the line carries more than twice the name's length of other text: it is the start of something longer (Mishra's Factory read in pieces)", () => {
		const line = "Mishra: ras Ea oc oO ees"; // 17 letters after a 6 letter name
		expect(normalizeName(line).length - "mishra".length).toBeGreaterThan(PARTIAL_MAX_EXTRA * "mishra".length);
		expect(owners(line)).not.toContain(0);
	});

	it("keeps its full score while the rest of the line is no longer than the name itself", () => {
		const free = matchLine("wasteland 2 u", idx, 1, 0.5)[0]; // 4 letters after a 9 letter name
		expect(free.partial).toBe(true);
		expect(free.score).toBeCloseTo(0.98, 6); // 1 - 0 edits - 0.02: no penalty for extra text yet
	});

	it("loses score gradually between one and two times its length", () => {
		const exactEnd = matchLine("wasteland", idx, 1, 0.5)[0].score;
		const noisy = matchLine("wasteland gp ee fae", idx, 1, 0.5)[0].score; // 10 extra for 9: just over one name's length
		const noisier = matchLine("wasteland gp ee fae hk lm n", idx, 1, 0.5)[0].score; // 18 extra: twice the length
		expect(exactEnd).toBeGreaterThan(noisy);
		expect(noisy).toBeGreaterThan(noisier);
	});
});

describe("the faces of an A // B card", () => {
	const idx = buildNameIndex(["Swords to Plowshares", "Emeritus of Truce // Swords to Plowshares", "Mountain", "Mountain // Mountain"], [0, 1, 2, 3]);

	it("lose a tie against the card that bears the name: the title 'Swords to Plowshares' is that card's, only half of the adventure card", () => {
		const m = matchLine("Swords to Plowshares", idx, 3, 0.75);
		expect(m.map((x) => x.owner)).toEqual([0, 1]);
		expect(m[0].score - m[1].score).toBeCloseTo(FACE_PENALTY, 6);
		expect(m[0].face).toBe(false);
		expect(m[1].face).toBe(true);
		expect(matchLine("Mountain", idx, 3, 0.75).map((x) => x.owner)).toEqual([2, 3]);
	});

	it("still win when nothing else bears the name: the title of an adventure card is its first face", () => {
		const m = matchLine("Emeritus of Truce", idx, 3, 0.75);
		expect(m[0].owner).toBe(1);
		expect(m[0].face).toBe(true);
	});
});

describe("trimNoiseWords", () => {
	it("takes the mana cost the OCR read off the end of a title, and a frame mark off its start", () => {
		expect(trimNoiseWords("Swamp U")).toBe("swamp");
		expect(trimNoiseWords("Fog G")).toBe("fog");
		expect(trimNoiseWords("i Opt 1U")).toBe("opt");
		expect(trimNoiseWords("Shock {R}")).toBe("shock"); // the symbols normalise to nothing
	});
	it("takes at most two small words from each end, and never the last word that is left", () => {
		expect(trimNoiseWords("a b c Swamp d e f")).toBe("c swamp d");
		expect(trimNoiseWords("a b")).toBe("b"); // one word always stays
		expect(trimNoiseWords("U")).toBe("u");
		expect(trimNoiseWords("")).toBe("");
	});
	it("keeps a word of three letters or more: it is a word of the title (a name of 5 letters is not hidden in 'Fog Bank', 'Hex Parasite')", () => {
		expect(trimNoiseWords("Fog Bank")).toBe("fog bank");
		expect(trimNoiseWords("Serra Ang")).toBe("serra ang");
		expect(trimNoiseWords("Hex Parasite")).toBe("hex parasite");
	});
	it("takes the words' size as a parameter", () => {
		expect(trimNoiseWords("Fog Bank", 4)).toBe("bank"); // the leading word goes first, one word always stays
		expect(trimNoiseWords("Swamp U", 0)).toBe("swamp u");
	});
});
