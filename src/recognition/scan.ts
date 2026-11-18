// Reading one photo: find the card, then read strips of it in the order of the reading plan until a card is sure. Pure orchestration: the OCR engine and
// the catalogue index are handed in, so it runs the same under a test with a fake engine as in the plugin with the real one.

import { findCard, type FindCardResult, type Point, type Quad } from "./card-finder";
import { matchedLanguage, type CatalogueLanguage, type CatalogueRow } from "./catalogue";
import type { NameIndex } from "./name-match";
import { combinePrinted, parsePrinted, type PrintedInfo } from "./printed";
import { CardReader, CONFIRM_CONFIG, READING_CONFIG, readingPlan, SET_SCOPE_OVERRIDES, SHORT_NAME_CONFIG, TitleConfirmer, trimNoiseLines, type Decision, type Proposal, type ReadLine, type ReadStep } from "./reading";
import { encodeBmp, extractStrip, stripVariant, toChannel, toGray, type Channel, type GrayImage } from "./strips";

/** What the OCR engine offers: read a picture (an uncompressed BMP held in memory) with a page segmentation mode, answer the lines with their boxes. */
export interface OcrReader {
	recognize(bmp: Uint8Array, psm: 6 | 7 | 11): Promise<ReadLine[]>;
}

export interface Photo {
	/** 4 values per pixel, as a canvas's ImageData.data; about 1000-1920 px on its long side is enough (the card is ~1000 px wide in a phone's photo) */
	rgba: ArrayLike<number>;
	w: number;
	h: number;
}

/** Width of the small copy the finder works on: measured on this size, and the finder's cost grows with the picture. */
export const FINDER_WIDTH = 360;

/** Box-filter downscale (the average of the pixels each new pixel covers): no canvas, so nothing here goes through `toBlob`. */
export function downscaleRgba(src: Photo, targetW: number): Photo {
	if (src.w <= targetW) return src;
	const k = src.w / targetW;
	const w = targetW;
	const h = Math.max(1, Math.round(src.h / k));
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const y0 = Math.floor(y * k);
		const y1 = Math.min(src.h, Math.max(y0 + 1, Math.floor((y + 1) * k)));
		for (let x = 0; x < w; x++) {
			const x0 = Math.floor(x * k);
			const x1 = Math.min(src.w, Math.max(x0 + 1, Math.floor((x + 1) * k)));
			let r = 0;
			let g = 0;
			let b = 0;
			for (let yy = y0; yy < y1; yy++)
				for (let xx = x0; xx < x1; xx++) {
					const i = (yy * src.w + xx) * 4;
					r += src.rgba[i];
					g += src.rgba[i + 1];
					b += src.rgba[i + 2];
				}
			const n = (y1 - y0) * (x1 - x0);
			const o = (y * w + x) * 4;
			out[o] = r / n;
			out[o + 1] = g / n;
			out[o + 2] = b / n;
			out[o + 3] = 255;
		}
	}
	return { rgba: out, w, h };
}

export interface ScanProgress {
	/** readings done so far, and the most the plan can ask for */
	reads: number;
	planned: number;
	/** milliseconds since the scan began, and the limit it was given (`ScanOptions.maxMs`): a bar that follows the wait follows the larger of reads/planned and elapsed/limit */
	elapsedMs: number;
	limitMs?: number;
	/** the cards with evidence so far, best first */
	proposals: Proposal[];
}

/** The card the corner of the photo points at, as the caller found it (Scryfall's card at the set code and number read, matched to the catalogue). */
export interface ShortcutCard {
	/** the catalogue row of that card; null when it has none (a token, a card newer than the snapshot): nothing to check the title against */
	owner: number | null;
	/** the names its title can bear, any language */
	names: string[];
}

/** The cards of the set the corner names, as an index over their names. An entry's owner is what identifies the card in the result: a row of the catalogue, or a number past its rows for a card it does not know. */
export interface SetScope {
	index: NameIndex;
}

/** Readings of the title made before the card list of the corner's set is asked for, when the corner already named a card (its confirmation usually comes within these). */
export const SET_SCOPE_START_READS = 4;

