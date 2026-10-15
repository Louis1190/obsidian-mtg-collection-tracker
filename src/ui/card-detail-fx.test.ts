import { describe, expect, it, vi } from "vitest";

// card-detail-fx.ts imports Obsidian's Platform at load; nothing here touches the DOM.
vi.mock("obsidian", () => ({ Platform: { isMobile: false } }));

import { cardbaseFinishOf, toCardbaseFinish } from "./card-detail-fx";
import type { PricedCard } from "../core/price";

const card = (over: Partial<PricedCard> = {}): PricedCard => ({
	finish: "regular",
	priceUsd: "",
	priceUsdFoil: "",
	priceEur: "",
	priceEurFoil: "",
	priceUsdEtched: "",
	priceEurEtched: "",
	count: 1,
	...over,
});

describe("the finish a price SOURCE is asked for", () => {
	it("maps the plugin's finishes to the sources' words", () => {
		expect(toCardbaseFinish("regular")).toBe("normal");
		expect(toCardbaseFinish("foiled")).toBe("foil");
		expect(toCardbaseFinish("surged")).toBe("foil");
		expect(toCardbaseFinish("etched")).toBe("etched");
	});
	it("a foil-only printing followed as regular is asked as a foil (Rammas Echor, Ancient Shield, LTC #549)", () => {
		expect(cardbaseFinishOf(card({ priceUsdFoil: "17.02", priceEurFoil: "14.86" }))).toBe("foil");
	});
	it("an ordinary card is asked as it always was", () => {
		expect(cardbaseFinishOf(card({ priceUsd: "8.56", priceUsdFoil: "6.61" }))).toBe("normal");
		expect(cardbaseFinishOf(card({ finish: "foiled", priceUsd: "8.56", priceUsdFoil: "6.61" }))).toBe("foil");
		expect(cardbaseFinishOf(card({ finish: "etched", priceUsd: "8.56" }))).toBe("etched");
		expect(cardbaseFinishOf(card({}))).toBe("normal"); // no price at all: nothing is guessed
	});
});
