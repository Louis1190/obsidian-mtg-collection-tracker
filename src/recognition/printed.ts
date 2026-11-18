// What a modern card prints in the bottom-left corner of its black border: the rarity and the collector number ("C 0082", or "082/274 R" on frames of
// 2015-2022), then the set code and the language ("SPM ★ FR", "M15 • EN"). Read by OCR in a small window, so the text is noisy; this parses the lines
// it gave, leniently, and says only what it is fairly sure of. Pure. Measured on 7 real phone photos: the number came out right 6 times in 7
// ("0197", "0082", "0047", "0188", "0046", "0042" and "0086" for a card numbered 88), the set code with its first letter lost now and then
// ("PM" for "SPM"), "FR" almost always (docs/history/card-recognition-spike.md, "Premier vrai test sur le téléphone").

export interface PrintedInfo {
	/** collector number without leading zeros ("82"), null when no number was read */
	number: string | null;
	/** the set code as read, lower case ("spm"; possibly with a letter missing), null when none */
	set: string | null;
	/** the language printed, as a code the plugin knows ("en", "fr", "de"…), null when not read or not one it knows */
	lang: string | null;
	/** the letter printed before the number where the rarity goes ("C", "U", "R", "M"…; "T" on a TOKEN, whose set code is "T" + the set's: TSPM), upper case, null when none was read */
	rarity: string | null;
}

/** What a card prints for its language → the code used everywhere else in the plugin (a copy's `language` is "" for English: callers map "en" to ""). */
const PRINTED_LANGUAGES: Record<string, string> = { EN: "en", FR: "fr", DE: "de", ES: "es", IT: "it", PT: "pt", JA: "ja", KO: "ko", RU: "ru", CS: "zhs", CT: "zht" };

// Letters the OCR gives for digits inside a number ("O082", "00B2", "l88"): corrected only inside a token that is otherwise made of digits.
const DIGIT_LOOKALIKES: Record<string, string> = { O: "0", o: "0", Q: "0", D: "0", I: "1", l: "1", "|": "1", S: "5", B: "8" };
const NUMBER_CHARS = "[0-9OoQDIl|SB]";

function toDigits(token: string): string | null {
	let digits = "";
	for (const ch of token) {
		const d = /[0-9]/.test(ch) ? ch : DIGIT_LOOKALIKES[ch];
		if (d === undefined) return null;
		digits += d;
	}
	// at least one genuine digit: "SSS" or "BOB" is not a number
	return /[0-9]/.test(token) ? digits : null;
}

/** A year ("1993", "2025") is not a collector number: modern numbers are zero-padded ("0082") or short; a 4-digit one starting 19/20 is the © line. */
function looksLikeYear(digits: string): boolean {
	return digits.length === 4 && /^(19[89]\d|20[0-3]\d)$/.test(digits);
}

/** The collector number of one line, null when the line is not a number line ("C 0082", "T0004", "082/274 R", "R 082/274"): short, one number, little else. */
function numberOfLine(line: string): { number: string; rarity: string | null } | null {
	const text = line.trim();
	if (text.length > 16) return null;
	const slashed = new RegExp(`(?:^|\\s)(${NUMBER_CHARS}{2,4})\\s*/\\s*${NUMBER_CHARS}{1,4}(?:\\s|$)`).exec(text);
	// the prefix may touch the number ("T0004"): up to two characters, of which only a single letter is taken for the rarity
	const plain = new RegExp(`^[^0-9A-Za-z]*(?:([A-Za-z¥©'.,:;*+\\-]{1,2})\\s*)?(${NUMBER_CHARS}{3,4})\\s*$`).exec(text);
	const token = slashed?.[1] ?? plain?.[2];
	if (!token) return null;
	const digits = toDigits(token);
	if (!digits || looksLikeYear(digits)) return null;
	const stripped = digits.replace(/^0+/, "");
	if (stripped === "") return null;
	const letter = slashed ? /(?:^|\s)([A-Za-z])(?=\s|$)/.exec(text)?.[1] : plain?.[1]?.length === 1 ? plain[1] : undefined;
	return { number: stripped, rarity: letter && /[A-Za-z]/.test(letter) ? letter.toUpperCase() : null };
}

