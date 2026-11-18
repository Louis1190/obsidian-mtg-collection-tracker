// Ordering the printings that share an artwork by how much they LOOK like the card in the photo. Pure. PRIVATE like the rest of src/recognition/.
//
// The artwork says which illustration the card carries; the printings that reuse it differ by frame, border and colours, which the whole-card look (descriptors.ts `lookOfCard`) sees. The photo's
// card is straightened under the same two alignment hypotheses and both orientations as the scan, and each printing's picture (Scryfall's small image, brought to 96 x 134 by the caller) is
// compared with every one of those: the smallest distance counts. A printing whose picture could not be read keeps its place after the ones that could.

import type { Quad } from "../card-finder";
import type { Photo } from "../scan";
import { DEFAULT_EXPANDS } from "./database";
import { lookBothWays, lookOfCard } from "./descriptors";
import { warpCard } from "./warp";

/** The looks of the photo's card: one per alignment hypothesis and orientation. */
export function lookQueries(photo: Photo, quad: Quad, expands: readonly number[] = DEFAULT_EXPANDS): Float32Array[] {
	const out: Float32Array[] = [];
	for (const expand of expands) out.push(...lookBothWays(warpCard(photo, quad, expand)));
	return out;
}

/** The smallest L2 distance of a printing's look to the photo's looks. */
export function lookDistance(queries: readonly Float32Array[], look: Float32Array): number {
	let best = Infinity;
	for (const q of queries) {
		let s = 0;
		for (let i = 0; i < look.length; i++) {
			const d = q[i] - look[i];
			s += d * d;
		}
		if (s < best) best = s;
	}
	return Math.sqrt(best);
}

/** The items nearest in look first; those with no picture (`rgb` null) after them, in their own order. Stable: equal distances keep the order given. */
export function rankByLook<T>(queries: readonly Float32Array[], items: readonly { item: T; rgb: Uint8Array | null }[]): T[] {
	const seen = items.map((it, index) => ({ it, index, d: it.rgb && queries.length > 0 ? lookDistance(queries, lookOfCard(it.rgb)) : Infinity }));
	seen.sort((a, b) => (a.d === b.d ? a.index - b.index : a.d - b.d));
	return seen.map((s) => s.it.item);
}
