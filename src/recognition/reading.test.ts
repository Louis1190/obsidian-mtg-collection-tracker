import { describe, expect, it } from "vitest";
import { buildNameIndex } from "./name-match";
import { CardReader, COLOUR_STRIPS, READING_CONFIG, readingPlan, SHORT_NAME_CONFIG, trimNoiseLines, type ReadLine, TitleConfirmer } from "./reading";

// owners: 0 Soul Burn / Brûlure des âmes, 1 Goblin Spy / Espion gobelin, 2 Penance / Pénitence, 3 Fog (short), 4 Rough Rhino Cavalry
const index = buildNameIndex(
	["Soul Burn", "Brûlure des âmes", "Goblin Spy", "Espion gobelin", "Penance", "Pénitence", "Fog", "Rough Rhino Cavalry", "Cavalerie des Rhinos féroces"],
	[0, 0, 1, 1, 2, 2, 3, 4, 4],
);
const tall = (text: string): ReadLine => ({ text, y0: 100, y1: 170 }); // a 70 px line: a title
const small = (text: string): ReadLine => ({ text, y0: 100, y1: 128 }); // a 28 px line: rules text

describe("CardReader", () => {
	it("does not decide on a single reading, however good, and decides when a second one agrees", () => {
		const r = new CardReader(index);
		expect(r.add([tall("Brûlure des âmes")])).toBeNull();
		const d = r.add([tall("Brulure des ames")]);
		expect(d).not.toBeNull();
		expect(d!.owner).toBe(0);
		expect(d!.sure).toBe(true);
		expect(d!.reads).toBe(2);
		expect(r.readCount).toBe(2);
	});

	it("gathers evidence from doubtful readings until it is enough", () => {
		const r = new CardReader(index);
		// "Bralure des Ames" scores 0.94 (one letter wrong): evidence 0.79 a time
		expect(r.add([tall("Bralure des Ames")])).toBeNull();
		const d = r.add([tall("Bralure des Ames")]);
		expect(d?.owner).toBe(0);
		expect(d!.evidence).toBeGreaterThan(1.5);
	});

	it("is not decided by a perfect name read ONCE by chance: the card read again and again wins", () => {
		const r = new CardReader(index);
		expect(r.add([tall("Penance")])).toBeNull(); // 1.00 but one reading, and nothing else
		expect(r.add([tall("Goblin Spy")])).toBeNull();
		expect(r.add([tall("Espion gobelin")])?.owner).toBe(1); // the card of two readings leads by more than the margin
	});

	it("waits for a lead over the second card", () => {
		const r = new CardReader(index);
		r.add([tall("Soul Burn")]);
		r.add([tall("Soul Burn")]); // would decide here...
		const c = new CardReader(index);
		c.add([tall("Soul Burn"), tall("Goblin Spy")]);
		expect(c.add([tall("Soul Burn"), tall("Goblin Spy")])).toBeNull(); // ...but two cards tie: no lead
		expect(c.add([tall("Soul Burn")])?.owner).toBe(0); // and it comes when one pulls ahead
	});

	it("counts a card once per reading, even when several lines of that reading propose it", () => {
		const r = new CardReader(index);
		r.add([tall("Bralure des Ames"), tall("Bralure des Ames"), tall("Brulure des Ames")]); // 0.94, 0.94, 1.00: the best counts, they do not add up
		const [p] = r.proposals();
		expect(p.reads).toBe(1);
		expect(p.evidence).toBeCloseTo(1, 5);
		const q = new CardReader(index);
		q.add([tall("Bralure des Ames"), tall("Bralure des Ames")]);
		expect(q.proposals()[0].evidence).toBeLessThan(0.8); // not 2 x 0.78 clipped to 1
	});

	it("remembers which name of a card scored best, to tell the language read", () => {
		const r = new CardReader(index);
		r.add([tall("Bralure des Ames")]); // the French name, one letter off: 0.94
		r.add([tall("Soul Burn")]); // the English name, exact
		expect(r.proposals(1)[0].key).toBe("soul burn");
		const q = new CardReader(index);
		q.add([tall("Brulure des ames")]);
		q.add([tall("Soul Burm")]); // 0.89
		expect(q.proposals(1)[0].key).toBe("brulure des ames");
	});

	it("never trusts a short name, however exact: a common word", () => {
		const r = new CardReader(index);
		for (let i = 0; i < 5; i++) expect(r.add([tall("Fog")])).toBeNull();
		expect(r.proposals()).toEqual([]);
		expect(r.finish()).toBeNull();
	});

	it("ignores a line that is too small to be a title (rules text, small print)", () => {
		const r = new CardReader(index);
		r.add([small("Brulure des ames")]);
		r.add([small("Brulure des ames")]);
		expect(r.proposals()).toEqual([]);
		r.add([{ text: "Brulure des ames", y0: 0, y1: READING_CONFIG.minLineHeight }]); // exactly the minimum counts
		expect(r.proposals()[0].owner).toBe(0);
	});

	it("when the plan runs out, proposes the best card only if it has enough evidence, and says it was not sure", () => {
		const weak = new CardReader(index);
		weak.add([tall("Bralure des Ames")]); // evidence 0.79 only
		expect(weak.finish()).toBeNull();
		// two cards read twice each, neither leading by the margin: the stop rule never fires, but the evidence is there
		const tie = new CardReader(index);
		expect(tie.add([tall("Bralure des Ames"), tall("Goblin Spy")])).toBeNull();
		expect(tie.add([tall("Bralure des Ames"), tall("Goblin Spy")])).toBeNull();
		const d = tie.finish();
		expect(d?.owner).toBe(1);
		expect(d?.sure).toBe(false);
		expect(d!.evidence).toBeGreaterThanOrEqual(READING_CONFIG.minEvidence);
	});

	it("lists the cards with evidence, best first, with how many readings proposed each", () => {
		const r = new CardReader(index);
		r.add([tall("Soul Burn"), tall("Goblin Spy")]);
		r.add([tall("Soul Burn")]);
		const p = r.proposals(3);
		expect(p.map((x) => x.owner)).toEqual([0, 1]);
		expect(p[0].reads).toBe(2);
		expect(p[1].reads).toBe(1);
		expect(r.proposals(1)).toHaveLength(1);
	});
});

