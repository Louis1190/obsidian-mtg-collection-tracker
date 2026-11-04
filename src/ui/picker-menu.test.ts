// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenPickerMenu, openPickerMenu } from "./picker-menu";

// Obsidian's DOM helpers (createDiv, addClass) are not in jsdom: the two the menu uses.
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createDiv = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		const d = document.createElement("div");
		if (o?.cls) d.className = o.cls;
		if (o?.text) d.textContent = o.text;
		this.appendChild(d);
		return d;
	};
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
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
