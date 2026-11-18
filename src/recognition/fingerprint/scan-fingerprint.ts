// Reading a photo with the image fingerprint: the card's illustration from the base, the printings that carry it from Scryfall, those printings in the order of their look. Everything it needs from
// outside (the base, Scryfall, the pictures) is handed in, so a test plays every outcome with nothing real. PRIVATE like the rest of src/recognition/.
//
// It never fails the scan: any problem (no base, no card seen, no answer from Scryfall, an exception) answers null and the caller reads the title instead, as it always did.

import type { ScryfallCard } from "../../api/scryfall";
import type { Quad } from "../card-finder";
import type { Photo } from "../scan";
import { findCardOf, identifyCard, type FingerprintDb } from "./database";
import { lookQueries, rankByLook } from "./look";
import { buildFingerprintCards, CORNER_CHECK_SCORE, isNoMatch, worthLookingUp, type FingerprintTiles } from "./tiles";

export interface FingerprintDeps {
	/** the base (null: none yet, the caller falls back); `onProgress(done, total)` counts the shards while it loads */
	database: (onProgress?: (done: number, total: number) => void) => Promise<FingerprintDb | null>;
	/** every paper printing that carries one of these illustrations (api/scryfall.ts `fetchPrintingsOfIllustrations`) */
	lookupIllustrations: (ids: string[]) => Promise<ScryfallCard[]>;
	/** a printing's picture as 96 x 134 RGB (its small image), null when it cannot be read; absent: the printings keep Scryfall's order */
	cardPixels?: (card: ScryfallCard) => Promise<Uint8Array | null>;
	/** the finder; the real one by default */
	findQuad?: (photo: Photo) => Quad | null;
	/**
	 * The printing the card's own corner names (the set code and number read from the photo, the card at that address from Scryfall), null when there is none or it cannot be read. Asked only when
	 * the best score is too weak to trust alone (CORNER_CHECK_SCORE), at the same time as the printings are looked up; `outer`: the quad is the card's own edge. Absent: the corner is never read here.
	 */
	cornerCard?: (photo: Photo, quad: Quad, outer: boolean, signal: AbortSignal) => Promise<ScryfallCard | null>;
}
export interface FingerprintHooks {
	signal?: AbortSignal;
	onStatus?: (text: string) => void;
	onProgress?: (fraction: number) => void;
	/** the card the finder found, in the photo's pixels, as soon as it is found (the panel outlines it); not called when no card is found */
	onQuad?: (quad: Quad) => void;
	lookupTimeoutMs?: number;
	pixelsTimeoutMs?: number;
	cornerTimeoutMs?: number;
	/** a best score above this asks `cornerCard` (CORNER_CHECK_SCORE by default; a test sets its own) */
	cornerCheckScore?: number;
}

/** How long the scan waits for Scryfall's answer, and for the printings' pictures (without them the printings keep Scryfall's order). */
export const LOOKUP_TIMEOUT_MS = 6000;
export const PIXELS_TIMEOUT_MS = 3000;
/** How long the scan waits for the corner's printing: the OCR engine may have to start (about a second and a half), read two or three windows and ask Scryfall. Without it the tiles are the fingerprint's alone. */
export const CORNER_TIMEOUT_MS = 8000;
/** Printings whose pictures are fetched to put them in the order of their look, at most. */
export const LOOK_POOL = 36;

function withTimeout<T>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => resolve(otherwise), ms);
		promise.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			() => {
				window.clearTimeout(timer);
				resolve(otherwise);
			},
		);
	});
}

// lets the panel paint its new status before the next stretch of computing blocks the page
const paint = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

export async function readWithFingerprint(photo: Photo, deps: FingerprintDeps, hooks: FingerprintHooks = {}): Promise<FingerprintTiles | null> {
	// the corner's reading belongs to this scan: it stops when the scan ends, whichever way, and when the person cancels
	const cornerAbort = new AbortController();
	const cancelCorner = () => cornerAbort.abort();
	hooks.signal?.addEventListener("abort", cancelCorner);
	try {
		const aborted = () => hooks.signal?.aborted === true;
		hooks.onStatus?.("Loading the card database…");
		const db = await deps.database((done, total) => hooks.onProgress?.(total > 0 ? (done / total) * 0.4 : 0));
		if (!db || aborted()) return null;
		hooks.onStatus?.("Looking for the card…");
		hooks.onProgress?.(0.4);
		await paint();
		if (aborted()) return null;
		const found = deps.findQuad ? asFound(deps.findQuad(photo)) : findCardOf(photo);
		if (!found) return null;
		const { quad, outer } = found;
		hooks.onQuad?.(quad);
		const matches = identifyCard(photo, quad, db);
		if (isNoMatch(matches)) return null;
		hooks.onProgress?.(0.7);
		hooks.onStatus?.("Looking up the editions…");
		// a match too faint to trust alone (a card the base does not hold is answered a wrong one at about this strength): the card's own corner says which printing it is, read while Scryfall is asked
		const cornerAsked =
			deps.cornerCard && matches[0].score > (hooks.cornerCheckScore ?? CORNER_CHECK_SCORE)
				? withTimeout(deps.cornerCard(photo, quad, outer, cornerAbort.signal), hooks.cornerTimeoutMs ?? CORNER_TIMEOUT_MS, null as ScryfallCard | null)
				: null;
		const asked = worthLookingUp(matches).map((m) => m.id);
		const printings = await withTimeout(deps.lookupIllustrations(asked), hooks.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, [] as ScryfallCard[]);
		if (printings.length === 0 || aborted()) return null;
		hooks.onProgress?.(0.9);
		if (cornerAsked) hooks.onStatus?.("Checking the number printed on your card…");
		// several printings carry the best illustration (or a near tie's): put them in the order of their look. One printing, nothing to rank, no picture fetched.
		const best = printings.filter((c) => c.illustration_id === matches[0].id).length;
		const pool = printings.slice(0, LOOK_POOL);
		const pixelsAsked =
			deps.cardPixels && (best > 1 || printings.length > 1)
				? withTimeout(Promise.all(pool.map((c) => deps.cardPixels!(c).catch(() => null))), hooks.pixelsTimeoutMs ?? PIXELS_TIMEOUT_MS, null)
				: null;
		// the pictures and the corner come in together: neither waits for the other
		const [pixels, corner] = await Promise.all([pixelsAsked, cornerAsked]);
		if (aborted()) return null;
		let lookOrder = new Map<string, number>();
		if (pixels) {
			const ranked = rankByLook(
				lookQueries(photo, quad),
				pool.map((c, i) => ({ item: c, rgb: pixels[i] })),
			);
			lookOrder = new Map(ranked.map((c, i) => [c.id, i]));
		}
		return buildFingerprintCards(matches, printings, lookOrder, corner);
	} catch {
		return null;
	} finally {
		hooks.signal?.removeEventListener("abort", cancelCorner);
		cornerAbort.abort();
	}
}

/** What a finder handed in by a caller (a test) gives is a bare quad: nothing says it is the card's own edge. */
const asFound = (quad: Quad | null): { quad: Quad; outer: boolean } | null => (quad ? { quad, outer: false } : null);
