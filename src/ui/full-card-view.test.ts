// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// full-card-view.ts imports Obsidian's setIcon at load.
vi.mock("obsidian", () => ({ setIcon: (el: HTMLElement, name: string) => el.setAttribute("data-icon", name) }));

import {
	FULL_CARD_CLOSE_MS,
	FULL_CARD_DECODE_NET_MS,
	addFullCardButton,
	openFullCardView,
	resolveFullCardUrl,
} from "./full-card-view";
import { closeOpenPickerMenu, openPickerMenu } from "./picker-menu";

// The helpers Obsidian adds to HTMLElement that the file (and the picker menu) use, on jsdom.
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createDiv = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		const d = document.createElement("div");
		if (o?.cls) d.className = o.cls;
		if (o?.text) d.textContent = o.text;
		this.appendChild(d);
		return d;
	};
	proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		if (o?.text) e.textContent = o.text;
		this.appendChild(e);
		return e;
	};
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
	proto.toggleClass = function (this: HTMLElement, c: string, on: boolean) {
		this.classList.toggle(c, on);
	};
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	document.body.innerHTML = "";
	vi.useFakeTimers();
});

afterEach(() => {
	closeOpenPickerMenu();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

function windowEl(): HTMLElement {
	const contentEl = document.createElement("div");
	document.body.appendChild(contentEl);
	return contentEl;
}
const overlayOf = (contentEl: HTMLElement) => contentEl.querySelector<HTMLElement>(".mtg-card-detail-fullcard");
const imgOf = (contentEl: HTMLElement) => contentEl.querySelector<HTMLImageElement>(".mtg-card-detail-fullcard-img");
// Lets the promise returned by `getUrl` settle, then the `.then` of the opener.
const settle = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("openFullCardView", () => {
	it("shows the scrim and the cross at once, the card only after its picture has loaded", async () => {
		const contentEl = windowEl();
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		const overlay = overlayOf(contentEl)!;
		expect(overlay).not.toBeNull();
		expect(overlay.querySelector(".mtg-card-detail-close-btn")).not.toBeNull();
		await settle();
		expect(imgOf(contentEl)!.getAttribute("src")).toBe("https://cards.example/front.jpg");
		expect(overlay.classList.contains("is-ready")).toBe(false);
		imgOf(contentEl)!.dispatchEvent(new Event("load"));
		expect(overlay.classList.contains("is-ready")).toBe(true);
	});

	it("waits for the picture to be decoded when the browser can say so", async () => {
		const contentEl = windowEl();
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		await settle();
		const img = imgOf(contentEl)!;
		let resolveDecode: () => void = () => {};
		img.decode = () => new Promise<void>((resolve) => (resolveDecode = resolve));
		img.dispatchEvent(new Event("load"));
		expect(overlayOf(contentEl)!.classList.contains("is-ready")).toBe(false);
		resolveDecode();
		await settle();
		expect(overlayOf(contentEl)!.classList.contains("is-ready")).toBe(true);
	});

	it("rounds the corners harder for an Alpha card, as the classic window does", () => {
		const alpha = windowEl();
		openFullCardView(alpha, () => Promise.resolve("https://cards.example/front.jpg"), { alpha: true });
		expect(alpha.querySelector(".mtg-card-detail-fullcard-card")!.classList.contains("is-alpha")).toBe(true);
		const other = windowEl();
		openFullCardView(other, () => Promise.resolve("https://cards.example/front.jpg"));
		expect(other.querySelector(".mtg-card-detail-fullcard-card")!.classList.contains("is-alpha")).toBe(false);
	});

	it("rises anyway when the decoding never ends (a window that draws no frames)", async () => {
		const contentEl = windowEl();
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		await settle();
		const img = imgOf(contentEl)!;
		img.decode = () => new Promise<void>(() => {});
		img.dispatchEvent(new Event("load"));
		const overlay = overlayOf(contentEl)!;
		vi.advanceTimersByTime(FULL_CARD_DECODE_NET_MS - 1);
		expect(overlay.classList.contains("is-ready")).toBe(false);
		vi.advanceTimersByTime(2);
		expect(overlay.classList.contains("is-ready")).toBe(true);
	});

	it("opens only one overlay however many times it is asked", () => {
		const contentEl = windowEl();
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		expect(contentEl.querySelectorAll(".mtg-card-detail-fullcard").length).toBe(1);
	});

	it("a tap anywhere closes it: the closing class first, the element once the animation ends", async () => {
		const contentEl = windowEl();
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		await settle();
		imgOf(contentEl)!.dispatchEvent(new Event("load"));
		const overlay = overlayOf(contentEl)!;
		overlay.querySelector<HTMLElement>(".mtg-card-detail-close-btn")!.click();
		expect(overlay.classList.contains("is-closing")).toBe(true);
		expect(overlay.isConnected).toBe(true);
		// An animation of a child (the card sinking) ending does not remove it, the overlay's own does.
		overlay.querySelector(".mtg-card-detail-fullcard-card")!.dispatchEvent(new Event("animationend", { bubbles: true }));
		expect(overlay.isConnected).toBe(true);
		overlay.dispatchEvent(new Event("animationend", { bubbles: true }));
		expect(overlay.isConnected).toBe(false);
	});

	it("is removed by the timer when no animation ever ends (a hidden window runs no frames)", async () => {
		const contentEl = windowEl();
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		await settle();
		const overlay = overlayOf(contentEl)!;
		overlay.click();
		vi.advanceTimersByTime(FULL_CARD_CLOSE_MS);
		expect(overlay.isConnected).toBe(true);
		vi.advanceTimersByTime(400);
		expect(overlay.isConnected).toBe(false);
		// And it can be opened again.
		openFullCardView(contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		expect(overlayOf(contentEl)).not.toBeNull();
	});

	it("closed before the picture was known, it never comes back", async () => {
		const contentEl = windowEl();
		let resolveUrl: (url: string) => void = () => {};
		openFullCardView(contentEl, () => new Promise<string>((resolve) => (resolveUrl = resolve)));
		const overlay = overlayOf(contentEl)!;
		overlay.click();
		vi.advanceTimersByTime(1000);
		resolveUrl("https://cards.example/front.jpg");
		await settle();
		expect(overlay.isConnected).toBe(false);
		// No picture is even requested for an overlay that is gone.
		expect(overlay.querySelector("img")).toBeNull();
	});

	it("says so, on the card's place, when the picture fails or there is none", async () => {
		const failing = windowEl();
		openFullCardView(failing, () => Promise.resolve("https://cards.example/missing.jpg"));
		await settle();
		imgOf(failing)!.dispatchEvent(new Event("error"));
		expect(overlayOf(failing)!.classList.contains("is-ready")).toBe(true);
		expect(failing.querySelector(".mtg-card-detail-fullcard-card.is-error")!.textContent).toContain("could not be loaded");
		expect(imgOf(failing)).toBeNull();

		const none = windowEl();
		openFullCardView(none, () => Promise.resolve(undefined));
		await settle();
		expect(none.querySelector(".mtg-card-detail-fullcard-card.is-error")).not.toBeNull();

		const rejected = windowEl();
		openFullCardView(rejected, () => Promise.reject(new Error("offline")));
		await settle();
		expect(rejected.querySelector(".mtg-card-detail-fullcard-card.is-error")).not.toBeNull();
	});
});

describe("addFullCardButton", () => {
	it("adds a square button of the condition / language stack that opens the overlay", async () => {
		const contentEl = windowEl();
		const stack = contentEl.appendChild(document.createElement("div"));
		const button = addFullCardButton(stack, contentEl, () => Promise.resolve("https://cards.example/front.jpg"));
		expect(button.parentElement).toBe(stack);
		expect(button.classList.contains("mtg-card-detail-image-icon-btn")).toBe(true);
		expect(button.getAttribute("data-icon")).toBe("maximize-2");
		expect(overlayOf(contentEl)).toBeNull();
		button.click();
		expect(overlayOf(contentEl)).not.toBeNull();
		await settle();
		expect(imgOf(contentEl)!.getAttribute("src")).toBe("https://cards.example/front.jpg");
	});

	it("hands the Alpha option on to the overlay", () => {
		const contentEl = windowEl();
		const button = addFullCardButton(
			contentEl.appendChild(document.createElement("div")),
			contentEl,
			() => Promise.resolve("https://cards.example/front.jpg"),
			{ alpha: true }
		);
		button.click();
		expect(contentEl.querySelector(".mtg-card-detail-fullcard-card")!.classList.contains("is-alpha")).toBe(true);
	});

	it("asks for the picture when it is tapped, not when it is built (the card or its face may have changed)", () => {
		const contentEl = windowEl();
		const getUrl = vi.fn(() => Promise.resolve("https://cards.example/front.jpg"));
		const button = addFullCardButton(contentEl.appendChild(document.createElement("div")), contentEl, getUrl);
		expect(getUrl).not.toHaveBeenCalled();
		button.click();
		expect(getUrl).toHaveBeenCalledTimes(1);
	});

	it("closes an open Finish / Condition / Language menu, which lives on <body> above the window", () => {
		const contentEl = windowEl();
		const button = addFullCardButton(contentEl.appendChild(document.createElement("div")), contentEl, () =>
			Promise.resolve("https://cards.example/front.jpg")
		);
		openPickerMenu(document.createElement("div"), [{ render: (el) => (el.textContent = "Foil"), onSelect: () => {} }]);
		expect(document.querySelectorAll(".mtg-picker-menu").length).toBe(1);
		button.click();
		expect(document.querySelectorAll(".mtg-picker-menu").length).toBe(0);
	});
});

describe("resolveFullCardUrl", () => {
	const faces = vi.fn((id: string) => Promise.resolve(id === "dfc" ? { back: "https://cards.example/back.jpg" } : null));

	it("is the card's own picture unless a double-faced card has been flipped", async () => {
		expect(await resolveFullCardUrl(faces, "dfc", false, "https://cards.example/front.jpg")).toBe("https://cards.example/front.jpg");
		expect(faces).not.toHaveBeenCalled();
		expect(await resolveFullCardUrl(faces, "dfc", true, "https://cards.example/front.jpg")).toBe("https://cards.example/back.jpg");
	});

	it("keeps the front when the flipped card has no back picture", async () => {
		expect(await resolveFullCardUrl(faces, "plain", true, "https://cards.example/front.jpg")).toBe("https://cards.example/front.jpg");
	});
});
