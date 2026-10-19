import { describe, expect, it, vi } from "vitest";

// card-detail-fx.ts imports Obsidian's Platform/setIcon at load.
vi.mock("obsidian", () => ({ Platform: { isMobile: false }, setIcon: () => {} }));

import { renderArtCredit } from "./card-detail-fx";

// The two helpers Obsidian adds to HTMLElement that renderArtCredit uses, on a minimal stand-in (the file runs under Node).
class FakeEl {
	children: FakeEl[] = [];
	className = "";
	textContent = "";
	createDiv(o?: { cls?: string; text?: string }): FakeEl {
		const d = new FakeEl();
		d.className = o?.cls ?? "";
		d.textContent = o?.text ?? "";
		this.children.push(d);
		return d;
	}
	setText(t: string): void {
		this.textContent = t;
	}
}

const asLayout = (el: FakeEl) => el as unknown as HTMLElement;
const credit = (layout: FakeEl) => layout.children[layout.children.length - 1];
const lines = (layout: FakeEl) => ({
	artist: credit(layout).children.find((c) => c.className === "mtg-card-detail-art-credit-artist")?.textContent,
	copyright: credit(layout).children.find((c) => c.className === "mtg-card-detail-art-credit-copyright")?.textContent,
});

describe("renderArtCredit (the artist and copyright Scryfall asks for next to an artwork shown alone)", () => {
	it("prints the artist then the copyright, on two lines, as the last child of the layout", () => {
		const layout = new FakeEl();
		layout.createDiv({ cls: "mtg-card-detail-panel" });
		renderArtCredit(asLayout(layout), "Seb McKinnon");
		expect(lines(layout)).toEqual({ artist: "Illustrated by Seb McKinnon", copyright: "™ & © Wizards of the Coast" });
		expect(credit(layout).className).toBe("mtg-card-detail-art-credit");
		expect(credit(layout).children.map((c) => c.className)).toEqual([
			"mtg-card-detail-art-credit-artist",
			"mtg-card-detail-art-credit-copyright",
		]);
	});

	it("leaves the artist line empty (hidden by CSS) when the artist is unknown, the copyright stays", () => {
		const layout = new FakeEl();
		renderArtCredit(asLayout(layout), "");
		expect(lines(layout)).toEqual({ artist: "", copyright: "™ & © Wizards of the Coast" });
	});

	it("shows the back face's illustrator while the card is flipped, the front's otherwise", () => {
		const layout = new FakeEl();
		const c = renderArtCredit(asLayout(layout), "Front Artist");
		c.setBackArtist("Back Artist");
		c.showFace(true);
		expect(lines(layout).artist).toBe("Illustrated by Back Artist");
		c.showFace(false);
		expect(lines(layout).artist).toBe("Illustrated by Front Artist");
	});

	it("keeps the front's illustrator for a back face that names none", () => {
		const layout = new FakeEl();
		const c = renderArtCredit(asLayout(layout), "Front Artist");
		c.setBackArtist(undefined);
		c.showFace(true);
		expect(lines(layout).artist).toBe("Illustrated by Front Artist");
	});
});
