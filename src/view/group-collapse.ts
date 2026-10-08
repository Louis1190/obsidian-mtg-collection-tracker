import { CardViewMode } from "../core/card-sorting";
import { holdAtOffset, releaseOffset } from "../ui/flip";
import type { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/* Animated collapse/expand of the card groups (rows, FLIP). */
/* ---------------------------------------------------------------------------- */

// "qty - name" format (like listSelectionTxtLines), with a "# Name" header
// per list when several are merged — without this, a combined export of
// several lists would be a flat list with no indication of which card comes
// from where (the combined CSV, for its part, already has its own "List"
// column per row, see buildListCsvString).

export function setRowCollapsed(this: MTGCollectionView, rowOuter: HTMLElement, collapsed: boolean) {
	// Used only in Table mode (see toggleGroupRows for List/Grid, which
	// handles the whole group at once to allow the FLIP animation of the
	// neighbors).
	const pending = this.tableFadeTimeouts.get(rowOuter);
	if (pending) window.clearTimeout(pending);

	if (collapsed) {
		rowOuter.addClass("mtg-row-fading");
		const timeoutId = window.setTimeout(() => {
			rowOuter.addClass("mtg-hidden");
			rowOuter.removeClass("mtg-row-fading");
			this.tableFadeTimeouts.delete(rowOuter);
		}, 150);
		this.tableFadeTimeouts.set(rowOuter, timeoutId);
	} else {
		rowOuter.removeClass("mtg-hidden");
		rowOuter.addClass("mtg-row-fading");
		window.requestAnimationFrame(() => {
			rowOuter.removeClass("mtg-row-fading");
		});
		this.tableFadeTimeouts.delete(rowOuter);
	}
}
// Collapses/expands a WHOLE group (List/Grid) as a single operation,
// rather than row by row: the disappearance/appearance of each card still
// uses transform/opacity (see CSS), but the shift of the following groups
// is smoothed via the FLIP technique (First-Last-Invert-Play) — see
// flipListChange. In Table mode, no FLIP: each row keeps its individual
// fade (setRowCollapsed).


export function toggleGroupRows(this: MTGCollectionView, 
	list: HTMLElement,
	headerEl: HTMLElement,
	rows: HTMLElement[],
	collapsed: boolean,
	viewMode: CardViewMode
) {
	if (viewMode === "table") {
		rows.forEach((r) => this.setRowCollapsed(r, collapsed));
		return;
	}

	const pending = this.groupCollapseTimeouts.get(headerEl);
	if (pending) window.clearTimeout(pending);

	if (collapsed) {
		// Measures each row before taking it out of the normal flow (absolute
		// position, frozen at its exact location) — the neighbors can then slide
		// IMMEDIATELY (via flipListChange, below), while the row keeps playing its
		// own fade-out on top, no longer making the others wait. Without this, the
		// neighbors only moved once the row's fade was already finished, creating
		// a noticeable dead time.
		const listRect = list.getBoundingClientRect();
		const rowRects = rows.map((r) => r.getBoundingClientRect());

		this.flipListChange(list, () => {
			rows.forEach((r, i) => {
				const rect = rowRects[i];
				// Absolute position frozen at the exact location: the class carries position/z-index, the
				// three measurements go through CSS variables (see .mtg-row-detached, styles.css).
				r.setCssProps({
					"--mtg-row-top": `${rect.top - listRect.top}px`,
					"--mtg-row-left": `${rect.left - listRect.left}px`,
					"--mtg-row-width": `${rect.width}px`,
				});
				r.addClass("mtg-row-detached");
				r.addClass("mtg-row-collapsed");
			});
		});

		const timeoutId = window.setTimeout(() => {
			rows.forEach((r) => {
				r.addClass("mtg-hidden");
				r.removeClass("mtg-row-detached");
			});
			this.groupCollapseTimeouts.delete(headerEl);
		}, 300);
		this.groupCollapseTimeouts.set(headerEl, timeoutId);
	} else {
		rows.forEach((r) => r.removeClass("mtg-row-detached"));
		this.flipListChange(list, () => {
			rows.forEach((r) => r.removeClass("mtg-hidden"));
		});
		void list.offsetHeight;
		window.requestAnimationFrame(() => {
			rows.forEach((r) => r.removeClass("mtg-row-collapsed"));
		});
	}
}
// FLIP technique: measures the position of everything that might move
// BEFORE the change, applies the real change instantly, then visually
// compensates for the difference with a transform (immediate, invisible),
// before releasing it smoothly. Since only "transform" animates, no layout
// recalculation takes place during the animation itself — the following
// groups therefore glide smoothly, rather than jumping all at once at the
// end.

export function flipListChange(this: MTGCollectionView, list: HTMLElement, mutate: () => void) {
	const movables = Array.from(
		list.querySelectorAll<HTMLElement>(".mtg-card-row-outer, .mtg-group-header")
	).filter((el) => !el.hasClass("mtg-hidden"));
	const firstTops = movables.map((el) => el.getBoundingClientRect().top);

	mutate();

	const toAnimate: HTMLElement[] = [];
	movables.forEach((el, i) => {
		if (el.hasClass("mtg-hidden")) return;
		const deltaY = firstTops[i] - el.getBoundingClientRect().top;
		if (Math.abs(deltaY) < 1) return;
		holdAtOffset(el, deltaY);
		toAnimate.push(el);
	});

	if (toAnimate.length === 0) return;
	// Forces the browser to "see" the offset position before releasing,
	// otherwise the two changes risk being merged and the animation skipped.
	list.getBoundingClientRect();
	window.requestAnimationFrame(() => {
		toAnimate.forEach((el) => releaseOffset(el));
	});
}
