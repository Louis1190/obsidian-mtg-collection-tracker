// The reading strategy: in which order to read the strips of a card, how a card gathers EVIDENCE from the readings, and when to stop. Pure.
//
// What measurement said (17 real photos, docs/history/card-recognition-spike.md; the settings below were tuned on those same photos, so say so):
//  - one TALL strip read as sparse text finds the title wherever the finder's frame put it, in at most 10 readings (2 ways up x 5 variants); it reads
//    10 of 17 photos (mean 6.6 readings) and also finds a card whose big name is a flavor name, by the small real name printed under it;
//  - the title strip at six heights, which matters to about 1 % of the card's height, reads the others, at up to 60 more readings;
//  - taking each card's BEST score lets chance in (a short name read by luck scores 1.00): a card must gather evidence from SEVERAL readings.
//
// A reading proposes cards; a card's evidence adds up what each reading gives it, ev = (score - 0.72) / 0.28 clipped to 0..1 (an exact name is
// worth 1, a doubtful one little). The reader stops as soon as the best card has `stop` evidence, leads the second by `margin` and was proposed by
// `minReads` readings; when the plan runs out, the best card is proposed if it has `minEvidence`. Nothing is added automatically: the person confirms.

import { buildNameIndex, matchLine, normalizeName, semiGlobal, trimNoiseWords, type NameIndex } from "./name-match";
import { STRIP_VARIANTS, TALL_STRIP, TITLE_STRIP, type Channel, type StripOptions, type StripVariant } from "./strips";

export const READING_CONFIG = {
	stop: 1, // evidence the best card needs to stop the reading...
	margin: 0.5, // ...with this much lead on the second...
	minReads: 2, // ...and proposed by at least this many readings (a perfect name read ONCE by chance does not decide: measured, "Penance" at 1.00)
	minEvidence: 1.0, // when the plan runs out: the best card is proposed only with this much (1.0: 12 of 17 right, 0 wrong; 0.5: 13 right, 1 wrong)
	minKeyLength: 6, // a name shorter than this, once normalised, is a common word (the faces "Give", "Take", "Hide"...): never trusted (loses "Opt", "Fog")
	minLineHeight: 45, // pixels in a 1100 px wide strip: a title is tall, rules text and small print are not
	minScore: 0.75, // the matcher's own floor for a name found in a line
	topPerLine: 3,
};

/**
 * What changes when a title is read among the cards of ONE SET (the one the corner of the photo names) instead of among every card: a few hundred names can bear a short word (the
 * French "Choc", 4 letters, was refused by `minKeyLength` 6 and the corner pointed at another card, 86 read for 88), so the minimum length drops to 3; and a line must be
 * (almost) the name (0.85: for a name under 7 letters, exactly it), since a short name accepted at 0.75 would match noise. Measured offline on 28 real photos (76 readings each) with the
 * cards of their sets: "Choc" is found at the 3rd reading where nothing was found; 0 false answers among 60 runs against other sets' cards, and 0 among the 96 catalogue names of
 * up to 4 letters taken as one list (docs/history/card-recognition-spike.md, Round 7).
 */
export const SET_SCOPE_OVERRIDES = { minKeyLength: 3, minScore: 0.85 };

/**
 * The reader of names of 3 to 5 letters (Swamp, Fog, Opt, Shock, Bayou, Taiga...), over an index of ONLY those names: a line must BE the name (0.85 is one slip for a name of seven letters or more, so
 * for these none), after `trimNoiseLines`, and THREE readings must say so (evidence 3, three readings). A single exact short word in a reading of noise is common: one reading alone decided wrongly on
 * 4 of 89 photos of other cards ("Soar" on a Birchlore Rangers, "Shock" on a Common Crook), and two readings can be two variants of the same strip. Measured on the recorded readings of 154 photos
 * (every reading of the plan, the colour ones included): 65 of short-named cards (60 Scryfall scans of 30 cards, flat and realistic, Fog and Opt of the first set of old cards, one real photo of Shock) and 89 of other cards
 * (66 old ones, 28 real photos): the right card on 25 of the 65 (on the others the title is not read at all, by any reader), a wrong card on none of the 89, at every setting from two readings to four.
 * docs/history/card-recognition-spike.md, "Noms courts".
 */
export const SHORT_NAME_CONFIG = { ...READING_CONFIG, minKeyLength: 3, minScore: 0.85, stop: 3, minReads: 3 };

/** The lines of a reading without the small words around them (`trimNoiseWords`), for the short-name reader. */
export function trimNoiseLines(lines: readonly ReadLine[]): ReadLine[] {
	return lines.map((l) => ({ ...l, text: trimNoiseWords(l.text) }));
}

/** A line the OCR read, with its box in the strip (only the height is used). */
export interface ReadLine {
	text: string;
	y0: number;
	y1: number;
}

export interface ReadStep {
	/** "tall": one tall strip read as sparse text (Tesseract's PSM 11); "strip": the title strip at one height read as one line (PSM 7) */
	kind: "tall" | "strip";
	psm: 7 | 11;
	roll: 0 | 2;
	variant: StripVariant;
	/** what the strip is cut from: the luminance, or one colour channel of the photo */
	channel: Channel;
	/** what to hand to `extractStrip` */
	strip: StripOptions;
}