describe("readingPlan", () => {
	const plan = readingPlan();
	const luminance = plan.filter((s) => s.channel === "L");
	it("is 160 readings: the 70 of the luminance (seven windows x two ways up x five variants) and 90 through the colour channels", () => {
		expect(plan).toHaveLength(160);
		expect(luminance).toHaveLength(70);
		expect(new Set(plan.map((s) => `${s.strip.y0}|${s.roll}|${s.variant}|${s.channel}`)).size).toBe(160);
		expect(new Set(luminance.map((s) => `${s.strip.y0}|${s.roll}|${s.variant}`)).size).toBe(70);
	});
	it("starts with the tall strip, the right way up, as sparse text, with the variants that cover most photos first", () => {
		expect(plan[0]).toMatchObject({ kind: "tall", psm: 11, roll: 0, variant: "asis", channel: "L" });
		expect(plan[1].variant).toBe("thabs");
		expect(plan.slice(0, 10).every((s) => s.kind === "tall" && s.psm === 11 && s.channel === "L")).toBe(true);
		expect(plan[5].roll).toBe(2); // then the same strip upside down
	});
	it("reads the title strip as one line (PSM 7) at the six heights, each way up", () => {
		const strips = luminance.filter((s) => s.kind === "strip");
		expect(strips).toHaveLength(60);
		expect(strips.every((s) => s.psm === 7)).toBe(true);
		expect(new Set(strips.map((s) => s.strip.y0!.toFixed(3))).size).toBe(6);
		expect(plan.every((s) => s.strip.roll === s.roll)).toBe(true);
	});
	it("reads the first three title-strip heights through blue, red and green too, never the tall strip and never the later heights", () => {
		const coloured = plan.filter((s) => s.channel !== "L");
		expect(coloured).toHaveLength(90);
		expect(coloured.every((s) => s.kind === "strip" && s.psm === 7)).toBe(true);
		expect(new Set(coloured.map((s) => s.strip.y0!.toFixed(3))).size).toBe(COLOUR_STRIPS);
		const heights = Array.from(new Set(plan.filter((s) => s.kind === "strip").map((s) => s.strip.y0!)));
		expect(new Set(coloured.map((s) => s.strip.y0))).toEqual(new Set(heights.slice(0, COLOUR_STRIPS))); // the first three of the plan's own order
		expect(new Set(coloured.map((s) => s.channel))).toEqual(new Set(["B", "R", "G"]));
		expect(coloured.filter((s) => s.roll === 0)).toHaveLength(45); // both ways up
		expect(coloured.filter((s) => s.roll === 2)).toHaveLength(45);
	});
	it("puts, for each such height, the luminance the right way up, then blue, red, green, then the same upside down, five variants each", () => {
		const first = plan.filter((s) => s.kind === "strip" && s.strip.y0 === plan[10].strip.y0);
		expect(first.map((s) => `${s.roll}${s.channel}`)).toEqual([
			...Array(5).fill("0L"), ...Array(5).fill("0B"), ...Array(5).fill("0R"), ...Array(5).fill("0G"),
			...Array(5).fill("2L"), ...Array(5).fill("2B"), ...Array(5).fill("2R"), ...Array(5).fill("2G"),
		]);
		expect(first.slice(0, 5).map((s) => s.variant)).toEqual(["asis", "thabs", "inv", "thlight", "thdark"]);
		expect(plan[10]).toMatchObject({ channel: "L", roll: 0 });
		expect(plan[15]).toMatchObject({ channel: "B", roll: 0, variant: "asis" });
	});
	it("keeps the first ten readings, the ones that confirm a card the corner named, exactly as before: the luminance, the right way up", () => {
		const rightWayUp = plan.filter((s) => s.roll === 0);
		expect(rightWayUp.slice(0, 10).every((s) => s.channel === "L")).toBe(true);
		expect(rightWayUp.slice(0, 5).every((s) => s.kind === "tall")).toBe(true);
		expect(rightWayUp.slice(5, 10).every((s) => s.kind === "strip")).toBe(true);
	});
});

