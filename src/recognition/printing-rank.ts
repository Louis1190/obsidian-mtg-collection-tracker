// Which printing of a recognised card the person is holding: the name says WHICH CARD, the collector number and the set code printed on it say WHICH
// EDITION. Scryfall answers a name with its default printing, which was the wrong one for 6 of 14 cards on the first real phone test, so the printings of
// the name are shown, ranked by how well they agree with what was read at the bottom of the card. Nothing is hidden: a misread digit or a lost letter only
// changes the order. Pure.

import type { PrintedInfo } from "./printed";

export interface PrintingLike {
	id: string;
	set: string;
	collector_number: string;
}

/** How a printing agrees with what was read: both number and set, the number only, a number one slip away (8 read as 6) in the right set, the set only, nothing. */
export type PrintingMatch = "exact" | "number" | "close" | "set" | "none";
const MATCH_ORDER: Record<PrintingMatch, number> = { exact: 0, number: 1, close: 2, set: 3, none: 4 };

const digitsOf = (collectorNumber: string): string => collectorNumber.replace(/\D/g, "").replace(/^0+/, "");

/** A set code that is the one read, or the one read with its first or last letter lost ("PM" for "SPM"). */
function sameSet(read: string, set: string): boolean {
	return read === set || (read.length >= 2 && (set.endsWith(read) || set.startsWith(read)));
}

/** True when the two digit strings differ by at most one inserted, deleted or replaced digit. */
function withinOneSlip(a: string, b: string): boolean {
	if (a === b) return true;
	if (Math.abs(a.length - b.length) > 1) return false;
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
	const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
	return longer.slice(i + 1) === shorter.slice(i);
}

/**
 * Among EXACT matches, how far each is from reading the card letter for letter: a set code only a little longer than the one read ("PSPM", a promo, for a read "SPM"), or a
 * collector number with a suffix ("46s" for a read 46), is a different printing from the one in the hand when the plain one exists. 0 is the plainest.
 */
function looseness(printing: PrintingLike, printed: PrintedInfo | null, match: PrintingMatch): number {
	if (!printed || match !== "exact") return 0;
	const setLoose = printed.set !== null && printed.set !== printing.set.toLowerCase() ? 1 : 0;
	const numberLoose = printed.number !== null && printing.collector_number.replace(/^0+/, "") !== printed.number ? 1 : 0;
	return setLoose + numberLoose;
}

export function matchPrinting(printing: PrintingLike, printed: PrintedInfo | null): PrintingMatch {
	if (!printed) return "none";
	const number = printed.number ? digitsOf(printed.number) : "";
	const own = digitsOf(printing.collector_number);
	const setOk = printed.set !== null && sameSet(printed.set, printing.set.toLowerCase());
	if (number !== "" && own === number) return setOk ? "exact" : "number";
	if (number !== "" && own !== "" && setOk && withinOneSlip(own, number)) return "close";
	return setOk ? "set" : "none";
}

/**
 * The printings in the order to show them. An EXACT match (number and set) comes first whichever name it belongs to: two independent readings agree on it.
 * Several exact matches go the plainest first (see `looseness`). Every other printing keeps the order of the names the title reading proposed (`proposalIndex`: 0 for the best name; an unrelated printing is a large number), then
 * the weaker agreements (number only, a slip away, set only), then the order Scryfall gave (newest first).
 */
export function rankPrintings<T extends PrintingLike>(
	printings: readonly T[],
	proposalIndex: (printing: T) => number,
	printed: PrintedInfo | null,
): { ordered: T[]; best: PrintingMatch } {
	const keyed = printings.map((printing, i) => {
		const match = matchPrinting(printing, printed);
		return { printing, match, i, p: match === "exact" ? -1 : proposalIndex(printing), loose: looseness(printing, printed, match) };
	});
	keyed.sort((a, b) => a.p - b.p || MATCH_ORDER[a.match] - MATCH_ORDER[b.match] || a.loose - b.loose || a.i - b.i);
	return { ordered: keyed.map((k) => k.printing), best: keyed.length ? keyed[0].match : "none" };
}