export interface ScanOptions {
	/**
	 * Asked with what the corner printed, BEFORE the title is read. A card answered with an `owner` is confirmed by the first few title readings (one good reading is enough) instead
	 * of being searched for among every name; with no `owner` the corner alone decides and no title is read. null: no such card, the whole plan runs as usual.
	 */
	shortcut?: (printed: PrintedInfo) => Promise<ShortcutCard | null>;
	/**
	 * Asked with what the corner printed, once the title has to be read without the corner's help: at once when the corner named no card, else after SET_SCOPE_START_READS
	 * readings that did not confirm it. The cards of the printed set, to read the title among them (a short name, or a number read one digit wrong, is found this way). null: no list;
	 * a rejection counts as none. The scan never waits for it: it joins the readings already made when it arrives.
	 */
	setScope?: (printed: PrintedInfo) => Promise<SetScope | null>;
	/**
	 * The index of the names of 3 to 5 letters (`shortNameIndex`), read by a reader of their own (`SHORT_NAME_CONFIG`) next to the whole-catalogue one, which refuses a name that short.
	 * Its decision comes after the others' (the corner's, the set's, the catalogue's) and only when no longer name containing it has evidence; what it has not decided is never proposed.
	 */
	shortIndex?: NameIndex;
	signal?: AbortSignal;
	onProgress?: (p: ScanProgress) => void;
	/** Called once with the card the finder found, in the pixels of the photo given, as soon as it is found (before the corner and the title are read): the panel outlines it on the photo. Not called when no card is found. */
	onQuad?: (quad: Quad) => void;
	/** stop after this many readings even if the plan is longer (a time budget in the caller's terms) */
	maxReads?: number;
	/**
	 * Stop reading the title once this many milliseconds have passed since the scan began (the finder and the corner count), whatever the plan still holds: what the cards with evidence by
	 * then are is the answer (`stoppedBy: "time"`). The reading in progress finishes first. A photo nothing can be read from would otherwise go through the whole plan (160 readings).
	 */
	maxMs?: number;
	/** The clock `maxMs` is read on, in milliseconds (`performance.now` by default; a test hands its own). */
	now?: () => number;
	config?: typeof READING_CONFIG;
}

/** What `CardRecognition.scan` takes: the scan's own options, except that the shortcut is given as a lookup of the card's English NAME (the recognition matches it to the catalogue). */
export interface RecognitionScanOptions extends Omit<ScanOptions, "shortcut" | "setScope"> {
	/** The English name of the card at the set code and number the corner printed (Scryfall), null when there is none or it cannot be asked. */
	exactName?: (printed: PrintedInfo) => Promise<string | null>;
	/** The English names of the cards of the set the corner printed (Scryfall), null when there is no such list; see ScanOptions.setScope. */
	setCards?: (printed: PrintedInfo) => Promise<string[] | null>;
}

export interface ScanResult {
	/** the card the finder found, in the pixels of the photo given; null: no card-shaped rectangle */
	quad: Quad | null;
	/** the card the reading is sure of, or the best the evidence allows once the plan ran out; null when there is none */
	decision: Decision | null;
	/** the cards with evidence, best first (up to 3): what the person is shown to pick from */
	proposals: Proposal[];
	reads: number;
	/** why it stopped: a card is sure, every strip was read, the person cancelled, or the reading budget ran out */
	stoppedBy: "sure" | "plan" | "cancelled" | "budget" | "time" | "no-card";
	finder: FindCardResult | null;
	/** what the bottom-left corner of the card prints (collector number, set code, language), when it was read: the EDITION, which the name cannot say */
	printed: PrintedInfo | null;
	/** how the card was found when the corner named it first: "confirmed" by a title reading, or "corner-only" (no title to check it against); "set-title": the title read among the cards of the corner's set (the number the corner printed pointed at another card, or the name is too short for the whole catalogue); null: the title reading found it */
	shortcut: "confirmed" | "corner-only" | "set-title" | "short-name" | null;
}

/**
 * Where a modern card prints its collector number, set code and language: the bottom-left of its black border, as shares of the QUAD's height. The finder most
 * often frames the inner coloured frame on a black-bordered card, so the text sits just BELOW its bottom edge (first window); when it framed the whole card the text
 * is higher (second). Measured on 7 real phone photos with the first window: the number read right 6 times in 7.
 */
export const PRINTED_WINDOWS = [
	{ x0: 0, x1: 0.3, y0: 0.975, y1: 1.06 },
	{ x0: 0, x1: 0.3, y0: 0.94, y1: 1.025 },
];

/**
 * The first window starting further LEFT (the quad's left edge is often inside the card's, the finder framing it skewed): the first letter of the set code ("S" of "SPM")
 * was cut off on 3 of 7 real photos and read as "PM". Read only when the first window gave a set code under 3 letters; kept apart from the first window because the extra
 * left margin lets noise in front of the number ("yvo0042") that the number's parser rightly refuses.
 */