describe("TitleConfirmer", () => {
	const line = (text: string, height = 70): ReadLine => ({ text, y0: 100, y1: 100 + height });
	const meower = () => new TitleConfirmer(["Masked Meower", "Miauleur masqué"], 7);

	it("confirms a title-sized line that is the card's name, in either language, and says which name matched", () => {
		expect(meower().check([line("Masked Meower")])).toMatchObject({ key: "masked meower", score: 1 });
		expect(meower().check([line("Miauleur masqué")])?.key).toBe("miauleur masque");
		expect(meower().check([line("Miauleur masque")])?.key).toBe("miauleur masque"); // no accent, as the OCR often reads it
	});

	it("tolerates the OCR's small slips in a long name, and refuses a different card's name", () => {
		expect(meower().check([line("Masked Meowcr")])).not.toBeNull();
		expect(meower().check([line("Masked Mower and Cats")])).not.toBeNull(); // a slip, and more on the line (a mana cost read as letters)
		expect(meower().check([line("Goblin Spy")])).toBeNull();
		expect(meower().check([line("Masked Mixer")])).toBeNull(); // too far from the name
		expect(meower().check([])).toBeNull();
	});

	it("only looks at title-sized lines: the card's own name in its rules text does not confirm it", () => {
		expect(meower().check([line("Masked Meower", 20)])).toBeNull();
		expect(meower().check([line("Masked Meower", 20), line("Masked Meower", 70)])).not.toBeNull();
	});

	it("takes the best of the lines", () => {
		const hit = meower().check([line("Masked Meowcr"), line("Masked Meower")]);
		expect(hit?.score).toBe(1);
	});

	it("confirms a long name read in pieces by one of its long words, and never by a short word or a word two slips off", () => {
		const sack = new TitleConfirmer(["The Sackville-Bagginses", "Les Sacquet de Besace"], 9);
		expect(sack.check([line("rhe Sackville- Raweinets")])?.key).toBe("the sackville bagginses"); // no whole line scores 0.85, the word "sackville" is there
		expect(sack.check([line("a ~Z ial > The Sackvile Bag")])?.key).toBe("the sackville bagginses"); // one letter dropped
		expect(sack.check([line("The Sack")])).toBeNull(); // the start of the name: "sack" is a short word, and "the" shorter
		expect(sack.check([line("The Rack of Pain")])).toBeNull();
		expect(sack.check([line("Sxckvxlle-Bxgginsxs")])).toBeNull(); // two slips in each word
		expect(sack.check([line("Sacquet de Besace")])?.key).toBe("les sacquet de besace"); // another language: "sacquet" has seven letters
		expect(sack.check([line("The Sackville-Bagginses", 20)])).toBeNull(); // rules-text height: not a title
	});

	it("accepts a name shorter than the usual minimum, but only read exactly: one letter off is too far for four or five letters", () => {
		const shock = new TitleConfirmer(["Shock", "Choc"], 3);
		expect(shock.check([line("Choc")])?.key).toBe("choc");
		expect(shock.check([line("Shock")])?.key).toBe("shock");
		expect(shock.check([line("Shock absorber supreme")])).toBeNull(); // the name inside a longer line
		expect(shock.check([line("Chock")])).toBeNull(); // one letter off: fine for a long name, not for a short one
		expect(shock.check([line("Shocks")])).toBeNull();
		expect(shock.check([line("Choc R")])).toBeNull();
	});
});

