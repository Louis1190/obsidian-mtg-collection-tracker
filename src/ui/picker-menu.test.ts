// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenPickerMenu, openPickerMenu } from "./picker-menu";

// Obsidian's DOM helpers (createDiv, addClass) are not in jsdom: the two the menu uses. Obsidian installs them on every window,
// popout windows included, so they go on a given window's own HTMLElement.
function installHelpers(win: Window) {
	const proto = (win as unknown as { HTMLElement: { prototype: unknown } }).HTMLElement.prototype as Record<string, unknown>;
	proto.createDiv = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		const d = this.ownerDocument.createElement("div");
		if (o?.cls) d.className = o.cls;
		if (o?.text) d.textContent = o.text;
		this.appendChild(d);
		return d;
	};
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
}

beforeEach(() => {
	installHelpers(window);
	document.body.innerHTML = "";
	vi.useFakeTimers();
});

afterEach(() => {
	closeOpenPickerMenu();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

const menus = () => document.querySelectorAll(".mtg-picker-menu").length;
const items = (onSelect = vi.fn()) => [
	{ render: (el: HTMLElement) => (el.textContent = "Foil"), onSelect },
	{ render: (el: HTMLElement) => (el.textContent = "Etched"), onSelect },
];
// A window like the card detail window: persistent content element, a trigger inside it that draw() rebuilds.
function windowWithTrigger() {
	const contentEl = document.createElement("div");
	const trigger = document.createElement("div");
	contentEl.appendChild(trigger);
	document.body.appendChild(contentEl);
	return { contentEl, trigger };
}
// MutationObserver callbacks run as microtasks.
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("openPickerMenu", () => {
	it("opens one menu with the items it was given", () => {
		const { trigger } = windowWithTrigger();
		openPickerMenu(trigger, items());
		expect(menus()).toBe(1);
		expect(document.querySelectorAll(".mtg-picker-item").length).toBe(2);
	});

	it("closes when its trigger leaves the page: the window redrew itself for another card (the Finish menu that stayed open after a swipe)", async () => {
		const { contentEl, trigger } = windowWithTrigger();
		openPickerMenu(trigger, items());
		contentEl.replaceChildren(document.createElement("div")); // draw(): contentEl emptied, rebuilt
		await flush();
		expect(menus()).toBe(0);
	});

	it("stays open while its trigger is still there, whatever else the page does", async () => {
		const { contentEl, trigger } = windowWithTrigger();
		openPickerMenu(trigger, items());
		contentEl.appendChild(document.createElement("div"));
		document.body.appendChild(document.createElement("span")).remove();
		await flush();
		expect(menus()).toBe(1);
	});

	it("a trigger that was never on the page does not close its menu at the first mutation", async () => {
		const loose = document.createElement("div");
		openPickerMenu(loose, items());
		document.body.appendChild(document.createElement("span"));
		await flush();
		expect(menus()).toBe(1);
	});

	it("closeOpenPickerMenu closes it, and does nothing when there is none", () => {
		const { trigger } = windowWithTrigger();
		expect(() => closeOpenPickerMenu()).not.toThrow();
		openPickerMenu(trigger, items());
		closeOpenPickerMenu();
		expect(menus()).toBe(0);
	});

	it("a click outside closes it, a click on an item selects and closes", () => {
		const { trigger } = windowWithTrigger();
		const onSelect = vi.fn();
		openPickerMenu(trigger, items(onSelect));
		vi.advanceTimersByTime(1); // the outside-click listener is added on the next tick
		document.body.click();
		expect(menus()).toBe(0);
		openPickerMenu(trigger, items(onSelect));
		(document.querySelector(".mtg-picker-item") as HTMLElement).click();
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(menus()).toBe(0);
	});

	it("tapping the same trigger again closes the menu instead of reopening it", () => {
		const { trigger } = windowWithTrigger();
		openPickerMenu(trigger, items());
		openPickerMenu(trigger, items());
		expect(menus()).toBe(0);
	});

	it("opening another menu replaces the first one", () => {
		const a = windowWithTrigger().trigger;
		const b = windowWithTrigger().trigger;
		openPickerMenu(a, items());
		openPickerMenu(b, items());
		expect(menus()).toBe(1);
	});

	it("a closed menu no longer watches the page (its trigger leaving afterwards is harmless)", async () => {
		const { contentEl, trigger } = windowWithTrigger();
		openPickerMenu(trigger, items());
		closeOpenPickerMenu();
		const next = windowWithTrigger().trigger;
		openPickerMenu(next, items());
		contentEl.replaceChildren(); // the FIRST window goes away: the second menu is not its business
		await flush();
		expect(menus()).toBe(1);
	});
});

// A view dragged into a popout window lives in another window with its own document and viewport. An iframe has both, like Obsidian's popouts.
function popoutWindow() {
	const frame = document.createElement("iframe");
	document.body.appendChild(frame);
	const win = frame.contentWindow as Window & typeof globalThis;
	installHelpers(win);
	const doc = win.document;
	const trigger = doc.createElement("div");
	doc.body.appendChild(trigger);
	return { win, doc, trigger };
}
const menusIn = (doc: Document) => doc.querySelectorAll(".mtg-picker-menu").length;
const rectAt = (bottom: number, left: number) => () => ({ bottom, left, width: 50, top: bottom - 20, right: left + 50, height: 20 }) as DOMRect;

describe("openPickerMenu from a popout window", () => {
	it("opens the menu in the window of its trigger, never in the main window", () => {
		const { doc, trigger } = popoutWindow();
		openPickerMenu(trigger, items());
		expect(menusIn(doc)).toBe(1);
		expect(menusIn(document)).toBe(0);
	});

	it("follows its trigger when the popout window scrolls (the main window's scroll is not its business)", () => {
		const { win, trigger } = popoutWindow();
		trigger.getBoundingClientRect = rectAt(100, 10);
		openPickerMenu(trigger, items());
		const menu = win.document.querySelector(".mtg-picker-menu") as HTMLElement;
		expect(menu.style.top).toBe("104px");
		trigger.getBoundingClientRect = rectAt(300, 40);
		window.dispatchEvent(new Event("scroll")); // the MAIN window scrolled: nothing to follow
		expect(menu.style.top).toBe("104px");
		win.dispatchEvent(new win.Event("scroll"));
		expect(menu.style.top).toBe("304px");
		expect(menu.style.left).toBe("40px");
	});

	it("a click elsewhere in the popout window closes it, a click in the main window leaves it alone", () => {
		const { doc, trigger } = popoutWindow();
		openPickerMenu(trigger, items());
		vi.advanceTimersByTime(1);
		document.body.click();
		expect(menusIn(doc)).toBe(1);
		doc.body.click();
		expect(menusIn(doc)).toBe(0);
	});

	it("closes when its trigger leaves the popout window", async () => {
		const { doc, trigger } = popoutWindow();
		openPickerMenu(trigger, items());
		trigger.remove();
		await flush();
		expect(menusIn(doc)).toBe(0);
	});

	it("its listeners leave with it: the popout window's, not the main window's", () => {
		const { win, trigger } = popoutWindow();
		const popoutRemove = vi.spyOn(win, "removeEventListener");
		const mainRemove = vi.spyOn(window, "removeEventListener");
		openPickerMenu(trigger, items());
		closeOpenPickerMenu();
		expect(popoutRemove.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
		expect(mainRemove).not.toHaveBeenCalled();
	});

	it("a menu opened in the popout window replaces the one open in the main window, and the other way round", () => {
		const { doc, trigger } = popoutWindow();
		const main = windowWithTrigger().trigger;
		openPickerMenu(main, items());
		openPickerMenu(trigger, items());
		expect(menusIn(document)).toBe(0);
		expect(menusIn(doc)).toBe(1);
		openPickerMenu(main, items());
		expect(menusIn(doc)).toBe(0);
		expect(menusIn(document)).toBe(1);
	});
});