const SET_AND_LANGUAGE = /^[^A-Za-z0-9]*([A-Z0-9]{2,5})[^A-Za-z0-9]{0,3}\s*([A-Z]{2,3})(?![A-Za-z])/;
const SET_ONLY = /^[^A-Za-z0-9]*([A-Z0-9]{2,5})/;

/** Parses the lines read from the bottom-left window; null when nothing usable (no number, no set, no language) came out of them. */
export function parsePrinted(lines: readonly string[]): PrintedInfo | null {
	let number: string | null = null;
	let rarity: string | null = null;
	let numberLine = -1;
	lines.forEach((l, i) => {
		if (number !== null) return;
		const n = numberOfLine(l);
		if (n !== null) {
			number = n.number;
			rarity = n.rarity;
			numberLine = i;
		}
	});
	let set: string | null = null;
	let lang: string | null = null;
	for (let i = 0; i < lines.length && lang === null; i++) {
		if (i === numberLine) continue;
		const m = SET_AND_LANGUAGE.exec(lines[i].trim());
		if (!m) continue;
		const code = PRINTED_LANGUAGES[m[2]];
		if (code === undefined) continue;
		set = m[1].toLowerCase();
		lang = code;
	}
	// a garbled separator or language ("PMePR"): the set is still the first word of the line under the number
	if (set === null && numberLine >= 0 && numberLine + 1 < lines.length) {
		const m = SET_ONLY.exec(lines[numberLine + 1].trim());
		if (m) set = m[1].toLowerCase();
	}
	if (number === null && set === null && lang === null) return null;
	return { number, set, lang, rarity };
}

/**
 * The reads of several variants of the same window, as one answer: each field is the value most reads agree on (the first read's on a tie), so one read
 * that swaps a digit does not decide against two that agree.
 */
export function combinePrinted(reads: readonly (PrintedInfo | null)[]): PrintedInfo | null {
	const found = reads.filter((r): r is PrintedInfo => r !== null);
	if (found.length === 0) return null;
	const vote = (pick: (r: PrintedInfo) => string | null): string | null => {
		const counts = new Map<string, number>();
		for (const r of found) {
			const v = pick(r);
			if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
		}
		let best: string | null = null;
		let bestCount = 0;
		for (const [v, c] of counts)
			if (c > bestCount) {
				best = v;
				bestCount = c;
			}
		return best;
	};
	const number = vote((r) => r.number);
	const lang = vote((r) => r.lang);
	const rarity = vote((r) => r.rarity);
	// a set code read with a letter lost ("PM") supports the whole code ("SPM") other reads gave; the longest of the best supported wins
	const sets = Array.from(new Set(found.map((r) => r.set).filter((x): x is string => x !== null)));
	const support = (code: string): number => found.filter((r) => r.set !== null && (r.set === code || (r.set.length >= 2 && (code.endsWith(r.set) || code.startsWith(r.set))))).length;
	// ...but a code read in full (3 letters or more) that appears more often than a longer one containing it is the code: "HOB" three times and "MHOB" once is a stray letter
	// in front of it, not a card whose set lost its first letter (a set read with two letters or fewer is never a whole code, so it only ever supports)
	const exact = (code: string): number => found.filter((r) => r.set === code).length;
	const contains = (longer: string, shorter: string): boolean => longer !== shorter && (longer.endsWith(shorter) || longer.startsWith(shorter));
	let set: string | null = null;
	for (const code of sets) {
		if (set === null) {
			set = code;
			continue;
		}
		const [shorter, longer]: [string, string] = code.length < set.length ? [code, set] : [set, code];
		if (shorter.length >= 3 && contains(longer, shorter) && exact(shorter) !== exact(longer)) set = exact(shorter) > exact(longer) ? shorter : longer;
		else if (support(code) > support(set) || (support(code) === support(set) && code.length > set.length)) set = code;
	}
	return number === null && set === null && lang === null ? null : { number, set, lang, rarity };
}
