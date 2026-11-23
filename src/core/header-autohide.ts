
// Downward travel (px) before the rows leave, upward travel before they come back. The way back is shorter on purpose: wanting the search
// again is a deliberate gesture, and leaving it should not need a long scroll to be noticed.
export const HIDE_AFTER_PX = 40;
export const SHOW_AFTER_PX = 16;

export interface ToolsState {
	hidden: boolean;
	// scrollTop at the previous event: the next event's delta is measured against it.
	lastTop: number;
	// Signed distance travelled in the CURRENT direction (reset when the direction changes or the state flips).
	travel: number;
}

export interface ToolsInput {
	// scrollTop of the scrolling area.
	top: number;
	// Height of the rows (their box, padding included): they sit in the scroller's flow at the very top, so until the content has scrolled
	// by that much, hiding them would leave an empty band under the title instead of the first card.
	toolsHeight: number;
	// The scroller is at (or, with an elastic bounce, past) its end.
	atBottom: boolean;
	// Select mode, or the focus is inside the rows (a keyboard is probably open): they stay.
	locked: boolean;
}

export function initialToolsState(top = 0, hidden = false): ToolsState {
	return { hidden, lastTop: top, travel: 0 };
}

export function nextToolsState(prev: ToolsState, input: ToolsInput): ToolsState {
	const { top, toolsHeight, atBottom, locked } = input;
	// Nothing to hide yet (the content has not scrolled past the rows' own place), an elastic bounce above the top (top < 0) or a lock.
	if (locked || top < toolsHeight) return { hidden: false, lastTop: top, travel: 0 };
	// The elastic bounce at the end of the list comes back upwards by itself: it must not read as the person asking for the rows.
	if (atBottom && prev.hidden) return { hidden: true, lastTop: top, travel: 0 };

	const delta = top - prev.lastTop;
	let travel = prev.travel;
	if (delta > 0) travel = travel > 0 ? travel + delta : delta;
	else if (delta < 0) travel = travel < 0 ? travel + delta : delta;

	let hidden = prev.hidden;
	if (!hidden && travel >= HIDE_AFTER_PX) {
		hidden = true;
		travel = 0;
	} else if (hidden && travel <= -SHOW_AFTER_PX) {
		hidden = false;
		travel = 0;
	}
	return { hidden, lastTop: top, travel };
}
