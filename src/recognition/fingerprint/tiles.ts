// What the fingerprint hands to the "Add cards" window: the printings of the illustrations it found, in the order the person should look at them, and the line that says how sure it is (never
// "sure"). Pure. PRIVATE like the rest of src/recognition/.

import type { ScryfallCard } from "../../api/scryfall";
import type { Match } from "./database";

/**
 * Scores are sums of z-scores (database.ts): lower is closer. On the 38 real photos the right card scored -24 to -12 and the best OTHER card -12 to -7.5 (docs/history/card-recognition-spike.md),
 * so these are first guesses, to be set on more photos (plan step P4): above NO_MATCH_SCORE nothing looks like a card of the base and the caller falls back to reading the title; above
 * WEAK_SCORE the match is shown with "check it against your card"; a second or third illustration is shown only when it is within NEAR_TIE of the best.
 */
export const NO_MATCH_SCORE = -6;
export const WEAK_SCORE = -11;
export const NEAR_TIE = 1.5;
export const MAX_FINGERPRINT_TILES = 24;

/**
 * A best score above this (closer to zero) is not trusted on its own: the card's corner is read too, and the printing it names is shown first. Measured (docs/history/card-recognition-fingerprint-plan.md):
 * a card the base does not hold (a token before the base had them, a set newer than the base) was answered a WRONG card at -12.4 to -6.0, the removed-card control reached about -11.8, and the right cards
 * scored -29 to -11.5 (median -16.9), so no score separates them, but everything wrong ever measured sits above -14 while about nine photos in ten of the right ones sit below it and skip the corner (and
 * the OCR engine it starts) altogether.
 */
export const CORNER_CHECK_SCORE = -14;

export interface FingerprintTiles {
	cards: ScryfallCard[];
	note: string;
	/** the best match is faint: the note says so */
	weak: boolean;
}

/** True when the best match is too far to be taken for a card of the base at all. */
export function isNoMatch(matches: readonly Match[]): boolean {
	return matches.length === 0 || matches[0].score > NO_MATCH_SCORE;
}

/** The matches worth looking up: the best always, the next ones when they are almost as close. */
export function worthLookingUp(matches: readonly Match[]): Match[] {
	if (matches.length === 0) return [];
	return matches.filter((m, i) => i === 0 || m.score - matches[0].score <= NEAR_TIE);
}

/**
 * The tiles: the printings of the best illustration first, then those of the near ties, each group in `lookOrder` (a printing id -> rank, lower first; Scryfall's own order, newest first, for a
 * printing with no rank), at most MAX_FINGERPRINT_TILES. `printings` is whatever Scryfall answered for the illustrations asked; a printing of another illustration (or of none) goes last.
 * Null when there is nothing to show.
 */
export function buildFingerprintCards(
	matches: readonly Match[],
	printings: readonly ScryfallCard[],
	lookOrder: ReadonlyMap<string, number> = new Map(),
	/** the printing the card's own corner names (set code + number read from the photo), when it was read and Scryfall has it */
	corner: ScryfallCard | null = null,
): FingerprintTiles | null {
	if (matches.length === 0) return null;
	const shown = worthLookingUp(matches);
	const groupOf = (card: ScryfallCard): number => {
		const g = shown.findIndex((m) => m.id === card.illustration_id);
		return g === -1 ? shown.length : g;
	};
	const indexed = printings.map((card, i) => ({ card, i, group: groupOf(card) }));
	indexed.sort((a, b) => a.group - b.group || (lookOrder.get(a.card.id) ?? Infinity) - (lookOrder.get(b.card.id) ?? Infinity) || a.i - b.i);
	const ranked = indexed.map((x) => x.card);
	if (corner) return cornerFirst(shown, ranked, corner);
	const cards = ranked.slice(0, MAX_FINGERPRINT_TILES);
	if (cards.length === 0) return null;
	const weak = matches[0].score > WEAK_SCORE;
	const manyIllustrations = shown.length > 1 && indexed.some((x) => x.group > 0 && x.group < shown.length);
	let note: string;
	if (weak) note = cards.length === 1 ? "1 possible card from your photo, but it only partly matches. Check it against your card." : `${cards.length} editions of the possible cards from your photo, but they only partly match. Check them against your card.`;
	else if (cards.length === 1) note = "1 possible card from your photo";
	else note = manyIllustrations ? `${cards.length} editions of the cards that look like your photo. Pick the one that matches your card.` : `${cards.length} editions of the card in your photo. Pick the one that matches your card.`;
	return { cards, note, weak };
}

/** Every illustration a printing carries: its own, and each face's for a double-faced card (Scryfall puts `illustration_id` on the faces there). */
function illustrationsOf(card: ScryfallCard): string[] {
	const ids = [card.illustration_id, ...(card.card_faces ?? []).map((f) => f.illustration_id)];
	return ids.filter((id): id is string => !!id);
}

/**
 * The tiles when the card's corner named a printing: that printing first, then the fingerprint's own order. The two kinds of evidence are independent, so which of them the person is told about
 * depends on whether they meet: the printing carries one of the illustrations the fingerprint found (they agree: the edition is settled, a card the base had), or it does not (the base probably does
 * not hold the card, or the corner was misread: the corner's printing still goes first, as it does when the title is read, and the person is asked to check).
 */
function cornerFirst(shown: readonly Match[], ranked: readonly ScryfallCard[], corner: ScryfallCard): FingerprintTiles {
	const agrees = illustrationsOf(corner).some((id) => shown.some((m) => m.id === id));
	const cards = [corner, ...ranked.filter((c) => c.id !== corner.id)].slice(0, MAX_FINGERPRINT_TILES);
	const where = `${corner.set.toUpperCase()} ${corner.collector_number}`;
	const more = cards.length > 1 ? " Other editions follow." : "";
	const note = agrees
		? `Matched by the number printed on your card (${where}), and the picture agrees.${more}`
		: `Matched by the number printed on your card (${where}), but the picture does not confirm it. Check it against your card.${more}`;
	return { cards, note, weak: !agrees };
}