export const WIDE_PRINTED_WINDOW = { x0: -0.06, x1: 0.3, y0: 0.975, y1: 1.06 };

/**
 * The same windows when the quad is the card's OWN edge (polarity "out"): the text is INSIDE the quad, at about 0.955 to 0.98 of
 * its height, so the windows above would read the table below the card (the first) or cut the number's line off (the second). Found on real photos of a black-bordered card alone
 * on a textured mat (2026-11-08): the corner read nothing, and the card was found by its title alone, slower and among noise.
 */
export const PRINTED_WINDOWS_OUTER = [
	{ x0: 0, x1: 0.3, y0: 0.915, y1: 1.0 },
	{ x0: 0, x1: 0.3, y0: 0.935, y1: 1.02 },
];
export const WIDE_PRINTED_WINDOW_OUTER = { x0: -0.06, x1: 0.3, y0: 0.915, y1: 1.0 };

/**
 * True when the finder's quad is the card's own edge (polarity "out"), not the frame inside its border. An inner frame the finder "extended" is NOT counted: its bottom side is
 * deduced from the width, lands a few percent above the card's bottom, and the first set of windows reads it right (measured on the 7 photos of 2026-11-07).
 */
export const isCardEdge = (found: FindCardResult): boolean => found.polarity === "out";

const scaleQuad = (q: Quad, k: number): Quad => q.map(([x, y]): Point => [x * k, y * k]) as Quad;

/**
 * The title read among the cards of the set the corner names (SET_SCOPE_OVERRIDES). It starts when its card list is asked for and never delays the scan: the list arrives while the
 * readings go on, and then every reading made so far is read through it too, so a card whose title was already read well is found at once.
 */
class SetTitleReader {
	private reader: CardReader | null = null;
	private started = false;
	private readonly seen: (readonly ReadLine[])[] = [];
	private fed = 0;

	constructor(
		private readonly ask: ((printed: PrintedInfo) => Promise<SetScope | null>) | undefined,
		private readonly cfg: typeof READING_CONFIG,
	) {}

	/** Asks for the card list of the printed set, once per scan (the corner is final by then). Never throws, never waits. */
	start(printed: PrintedInfo | null): void {
		if (!this.ask || this.started || !printed?.set) return;
		this.started = true;
		let asked: Promise<SetScope | null>;
		try {
			asked = this.ask(printed);
		} catch {
			return;
		}
		void asked.then(
			(scope) => {
				if (scope) this.reader = new CardReader(scope.index, this.cfg);
			},
			() => undefined,
		);
	}

	/** Adds the lines of one reading; answers a decision as soon as the cards of the set make one. */
	add(lines: readonly ReadLine[]): Decision | null {
		this.seen.push(lines);
		if (!this.reader) return null;
		let decision: Decision | null = null;
		while (this.fed < this.seen.length && !decision) decision = this.reader.add(this.seen[this.fed++]);
		return decision;
	}

	proposals(n = 3): Proposal[] {
		return this.reader ? this.reader.proposals(n) : [];
	}

	finish(): Decision | null {
		return this.reader ? this.reader.finish() : null;
	}
}

/** True when a card the whole-catalogue reader has evidence for has a longer name that contains the short card's name: the short name is then part of that title, not a title of its own. */
function explainedByLongerName(short: Decision, proposals: readonly Proposal[]): boolean {
	return proposals.some((p) => p.owner !== short.owner && p.evidence >= LONGER_NAME_MIN_EVIDENCE && p.key.length > short.key.length && p.key.includes(short.key));
}

/** The evidence a longer name needs to explain a short name away (see `explainedByLongerName`): a reading or two of it, not a passing guess. */
export const LONGER_NAME_MIN_EVIDENCE = 0.3;

/** The proposals of the set-scoped reader first (the corner narrowed them), then the whole-catalogue reader's, each card once, at most `n`. */
function mergeProposals(first: readonly Proposal[], second: readonly Proposal[], n = 3): Proposal[] {
	const out: Proposal[] = [];
	for (const p of [...first, ...second]) if (!out.some((o) => o.owner === p.owner)) out.push(p);
	return out.slice(0, n);
}

/**
 * Reads a photo: the card is found, its corner is read (edition), then the title. When `opts.shortcut` names the card from the corner, the first title readings confirm it
 * and the scan stops there; otherwise (or when they do not confirm) the whole plan runs as before, and the title is also read among the cards of the printed set (`opts.setScope`). Never throws on a photo with no card (it answers `stoppedBy: "no-card"`);
 * an engine that throws is the caller's to handle.
 */
