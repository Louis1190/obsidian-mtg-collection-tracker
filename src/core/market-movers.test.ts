import { describe, it, expect, vi } from "vitest";
import {
	MOVER_MIN_PRICE,
	MOVER_MAX_JUMP_RATIO,
	MOVER_HIGH_PRICE,
	MOVER_HIGH_PRICE_MAX_JUMP_RATIO,
	MOVERS_STALE_AFTER_DAYS,
	shouldHideMover,
	selectDisplayMovers,
	getMoversAgeDays,
	isMoversDataStale,
	moverFinishOf,
	moverOwnershipKey,
	moverNativeCurrency,
	getMoverPriceDisplay,
} from "./market-movers";
import type { CardbaseMover } from "../api/cardbase";

let idCounter = 0;
function makeMover(overrides: Partial<CardbaseMover> = {}): CardbaseMover {
	idCounter += 1;
	const priceFrom = overrides.priceFrom ?? 10;
	const priceTo = overrides.priceTo ?? 12;
	return {
		scryfallId: `scry${idCounter}`,
		name: `Card ${idCounter}`,
		vendor: "tcgplayer",
		finish: "normal",
		currency: "USD",
		priceFrom,
		priceTo,
		changePct: ((priceTo - priceFrom) / priceFrom) * 100,
		...overrides,
	};
}

describe("shouldHideMover", () => {
	it("keeps an ordinary mover", () => {
		expect(shouldHideMover(makeMover({ priceFrom: 10, priceTo: 15 }))).toBe(false);
		expect(shouldHideMover(makeMover({ priceFrom: 40, priceTo: 20 }))).toBe(false);
	});

	it("hides a card whose lower price is under the floor (penny-stock noise)", () => {
		// Relevé réel 2026-09-09 : Breeding Pit, +794.8 % sur une carte à quelques centimes.
		expect(shouldHideMover(makeMover({ priceFrom: 0.58, priceTo: 5.19, currency: "EUR" }))).toBe(true);
	});

	it("treats the floor as inclusive, on the LOWER of the two prices", () => {
		expect(shouldHideMover(makeMover({ priceFrom: MOVER_MIN_PRICE, priceTo: 4 }))).toBe(false);
		expect(shouldHideMover(makeMover({ priceFrom: MOVER_MIN_PRICE - 0.01, priceTo: 4 }))).toBe(true);
		// Un effondrement VERS un prix sous le plancher est masqué aussi (baisse "vers ~0").
		expect(shouldHideMover(makeMover({ priceFrom: 12, priceTo: 1.5 }))).toBe(true);
	});

	it("hides the vendor placeholder prices actually seen in the live data", () => {
		// Les 5 premières "Losers" sur 24 h, relevé réel du 2026-09-09 (données lues le 2026-09-23).
		expect(shouldHideMover(makeMover({ priceFrom: 99999, priceTo: 5.95, currency: "EUR" }))).toBe(true); // Monstrous Hound -100 %
		expect(shouldHideMover(makeMover({ priceFrom: 209765.85, priceTo: 412.5 }))).toBe(true); // Bayou -99.8 %
		expect(shouldHideMover(makeMover({ priceFrom: 999, priceTo: 24.99, currency: "EUR" }))).toBe(true); // Cut Down -97.5 %
		// Côté hausses, sur 7 jours : le prix d'ARRIVÉE est le placeholder.
		expect(shouldHideMover(makeMover({ priceFrom: 33.94, priceTo: 148057.9 }))).toBe(true); // Stoneforge Mystic
		expect(shouldHideMover(makeMover({ priceFrom: 199.99, priceTo: 10000, currency: "EUR" }))).toBe(true); // Ponder
		expect(shouldHideMover(makeMover({ priceFrom: 0.5, priceTo: 99999, currency: "EUR" }))).toBe(true); // Stroke of Midnight
	});

	it("applies the jump ceiling symmetrically, inclusive at exactly the ceiling", () => {
		expect(shouldHideMover(makeMover({ priceFrom: 10, priceTo: 10 * MOVER_MAX_JUMP_RATIO }))).toBe(false);
		expect(shouldHideMover(makeMover({ priceFrom: 10, priceTo: 10 * MOVER_MAX_JUMP_RATIO + 0.1 }))).toBe(true);
		expect(shouldHideMover(makeMover({ priceFrom: 50, priceTo: 50 / MOVER_MAX_JUMP_RATIO }))).toBe(false);
		expect(shouldHideMover(makeMover({ priceFrom: 50, priceTo: 50 / MOVER_MAX_JUMP_RATIO - 0.1 }))).toBe(true);
	});

	it("uses a stricter ceiling from the expensive-card threshold up", () => {
		// Relevé réel : prix "vitrine" qui passaient les deux premières règles.
		expect(shouldHideMover(makeMover({ priceFrom: 325, priceTo: 1200, currency: "EUR" }))).toBe(true); // Narset, Parter of Veils
		expect(shouldHideMover(makeMover({ priceFrom: 850, priceTo: 1999 }))).toBe(true); // Word of Command
		expect(shouldHideMover(makeMover({ priceFrom: 999.99, priceTo: 305, currency: "EUR" }))).toBe(true); // Cavern of Souls
		// Un mouvement raisonnable sur une carte chère reste visible...
		expect(shouldHideMover(makeMover({ priceFrom: 400, priceTo: 400 * MOVER_HIGH_PRICE_MAX_JUMP_RATIO }))).toBe(false);
		expect(shouldHideMover(makeMover({ priceFrom: 400, priceTo: 400 * MOVER_HIGH_PRICE_MAX_JUMP_RATIO + 1 }))).toBe(true);
		// ... et un saut strictement entre les deux plafonds reste permis juste SOUS le seuil "cher".
		const between = (MOVER_HIGH_PRICE_MAX_JUMP_RATIO + MOVER_MAX_JUMP_RATIO) / 2;
		const justBelow = MOVER_HIGH_PRICE - 1;
		expect(shouldHideMover(makeMover({ priceFrom: justBelow / between, priceTo: justBelow }))).toBe(false);
		// Le seuil compte le prix le PLUS HAUT des deux : une CHUTE depuis le seuil est "chère" aussi.
		expect(shouldHideMover(makeMover({ priceFrom: MOVER_HIGH_PRICE, priceTo: MOVER_HIGH_PRICE / between }))).toBe(true);
	});

	it("hides non-finite and non-positive prices without dividing by zero", () => {
		expect(shouldHideMover(makeMover({ priceFrom: NaN, priceTo: 10 }))).toBe(true);
		expect(shouldHideMover(makeMover({ priceFrom: 10, priceTo: Infinity }))).toBe(true);
		expect(shouldHideMover(makeMover({ priceFrom: 0, priceTo: 10 }))).toBe(true);
		expect(shouldHideMover(makeMover({ priceFrom: -5, priceTo: 10 }))).toBe(true);
	});
});

