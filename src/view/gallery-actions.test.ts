// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeGalleryActionButtons, watchGalleryActionsPlacement } from "./gallery-actions";
import type { MTGCollectionView } from "../view";

// Where the gallery buttons sit: the header on a phone, the slot to the right of each gallery's search bar elsewhere. The layout itself is measured in the
// harness; here, what the function does with the six persistent elements.

const div = (cls: string) => {
	const el = document.createElement("div");
	el.className = cls;
	return el;
};

interface Fake {
	view: MTGCollectionView & { registered: (() => void)[] };
	header: HTMLElement;
	slots: HTMLElement[];
	buttons: HTMLElement[];
}

function build(): Fake {
	document.body.innerHTML = "";
	document.body.className = "";
	const header = div("header");
	const title = div("title");
	header.appendChild(title);
	const slots = [div("slot-collection"), div("slot-decks"), div("slot-wantlists")];
	const toolbars = slots.map((slot) => {
		const toolbar = div("toolbar");
		toolbar.append(div("filter"), slot);
		return toolbar;
	});
	const buttons = ["newList", "selectList", "newDeck", "selectDeck", "newWantlist", "selectWantlist"].map((name) => div(name));
	// Created in the header, in this order, like view.ts onOpen.
	header.append(...buttons);
	document.body.append(header, ...toolbars);
	const registered: (() => void)[] = [];
	const view = {
		collectionHeaderEl: header,
		collectionActionsEl: slots[0],
		decksActionsEl: slots[1],
		wantlistsActionsEl: slots[2],
		newListBtn: buttons[0],
		listGallerySelectBtn: buttons[1],
		newDeckBtn: buttons[2],
		deckGallerySelectBtn: buttons[3],
		newWantlistBtn: buttons[4],
		wantlistGallerySelectBtn: buttons[5],
		registered,
		register: (cb: () => void) => registered.push(cb),
	} as unknown as Fake["view"];
	return { view, header, slots, buttons };
}

const names = (el: HTMLElement) => Array.from(el.children).map((c) => c.className);

let fake: Fake;
beforeEach(() => {
	fake = build();
});
afterEach(() => {
	document.body.className = "";
});

describe("placeGalleryActionButtons", () => {
	it("moves each gallery's two buttons into the slot of its own search bar on a computer, new button first", () => {
		placeGalleryActionButtons(fake.view);
		expect(names(fake.slots[0])).toEqual(["newList", "selectList"]);
		expect(names(fake.slots[1])).toEqual(["newDeck", "selectDeck"]);
		expect(names(fake.slots[2])).toEqual(["newWantlist", "selectWantlist"]);
		expect(names(fake.header)).toEqual(["title"]);
	});

	it("moves them into the slots on a tablet too", () => {
		document.body.className = "is-mobile is-tablet";
		placeGalleryActionButtons(fake.view);
		expect(names(fake.slots[0])).toEqual(["newList", "selectList"]);
	});

	it("leaves them in the header on a phone, in their original order", () => {
		document.body.className = "is-mobile is-phone";
		placeGalleryActionButtons(fake.view);
		expect(names(fake.header)).toEqual(["title", "newList", "selectList", "newDeck", "selectDeck", "newWantlist", "selectWantlist"]);
		expect(fake.slots.map((s) => s.children.length)).toEqual([0, 0, 0]);
	});

	it("brings them back to the header, in order, when the window becomes a phone, and back again", () => {
		placeGalleryActionButtons(fake.view);
		document.body.className = "is-phone";
		placeGalleryActionButtons(fake.view);
		expect(names(fake.header)).toEqual(["title", "newList", "selectList", "newDeck", "selectDeck", "newWantlist", "selectWantlist"]);
		document.body.className = "";
		placeGalleryActionButtons(fake.view);
		expect(names(fake.slots[1])).toEqual(["newDeck", "selectDeck"]);
		expect(names(fake.header)).toEqual(["title"]);
	});

	it("keeps the very same elements, so their listeners and state go with them", () => {
		let clicks = 0;
		fake.buttons[0].addEventListener("click", () => clicks++);
		fake.buttons[1].classList.add("is-active");
		placeGalleryActionButtons(fake.view);
		fake.buttons[0].click();
		expect(clicks).toBe(1);
		expect(fake.slots[0].children[0]).toBe(fake.buttons[0]);
		expect(fake.buttons[1].classList.contains("is-active")).toBe(true);
	});

	it("does not touch an element that is already in place", () => {
		placeGalleryActionButtons(fake.view);
		let mutations = 0;
		const observer = new MutationObserver((records) => (mutations += records.length));
		observer.observe(document.body, { childList: true, subtree: true });
		placeGalleryActionButtons(fake.view);
		mutations += observer.takeRecords().length;
		observer.disconnect();
		expect(mutations).toBe(0);
	});
});

describe("watchGalleryActionsPlacement", () => {
	it("re-places the buttons when the body's classes change, and stops when the view is unloaded", async () => {
		watchGalleryActionsPlacement(fake.view);
		document.body.className = "is-phone";
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(names(fake.header)).toContain("newList");

		document.body.className = "";
		await new Promise((r) => setTimeout(r, 0));
		expect(names(fake.slots[0])).toEqual(["newList", "selectList"]);

		expect(fake.view.registered).toHaveLength(1);
		fake.view.registered[0]();
		document.body.className = "is-phone";
		await new Promise((r) => setTimeout(r, 0));
		expect(names(fake.slots[0])).toEqual(["newList", "selectList"]);
	});
});
