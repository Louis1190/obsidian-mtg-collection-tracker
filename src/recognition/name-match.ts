// Fuzzy matching of text read by an OCR against a catalogue of card names, English and localized. Pure (no DOM, no Obsidian).
//
// The OCR does not have to read a title perfectly: it has to read it well enough for the right name to be the nearest one among ~70 000 (English +
// French) to ~190 000 (five Latin-script languages). Ported from the measurement kit (tools/android/probes/card-scan/match.js + match-compact.js;
// proven to give the same cards and scores on the OCR lines of the real photos, see docs/history/card-recognition-spike.md).
//
// The index is flat typed arrays, not one Set of trigrams per name: the naive index cost 85 MB (English + French) and 242 MB (five languages) of
// heap, this one 9 MB and 17 MB (measured), which a phone can carry. An entry points to an OWNER (whatever identifies the card: a row number in
// the catalogue); a card has several entries (its name in each language, each face of a double-faced card) and is proposed once, with the best
// score any of them reached.

/** Same key on both sides: no accents, no apostrophes, lower case, every other symbol a space. */
export function normalizeName(s: string): string {
	return String(s)
		.replace(/[æÆ]/g, "ae")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/['’`]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * A line of OCR text without the little words around it: up to `maxWords` words of at most `maxLetters` letters are taken off each end, one word always stays. A title is followed by
 * its mana cost, which the OCR reads as "U", "2R" or "o4", and sometimes preceded by a frame mark read as "i": for a name of three to five letters that is the difference between a line
 * that IS the name and one that is not (the matching of those names accepts nothing but the whole line). Returns the normalised text.
 */
export function trimNoiseWords(text: string, maxLetters = 2, maxWords = 2): string {
	const words = normalizeName(text).split(" ").filter((w) => w !== "");
	for (let i = 0; i < maxWords && words.length > 1 && words[0].length <= maxLetters; i++) words.shift();
	for (let i = 0; i < maxWords && words.length > 1 && words[words.length - 1].length <= maxLetters; i++) words.pop();
	return words.join(" ");
}

/** Levenshtein distance, giving up as soon as it must exceed `max` (returns max + 1). */
export function levenshtein(a: string, b: string, max: number): number {
	if (a === b) return 0;
	const n = a.length;
	const m = b.length;
	if (Math.abs(n - m) > max) return max + 1;
	let prev = new Int32Array(m + 1);
	let cur = new Int32Array(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		let rowMin = i;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= m; j++) {
			const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
			cur[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > max) return max + 1;
		const t = prev;
		prev = cur;
		cur = t;
	}
	return prev[m];
}

/**
 * Cost of the best alignment of the whole `pat` against ANY substring of `text` (Sellers): free text before and after. This is what lets
 * "divine inceryencion o4" (a name followed by noise read off the mana cost) still find "divine intervention".
 */
export function semiGlobal(pat: string, text: string): number {
	const m = pat.length;
	const n = text.length;
	let prev = new Int32Array(m + 1);
	let cur = new Int32Array(m + 1);
	for (let i = 0; i <= m; i++) prev[i] = i;
	let best = prev[m];
	for (let j = 1; j <= n; j++) {
		cur[0] = 0;
		const cb = text.charCodeAt(j - 1);
		for (let i = 1; i <= m; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (pat.charCodeAt(i - 1) === cb ? 0 : 1));
		if (cur[m] < best) best = cur[m];
		const t = prev;
		prev = cur;
		cur = t;
	}
	return best;
}

function trigramsOf(key: string): Set<string> {
	const s = " " + key + " ";
	const out = new Set<string>();
	for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
	return out;
}

export interface NameIndex {
	keys: string[];
	owners: number[];
	/** 1 for an entry that is ONE face of an "A // B" name (the whole name and every ordinary name: 0) */
	faces: Uint8Array;
	gramCount: Uint8Array;
	ids: Map<string, number>;
	start: Int32Array;
	post: Int32Array;
	/** scratch counters, reset after every line */
	counts: Uint16Array;
}

/**
 * `strings[i]` is a name of the card `owners[i]`. A double-faced or split card is listed once as "A // B"; a photo shows ONE face, so each face is
 * an entry too. A trigram table lets a line look only at the few names that share letters with it.
 */
export function buildNameIndex(strings: readonly string[], owners: readonly number[]): NameIndex {
	const keys: string[] = [];
	const own: number[] = [];
	const faceFlags: number[] = [];
	const seen = new Set<string>();
	for (let n = 0; n < strings.length; n++) {
		const name = strings[n];
		const forms = [{ key: normalizeName(name), face: 0 }];
		if (name.indexOf(" // ") >= 0) for (const f of name.split(" // ")) forms.push({ key: normalizeName(f), face: 1 });
		for (const { key, face } of forms) {
			const id = key + "|" + owners[n];
			if (key && !seen.has(id)) {
				seen.add(id);
				keys.push(key);
				own.push(owners[n]);
				faceFlags.push(face);
			}
		}
	}
	// pass 1: how many entries each trigram appears in; pass 2 (the trigrams are computed again rather than kept: 190 000 small arrays would
	// cost more than the answer) fills the flat table (compressed-row layout)
	const ids = new Map<string, number>();
	const gramCount = new Uint8Array(keys.length);
	const freq: number[] = [];
	for (let i = 0; i < keys.length; i++) {
		const ts = trigramsOf(keys[i]);
		gramCount[i] = Math.min(255, ts.size);
		for (const g of ts) {
			let id = ids.get(g);
			if (id === undefined) {
				id = ids.size;
				ids.set(g, id);
				freq.push(0);
			}
			freq[id]++;
		}
	}
	const start = new Int32Array(ids.size + 1);
	for (let g = 0; g < ids.size; g++) start[g + 1] = start[g] + freq[g];
	const post = new Int32Array(start[ids.size]);
	const fill = new Int32Array(ids.size);
	for (let i = 0; i < keys.length; i++)
		for (const g of trigramsOf(keys[i])) {
			const id = ids.get(g) as number;
			post[start[id] + fill[id]++] = i;
		}
	return { keys, owners: own, faces: Uint8Array.from(faceFlags), gramCount, ids, start, post, counts: new Uint16Array(keys.length) };
}

const PARTIAL_MIN_LEN = 6; // a short name ("fog", "opt") would match inside any noise
const PARTIAL_MIN_SCORE = 0.82;
/**
 * How much more than the name a line may carry for the name to count as found INSIDE it, as a share of the name's length. A title carries its mana cost and some frame noise, not a
 * second title: on the 66 photos of 33 old cards (every reading of the plan kept), a name found inside a line with 1.5 to 2 times its length of other text was the wrong card 20 times
 * out of 23 ("Mishra" in "Mishra: ras Ea oc oO ees" for Mishra's Factory, "Prepare" for Nicol Bolas), beyond twice its length 16 of 16; up to its own length the right card was found 113
 * times out of 135. So no match beyond `PARTIAL_MAX_EXTRA`, and a growing penalty from `PARTIAL_FREE_EXTRA`.
 */
export const PARTIAL_MAX_EXTRA = 2;
export const PARTIAL_FREE_EXTRA = 1;
export const PARTIAL_EXTRA_PENALTY = 0.08;

export interface NameMatch {
	owner: number;
	/** the normalised name that matched (its length is what a caller uses to distrust a short one) */
	key: string;
	/** 0..1: 1 - distance / the name's or the line's length; a name found INSIDE a longer noisy line scores a little lower than a line that is the name */
	score: number;
	/** the name was found INSIDE a longer line (the line is more than the name), not matched as the whole line */
	partial?: boolean;
	/** the entry that matched is one face of an "A // B" card */
	face?: boolean;
	/** the normalised line it was found in: with `partial`, how much of the line the name leaves unexplained */
	lineLength?: number;
}

/**
 * What a face of an "A // B" card loses against a card that is called exactly that: "Swords to Plowshares" is the title of the card of that name, and only a half of the
 * adventure card "Emeritus of Truce // Swords to Plowshares" (whose title reads "Emeritus of Truce"), so an equal reading goes to the card that bears the name.
 */
export const FACE_PENALTY = 0.004;

/** The best `top` cards for ONE line of OCR text. */
export function matchLine(line: string, index: NameIndex, top: number, minScore: number): NameMatch[] {
	const key = normalizeName(line);
	if (key.length < 3) return [];
	const { keys, owners, faces, gramCount, ids, start, post, counts } = index;
	const touched: number[] = [];
	for (const g of trigramsOf(key)) {
		const id = ids.get(g);
		if (id === undefined) continue;
		for (let p = start[id]; p < start[id + 1]; p++) {
			const i = post[p];
			if (counts[i]++ === 0) touched.push(i);
		}
	}
	// the best score each CARD reached
	const byOwner = new Map<number, NameMatch>();
	for (const i of touched) {
		const shared = counts[i];
		counts[i] = 0;
		if (shared < Math.max(2, Math.ceil(gramCount[i] * 0.3))) continue;
		const ekey = keys[i];
		const longer = Math.max(key.length, ekey.length);
		const max = Math.floor(longer * (1 - minScore));
		let score = 0;
		let partial = false;
		if (Math.abs(key.length - ekey.length) <= max) {
			const d = levenshtein(key, ekey, max);
			if (d <= max) score = 1 - d / longer;
		}
		const extra = (key.length - ekey.length) / ekey.length;
		if (ekey.length >= PARTIAL_MIN_LEN && key.length > ekey.length && extra <= PARTIAL_MAX_EXTRA) {
			const d2 = semiGlobal(ekey, key);
			const s2 = 1 - d2 / ekey.length - 0.02 - PARTIAL_EXTRA_PENALTY * Math.max(0, extra - PARTIAL_FREE_EXTRA);
			if (s2 >= Math.max(minScore, PARTIAL_MIN_SCORE) && s2 > score) {
				score = s2;
				partial = true;
			}
		}
		if (faces[i]) score -= FACE_PENALTY;
		if (score < minScore) continue;
		const known = byOwner.get(owners[i]);
		if (!known || score > known.score) byOwner.set(owners[i], { owner: owners[i], key: ekey, score, partial, face: faces[i] === 1, lineLength: key.length });
	}
	return Array.from(byOwner.values())
		.sort((x, y) => y.score - x.score)
		.slice(0, top);
}

/** Candidates for a block of OCR text (several lines, one of them the name): the best score each card reached on any line. */
export function matchText(lines: readonly string[], index: NameIndex, opts?: { top?: number; minScore?: number }): NameMatch[] {
	const top = opts?.top ?? 3;
	const minScore = opts?.minScore ?? 0.75;
	const best = new Map<number, NameMatch>();
	for (const line of lines)
		for (const c of matchLine(line, index, top, minScore)) {
			const known = best.get(c.owner);
			if (!known || c.score > known.score) best.set(c.owner, c);
		}
	return Array.from(best.values())
		.sort((x, y) => y.score - x.score)
		.slice(0, top);
}
