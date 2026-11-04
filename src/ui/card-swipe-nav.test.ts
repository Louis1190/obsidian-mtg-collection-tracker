// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { registerCardSwipeNav, type SwipeNav } from "./card-swipe-nav";
import { closeOpenPickerMenu, openPickerMenu } from "./picker-menu";

// jsdom has no layout and no Touch constructor: the events are plain Events carrying the fields the
// handlers read, and the sideways-scroller check is fed through scrollWidth/clientWidth + inline overflow.

interface Pt {
	x: number;
	y: number;
}

let contentEl: HTMLElement;
let layout: HTMLElement;
let input: HTMLInputElement;
let track: HTMLElement;
let trackChild: HTMLElement;
let plain: HTMLElement;
let svgDot: SVGElement;
let go: Mock<SwipeNav>;
let clock = 0;

function touchEvent(type: string, points: Pt[], changed: Pt[] = points): Event {
	const evt = new Event(type, { bubbles: true });
	const toList = (ps: Pt[]) => ps.map((p) => ({ clientX: p.x, clientY: p.y }));
	Object.defineProperty(evt, "touches", { value: type === "touchend" ? [] : toList(points) });
	Object.defineProperty(evt, "changedTouches", { value: toList(changed) });
	Object.defineProperty(evt, "timeStamp", { value: clock });
	return evt;
}

// A finger going from `a` to `b` in `ms`, with a move event halfway.
function swipe(target: Element, a: Pt, b: Pt, ms = 400) {
	clock = 1000;
	target.dispatchEvent(touchEvent("touchstart", [a]));
	clock += ms / 2;
	target.dispatchEvent(touchEvent("touchmove", [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]));
	clock += ms / 2;
	target.dispatchEvent(touchEvent("touchmove", [b]));
	target.dispatchEvent(touchEvent("touchend", [], [b]));
}

const LEFT = { from: { x: 300, y: 400 }, to: { x: 150, y: 400 } };

beforeEach(() => {
	document.body.className = "is-phone";
	Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
	document.body.innerHTML = "";
	contentEl = document.createElement("div");
	contentEl.innerHTML = `
		<div class="mtg-card-detail-nav-header"></div>
		<div class="mtg-card-detail-layout">
			<div class="plain"><svg><circle id="dot"></circle></svg></div>
			<input type="text" />
			<div class="track"><div class="tile"></div></div>
		</div>`;
	document.body.appendChild(contentEl);
	layout = contentEl.querySelector(".mtg-card-detail-layout") as HTMLElement;
	input = contentEl.querySelector("input") as HTMLInputElement;
	track = contentEl.querySelector(".track") as HTMLElement;
	trackChild = contentEl.querySelector(".tile") as HTMLElement;
	plain = contentEl.querySelector(".plain") as HTMLElement;
	svgDot = contentEl.querySelector("#dot") as SVGElement;
	// The layout is the vertical scroller: overflow-x computes to "auto" and it may overflow by a pixel or more.
	layout.style.overflowX = "auto";
	Object.defineProperty(layout, "scrollWidth", { value: 420, configurable: true });
	Object.defineProperty(layout, "clientWidth", { value: 390, configurable: true });
	go = vi.fn<SwipeNav>();
	registerCardSwipeNav(contentEl, go);
});

afterEach(() => {
	document.body.className = "";
});

