import { initialToolsState, nextToolsState } from "../core/header-autohide";
import type { MTGCollectionView } from "../view";

export function attachDetailTools(
	this: MTGCollectionView,
	toolsEl: HTMLElement,
	header: HTMLElement,
	scrollArea: HTMLElement,
	locked: boolean
) {
	// Read now, like the other phone checks: Obsidian flips `is-phone` live with the window size.
	if (!activeDocument.body.classList.contains("is-phone")) return;

	header.addClass("has-detached-tools");
	scrollArea.addClass("has-sticky-tools");
	scrollArea.prepend(toolsEl);

	// The key of "where we are" (section + open list/deck/wantlist), set by render() before it builds the view.
	const key = this.lastRenderedViewKey ?? "";
	const remembered = this.detailToolsState?.key === key ? this.detailToolsState.state : null;
	let state = remembered ?? initialToolsState();
	if (locked) state = { ...state, hidden: false, travel: 0 };
	const apply = () => {
		toolsEl.toggleClass("is-hidden", state.hidden);
		// The scroller's own top fade depends on it (styles.css): off while the rows are in, back once they are out.
		scrollArea.toggleClass("is-tools-hidden", state.hidden);
		this.detailToolsState = { key, state };
	};
	apply();

	// One decision from the scroller's REAL position, at each scroll event and (below) at each layout of the rows.
	let toolsHeight = 0;
	const evaluate = () => {
		const top = scrollArea.scrollTop;
		state = nextToolsState(state, {
			top,
			toolsHeight,
			atBottom: top + scrollArea.clientHeight >= scrollArea.scrollHeight - 1,
			locked: locked || toolsEl.contains(activeDocument.activeElement),
		});
		apply();
	};

	// Their box, kept up to date by an observer (the height changes with a wrapping row or the select-mode bar): read at each scroll
	// event, an offsetHeight could force a layout in the middle of a gesture. The first callback is also the first moment the scroller's
	// position is the real one (render() restores it right after the swap, before any layout): a remembered "hidden" that does not fit it
	// (a scroller that starts at the top) is corrected here instead of waiting for a scroll event that never comes while the list rests at
	// the top: the rows would stay out of sight over an empty band. Nothing is decided while they have no box (a window not on screen).
	new ResizeObserver(() => {
		toolsHeight = toolsEl.offsetHeight;
		if (toolsHeight > 0) evaluate();
	}).observe(toolsEl);

	scrollArea.addEventListener("scroll", evaluate, { passive: true });

	// Focus can reach hidden rows (a restored focus, a screen reader): they come back rather than take it out of sight.
	toolsEl.addEventListener("focusin", () => {
		if (!state.hidden) return;
		state = { ...state, hidden: false, travel: 0 };
		apply();
	});

	// A rebuilt header that starts hidden must not slide out under the person's eyes: the transition is only switched on afterwards.
	window.setTimeout(() => toolsEl.addClass("is-animated"), 80);
}