describe("selectDisplayMovers", () => {
	it("drops hidden rows, then applies the limit to what remains", () => {
		const rows = [
			makeMover({ name: "Placeholder", priceFrom: 99999, priceTo: 5.95, changePct: -100 }),
			makeMover({ name: "A", priceFrom: 10, priceTo: 4, changePct: -60 }),
			makeMover({ name: "B", priceFrom: 10, priceTo: 3, changePct: -70 }),
			makeMover({ name: "C", priceFrom: 10, priceTo: 5, changePct: -50 }),
		];
		// Le placeholder (-100 %) est en tête de l'API mais n'occupe AUCUNE des places retenues.
		expect(selectDisplayMovers(rows, "down", 2).map((m) => m.name)).toEqual(["B", "A"]);
	});

	it("sorts gainers by biggest rise first and losers by biggest fall first, whatever the input order", () => {
		const rows = [
			makeMover({ name: "small", changePct: 20 }),
			makeMover({ name: "big", changePct: 300 }),
			makeMover({ name: "mid", changePct: 80 }),
		];
		expect(selectDisplayMovers(rows, "up", 10).map((m) => m.name)).toEqual(["big", "mid", "small"]);
		const falls = [
			makeMover({ name: "small", changePct: -20 }),
			makeMover({ name: "big", changePct: -75 }),
			makeMover({ name: "mid", changePct: -50 }),
		];
		expect(selectDisplayMovers(falls, "down", 10).map((m) => m.name)).toEqual(["big", "mid", "small"]);
	});

	it("does not mutate the array it was given (it lives in the plugin's session cache)", () => {
		const rows = [makeMover({ name: "a", changePct: 10 }), makeMover({ name: "b", changePct: 50 })];
		const snapshot = rows.map((m) => m.name);
		selectDisplayMovers(rows, "up", 5);
		expect(rows.map((m) => m.name)).toEqual(snapshot);
	});

	it("returns an empty list when everything is hidden or the input is empty", () => {
		expect(selectDisplayMovers([], "up", 5)).toEqual([]);
		expect(selectDisplayMovers([makeMover({ priceFrom: 0.5, priceTo: 3 })], "up", 5)).toEqual([]);
	});
});

