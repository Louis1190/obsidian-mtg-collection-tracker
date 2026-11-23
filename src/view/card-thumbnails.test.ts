// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hideCardNamePreview, showCardNamePreview } from "./card-thumbnails";
import type { MTGCollectionView } from "../view";

// The hover preview of a name (Table view) is ONE element on <body>, created when the view opens. A view dragged into a popout window hovers
// names in another document with its own viewport: the preview has to follow the name there, and the position is computed against THAT window.

function installHelpers(win: Window) {
	const proto = (win as unknown as { HTMLElement: { prototype: unknown } }).HTMLElement.prototype as Record<string, unknown>;
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
	proto.removeClass = function (this: HTMLElement, c: string) {
		this.classList.remove(c);
	};
}

function fakeView() {
	const el = document.createElement("div");
	const img = document.createElement("img");
	el.appendChild(img);
	document.body.appendChild(el);
	return { cardNamePreviewEl: el, cardNamePreviewImgEl: img } as unknown as MTGCollectionView;
}

// A popout window: an iframe has its own window and document, and its own viewport (set here: jsdom gives every window 1024 x 768).
function popout(innerWidth: number, innerHeight: number) {
	const frame = document.createElement("iframe");
	document.body.appendChild(frame);
	const win = frame.contentWindow as Window & typeof globalThis;
	installHelpers(win);
	Object.defineProperty(win, "innerWidth", { value: innerWidth });
	Object.defineProperty(win, "innerHeight", { value: innerHeight });
	return win;
}

function nameAt(doc: Document, rect: { left: number; right: number; top: number }) {
	const name = doc.createElement("span");
	doc.body.appendChild(name);
	name.getBoundingClientRect = () => ({ ...rect, bottom: rect.top + 20, width: rect.right - rect.left, height: 20 }) as DOMRect;
	return name;
}

beforeEach(() => {
	installHelpers(window);
	document.body.innerHTML = "";
});
afterEach(() => {
	document.body.innerHTML = "";
});

describe("showCardNamePreview", () => {
	it("shows the picture to the right of the hovered name in the main window", () => {
		const view = fakeView();
		showCardNamePreview.call(view, nameAt(document, { left: 100, right: 200, top: 50 }), "https://example.test/a.jpg");
		expect(view.cardNamePreviewImgEl.src).toBe("https://example.test/a.jpg");
		expect(view.cardNamePreviewEl.style.left).toBe("212px"); // right edge + the 12px margin
		expect(view.cardNamePreviewEl.classList.contains("is-visible")).toBe(true);
		expect(view.cardNamePreviewEl.parentElement).toBe(document.body);
	});

	it("follows the hovered name into a popout window: the element moves there", () => {
		const view = fakeView();
		const win = popout(1024, 768);
		showCardNamePreview.call(view, nameAt(win.document, { left: 100, right: 200, top: 50 }), "https://example.test/a.jpg");
		expect(view.cardNamePreviewEl.parentElement).toBe(win.document.body);
		expect(view.cardNamePreviewEl.ownerDocument).toBe(win.document);
		expect(view.cardNamePreviewEl.classList.contains("is-visible")).toBe(true);
		expect(document.querySelector(".is-visible")).toBeNull();
	});

	it("measures the viewport of the popout window, not the main window's", () => {
		const view = fakeView();
		const win = popout(300, 768); // narrow popout: the 220px preview would overflow on the right of a name ending at 250
		showCardNamePreview.call(view, nameAt(win.document, { left: 150, right: 250, top: 50 }), "https://example.test/a.jpg");
		// Flipped to the left of the name (-82px), then clamped on the 12px margin. Measured against the main window's 1024px it would stay at 262px.
		expect(view.cardNamePreviewEl.style.left).toBe("12px");
		expect(window.innerWidth).toBe(1024);
	});

	it("comes back to the main window when a name is hovered there, and is not moved when it is already in the right window", () => {
		const view = fakeView();
		const win = popout(1024, 768);
		showCardNamePreview.call(view, nameAt(win.document, { left: 100, right: 200, top: 50 }), "https://example.test/a.jpg");
		showCardNamePreview.call(view, nameAt(document, { left: 100, right: 200, top: 50 }), "https://example.test/b.jpg");
		expect(view.cardNamePreviewEl.ownerDocument).toBe(document);
		const append = vi.spyOn(document.body, "appendChild");
		const hovered = nameAt(document, { left: 120, right: 220, top: 60 }); // (appending the name itself is not the preview moving)
		append.mockClear();
		showCardNamePreview.call(view, hovered, "https://example.test/c.jpg");
		expect(append).not.toHaveBeenCalled();
		expect(view.cardNamePreviewImgEl.src).toBe("https://example.test/c.jpg");
	});

	it("shows nothing for a card with no picture", () => {
		const view = fakeView();
		showCardNamePreview.call(view, nameAt(document, { left: 100, right: 200, top: 50 }), "");
		expect(view.cardNamePreviewEl.classList.contains("is-visible")).toBe(false);
	});

	it("hides it", () => {
		const view = fakeView();
		showCardNamePreview.call(view, nameAt(document, { left: 100, right: 200, top: 50 }), "https://example.test/a.jpg");
		hideCardNamePreview.call(view);
		expect(view.cardNamePreviewEl.classList.contains("is-visible")).toBe(false);
	});
});