/** Heights of the title strip, in shares of the card's height relative to its default position, in the order they are worth trying. */
export const STRIP_SHIFTS = [-0.005, -0.02, -0.035, -0.05, -0.065, 0.01];

/**
 * The first this many title-strip heights (STRIP_SHIFTS in order: the ones worth trying first) are ALSO read through each colour channel, `COLOUR_ORDER`, after the luminance readings
 * of the same way up. Measured on 66 photos of 33 pre-2015 cards (every reading recorded, replayed through the reader, docs/history/card-recognition-spike.md, "Les couleurs"): the
 * titles of the 1993 frames (dark text on a coloured bar) that the luminance could not read were read by the red and blue channels (14 and 13 readings of the true name, green 6, luminance 1);
 * right card first 53 -> 60, wrong card 0 -> 0, no answer 12 -> 6, a photo that fails takes 115 readings (32 s) instead of 70 (22 s). Not the tall strip: the one wrong card the colours made was
 * a single green reading of it, and a tall reading costs four title readings. The green channel alone was worse than all three (2 wrong cards).
 */
export const COLOUR_STRIPS = 3;
export const COLOUR_ORDER: readonly Channel[] = ["B", "R", "G"];

/**
 * Every strip to read, in order: the tall strip first, then the title strip at each height; for each, the five variants of the luminance the right way up, then (the first `COLOUR_STRIPS`
 * heights only) the five variants of each colour channel, then the same upside down. 160 readings at most.
 */
export function readingPlan(): ReadStep[] {
	const steps: ReadStep[] = [];
	const windows: { kind: ReadStep["kind"]; psm: 7 | 11; strip: StripOptions; colours: boolean }[] = [
		{ kind: "tall", psm: 11, strip: { ...TALL_STRIP }, colours: false },
		...STRIP_SHIFTS.map((s, i) => ({ kind: "strip" as const, psm: 7 as const, strip: { ...TITLE_STRIP, y0: TITLE_STRIP.y0 + s, y1: TITLE_STRIP.y1 + s }, colours: i < COLOUR_STRIPS })),
	];
	for (const w of windows)
		for (const roll of [0, 2] as const) {
			for (const variant of STRIP_VARIANTS) steps.push({ kind: w.kind, psm: w.psm, roll, variant, channel: "L", strip: { ...w.strip, roll } });
			if (w.colours) for (const channel of COLOUR_ORDER) for (const variant of STRIP_VARIANTS) steps.push({ kind: w.kind, psm: w.psm, roll, variant, channel, strip: { ...w.strip, roll } });
		}
	return steps;
}

export interface Proposal {
	/** whatever identified the card in the index (a row of the catalogue) */
	owner: number;
	/** the normalised name that scored best for it (which language's name was read: catalogue.ts `matchedLanguage`) */
	key: string;
	evidence: number;
	/** how many readings proposed it */
	reads: number;
}
export interface Decision extends Proposal {
	/** true when the stop rule was met; false when the plan ran out and this is only the best the evidence allows */
	sure: boolean;
}

const evidenceOf = (score: number): number => Math.max(0, Math.min(1, (score - 0.72) / 0.28));

export class CardReader {
	private evidence = new Map<number, number>();
	private votes = new Map<number, number>();
	private bestName = new Map<number, { key: string; score: number }>();
	private count = 0;

	constructor(
		private readonly index: NameIndex,
		private readonly cfg = READING_CONFIG,
	) {}

	/** Readings added so far. */
	get readCount(): number {
		return this.count;
	}

