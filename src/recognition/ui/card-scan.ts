// Adding a card from a photo (beta). The panel that shows the reading — a progress
// bar and a Cancel button — and what it ends with: the PRINTINGS of the cards the reading proposes (up to three names), the one the card carries first when its
// printed number and set code were read, for the person to choose from. Nothing is added here: the modal that owns the panel shows them as ordinary search
// results, so choosing one is the usual "Add". The recognition (src/recognition/) and the Scryfall lookups are handed in, so a test can play every outcome
// without the OCR engine; nothing in this file imports the engine's embedded assets.

import type { ScryfallCard } from "../../api/scryfall";
import type { Quad } from "../card-finder";
import type { CatalogueRow } from "../catalogue";
import { readWithFingerprint, type FingerprintDeps } from "../fingerprint/scan-fingerprint";
import { photoFromSource, type PhotoSource } from "../photo-input";
import type { PrintedInfo } from "../printed";
import { rankPrintings, type PrintingMatch } from "../printing-rank";
import type { Proposal } from "../reading";
import { languageOfCard, type Photo, type RecognitionScanOptions, type ScanResult } from "../scan";
import { ReaderUnsupportedError } from "../wasm-simd";
import { renderPhotoPreview, type PhotoPreview } from "./scan-photo-preview";

/** The part of `CardRecognition` (recognition/service.ts) this file uses. */
export interface ScanRecognition {
	/** the day of the card names the reader knows: a card newer than that cannot be recognised */
	readonly catalogueDate: string;
	scan(photo: Photo, opts: RecognitionScanOptions): Promise<{ result: ScanResult; rows: CatalogueRow[] }>;
}

export interface CardScanDeps {
	/** Called when the photo has been read, so nothing is built (no engine, no catalogue) before a photo is given. */
	recognition: () => ScanRecognition;
	/** Every printing of some English names, newest first (api/scryfall.ts `fetchPrintingsOfNames`); empty when the request fails. */
	lookupPrintings: (names: string[]) => Promise<ScryfallCard[]>;
	/** The printing with a set code and a collector number, what the card itself prints (`fetchPrintingBySetAndNumber`); null when there is none. */
	lookupExact: (set: string, collectorNumber: string) => Promise<ScryfallCard | null>;
	/** The cards of some English names, keyed by the lower-cased name asked for (`fetchCardsByName`): the way back when the printings cannot be fetched. */
	lookupCards: (names: string[]) => Promise<Map<string, ScryfallCard>>;
	/** The English names of the cards of a set (`fetchSetCardNames`), to read the title among them when the corner's number did not settle it; null when there is no list. Absent: the title is only read among every card. */
	lookupSetCards?: (set: string) => Promise<string[] | null>;
	/** The photo as pixels; the real one by default. */
	readPhoto?: (file: PhotoSource) => Promise<Photo>;
	/** "Try another photo" on a failure, and "Retake" while the photo is being read (which cancels the reading first). */
	onRetry: () => void;
	/** How long to wait for Scryfall's answer about the card the corner names (a test shortens it); EXACT_LOOKUP_TIMEOUT_MS by default. */
	exactTimeoutMs?: number;
	/** The image fingerprint (recognition/fingerprint/): present only while it is on. The scan tries it FIRST and reads the title when it finds nothing; absent, the title is read as it always was. */
	fingerprint?: FingerprintDeps;
}

export type ScanFailure = "no-card" | "unreadable" | "unknown-cards" | "unsupported" | "error";

export type ScanOutcome =
	| { kind: "cards"; cards: ScryfallCard[]; /** the line to show with them: how the first one was chosen, or how many there are */ note: string; match: PrintingMatch }
	| { kind: "failed"; reason: ScanFailure }
	| { kind: "cancelled" };

/**
 * Of the cards the reading gives evidence for (best first), the ones worth showing: the best one always, the others when their evidence is at least this
 * share of the best's and this much in itself. A card read once at the edge of a guess (0.2 against 1.5) is noise the person would have to look at. Chosen on
 * the 17 real photos the reader was tried on (the right card was never below 0.65 of the best); to revisit with more.
 */
export const PROPOSAL_MIN_SHARE = 0.4;
export const PROPOSAL_MIN_EVIDENCE = 0.3;