export async function scanPhoto(photo: Photo, reader: OcrReader, index: NameIndex, opts: ScanOptions = {}): Promise<ScanResult> {
	const now = opts.now ?? (() => performance.now());
	const startedAt = now();
	const small = downscaleRgba(photo, FINDER_WIDTH);
	const found = findCard(small.rgba, small.w, small.h);
	if (!found || !found.quad) return { quad: null, decision: null, proposals: [], reads: 0, stoppedBy: "no-card", finder: found, printed: null, shortcut: null };
	const quad = scaleQuad(found.quad, photo.w / small.w);
	opts.onQuad?.(quad);
	const gray: GrayImage = toGray(photo.rgba, photo.w, photo.h);
	// the colour channels the title strips are cut from after the luminance ones (readingPlan): made when a reading first asks for one, a photo read at once never pays for them
	const planes = new Map<Channel, GrayImage>([["L", gray]]);
	const planeOf = (channel: Channel): GrayImage => {
		let plane = planes.get(channel);
		if (!plane) {
			plane = toChannel(photo.rgba, photo.w, photo.h, channel);
			planes.set(channel, plane);
		}
		return plane;
	};
	const fullPlan: ReadStep[] = readingPlan();
	const budget = Math.min(fullPlan.length, opts.maxReads ?? fullPlan.length);
	const cardReader = new CardReader(index, opts.config ?? READING_CONFIG);
	// the corner first: it says which EDITION, and with the set code and number it may name the card outright (also when no title can be read: a token)
	const outer = isCardEdge(found);
	const corner = await readPrinted(gray, quad, reader, opts.signal, outer);
	let printed = corner.printed;
	// a corner that could only be read from the quad turned half a turn says the card lies upside down: the title is then right way up in that quad
	const titleQuad = corner.quad;
	const result = (decision: Decision | null, stoppedBy: ScanResult["stoppedBy"], reads: number, shortcut: ScanResult["shortcut"] = null, proposals = cardReader.proposals(3)): ScanResult => ({
		quad,
		decision,
		proposals,
		reads,
		stoppedBy,
		finder: found,
		printed,
		shortcut,
	});
	let confirmer: TitleConfirmer | null = null;
	let expected: ShortcutCard | null = null;
	const setTitle = new SetTitleReader(opts.setScope, { ...(opts.config ?? READING_CONFIG), ...SET_SCOPE_OVERRIDES });
	// the names of 3 to 5 letters, which the whole-catalogue reader refuses: read apart (see ScanOptions.shortIndex)
	const shortReader = opts.shortIndex ? new CardReader(opts.shortIndex, SHORT_NAME_CONFIG) : null;
	if (printed && opts.shortcut && !opts.signal?.aborted) {
		const ask = async (info: PrintedInfo): Promise<ShortcutCard | null> => {
			try {
				return await opts.shortcut!(info);
			} catch {
				return null; // the way back is the whole plan
			}
		};
		expected = await ask(printed);
		// a set code of three letters that is not one ("PMR" for "SPM"): the wide window reads the first letter the narrow one cuts off, and the lookup is tried once more
		if (!expected && printed.number && printed.set && printed.set.length >= 3 && !opts.signal?.aborted) {
			const again = await rereadPrintedWide(gray, corner.quad, reader, printed, opts.signal, outer);
			if (again && again.set !== printed.set) {
				printed = again;
				expected = await ask(again);
			}
		}
		if (expected && expected.owner === null) return result(null, "sure", 0, "corner-only");
		if (expected && expected.owner !== null) confirmer = new TitleConfirmer(expected.names, expected.owner, opts.config ?? READING_CONFIG);
	}
	// no card named by the corner (or no way to ask): the cards of the printed set are the best help the title reading can have; a named card is usually confirmed within a few readings first
	if (!confirmer) setTitle.start(printed);
	// a card the corner named is confirmed by a title reading the right way up, so those come first and the upside-down ones (which only matter for a card whose corner could not be read) last
	const plan = confirmer ? [...fullPlan.filter((s) => s.roll === 0), ...fullPlan.filter((s) => s.roll !== 0)] : fullPlan;
	// the five variants of a strip share the strip: cut it once (a strip is the window, the way up AND the channel)
	let stripKey = "";
	let strip: GrayImage | null = null;
	for (let i = 0; i < budget; i++) {
		if (opts.signal?.aborted) return result(null, "cancelled", i);
		// the person has waited long enough: what the readings made so far propose is the answer, as when the plan runs out (a decision only with the evidence the plan's end asks for)
		if (opts.maxMs !== undefined && now() - startedAt >= opts.maxMs) return result(cardReader.finish() ?? setTitle.finish(), "time", i, null, mergeProposals(setTitle.proposals(3), cardReader.proposals(3)));
		const step = plan[i];
		const key = `${step.kind}|${step.roll}|${step.strip.y0}|${step.channel}`;
		if (key !== stripKey || !strip) {
			strip = extractStrip(planeOf(step.channel), titleQuad, step.strip);
			stripKey = key;
		}
		const lines = await reader.recognize(encodeBmp(stripVariant(strip, step.variant)), step.psm);
		const decision = cardReader.add(lines);
		const setDecision = setTitle.add(lines);
		const shortDecision = shortReader ? shortReader.add(trimNoiseLines(lines)) : null;
		opts.onProgress?.({ reads: i + 1, planned: plan.length, elapsedMs: now() - startedAt, limitMs: opts.maxMs, proposals: mergeProposals(setTitle.proposals(3), cardReader.proposals(3)) });
		const hit = confirmer && i < CONFIRM_CONFIG.steps ? confirmer.check(lines) : null;
		if (hit && expected && expected.owner !== null) {
			const proposal: Proposal = { owner: expected.owner, key: hit.key, evidence: 1, reads: 1 };
			return result({ ...proposal, sure: true }, "sure", i + 1, "confirmed", [proposal]);
		}
		// the corner's card was not confirmed by the first readings: the title read among the cards of its set
		if (i + 1 >= SET_SCOPE_START_READS) setTitle.start(printed);
		if (setDecision) return result(setDecision, "sure", i + 1, "set-title", mergeProposals(setTitle.proposals(3), cardReader.proposals(3)));
		// while the readings that may still confirm the card the corner named go on, a card the first readings agree on does not stop the scan: a long name comes out in pieces
		// ("The Sack", read three times, is "The Rack"), and the confirming reading is the fourth
		const holdsOutForCorner = confirmer !== null && expected !== null && i < CONFIRM_CONFIG.steps && decision?.owner !== expected.owner;
		if (decision && !holdsOutForCorner) return result(decision, "sure", i + 1);
		// a short name is decided last: after the corner's window (`holdsOutForCorner`: a card the corner named is confirmed first), and not while a longer name that contains it has evidence ("Serra" is the start of
		// "Serra Angel": a reading of the longer title that came out in pieces must not become the short card)
		if (shortDecision && !holdsOutForCorner && !explainedByLongerName(shortDecision, cardReader.proposals(3)))
			return result(shortDecision, "sure", i + 1, "short-name", mergeProposals(mergeProposals([shortDecision], setTitle.proposals(3)), cardReader.proposals(3)));
	}
	if (opts.signal?.aborted) return result(null, "cancelled", budget);
	return result(cardReader.finish() ?? setTitle.finish(), budget < plan.length ? "budget" : "plan", budget, null, mergeProposals(setTitle.proposals(3), cardReader.proposals(3)));
}