describe("CardReader, names that explain each other", () => {
	// owners: 0 Arcbound Ravager, 1 Havoc / Ravage (a French name inside "Ravager"), 2 Swords to Plowshares, 3 Emeritus of Truce // Swords to Plowshares, 4 Wrath of God, 5 Wrath of Gods
	const idx = buildNameIndex(
		["Arcbound Ravager", "Havoc", "Ravage", "Swords to Plowshares", "Emeritus of Truce // Swords to Plowshares", "Wrath of God", "Wrath of Gods"],
		[0, 1, 1, 2, 3, 4, 5],
	);

	it("gives a name found INSIDE a longer name that matched the same reading nothing: 'Ravage' is part of 'Arcbound Ravager'", () => {
		const r = new CardReader(idx);
		r.add([tall("Archound Ravager")]);
		const d = r.add([tall("Arcbound Ravager ae")]);
		expect(d?.owner).toBe(0);
		expect(r.proposals(3).map((p) => p.owner)).toEqual([0]);
	});

	it("also when the longer name is read worse: 'Mishra Exctory' is Mishra's Factory, whose tail it resembles, and not the card Mishra with junk after it", () => {
		const idx2 = buildNameIndex(["Mishra", "Mishra's Factory"], [0, 1]);
		const r = new CardReader(idx2);
		r.add([tall("| Mishra Exctory")]);
		r.add([tall("| Mishra Exctory")]);
		expect(r.proposals(3).map((p) => p.owner)).toEqual([1]);
	});

	it("keeps the short name when the longer one did not match: 'Ravage' read alone is still Havoc", () => {
		const r = new CardReader(idx);
		r.add([tall("Ravage")]);
		const d = r.add([tall("Ravage")]);
		expect(d?.owner).toBe(1);
	});

	it("is not stopped by a card that answers to the SAME name: a split or adventure card with a face of that name cannot be told apart, both are proposed, the one that bears the name first", () => {
		const r = new CardReader(idx);
		expect(r.add([tall("Swords to Plowshares")])).toBeNull();
		const d = r.add([tall("Swords to Plowshares")]);
		expect(d?.sure).toBe(true);
		expect(d?.owner).toBe(2);
		expect(r.proposals(3).map((p) => p.owner)).toEqual([2, 3]);
	});

	it("does not let a doubtful longer name erase a clean title followed by its mana cost: 'Wrath of God 2WW' is Wrath of God, not Wrath of Gods", () => {
		const r = new CardReader(idx);
		r.add([tall("Wrath of God 2WW")]);
		const d = r.add([tall("Wrath of God 2WW")]);
		expect(d?.owner).toBe(4);
	});

	it("is still held back by a card with ANOTHER name that is nearly as good: 'Wrath of Godz' is one slip from both", () => {
		const r = new CardReader(idx);
		r.add([tall("Wrath of Godz")]);
		expect(r.add([tall("Wrath of Godz")])).toBeNull();
		expect(r.proposals(2).map((p) => p.owner)).toEqual([4, 5]);
	});
});