describe("registerCardSwipeNav", () => {
	it("a swipe to the left asks for the next card, a swipe to the right for the previous one", () => {
		swipe(plain, LEFT.from, LEFT.to);
		expect(go).toHaveBeenLastCalledWith("next");
		swipe(plain, LEFT.to, LEFT.from);
		expect(go).toHaveBeenLastCalledWith("prev");
		expect(go).toHaveBeenCalledTimes(2);
	});

	it("works from an SVG element too (the price chart)", () => {
		swipe(svgDot, LEFT.from, LEFT.to);
		expect(go).toHaveBeenCalledWith("next");
	});

	it("does nothing off a phone (a tablet and a computer keep their arrows)", () => {
		document.body.classList.remove("is-phone");
		swipe(plain, LEFT.from, LEFT.to);
		expect(go).not.toHaveBeenCalled();
		// ... and starts working as soon as the window becomes a phone one (is-phone flips live).
		document.body.classList.add("is-phone");
		swipe(plain, LEFT.from, LEFT.to);
		expect(go).toHaveBeenCalledTimes(1);
	});

	it("ignores a touch that starts at a screen edge (the system's own gestures)", () => {
		swipe(plain, { x: 8, y: 400 }, { x: 200, y: 400 });
		swipe(plain, { x: 385, y: 400 }, { x: 150, y: 400 });
		expect(go).not.toHaveBeenCalled();
	});

	it("ignores a gesture that starts in a text field", () => {
		swipe(input, LEFT.from, LEFT.to);
		expect(go).not.toHaveBeenCalled();
	});

	it("ignores a gesture that starts in a sideways scroller, but not in one that has nothing to scroll", () => {
		track.style.overflowX = "auto";
		Object.defineProperty(track, "scrollWidth", { value: 700, configurable: true });
		Object.defineProperty(track, "clientWidth", { value: 350, configurable: true });
		swipe(trackChild, LEFT.from, LEFT.to);
		expect(go).not.toHaveBeenCalled();

		Object.defineProperty(track, "scrollWidth", { value: 350, configurable: true });
		swipe(trackChild, LEFT.from, LEFT.to);
		expect(go).toHaveBeenCalledTimes(1);
	});

	it("does not treat the vertical scroller (the layout itself) as a sideways one", () => {
		swipe(layout, LEFT.from, LEFT.to);
		expect(go).toHaveBeenCalledWith("next");
	});

	it("does nothing on the 'Remove this card?' screen (no nav header)", () => {
		contentEl.querySelector(".mtg-card-detail-nav-header")?.remove();
		swipe(plain, LEFT.from, LEFT.to);
		expect(go).not.toHaveBeenCalled();
	});

	it("does nothing for a scroll (mostly vertical) or a short drag", () => {
		swipe(plain, { x: 300, y: 300 }, { x: 200, y: 560 });
		swipe(plain, { x: 300, y: 400 }, { x: 270, y: 400 }, 600);
		expect(go).not.toHaveBeenCalled();
	});

	it("a quick short flick is enough", () => {
		swipe(plain, { x: 300, y: 400 }, { x: 265, y: 400 }, 60);
		expect(go).toHaveBeenCalledWith("next");
	});

	it("a second finger cancels the gesture", () => {
		clock = 1000;
		plain.dispatchEvent(touchEvent("touchstart", [LEFT.from]));
		plain.dispatchEvent(touchEvent("touchmove", [LEFT.from, { x: 100, y: 100 }]));
		plain.dispatchEvent(touchEvent("touchend", [], [LEFT.to]));
		expect(go).not.toHaveBeenCalled();
	});

	it("a cancelled touch (the browser took the gesture over) does nothing", () => {
		clock = 1000;
		plain.dispatchEvent(touchEvent("touchstart", [LEFT.from]));
		plain.dispatchEvent(touchEvent("touchmove", [LEFT.to]));
		plain.dispatchEvent(touchEvent("touchcancel", [LEFT.to]));
		plain.dispatchEvent(touchEvent("touchend", [], [LEFT.to]));
		expect(go).not.toHaveBeenCalled();
	});

	it("registering again (every draw) replaces the function without stacking listeners", () => {
		const next = vi.fn<SwipeNav>();
		registerCardSwipeNav(contentEl, next);
		registerCardSwipeNav(contentEl, next);
		swipe(plain, LEFT.from, LEFT.to);
		expect(go).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});

	describe("with a picker menu open (Finish, Condition, Language)", () => {
		const openMenu = () => {
			const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
			proto.createDiv = function (this: HTMLElement, o?: { cls?: string }) {
				const d = document.createElement("div");
				if (o?.cls) d.className = o.cls;
				this.appendChild(d);
				return d;
			};
			proto.addClass = function (this: HTMLElement, c: string) {
				this.classList.add(c);
			};
			openPickerMenu(plain, [{ render: (el) => (el.textContent = "Foil"), onSelect: () => {} }]);
		};
		const menus = () => document.querySelectorAll(".mtg-picker-menu").length;
		afterEach(() => closeOpenPickerMenu());

		it("a swipe closes it, and still asks for the other card", () => {
			openMenu();
			expect(menus()).toBe(1);
			swipe(plain, LEFT.from, LEFT.to);
			expect(menus()).toBe(0);
			expect(go).toHaveBeenCalledWith("next");
		});

		it("so does a swipe the other way", () => {
			openMenu();
			swipe(plain, LEFT.to, LEFT.from);
			expect(menus()).toBe(0);
			expect(go).toHaveBeenCalledWith("prev");
		});

		it("a vertical scroll is not a swipe: the menu stays (it follows the scroll)", () => {
			openMenu();
			swipe(plain, { x: 300, y: 600 }, { x: 305, y: 300 });
			expect(menus()).toBe(1);
			expect(go).not.toHaveBeenCalled();
		});
	});
});