type PrintedWindow = typeof WIDE_PRINTED_WINDOW;

/** Reads one window of the corner with the two variants and parses each reading into `reads`. Stops quietly when the person cancelled. */
async function readWindowInto(reads: (PrintedInfo | null)[], gray: GrayImage, quad: Quad, reader: OcrReader, win: PrintedWindow, signal?: AbortSignal): Promise<void> {
	const strip = extractStrip(gray, quad, { ...win, outW: 1100, roll: 0 });
	for (const variant of ["asis", "inv"] as const) {
		if (signal?.aborted) return;
		const lines = await reader.recognize(encodeBmp(stripVariant(strip, variant)), 6);
		reads.push(parsePrinted(lines.map((l) => l.text)));
	}
}

/** The same card turned half a turn: its bottom-left corner is the quad's top-right one. */
const turnQuad = (q: Quad): Quad => [q[2], q[3], q[0], q[1]];

/**
 * Reads the bottom-left corner of the card: the first window with two variants (the text is white on black: `asis` and `inv` both read it), the wide window when a number was
 * read but the set code came out under 3 letters, the second window when no number was read twice. When nothing at all was read, the first window of the quad turned half a
 * turn (a card lying with its top toward the bottom of the photo: the finder cannot tell, and half the photos of a card on its side are that way), which is kept for the
 * second window when it reads a number. Each read is parsed; the reads are combined by vote. Answers the quad the corner was read from, turned or not. Never throws: an
 * engine that fails here costs the edition, not the card.
 */
