import { describe, it, expect } from "vitest";
import { parseDecklistText } from "./decklist-import";

describe("parseDecklistText", () => {
	it("parses plain 'qty name' lines with no metadata", () => {
		const { lines, unparsedLines } = parseDecklistText("1 Sol Ring\n1 Arcane Signet\n4 Lightning Bolt");
		expect(unparsedLines).toEqual([]);
		expect(lines).toEqual([
			{ raw: "1 Sol Ring", quantity: 1, name: "Sol Ring", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
			{ raw: "1 Arcane Signet", quantity: 1, name: "Arcane Signet", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
			{ raw: "4 Lightning Bolt", quantity: 4, name: "Lightning Bolt", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
		]);
	});

	it("accepts an 'x' quantity suffix and defaults to 1 with no quantity at all", () => {
		const { lines } = parseDecklistText("1x Sol Ring\nArcane Signet");
		expect(lines[0]).toMatchObject({ quantity: 1, name: "Sol Ring" });
		expect(lines[1]).toMatchObject({ quantity: 1, name: "Arcane Signet" });
	});

	it("extracts a trailing (SET) collector number, Archidekt-style", () => {
		const { lines } = parseDecklistText("1x Sol Ring (C21) 263");
		expect(lines[0]).toMatchObject({
			quantity: 1,
			name: "Sol Ring",
			setCode: "c21",
			collectorNumber: "263",
		});
	});

	it("strips a foil marker and an Archidekt label without affecting name/set", () => {
		const { lines } = parseDecklistText("1x Sol Ring (C21) 263 *F* ^MyLabel,#ff0000^");
		expect(lines[0]).toMatchObject({ name: "Sol Ring", setCode: "c21", collectorNumber: "263" });
	});

	it("does not mistake a real parenthesized card name for a set code", () => {
		const { lines } = parseDecklistText("1 Erase (Not the Urza's Legacy One)");
		expect(lines[0]).toMatchObject({
			name: "Erase (Not the Urza's Legacy One)",
			setCode: undefined,
			collectorNumber: undefined,
		});
	});

	it("recognizes section headers and applies them to following lines until the next header", () => {
		const text = [
			"Commander",
			"1 Korvold, Fae-Cursed King",
			"",
			"Deck",
			"1 Sol Ring",
			"1 Arcane Signet",
			"",
			"Sideboard",
			"1 Some Card",
		].join("\n");
		const { lines } = parseDecklistText(text);
		expect(lines).toEqual([
			{ raw: "1 Korvold, Fae-Cursed King", quantity: 1, name: "Korvold, Fae-Cursed King", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: true },
			{ raw: "1 Sol Ring", quantity: 1, name: "Sol Ring", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
			{ raw: "1 Arcane Signet", quantity: 1, name: "Arcane Signet", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
			{ raw: "1 Some Card", quantity: 1, name: "Some Card", setCode: undefined, collectorNumber: undefined, category: "sideboard", isCommander: false },
		]);
	});

	it("recognizes a section header with a trailing count or colon", () => {
		const text = ["Deck (99)", "1 Sol Ring", "Sideboard:", "1 Some Card"].join("\n");
		const { lines } = parseDecklistText(text);
		expect(lines[0].category).toBe("mainboard");
		expect(lines[1].category).toBe("sideboard");
	});

	it("recognizes '// Commander' as a header via the comment convention", () => {
		const text = ["// Commander", "1 Korvold, Fae-Cursed King", "// Deck", "1 Sol Ring"].join("\n");
		const { lines } = parseDecklistText(text);
		expect(lines[0].category).toBe("mainboard");
		expect(lines[0].isCommander).toBe(true);
		expect(lines[1].category).toBe("mainboard");
		expect(lines[1].isCommander).toBe(false);
	});

	it("recognizes inline 'Commander:'/'SB:' prefixes without changing the section for later lines", () => {
		const text = ["Commander: Korvold, Fae-Cursed King", "1 Sol Ring", "SB: 1 Some Card", "1 Arcane Signet"].join(
			"\n"
		);
		const { lines } = parseDecklistText(text);
		expect(lines).toEqual([
			{ raw: "Commander: Korvold, Fae-Cursed King", quantity: 1, name: "Korvold, Fae-Cursed King", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: true },
			{ raw: "1 Sol Ring", quantity: 1, name: "Sol Ring", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
			{ raw: "SB: 1 Some Card", quantity: 1, name: "Some Card", setCode: undefined, collectorNumber: undefined, category: "sideboard", isCommander: false },
			{ raw: "1 Arcane Signet", quantity: 1, name: "Arcane Signet", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
		]);
	});

	it("recognizes an Archidekt [Category] bracket for the board roles it can represent", () => {
		const { lines } = parseDecklistText("1x Sol Ring (C21) 263 [Commander]\n1x Chrome Mox (MRD) 227 [Ramp]");
		expect(lines[0].category).toBe("mainboard");
		expect(lines[0].isCommander).toBe(true);
		// "[Ramp]" is not a representable board role — removed from the line,
		// category unchanged (mainboard, the default section).
		expect(lines[1].category).toBe("mainboard");
		expect(lines[1].isCommander).toBe(false);
		expect(lines[1].name).toBe("Chrome Mox");
	});

	it("a per-line bracket/prefix category overrides the current section for that line only", () => {
		const text = ["Sideboard", "1x Sol Ring [Commander]", "1 Some Card"].join("\n");
		const { lines } = parseDecklistText(text);
		expect(lines[0].category).toBe("mainboard");
		expect(lines[0].isCommander).toBe(true);
		expect(lines[1].category).toBe("sideboard");
		expect(lines[1].isCommander).toBe(false);
	});

	it("ignores blank lines and reports a line with no extractable name as unparsed", () => {
		const { lines, unparsedLines } = parseDecklistText("1 Sol Ring\n\n\n[Ramp]\n1 Arcane Signet");
		expect(lines.map((l) => l.name)).toEqual(["Sol Ring", "Arcane Signet"]);
		expect(unparsedLines).toEqual(["[Ramp]"]);
	});

	it("handles the full Archidekt export shape combining every optional element at once", () => {
		const { lines } = parseDecklistText(
			"1x Sol Ring (C21) 263 *F* [Commander] ^MyLabel,#ff0000^"
		);
		expect(lines[0]).toEqual({
			raw: "1x Sol Ring (C21) 263 *F* [Commander] ^MyLabel,#ff0000^",
			quantity: 1,
			name: "Sol Ring",
			setCode: "c21",
			collectorNumber: "263",
			category: "mainboard",
			isCommander: true,
		});
	});

	it("skips a Magic Arena 'About'/'Name …' metadata block, real-export shape", () => {
		const text = [
			"About",
			"Name [$25 Budget] My Dog and I (Voltron)",
			"",
			"Deck",
			"1 Biosynthic Burst",
			"8 Forest",
			"",
			"Sideboard",
			"1 Negate",
		].join("\n");
		const { lines, unparsedLines } = parseDecklistText(text);
		expect(unparsedLines).toEqual([]);
		expect(lines).toEqual([
			{ raw: "1 Biosynthic Burst", quantity: 1, name: "Biosynthic Burst", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
			{ raw: "8 Forest", quantity: 8, name: "Forest", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
			{ raw: "1 Negate", quantity: 1, name: "Negate", setCode: undefined, collectorNumber: undefined, category: "sideboard", isCommander: false },
		]);
	});

	it("does not swallow a real card merely because it starts with 'Name' outside an 'About' block", () => {
		const { lines } = parseDecklistText("1 Name Sticker Goblin");
		expect(lines).toEqual([
			{ raw: "1 Name Sticker Goblin", quantity: 1, name: "Name Sticker Goblin", setCode: undefined, collectorNumber: undefined, category: "mainboard", isCommander: false },
		]);
	});

	it("handles a hyphenated Moxfield collector number (secret lair/promo style)", () => {
		const { lines } = parseDecklistText("1 Breath of Darigaaz (PLST) INV-138\n1 Invigorating Surge (PLST) M21-190");
		expect(lines[0]).toMatchObject({ name: "Breath of Darigaaz", setCode: "plst", collectorNumber: "INV-138" });
		expect(lines[1]).toMatchObject({ name: "Invigorating Surge", setCode: "plst", collectorNumber: "M21-190" });
	});

	it("still extracts set/number when a card's real name contains a slash (transform/split card)", () => {
		const { lines } = parseDecklistText(
			"1 Sidequest: Play Blitzball / World Champion, Celestial Weapon (FIN) 158"
		);
		expect(lines[0]).toMatchObject({
			name: "Sidequest: Play Blitzball / World Champion, Celestial Weapon",
			setCode: "fin",
			collectorNumber: "158",
		});
	});

	describe("the 'trailing block = Commander' heuristic (headerless formats only)", () => {
		it("tags the final 1-2 lines as commander when separated by a blank line and no header exists anywhere", () => {
			const text = ["1 Sol Ring", "1 Arcane Signet", "8 Forest", "", "1 Haldan, Avid Arcanist", "1 Pako, Arcane Retriever"].join(
				"\n"
			);
			const { lines } = parseDecklistText(text);
			expect(lines.map((l) => [l.name, l.category, l.isCommander])).toEqual([
				["Sol Ring", "mainboard", false],
				["Arcane Signet", "mainboard", false],
				["Forest", "mainboard", false],
				["Haldan, Avid Arcanist", "mainboard", true],
				["Pako, Arcane Retriever", "mainboard", true],
			]);
		});

		it("tags a single trailing commander the same way", () => {
			const text = ["1 Sol Ring", "1 Arcane Signet", "", "1 Korvold, Fae-Cursed King"].join("\n");
			const { lines } = parseDecklistText(text);
			expect(lines[2]).toMatchObject({ name: "Korvold, Fae-Cursed King", category: "mainboard", isCommander: true });
		});

		it("never activates when a real section header appears anywhere in the text", () => {
			const text = ["Deck", "1 Sol Ring", "1 Arcane Signet", "", "1 Haldan, Avid Arcanist", "1 Pako, Arcane Retriever"].join(
				"\n"
			);
			const { lines } = parseDecklistText(text);
			expect(lines.every((l) => l.category === "mainboard" && !l.isCommander)).toBe(true);
		});

		it("does not misfire on a genuine trailing Sideboard of 1-2 cards under an explicit header", () => {
			const text = ["1 Sol Ring", "1 Arcane Signet", "", "Sideboard", "1 Negate"].join("\n");
			const { lines } = parseDecklistText(text);
			expect(lines.find((l) => l.name === "Negate")?.category).toBe("sideboard");
			expect(lines.find((l) => l.name === "Negate")?.isCommander).toBe(false);
		});

		it("never activates when the whole text has no blank line at all (single block)", () => {
			const { lines } = parseDecklistText("1 Sol Ring\n1 Haldan, Avid Arcanist");
			expect(lines.every((l) => l.category === "mainboard" && !l.isCommander)).toBe(true);
		});

		it("does not activate when the trailing block is larger than 2 cards", () => {
			const text = ["1 Sol Ring", "", "1 Card A", "1 Card B", "1 Card C"].join("\n");
			const { lines } = parseDecklistText(text);
			expect(lines.every((l) => l.category === "mainboard" && !l.isCommander)).toBe(true);
		});

		it("never overrides a line already explicitly tagged (inline prefix or bracket)", () => {
			const text = ["1 Sol Ring", "", "SB: 1 Negate"].join("\n");
			const { lines } = parseDecklistText(text);
			expect(lines.find((l) => l.name === "Negate")?.category).toBe("sideboard");
			expect(lines.find((l) => l.name === "Negate")?.isCommander).toBe(false);
		});

		it("ignores leading blank lines when locating the true last block", () => {
			const text = ["", "", "1 Sol Ring", "1 Arcane Signet", "", "1 Haldan, Avid Arcanist"].join("\n");
			const { lines } = parseDecklistText(text);
			expect(lines.find((l) => l.name === "Haldan, Avid Arcanist")?.isCommander).toBe(true);
			expect(lines.find((l) => l.name === "Sol Ring")?.isCommander).toBe(false);
		});
	});

	it("returns empty results for empty input", () => {
		expect(parseDecklistText("")).toEqual({ lines: [], unparsedLines: [] });
		expect(parseDecklistText("   \n  \n")).toEqual({ lines: [], unparsedLines: [] });
	});
});
