import { describe, expect, it } from "vitest";
import { HIDE_AFTER_PX, SHOW_AFTER_PX, initialToolsState, nextToolsState, type ToolsInput, type ToolsState } from "./header-autohide";

const TOOLS = 200;
const base = (over: Partial<ToolsInput> = {}): ToolsInput => ({ top: 0, toolsHeight: TOOLS, atBottom: false, locked: false, ...over });

// Feeds a list of scrollTop values one event at a time, like the scroll listener does.
function run(tops: number[], over: Partial<ToolsInput> = {}, from: ToolsState = initialToolsState()): ToolsState[] {
	const out: ToolsState[] = [];
	let state = from;
	for (const top of tops) {
		state = nextToolsState(state, base({ top, ...over }));
		out.push(state);
	}
	return out;
}
const last = (states: ToolsState[]) => states[states.length - 1];

describe("nextToolsState", () => {
	it("starts shown and stays shown while the content has not scrolled past the rows' own place", () => {
		const states = run([0, 30, 80, 150, 199]);
		expect(states.every((s) => !s.hidden)).toBe(true);
	});

	it("hides after HIDE_AFTER_PX of downward travel once past the rows' place, not before", () => {
		// The listener sees every event, so by the time the scroller reaches the rows' place the previous position is right behind it.
		const states = run([TOOLS + HIDE_AFTER_PX - 1], {}, initialToolsState(TOOLS));
		expect(last(states).hidden).toBe(false);
		expect(last(run([TOOLS + HIDE_AFTER_PX], {}, last(states))).hidden).toBe(true);
	});

	it("never hides below the rows' own place, however far the finger travels (an empty band would show under the title)", () => {
		const states = run([0, 60, 120, TOOLS - 1]);
		expect(states.every((s) => !s.hidden)).toBe(true);
	});

	it("comes back after SHOW_AFTER_PX of upward travel, which is shorter than the way down", () => {
		expect(SHOW_AFTER_PX).toBeLessThan(HIDE_AFTER_PX);
		const hidden = last(run([TOOLS, TOOLS + 20, TOOLS + 60, TOOLS + 300]));
		expect(hidden.hidden).toBe(true);
		const almost = run([TOOLS + 300 - (SHOW_AFTER_PX - 1)], {}, hidden);
		expect(last(almost).hidden).toBe(true);
		expect(last(run([TOOLS + 300 - SHOW_AFTER_PX], {}, hidden)).hidden).toBe(false);
	});

	it("measures the travel in one direction: a small step the other way starts a new count", () => {
		let state = last(run([TOOLS, TOOLS + 30], {}, initialToolsState(TOOLS - 5)));
		state = nextToolsState(state, base({ top: TOOLS + 25 })); // 5 px back: the downward count restarts from zero
		state = nextToolsState(state, base({ top: TOOLS + 55 })); // 30 px down again, 30 < 40
		expect(state.hidden).toBe(false);
		state = nextToolsState(state, base({ top: TOOLS + 70 }));
		expect(state.hidden).toBe(true);
	});

	it("shows them again as soon as the scroller is back above the rows' place, hidden or not", () => {
		const hidden = last(run([TOOLS, TOOLS + 100, TOOLS + 400]));
		expect(hidden.hidden).toBe(true);
		const back = nextToolsState(hidden, base({ top: TOOLS - 1 }));
		expect(back.hidden).toBe(false);
		expect(back.travel).toBe(0);
	});

	it("an elastic bounce above the top (negative scrollTop) shows them", () => {
		const hidden = last(run([TOOLS, TOOLS + 100, TOOLS + 400]));
		expect(nextToolsState(hidden, base({ top: -30 })).hidden).toBe(false);
	});

	it("a lock (select mode, focus in the rows) keeps them shown and forgets the travel", () => {
		const states = run([TOOLS, TOOLS + 50, TOOLS + 500, TOOLS + 900], { locked: true });
		expect(states.every((s) => !s.hidden && s.travel === 0)).toBe(true);
		// and once the lock is gone the count starts from zero, not from the 900 px that were scrolled meanwhile
		const after = nextToolsState(last(states), base({ top: TOOLS + 910 }));
		expect(after.hidden).toBe(false);
	});

	it("a lock shows them even when they were hidden (the person put the focus in the search)", () => {
		const hidden = last(run([TOOLS, TOOLS + 100, TOOLS + 400]));
		expect(nextToolsState(hidden, base({ top: TOOLS + 400, locked: true })).hidden).toBe(false);
	});

	it("the elastic bounce back from the end of the list does not bring them back", () => {
		const hidden = last(run([TOOLS, TOOLS + 100, TOOLS + 5000]));
		const bounce = run([4990, 4960, 4900], { atBottom: true }, hidden);
		expect(bounce.every((s) => s.hidden)).toBe(true);
		// leaving the end by a real scroll up brings them back once the usual distance is travelled (the bounce left the position at 4900)
		const leaving = run([4890, 4885], { atBottom: false }, last(bounce));
		expect(last(leaving).hidden).toBe(true); // 15 px up, one short of SHOW_AFTER_PX
		expect(last(run([4884], { atBottom: false }, last(leaving))).hidden).toBe(false); // 16 px
	});

	it("an event that did not move changes nothing", () => {
		const state = last(run([TOOLS, TOOLS + 30]));
		expect(nextToolsState(state, base({ top: TOOLS + 30 }))).toEqual(state);
	});

	it("a restored scroll position (a re-render puts the same scrollTop back) is not a gesture", () => {
		// The view remembers lastTop across renders: the new scroll area is set to the same scrollTop, the next event has delta 0.
		const remembered = last(run([TOOLS, TOOLS + 100, TOOLS + 1500]));
		expect(remembered.hidden).toBe(true);
		const afterRestore = nextToolsState(remembered, base({ top: TOOLS + 1500 }));
		expect(afterRestore).toEqual(remembered);
	});

	it("initialToolsState can start hidden at a given position", () => {
		expect(initialToolsState(700, true)).toEqual({ hidden: true, lastTop: 700, travel: 0 });
		expect(initialToolsState()).toEqual({ hidden: false, lastTop: 0, travel: 0 });
	});
});