export function worthShowing(proposals: readonly Proposal[]): Proposal[] {
	if (proposals.length === 0) return [];
	const best = proposals[0].evidence;
	return proposals.filter((p, i) => i === 0 || (p.evidence >= PROPOSAL_MIN_EVIDENCE && p.evidence >= best * PROPOSAL_MIN_SHARE));
}

/**
 * A title read with at least this much evidence (the reader's own "sure" threshold) is trusted over the corner: the printing the card's set code and number point at, when it
 * is a card the title did not propose, goes AFTER the proposals' printings (a number read one digit wrong points at an unrelated card). With a weaker title, or none, it goes first.
 */
export const STRONG_TITLE_EVIDENCE = 1;

/**
 * The set code to look the card up by: the one read, and for a TOKEN (rarity letter "T" where the rarity goes) "t" + it, because a token's set code is the set's with a T in front
 * ("TSPM" for "SPM") and that first letter is the one lost most often: without it the lookup lands on the CARD with the same number (City Pigeon SPM 4 for the token Human Citizen
 * TSPM 4, seen on the second real phone test). Null when the set code was read with too few letters to look anything up.
 */
export function lookupSetCode(printed: PrintedInfo | null): string | null {
	if (!printed?.set || printed.set.length < MIN_SET_CODE_LENGTH) return null;
	return printed.rarity === "T" && !printed.set.startsWith("t") ? `t${printed.set}` : printed.set;
}

/** A set code read with fewer letters than this lost one ("PM" for "SPM"): not worth a request, the ranking still uses it against the printings of the name. */
export const MIN_SET_CODE_LENGTH = 3;

/** At most this many tiles: a basic land has hundreds of printings, and the one the card carries is first when its number was read. */
export const MAX_SHOWN_PRINTINGS = 24;

export interface ScanCards {
	cards: ScryfallCard[];
	note: string;
	match: PrintingMatch;
}

/**
 * The tiles to show: every printing of the proposed names (plus the printing the card's own set code and number point at), ranked by how they agree with what was read
 * in the card's corner (recognition/printing-rank.ts), at most MAX_SHOWN_PRINTINGS. A printing is the ENGLISH card (its picture, its prices) carrying the language the
 * title was read in and the name printed in it (core/foreign-print.ts), which is how a hit found by a foreign name reaches the usual "Add"; for a printing no title was read
 * for, the language printed on the card. Empty when there is nothing to show.
 */
export function buildScanCards(
	proposals: readonly Proposal[],
	rows: readonly CatalogueRow[],
	printings: readonly ScryfallCard[],
	exact: ScryfallCard | null,
	printed: PrintedInfo | null,
	/** the corner named the card and it has no name in the reader's list (a token): the title was not read at all */
	cornerOnly = false,
	/** the reader was not sure of the title (the plan ran out with too little evidence): the cards are its best guess, not a reading */
	weak = false,
): ScanCards {
	const names = proposals.map((p) => rows[p.owner]?.english ?? "");
	const proposalIndex = new Map<string, number>();
	names.forEach((n, i) => {
		const k = n.toLowerCase();
		if (k && !proposalIndex.has(k)) proposalIndex.set(k, i);
	});
	const proposalOf = (card: ScryfallCard): number => proposalIndex.get(card.name.toLowerCase()) ?? names.length;
	const unrelatedExact = exact !== null && proposalOf(exact) === names.length;
	const strongTitle = proposals.length > 0 && proposals[0].evidence >= STRONG_TITLE_EVIDENCE;
	// a sure title and a printing of ANOTHER card at the card's own set and number: the number was probably misread, the title decides
	const demoted = unrelatedExact && strongTitle ? exact : null;
	const candidates: ScryfallCard[] = [];
	const seen = new Set<string>();
	for (const card of [...printings, ...(exact && !demoted ? [exact] : [])]) {
		if (seen.has(card.id)) continue;
		seen.add(card.id);
		candidates.push(card);
	}
	const { ordered, best } = rankPrintings(candidates, proposalOf, printed);
	if (demoted && !seen.has(demoted.id)) ordered.push(demoted);
	const cards = ordered.slice(0, MAX_SHOWN_PRINTINGS).map((card): ScryfallCard => {
		const proposal = proposals[proposalOf(card)];
		const row = proposal ? rows[proposal.owner] : undefined;
		let lang: string = proposal && row ? languageOfCard(row, proposal.key) : "";
		const printedName = lang && row ? row.names[lang as keyof typeof row.names] : undefined;
		// the language of the corner counts only with a number read next to it: a stray "IT" that the OCR made out of the table or the card's art is not the card's language
		if (!lang && printed?.number != null && printed.lang && printed.lang !== "en") lang = printed.lang;
		return lang ? { ...card, lang, printed_name: printedName } : card;
	});
	// the first tile is a card the title did not propose, found by the corner alone
	const byCornerAlone = best === "exact" && cards.length > 0 && proposalOf(cards[0]) === names.length;
	return { cards, note: noteFor(best, cards, printed, byCornerAlone, proposals.length === 0, cornerOnly, weak), match: best };
}