describe("the reader of short names", () => {
	// owners: 0 Swamp, 1 Fog, 2 Shock / Choc
	const idx = buildNameIndex(["Swamp", "Fog", "Shock", "Choc"], [0, 1, 2, 2]);
	const reader = () => new CardReader(idx, SHORT_NAME_CONFIG);

	it("takes a name of three letters, which the whole-catalogue reader never does", () => {
		const whole = new CardReader(idx);
		for (let i = 0; i < 5; i++) expect(whole.add([tall("Fog")])).toBeNull();
		expect(whole.proposals(3)).toEqual([]);
		const r = reader();
		expect(r.add([tall("Fog")])).toBeNull();
		expect(r.add([tall("Fog")])).toBeNull();
		expect(r.add([tall("Fog")])).toMatchObject({ owner: 1, sure: true, reads: 3 });
	});

	it("does not decide on one reading, nor on two: a lone exact short word in noise is common", () => {
		const r = reader();
		expect(r.add([tall("Shock")])).toBeNull();
		expect(r.add([tall("Shock")])).toBeNull();
		expect(SHORT_NAME_CONFIG.minReads).toBe(3);
		expect(SHORT_NAME_CONFIG.stop).toBe(3);
	});

	it("wants the whole line, not a slip: 'Swomp' and 'Shok' are not the names", () => {
		const r = reader();
		for (let i = 0; i < 6; i++) expect(r.add([tall("Swomp"), tall("Shok")])).toBeNull();
		expect(r.proposals(3)).toEqual([]);
	});

	it("takes the readings of any strip together, in whatever order, and a French name for the same card", () => {
		const r = reader();
		r.add([tall("Shock")]);
		r.add([tall("Choc")]);
		expect(r.add([tall("Shock")])).toMatchObject({ owner: 2, reads: 3 });
	});

	it("reads through the small words around a title once they are taken off (the mana cost read as 'U')", () => {
		const r = reader();
		r.add(trimNoiseLines([tall("Swamp U")]));
		r.add(trimNoiseLines([tall("i Swamp 2R")]));
		expect(r.add(trimNoiseLines([tall("Swamp")]))).toMatchObject({ owner: 0 });
		expect(trimNoiseLines([{ text: "Swamp U", y0: 5, y1: 90 }])).toEqual([{ text: "swamp", y0: 5, y1: 90 }]);
	});

	it("does not decide on a line too small to be a title, as the other reader", () => {
		const r = reader();
		for (let i = 0; i < 5; i++) expect(r.add([small("Fog")])).toBeNull();
	});
});