export async function readPrinted(gray: GrayImage, quad: Quad, reader: OcrReader, signal?: AbortSignal, outer = false): Promise<{ printed: PrintedInfo | null; quad: Quad }> {
	const windows = outer ? PRINTED_WINDOWS_OUTER : PRINTED_WINDOWS;
	const wide = outer ? WIDE_PRINTED_WINDOW_OUTER : WIDE_PRINTED_WINDOW;
	let reads: (PrintedInfo | null)[] = [];
	let used = quad;
	const hasNumber = (rs: (PrintedInfo | null)[]): boolean => rs.some((r) => r?.number != null);
	const numberReadTwice = (): boolean => reads.some((r, i) => r?.number != null && reads.some((o, j) => j !== i && o?.number === r.number));
	try {
		await readWindowInto(reads, gray, used, reader, windows[0], signal);
		const set = combinePrinted(reads)?.set;
		if (hasNumber(reads) && (!set || set.length < 3)) await readWindowInto(reads, gray, used, reader, wide, signal);
		if (!numberReadTwice()) await readWindowInto(reads, gray, used, reader, windows[1], signal);
		if (!hasNumber(reads) && !signal?.aborted) {
			const turned: (PrintedInfo | null)[] = [];
			await readWindowInto(turned, gray, turnQuad(used), reader, windows[0], signal);
			if (hasNumber(turned)) {
				used = turnQuad(used);
				reads = turned;
				if (!numberReadTwice()) await readWindowInto(reads, gray, used, reader, windows[1], signal);
			}
		}
	} catch {
		// the title result stands without an edition
	}
	return { printed: combinePrinted(reads), quad: used };
}

/**
 * Reads the wide window once more and votes it with what was read before: for a set code that came out with 3 letters but the wrong ones ("PMR" for "SPM") and that Scryfall
 * did not know. Never throws.
 */
export async function rereadPrintedWide(gray: GrayImage, quad: Quad, reader: OcrReader, earlier: PrintedInfo | null, signal?: AbortSignal, outer = false): Promise<PrintedInfo | null> {
	const reads: (PrintedInfo | null)[] = [];
	try {
		await readWindowInto(reads, gray, quad, reader, outer ? WIDE_PRINTED_WINDOW_OUTER : WIDE_PRINTED_WINDOW, signal);
	} catch {
		// the first reading stands
	}
	return combinePrinted([earlier, ...reads]);
}

/**
 * The card the corner of a photo names, for a caller that has ALREADY found the card (the image fingerprint did): reads the bottom-left corner of `quad` (`outer`: the quad is the card's own edge, see
 * `isCardEdge`) and asks `lookup` for the card at the set code and number it read. A set code of three letters that finds no card is read once more through the wide window (the first letter is the one lost
 * most often), as `scanPhoto` does. `printed` is what was read, whether or not a card came of it. Never throws: an engine or a lookup that fails costs the edition, not the card.
 */
export async function findCornerCard<T>(
	photo: Photo,
	quad: Quad,
	outer: boolean,
	reader: OcrReader,
	lookup: (printed: PrintedInfo) => Promise<T | null>,
	signal?: AbortSignal,
): Promise<{ printed: PrintedInfo | null; card: T | null }> {
	const ask = async (info: PrintedInfo): Promise<T | null> => {
		try {
			return await lookup(info);
		} catch {
			return null;
		}
	};
	try {
		const gray = toGray(photo.rgba, photo.w, photo.h);
		const corner = await readPrinted(gray, quad, reader, signal, outer);
		let printed = corner.printed;
		if (!printed || signal?.aborted) return { printed, card: null };
		let card = await ask(printed);
		if (!card && printed.number && printed.set && printed.set.length >= 3 && !signal?.aborted) {
			const again = await rereadPrintedWide(gray, corner.quad, reader, printed, signal, outer);
			if (again && again.set !== printed.set) {
				printed = again;
				card = await ask(again);
			}
		}
		return { printed, card };
	} catch {
		return { printed: null, card: null };
	}
}

/** The language to give a copy added from a photo: the language of the name that matched, "" (the plugin's code for English) for English. */
export function languageOfCard(row: CatalogueRow, key: string): CatalogueLanguage | "" {
	const lang = matchedLanguage(row, key);
	return lang === "en" ? "" : lang;
}