function noteFor(match: PrintingMatch, cards: readonly ScryfallCard[], printed: PrintedInfo | null, byCornerAlone: boolean, noTitle: boolean, cornerOnly: boolean, weak: boolean): string {
	const first = cards[0];
	const more = cards.length > 1 ? " Other editions follow." : "";
	switch (match) {
		case "exact":
			if (byCornerAlone) {
				const where = `${first.set.toUpperCase()} ${first.collector_number}`;
				if (cornerOnly) return `Matched by the number printed on your card (${where}). Its name is not in the reader's list, so the title could not confirm it. Check it against your card.`;
				return noTitle
					? `The name could not be read: this is the card at the number printed on yours (${where}). Check it against your card.`
					: `Matched by the number printed on your card (${where}), but the title does not confirm it. Check it against your card.`;
			}
			return `Matched by the number printed on your card (${first.set.toUpperCase()} ${first.collector_number}).${more}`;
		case "number":
			return `The number printed on your card (${printed?.number}) matches the first edition shown. Check it against your card.`;
		case "close":
			return `The number printed on your card looked like ${printed?.number}: the closest edition is shown first. Check it against your card.`;
		default:
			// a title the reader was not sure of is a guess (the single readings behind such a guess were the wrong card as often as the right one on the old cards tried): say so
			if (weak) return cards.length === 1 ? "1 possible card from your photo, but its name was only partly read. Check it against your card." : `${cards.length} editions of the possible cards from your photo, but the name was only partly read. Check them against your card.`;
			return cards.length === 1 ? "1 possible card from your photo" : `${cards.length} editions of the possible cards from your photo. Pick the one that matches your card.`;
	}
}

export function failureMessage(reason: ScanFailure, catalogueDate: string, detail = ""): string {
	switch (reason) {
		case "no-card":
			return "No card found in this photo. Lay the card flat on a plain, well-lit surface and fill most of the frame. A dark card on a dark surface is hard to see: try a lighter one.";
		case "unreadable":
			return "The card was found but its name could not be read. Try again closer and in better light, with the whole card in focus and no glare on the title, or search for it by name.";
		case "unknown-cards":
			return `Scryfall did not return the cards the reader suggested: you may be offline, or the card may be newer than the list of names built into this plugin (from ${catalogueDate}). Search for it by name instead.`;
		case "unsupported":
			return "Reading a card's name is not available on this device: its browser engine does not support WebAssembly SIMD. Search for the card by name instead.";
		case "error":
			return `The card reader could not run on this device${detail ? `: ${detail}` : "."}`;
	}
}

export interface CardScanHandle {
	cancel(): void;
	done: Promise<ScanOutcome>;
}

/**
 * How long the person waits for a photo, at most (the finder, the corner and the title readings): then the reading stops and the cards it has evidence for are shown, or the way out if it
 * has none. Without it a photo nothing can be read from went through the whole plan (160 readings: 48 s on a laptop, more on a phone) and only "Cancel" stopped it. Chosen on the recorded
 * readings of 66 photos of old cards (docs/history/card-recognition-spike.md, "Plafond de durée"): at 25 s the right card was first on 59 photos out of the 60 an unlimited plan gets, at
 * 20 s 56, at 15 s 55; wrong cards 0 at every limit; the mean wait of a photo 12.6 s instead of 16.8 s, the longest 25 s instead of 45.
 */