describe("getMoversAgeDays / isMoversDataStale", () => {
	// 2026-09-23 14:00 UTC — le jour où l'as_of réel de cardbase datait encore du 2026-09-09.
	const now = Date.UTC(2026, 8, 23, 14, 0, 0);

	it("counts whole days since midnight UTC of the as_of date", () => {
		expect(getMoversAgeDays("2026-09-09", now)).toBe(14);
		expect(getMoversAgeDays("2026-09-22", now)).toBe(1);
		expect(getMoversAgeDays("2026-09-23", now)).toBe(0);
	});

	it("never goes negative for a date in the future (clock skew)", () => {
		expect(getMoversAgeDays("2026-09-30", now)).toBe(0);
	});

	it("returns undefined for a missing or unreadable date", () => {
		expect(getMoversAgeDays(undefined, now)).toBeUndefined();
		expect(getMoversAgeDays("", now)).toBeUndefined();
		expect(getMoversAgeDays("not a date", now)).toBeUndefined();
		// Un timestamp complet n'est pas le format annoncé : se taire plutôt que deviner.
		expect(getMoversAgeDays("2026-09-09T06:38:45Z", now)).toBeUndefined();
	});

	it("only flags data as stale from the threshold on, never when the age is unknown", () => {
		expect(isMoversDataStale(undefined)).toBe(false);
		expect(isMoversDataStale(0)).toBe(false);
		expect(isMoversDataStale(MOVERS_STALE_AFTER_DAYS - 1)).toBe(false);
		expect(isMoversDataStale(MOVERS_STALE_AFTER_DAYS)).toBe(true);
		expect(isMoversDataStale(14)).toBe(true);
	});
});

describe("moverFinishOf / moverOwnershipKey", () => {
	it("maps this plugin's finishes onto cardbase's", () => {
		expect(moverFinishOf("regular")).toBe("normal");
		expect(moverFinishOf("foiled")).toBe("foil");
		// Surge Foil se cote comme un foil (voir getRawCardPrice, price.ts).
		expect(moverFinishOf("surged")).toBe("foil");
		expect(moverFinishOf("etched")).toBe("etched");
	});

	it("gives proxies no market finish at all", () => {
		expect(moverFinishOf("proxy")).toBeNull();
	});

	it("keys on printing AND finish, so a foil row never matches a non-foil copy", () => {
		expect(moverOwnershipKey("abc", "foil")).not.toBe(moverOwnershipKey("abc", "normal"));
		expect(moverOwnershipKey("abc", "foil")).toBe(moverOwnershipKey("abc", "foil"));
		expect(moverOwnershipKey("abc", "foil")).not.toBe(moverOwnershipKey("abd", "foil"));
	});
});

describe("moverNativeCurrency", () => {
	it("reads cardbase's currency code case-insensitively", () => {
		expect(moverNativeCurrency({ currency: "EUR" })).toBe("eur");
		expect(moverNativeCurrency({ currency: "eur" })).toBe("eur");
		expect(moverNativeCurrency({ currency: "USD" })).toBe("usd");
	});

	it("falls back to usd for any other code (the plugin only tracks usd/eur)", () => {
		expect(moverNativeCurrency({ currency: "GBP" })).toBe("usd");
	});
});

describe("getMoverPriceDisplay", () => {
	const usdRow = { currency: "USD", priceFrom: 10, priceTo: 12.5 };
	const eurRow = { currency: "EUR", priceFrom: 20, priceTo: 15 };

	it("converts a USD row into the chosen currency and derives the delta from the converted amounts", () => {
		const convert = vi.fn((amount: number) => amount * 0.9);
		const d = getMoverPriceDisplay(usdRow, "eur", convert);
		expect(d.currency).toBe("eur");
		expect(d.converted).toBe(true);
		expect(d.from).toBeCloseTo(9);
		expect(d.to).toBeCloseTo(11.25);
		expect(d.delta).toBeCloseTo(2.25);
		expect(convert).toHaveBeenCalledWith(10, "usd", "eur");
		expect(convert).toHaveBeenCalledWith(12.5, "usd", "eur");
	});

	it("leaves a row already in the chosen currency untouched, without calling convert", () => {
		const convert = vi.fn();
		const d = getMoverPriceDisplay(eurRow, "eur", convert);
		expect(d).toEqual({ currency: "eur", from: 20, to: 15, delta: -5, converted: false });
		expect(convert).not.toHaveBeenCalled();
	});

	it("shows the native amounts (with the native currency) when no conversion is available", () => {
		const d = getMoverPriceDisplay(usdRow, "eur", undefined);
		expect(d).toEqual({ currency: "usd", from: 10, to: 12.5, delta: 2.5, converted: false });
	});

	it("gives a negative delta for a fall", () => {
		expect(getMoverPriceDisplay(eurRow, "usd", (a) => a * 1.1).delta).toBeCloseTo(-5.5);
	});
});
