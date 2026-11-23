// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDetailTools } from "./detail-tools";
import type { MTGCollectionView } from "../view";
import { initialToolsState } from "../core/header-autohide";

// The DOM half of the phone's collapsing list header. The decision itself (when to hide) is core/header-autohide.test.ts: here, what
// the function does with the elements and the view's remembered state.

const TOOLS_H = 200;

let resizeCallbacks: (() => void)[] = [];
class FakeResizeObserver {
	constructor(cb: () => void) {
		resizeCallbacks.push(cb);
	}
	observe() {}
	disconnect() {}
}

// Obsidian's class helpers are not in jsdom.
function installHelpers() {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
	proto.toggleClass = function (this: HTMLElement, c: string, on: boolean) {
		this.classList.toggle(c, on);
	};
}

function fakeView(over: Partial<{ lastRenderedViewKey: string | null; detailToolsState: unknown }> = {}) {
	return { lastRenderedViewKey: "collection:l1::", detailToolsState: null, ...over } as unknown as MTGCollectionView & {
		detailToolsState: { key: string; state: { hidden: boolean; lastTop: number; travel: number } } | null;
	};
}

function build() {
	document.body.innerHTML = "";
	const header = document.createElement("div");
	const tools = document.createElement("div");
	const input = document.createElement("input");
	tools.appendChild(input);
	header.appendChild(tools);
	const scrollArea = document.createElement("div");
	const content = document.createElement("div");
	scrollArea.appendChild(content);
	document.body.append(header, scrollArea);
	let top = 0;
	Object.defineProperty(scrollArea, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
	Object.defineProperty(scrollArea, "clientHeight", { value: 600, configurable: true });
	Object.defineProperty(scrollArea, "scrollHeight", { value: 10000, configurable: true });
	Object.defineProperty(tools, "offsetHeight", { value: TOOLS_H, configurable: true });
	return { header, tools, input, scrollArea };
}

// One scroll event at a given position, like the browser's.
const scrollTo = (el: HTMLElement, top: number) => {
	el.scrollTop = top;
	el.dispatchEvent(new Event("scroll"));
};
const fireResize = () => resizeCallbacks.forEach((cb) => cb());

beforeEach(() => {
	installHelpers();
	resizeCallbacks = [];
	vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	vi.useFakeTimers();
	document.body.className = "is-phone";
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.className = "";
});

describe("attachDetailTools", () => {
	it("does nothing off a phone: the rows stay in the header, no class, no listener", () => {
		document.body.className = "";
		const { header, tools, scrollArea } = build();
		const view = fakeView();
		attachDetailTools.call(view, tools, header, scrollArea, false);
		expect(tools.parentElement).toBe(header);
		expect(scrollArea.className).toBe("");
		expect(header.className).toBe("");
		scrollTo(scrollArea, 5000);
		expect(tools.classList.contains("is-hidden")).toBe(false);
		expect(view.detailToolsState).toBeNull();
	});

	it("on a phone moves the rows to the very top of the scrolling area and marks both containers", () => {
		const { header, tools, scrollArea } = build();
		attachDetailTools.call(fakeView(), tools, header, scrollArea, false);
		expect(scrollArea.firstElementChild).toBe(tools);
		expect(scrollArea.classList.contains("has-sticky-tools")).toBe(true);
		expect(header.classList.contains("has-detached-tools")).toBe(true);
	});

	it("hides on a scroll down past their place and shows again on a short scroll up, on the rows and on the scroller", () => {
		const { header, tools, scrollArea } = build();
		attachDetailTools.call(fakeView(), tools, header, scrollArea, false);
		fireResize();
		scrollTo(scrollArea, TOOLS_H - 20);
		expect(tools.classList.contains("is-hidden")).toBe(false);
		scrollTo(scrollArea, TOOLS_H + 30);
		scrollTo(scrollArea, TOOLS_H + 60);
		expect(tools.classList.contains("is-hidden")).toBe(true);
		expect(scrollArea.classList.contains("is-tools-hidden")).toBe(true);
		scrollTo(scrollArea, TOOLS_H + 40);
		expect(tools.classList.contains("is-hidden")).toBe(false);
		expect(scrollArea.classList.contains("is-tools-hidden")).toBe(false);
	});

	it("stays shown inside the rows' own place, however big the first gesture (their height is the one the observer measured)", () => {
		const { header, tools, scrollArea } = build();
		attachDetailTools.call(fakeView(), tools, header, scrollArea, false);
		fireResize();
		// 150 px is inside their place (200): a gesture of 150 px down does not hide them
		scrollTo(scrollArea, 150);
		expect(tools.classList.contains("is-hidden")).toBe(false);
	});

	it("remembers the state on the view and gives it back to a rebuilt header of the same view (render() rebuilds everything)", () => {
		const view = fakeView();
		const first = build();
		attachDetailTools.call(view, first.tools, first.header, first.scrollArea, false);
		fireResize();
		scrollTo(first.scrollArea, TOOLS_H + 30);
		scrollTo(first.scrollArea, TOOLS_H + 400);
		expect(view.detailToolsState?.state.hidden).toBe(true);
		expect(view.detailToolsState?.key).toBe("collection:l1::");

		// render(): a new header and scroller; render() gives the scroller its old scrollTop back right after the swap (before any layout),
		// which is then not a gesture
		resizeCallbacks = [];
		const second = build();
		attachDetailTools.call(view, second.tools, second.header, second.scrollArea, false);
		second.scrollArea.scrollTop = TOOLS_H + 400;
		fireResize();
		expect(second.tools.classList.contains("is-hidden")).toBe(true);
		expect(second.scrollArea.classList.contains("is-tools-hidden")).toBe(true);
		scrollTo(second.scrollArea, TOOLS_H + 400);
		expect(second.tools.classList.contains("is-hidden")).toBe(true);
	});

	it("a remembered 'hidden' on a scroller that starts at the top is corrected at the first layout: the rows are never out of sight over an empty band", () => {
		// Real phone, 1.0.656: a deck left with its rows hidden, reopened from the gallery (scrollTop 0, the same view key as before): no scroll event
		// ever comes while the list rests at the top, so nothing brought the rows back and a 250 px black band showed under the title.
		const view = fakeView({ detailToolsState: { key: "collection:l1::", state: { hidden: true, lastTop: 11313, travel: 2309 } } });
		const { header, tools, scrollArea } = build();
		attachDetailTools.call(view, tools, header, scrollArea, false);
		fireResize();
		expect(tools.classList.contains("is-hidden")).toBe(false);
		expect(scrollArea.classList.contains("is-tools-hidden")).toBe(false);
		expect(view.detailToolsState?.state.hidden).toBe(false);
	});

	it("decides nothing while the rows have no box yet (a window not on screen keeps what it remembered)", () => {
		const view = fakeView({ detailToolsState: { key: "collection:l1::", state: { hidden: true, lastTop: 900, travel: 0 } } });
		const { header, tools, scrollArea } = build();
		Object.defineProperty(tools, "offsetHeight", { value: 0, configurable: true });
		attachDetailTools.call(view, tools, header, scrollArea, false);
		// 200 px above where it was remembered: a real position that WOULD bring the rows back, were it read with a box to judge by
		scrollArea.scrollTop = 700;
		fireResize();
		expect(tools.classList.contains("is-hidden")).toBe(true);
	});

	it("starts shown for another list, deck or wantlist", () => {
		const view = fakeView({ detailToolsState: { key: "collection:l1::", state: { hidden: true, lastTop: 900, travel: 0 } } });
		view.lastRenderedViewKey = "collection:l2::";
		const { header, tools, scrollArea } = build();
		attachDetailTools.call(view, tools, header, scrollArea, false);
		expect(tools.classList.contains("is-hidden")).toBe(false);
		expect(view.detailToolsState?.key).toBe("collection:l2::");
		expect(view.detailToolsState?.state).toEqual(initialToolsState());
	});

	it("select mode keeps them shown, even when the remembered state was hidden, and whatever the scroll", () => {
		const view = fakeView({ detailToolsState: { key: "collection:l1::", state: { hidden: true, lastTop: 900, travel: 0 } } });
		const { header, tools, scrollArea } = build();
		attachDetailTools.call(view, tools, header, scrollArea, true);
		fireResize();
		expect(tools.classList.contains("is-hidden")).toBe(false);
		scrollTo(scrollArea, 1000);
		scrollTo(scrollArea, 3000);
		expect(tools.classList.contains("is-hidden")).toBe(false);
	});

	it("a focus inside the rows keeps them shown while it lasts, and a focus that reaches hidden rows brings them back", () => {
		const { header, tools, input, scrollArea } = build();
		attachDetailTools.call(fakeView(), tools, header, scrollArea, false);
		fireResize();
		scrollTo(scrollArea, TOOLS_H + 30);
		scrollTo(scrollArea, TOOLS_H + 100);
		expect(tools.classList.contains("is-hidden")).toBe(true);
		input.focus();
		input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(tools.classList.contains("is-hidden")).toBe(false);
		expect(scrollArea.classList.contains("is-tools-hidden")).toBe(false);
		scrollTo(scrollArea, TOOLS_H + 800);
		scrollTo(scrollArea, TOOLS_H + 1200);
		expect(tools.classList.contains("is-hidden")).toBe(false); // typing in the search: the keyboard is up
		input.blur();
		scrollTo(scrollArea, TOOLS_H + 1300);
		expect(tools.classList.contains("is-hidden")).toBe(true);
	});

	it("switches the slide animation on only after the first frames (a rebuilt hidden header must not slide out in view)", () => {
		const { header, tools, scrollArea } = build();
		attachDetailTools.call(fakeView(), tools, header, scrollArea, false);
		expect(tools.classList.contains("is-animated")).toBe(false);
		vi.advanceTimersByTime(100);
		expect(tools.classList.contains("is-animated")).toBe(true);
	});
});