export const SCAN_TIME_LIMIT_MS = 25000;

/** How long the scan waits for Scryfall's answer about the card the corner names: before it reads the title the long way, and again before it shows the tiles without that printing. */
export const EXACT_LOOKUP_TIMEOUT_MS = 4000;

/**
 * Resolves once the browser has had the chance to draw what was just added (the next frame, then the task after it), or after this long when it draws no frames (a hidden window): the
 * photo and its outline show up before the finder keeps the page busy for a few hundred milliseconds.
 */
export const PAINT_WAIT_MAX_MS = 100;

function afterPaint(): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		window.requestAnimationFrame(() => window.setTimeout(finish, 0));
		window.setTimeout(finish, PAINT_WAIT_MAX_MS);
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => resolve(otherwise), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			() => {
				window.clearTimeout(timer);
				resolve(otherwise);
			},
		);
	});
}

/** Draws the panel in `panelEl` (which the caller has emptied) and reads `file`: a file, or the pixels of a webcam frame. The panel stays after a failure (with its message and a retry button). */
export function startCardScan(panelEl: HTMLElement, file: PhotoSource, deps: CardScanDeps): CardScanHandle {
	const controller = new AbortController();
	const exactTimeoutMs = deps.exactTimeoutMs ?? EXACT_LOOKUP_TIMEOUT_MS;
	// the card at the set code and number printed on the card is asked for ONCE: the scan needs it to confirm the title, the tiles need it to put that printing first
	const exactAsked = new Map<string, Promise<ScryfallCard | null>>();
	const exactOnce = (set: string, collectorNumber: string): Promise<ScryfallCard | null> => {
		const key = `${set}/${collectorNumber}`;
		let asked = exactAsked.get(key);
		if (!asked) {
			asked = deps.lookupExact(set, collectorNumber);
			exactAsked.set(key, asked);
		}
		return asked;
	};
	const panel = panelEl.createDiv({ cls: "mtg-scan-panel" });
	panel.createDiv({ cls: "mtg-scan-title", text: "Reading your photo" });
	const bar = panel.createDiv({ cls: "mtg-scan-bar is-waiting" });
	bar.setAttribute("role", "progressbar");
	bar.setAttribute("aria-valuemin", "0");
	bar.setAttribute("aria-valuemax", "100");
	bar.createDiv({ cls: "mtg-scan-bar-fill" });
	const status = panel.createDiv({ cls: "mtg-scan-status" });
	const actions = panel.createDiv({ cls: "mtg-scan-actions" });
	const cancelBtn = actions.createEl("button", { cls: "mtg-scan-cancel", text: "Cancel" });
	// the photo with the card outlined on it comes once the photo is read; if the outline is on the wrong thing, this is the way to a better photo without waiting for a wrong answer
	const retakeBtn = actions.createEl("button", { cls: "mtg-scan-retake", text: "Retake" });
	let preview: PhotoPreview | null = null;
	const setStatus = (text: string) => {
		status.textContent = text;
	};
	const setProgress = (fraction: number) => {
		const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
		bar.removeClass("is-waiting");
		bar.setAttribute("aria-valuenow", String(percent));
		bar.setCssProps({ "--mtg-scan-progress": `${percent}%` });
	};
	setStatus("Starting the reader…");

	const cancel = () => controller.abort();
	cancelBtn.addEventListener("click", cancel);
	// the camera has to open inside this tap (a browser only opens a file chooser from a tap), so the reading is stopped and the caller's retry runs right here
	retakeBtn.addEventListener("click", () => {
		cancel();
		deps.onRetry();
	});
	const showOutline = (quad: Quad) => preview?.setOutline(quad);

	// the failure may be the recognition failing to exist at all
	const catalogueDateOf = (): string => {
		try {
			return deps.recognition().catalogueDate;
		} catch {
			return "";
		}
	};
	const fail = (reason: ScanFailure, detail = ""): ScanOutcome => {
		panel.addClass("is-failed");
		panel.querySelector(".mtg-scan-title")!.textContent = "Could not read this photo";
		bar.remove();
		setStatus(failureMessage(reason, catalogueDateOf(), detail));
		cancelBtn.remove();
		retakeBtn.remove();
		const retry = actions.createEl("button", { cls: "mtg-scan-retry mod-cta", text: "Try another photo" });
		retry.addEventListener("click", deps.onRetry);
		return { kind: "failed", reason };
	};
	const cancelled = (): ScanOutcome => {
		panel.remove();
		return { kind: "cancelled" };
	};

	const done = (async (): Promise<ScanOutcome> => {
		try {
			const photo = await (deps.readPhoto ?? photoFromSource)(file);
			if (controller.signal.aborted) return cancelled();
			// the photo as the reader sees it, shown at once: the finder is about to keep the page busy for a few hundred milliseconds
			preview = renderPhotoPreview(panel, bar, photo);
			if (preview) {
				await afterPaint();
				if (controller.signal.aborted) return cancelled();
			}
			if (deps.fingerprint) {
				// the card's artwork looked up in the base first (about a second); the printings that carry it are the tiles. Nothing found (no base, no card seen, nothing close): the title is read, as before.
				const found = await readWithFingerprint(photo, deps.fingerprint, { signal: controller.signal, onStatus: setStatus, onProgress: setProgress, onQuad: showOutline });
				if (controller.signal.aborted) return cancelled();
				if (found) {
					setProgress(1);
					return { kind: "cards", cards: found.cards, note: found.note, match: "none" };
				}
				bar.addClass("is-waiting");
				bar.removeAttribute("aria-valuenow");
				setStatus("Starting the reader…");
			}
			const { result, rows } = await deps.recognition().scan(photo, {
				signal: controller.signal,
				exactName: async (printed) => {
					const set = lookupSetCode(printed);
					if (!set || !printed.number) return null;
					const found = await withTimeout(exactOnce(set, printed.number), exactTimeoutMs, null);
					return found ? found.name : null;
				},
				setCards: deps.lookupSetCards
					? async (printed) => {
							const set = lookupSetCode(printed);
							return set ? deps.lookupSetCards!(set) : null;
						}
					: undefined,
				maxMs: SCAN_TIME_LIMIT_MS,
				onQuad: showOutline,
				onProgress: (p) => {
					setStatus("Reading the card's name…");
					// the bar follows the wait: the plan is much longer than the time allowed, so reads/planned alone would stall at half of it when the time runs out
					setProgress(Math.max(p.reads / p.planned, p.limitMs ? p.elapsedMs / p.limitMs : 0));
				},
			});
			if (result.stoppedBy === "cancelled") return cancelled();
			if (result.stoppedBy === "no-card") return fail("no-card");
			const proposals = worthShowing(result.proposals);
			const printed = result.printed;
			const lookupSet = lookupSetCode(printed);
			const cornerPointsAtACard = lookupSet !== null && !!printed?.number;
			// no title the reader can take (a token, a short name): the card's own set code and number may still say which card it is
			if (proposals.length === 0 && !cornerPointsAtACard) return fail("unreadable");
			setProgress(1);
			setStatus("Looking up the editions…");
			const names = proposals.map((p) => rows[p.owner].english);
			const [printings, exact] = await Promise.all([
				names.length > 0 ? deps.lookupPrintings(names) : Promise.resolve([] as ScryfallCard[]),
				lookupSet !== null && printed?.number ? withTimeout(exactOnce(lookupSet, printed.number), exactTimeoutMs, null) : Promise.resolve(null),
			]);
			// the printings could not be fetched: the card's default printing by name, as before, rather than nothing
			const fallback = names.length > 0 && printings.length === 0 ? Array.from((await deps.lookupCards(names)).values()) : [];
			if (controller.signal.aborted) return cancelled();
			const shown = buildScanCards(proposals, rows, [...printings, ...fallback], exact, printed, result.shortcut === "corner-only", result.decision === null);
			if (shown.cards.length === 0) return fail(proposals.length === 0 ? "unreadable" : "unknown-cards");
			return { kind: "cards", cards: shown.cards, note: shown.note, match: shown.match };
		} catch (e) {
			console.warn("MTG Collection: reading a card from a photo failed", e);
			// a device that cannot run the OCR engine says so in plain words, not with the browser's own message about an unknown instruction
			if (e instanceof ReaderUnsupportedError) return fail("unsupported");
			return fail("error", e instanceof Error ? e.message : String(e));
		}
	})();
	return { cancel, done };
}