	/** Adds the lines of ONE reading. Returns a decision as soon as the stop rule is met, else null. */
	add(lines: readonly ReadLine[]): Decision | null {
		this.count++;
		const best = new Map<number, { key: string; score: number; partial: boolean; lineLength: number }>(); // the best score each card got on this reading, and with which name
		for (const l of lines) {
			if (l.y1 - l.y0 < this.cfg.minLineHeight) continue;
			for (const c of matchLine(l.text, this.index, this.cfg.topPerLine, this.cfg.minScore)) {
				if (c.key.length < this.cfg.minKeyLength) continue;
				const known = best.get(c.owner);
				if (!known || c.score > known.score) best.set(c.owner, { key: c.key, score: c.score, partial: c.partial === true, lineLength: c.lineLength ?? c.key.length });
			}
		}
		// a name found INSIDE a longer line is part of a longer name that contains it when that name matches the WHOLE line with fewer edits than the short name leaves letters over: "ravage"
		// (the French Havoc) leaves 10 letters of "archound ravager" unexplained, the card Arcbound Ravager needs 1 edit; "Mishra" leaves 8 letters of "Mishra Exctory", Mishra's Factory
		// needs 3. The longer name explains the line, so the short one gets nothing from it. A longer name that only matches PART of the line (a title followed by its mana cost matches
		// "Wrath of God" and, a little worse, "Wrath of Gods") or that needs as many edits as the short one leaves letters ("Wrath of Godz") does not explain it away.
		for (const [owner, hit] of Array.from(best)) {
			const leftOver = hit.lineLength - hit.key.length; // 0 or less unless the name was found INSIDE a longer line
			for (const [other, rival] of best) {
				if (other === owner || rival.partial || !rival.key.includes(hit.key)) continue;
				const edits = Math.round((1 - rival.score) * Math.max(rival.lineLength, rival.key.length));
				if (edits < leftOver) {
					best.delete(owner);
					break;
				}
			}
		}
		for (const [owner, hit] of best) {
			this.evidence.set(owner, (this.evidence.get(owner) ?? 0) + evidenceOf(hit.score));
			this.votes.set(owner, (this.votes.get(owner) ?? 0) + 1);
			const kept = this.bestName.get(owner);
			if (!kept || hit.score > kept.score) this.bestName.set(owner, hit);
		}
		const [first, ...others] = this.proposals(6);
		// the rival is a card the title tells apart from the first: a card that answers to the SAME name (a split or adventure card with a face of that name, "Mountain // Mountain") cannot be
		// told apart by any reading, so waiting for the plan to run out would not separate them: both are proposed, the first is the one that bears the name (FACE_PENALTY)
		const rival = first ? others.find((p) => p.key !== first.key) : undefined;
		if (first && first.evidence >= this.cfg.stop && first.evidence - (rival ? rival.evidence : 0) >= this.cfg.margin && first.reads >= this.cfg.minReads) return { ...first, sure: true };
		return null;
	}

	/** The plan ran out: the best card, if it has enough evidence. */
	finish(): Decision | null {
		const [first] = this.proposals(1);
		return first && first.evidence >= this.cfg.minEvidence ? { ...first, sure: false } : null;
	}

	/** The cards with evidence, best first. */
	proposals(n = 3): Proposal[] {
		return Array.from(this.evidence.entries())
			.map(([owner, evidence]) => ({ owner, key: this.bestName.get(owner)?.key ?? "", evidence, reads: this.votes.get(owner) ?? 0 }))
			.sort((a, b) => b.evidence - a.evidence)
			.slice(0, n);
	}
}

/**
 * The title of a card that something else already names (its set code and collector number, read in the corner and looked up on Scryfall): the lines of ONE reading are
 * checked against that card's own names only, so one good reading confirms it, where finding a card among 35 000 names takes several. There is no minimum name length here
 * (the title "Choc" is four letters): the card was named by something else already, and with `minScore` this high a name under six letters has to be read exactly.
 */
export const CONFIRM_CONFIG = {
	minScore: 0.85, // the matcher's score a line needs against the card's own names
	steps: 10, // the readings of the plan tried this way before the whole plan takes over: the tall strip and then the first title strip, the right way up, five variants each (a red-framed title whose tall reading gave only "(Pin" was confirmed by the first title strip, the 11th reading of the old order)
	distinctiveWord: 7, // letters: a word of the card's name this long, read within one slip, confirms it even when the rest of the line is too noisy
};

export class TitleConfirmer {
	private readonly index: NameIndex;

	/** each name's normalized form and its long words */
	private readonly words: { key: string; words: string[] }[];

	constructor(
		/** the names the title can bear, any language; every one belongs to the same card (`owner`) */
		names: readonly string[],
		private readonly owner: number,
		private readonly cfg = READING_CONFIG,
	) {
		this.index = buildNameIndex(names, names.map(() => owner));
		this.words = names.map((n) => ({ key: normalizeName(n), words: normalizeName(n).split(" ").filter((w) => w.length >= CONFIRM_CONFIG.distinctiveWord) }));
	}

	/** The best match for the card among the lines of one reading (title-sized lines only), or null. */
	check(lines: readonly ReadLine[]): { key: string; score: number } | null {
		let best: { key: string; score: number } | null = null;
		for (const l of lines) {
			if (l.y1 - l.y0 < this.cfg.minLineHeight) continue;
			for (const c of matchLine(l.text, this.index, 1, CONFIRM_CONFIG.minScore)) {
				if (c.owner !== this.owner) continue;
				if (!best || c.score > best.score) best = { key: c.key, score: c.score };
			}
		}
		return best ?? this.byDistinctiveWord(lines);
	}

	/**
	 * A long name is often read in pieces ("rhe Sackville- Raweinets", "The Sack"): no whole line scores 0.85 against it, yet "sackville" is there. The card is already named by
	 * its corner, so one long word of its name read within a slip, on a title-sized line, is enough; a short word proves nothing (any title has one) and is never taken.
	 */
	private byDistinctiveWord(lines: readonly ReadLine[]): { key: string; score: number } | null {
		for (const l of lines) {
			if (l.y1 - l.y0 < this.cfg.minLineHeight) continue;
			const text = normalizeName(l.text);
			for (const name of this.words) for (const word of name.words) if (semiGlobal(word, text) <= 1) return { key: name.key, score: CONFIRM_CONFIG.minScore };
		}
		return null;
	}
}
