// Where each page of a snapping row starts, and which page a scroll position belongs to
// (view/pinned-carousel.ts). The two-tile pinned rows could assume the pages are spread evenly
// over the scroll range, because with two tiles the pages are "the start" and "the end". With
// more tiles that is wrong: the snap points are one tile + gap apart and only the last page is
// cut short by the end of the row, so an even split would park the middle pages off their tile.

// `lefts` are the tiles' left edges in any one coordinate space (only their differences are used).
// A page starts where its tile starts, but never past the end of the scroll range (`maxLeft`).
export function pageOffsets(lefts: number[], maxLeft: number): number[] {
	if (lefts.length === 0) return [];
	const first = lefts[0];
	return lefts.map((left) => Math.min(maxLeft, Math.max(0, left - first)));
}

// The page whose start is closest to `scrollLeft`. On a tie the later page wins, which is also what
// settles the last pages that all clamp to the end of the range. Nothing to scroll = the first page.
export function nearestPage(scrollLeft: number, offsets: number[]): number {
	if (offsets.length === 0 || offsets[offsets.length - 1] <= 1) return 0;
	let best = 0;
	for (let i = 1; i < offsets.length; i++) {
		if (Math.abs(offsets[i] - scrollLeft) <= Math.abs(offsets[best] - scrollLeft)) best = i;
	}
	return best;
}
