import { describe, it, expect } from "vitest";
import {
	getRawCardPrice,
	effectiveFinish,
	getCardPriceNumber,
	formatCardPrice,
	cardValue,
	formatMoney,
	formatSignedMoney,
	formatScryfallPrice,
	pickCoverImage,
	resolveCoverImage,
	pickDeckCoverImage,
	resolveDeckCoverImage,
	toDeckPricedCard,
	displayedPriceOf,
	groupByList,
	groupByWantlist,
	PricedCard,
} from "./price";
import type { CollectionCard, WantlistCard } from "./card-model";
import type { ScryfallCard } from "../api/scryfall";
import type { CollectionList, Wantlist } from "./data-model";

function makePricedCard(overrides: Partial<PricedCard> = {}): PricedCard {
	return {
		finish: "regular",
		priceUsd: "",
		priceUsdFoil: "",
		priceEur: "",
		priceEurFoil: "",
		priceUsdEtched: "",
		priceEurEtched: "",
		count: 1,
		...overrides,
	};
}

let idCounter = 0;
function makeCardEntry(overrides: Partial<CollectionCard> = {}): CollectionCard {
	idCounter += 1;
	return {
		id: `id${idCounter}`,
		scryfallId: `scry${idCounter}`,
		name: "Card",
		setCode: "set",
		setName: "Set",
		collectorNumber: "1",
		rarity: "common",
		manaCost: "",
		manaValue: 0,
		typeLine: "",
		artist: "",
		colors: [],
		keywords: [],
		releasedAt: "",
		imageUrl: "img.png",
		artCropUrl: "art.png",
		priceUsd: "1.00",
		priceUsdFoil: "",
		priceEur: "",
		priceEurFoil: "",
		priceUsdEtched: "",
		priceEurEtched: "",
		count: 1,
		finish: "regular",
		language: "en",
		condition: "NM",
		listId: "list1",
		dateAdded: 0,
		dateModified: 0,
		...overrides,
	};
}

describe("getRawCardPrice", () => {
	it("excludes proxy cards from value entirely", () => {
		const card = makePricedCard({ finish: "proxy", priceUsd: "100.00", priceUsdFoil: "200.00" });
		expect(getRawCardPrice(card, "usd")).toBe("");
		expect(getRawCardPrice(card, "eur")).toBe("");
	});

	it("uses the plain price for a regular card", () => {
		const card = makePricedCard({ priceUsd: "1.50", priceEur: "1.30" });
		expect(getRawCardPrice(card, "usd")).toBe("1.50");
		expect(getRawCardPrice(card, "eur")).toBe("1.30");
	});

	it("uses the foil price for a foiled card, and treats surged the same way", () => {
		const foiled = makePricedCard({ finish: "foiled", priceUsd: "1.00", priceUsdFoil: "3.00" });
		expect(getRawCardPrice(foiled, "usd")).toBe("3.00");

		const surged = makePricedCard({ finish: "surged", priceUsd: "1.00", priceUsdFoil: "5.00" });
		expect(getRawCardPrice(surged, "usd")).toBe("5.00");
	});

	it("uses the etched price when available, else falls back to the non-foil price (USD)", () => {
		const withEtched = makePricedCard({ finish: "etched", priceUsd: "1.00", priceUsdEtched: "4.00" });
		expect(getRawCardPrice(withEtched, "usd")).toBe("4.00");

		const withoutEtched = makePricedCard({ finish: "etched", priceUsd: "1.00", priceUsdEtched: "" });
		expect(getRawCardPrice(withoutEtched, "usd")).toBe("1.00");
	});

	it("falls back to the plain USD price when the foil USD price is missing", () => {
		const card = makePricedCard({ finish: "foiled", priceUsd: "1.00", priceUsdFoil: "" });
		expect(getRawCardPrice(card, "usd")).toBe("1.00");
	});

	describe("a printing that only exists in foil, left on the regular finish", () => {
		it("shows its foil price in the display currency", () => {
			const card = makePricedCard({ priceUsdFoil: "5.00", priceEurFoil: "4.50" });
			expect(getRawCardPrice(card, "usd")).toBe("5.00");
			expect(getRawCardPrice(card, "eur")).toBe("4.50");
		});

		it("counts that foil price in the value of the stack", () => {
			const card = makePricedCard({ priceEurFoil: "4.50", count: 3 });
			expect(cardValue(card, "eur")).toBeCloseTo(13.5);
		});

		it("does not borrow the other currency when the foil price exists in one only", () => {
			// Seventh Edition ★: a USD foil price and nothing in EUR.
			const card = makePricedCard({ priceUsdFoil: "5.00" });
			expect(getRawCardPrice(card, "usd")).toBe("5.00");
			expect(getRawCardPrice(card, "eur")).toBe("");
		});

		it("leaves a card that exists in non-foil alone when only ONE currency lacks the plain price", () => {
			// Tales of Middle-earth Commander: plain USD price, no plain EUR price, EUR foil price.
			const card = makePricedCard({ priceUsd: "2.00", priceEurFoil: "900.00" });
			expect(getRawCardPrice(card, "eur")).toBe("");
			expect(getRawCardPrice(card, "usd")).toBe("2.00");
		});

		it("keeps the plain price whenever there is one", () => {
			const card = makePricedCard({ priceEur: "1.00", priceEurFoil: "9.00" });
			expect(getRawCardPrice(card, "eur")).toBe("1.00");
		});

		it("stays empty when no price is known at all", () => {
			expect(getRawCardPrice(makePricedCard(), "eur")).toBe("");
		});

		it("never prices a proxy, and does not change the etched finish", () => {
			expect(getRawCardPrice(makePricedCard({ finish: "proxy", priceEurFoil: "9.00" }), "eur")).toBe("");
			const etched = makePricedCard({ finish: "etched", priceEurFoil: "9.00" });
			expect(getRawCardPrice(etched, "eur")).toBe("");
		});
	});

	it("does NOT fall back to the plain EUR price when the foil EUR price is missing", () => {
		// Existing asymmetry of getRawCardPrice: the USD branch falls back to
		// priceUsd, the EUR branch falls back to nothing else.
		const card = makePricedCard({ finish: "foiled", priceEur: "2.00", priceEurFoil: "" });
		expect(getRawCardPrice(card, "eur")).toBe("");
	});
});

describe("effectiveFinish: the finish a card is looked up as (price, stores, history, Home), one rule for all", () => {
	it("a copy left on regular of a printing that exists only in foil is a foil", () => {
		expect(effectiveFinish(makePricedCard({ priceUsdFoil: "5.00" }))).toBe("foiled");
		expect(effectiveFinish(makePricedCard({ priceEurFoil: "4.50" }))).toBe("foiled");
		expect(effectiveFinish(makePricedCard({ priceUsdFoil: "5.00", priceEurFoil: "4.50" }))).toBe("foiled");
	});
	it("not when a plain price exists in EITHER currency (a printing that merely lacks one price is still a non-foil: the 21 Tales of Middle-earth Commander cards)", () => {
		expect(effectiveFinish(makePricedCard({ priceEur: "1.00", priceEurFoil: "9.00" }))).toBe("regular");
		expect(effectiveFinish(makePricedCard({ priceUsd: "2.00", priceEurFoil: "900.00" }))).toBe("regular");
	});
	it("not when there is no foil price either: nothing is known, nothing is guessed", () => {
		expect(effectiveFinish(makePricedCard({}))).toBe("regular");
	});
	it("every other finish is its own: a foil stays a foil, an etched stays etched, surged and proxy too, whatever the prices", () => {
		for (const finish of ["foiled", "etched", "surged", "proxy"] as const) {
			expect(effectiveFinish(makePricedCard({ finish, priceUsdFoil: "5.00" }))).toBe(finish);
			expect(effectiveFinish(makePricedCard({ finish, priceUsd: "1.00", priceUsdFoil: "5.00" }))).toBe(finish);
		}
	});
	it("the displayed price follows it: the same answer by either road", () => {
		const card = makePricedCard({ priceUsdFoil: "5.00", priceEurFoil: "4.50" });
		expect(getRawCardPrice(card, "usd")).toBe(getRawCardPrice({ ...card, finish: effectiveFinish(card) }, "usd"));
		expect(getRawCardPrice(card, "eur")).toBe("4.50");
	});
});

describe("getCardPriceNumber", () => {
	it("parses the raw price as a float, defaulting to 0", () => {
		expect(getCardPriceNumber(makePricedCard({ priceUsd: "3.25" }), "usd")).toBe(3.25);
		expect(getCardPriceNumber(makePricedCard({ finish: "proxy", priceUsd: "3.25" }), "usd")).toBe(0);
	});
});

describe("formatCardPrice", () => {
	it("shows an em dash when there is no price", () => {
		expect(formatCardPrice(makePricedCard({ priceUsd: "" }), "usd")).toBe("—");
	});

	it("prefixes the raw price with the currency symbol", () => {
		expect(formatCardPrice(makePricedCard({ priceUsd: "3.25" }), "usd")).toBe("$3.25");
		expect(formatCardPrice(makePricedCard({ priceEur: "3.25" }), "eur")).toBe("€3.25");
	});
});

describe("cardValue", () => {
	it("multiplies the unit price by the owned count", () => {
		expect(cardValue(makePricedCard({ priceUsd: "2.00", count: 3 }))).toBe(6);
	});

	it("is zero for a proxy regardless of count", () => {
		expect(cardValue(makePricedCard({ finish: "proxy", priceUsd: "2.00", count: 3 }))).toBe(0);
	});
});

describe("formatMoney", () => {
	it("formats an already-computed amount with the currency symbol and 2 decimals", () => {
		expect(formatMoney(12.5, "usd")).toBe("$12.50");
		expect(formatMoney(0, "eur")).toBe("€0.00");
	});
});

describe("formatSignedMoney", () => {
	it("puts the sign before the currency symbol, with a + for a rise", () => {
		expect(formatSignedMoney(2.5, "eur")).toBe("+€2.50");
		expect(formatSignedMoney(-1.05, "usd")).toBe("-$1.05");
	});

	it("rounds to 2 decimals like formatMoney", () => {
		expect(formatSignedMoney(1.006, "usd")).toBe("+$1.01");
		expect(formatSignedMoney(-1.006, "usd")).toBe("-$1.01");
	});

	it("never shows a negative zero", () => {
		expect(formatSignedMoney(0, "eur")).toBe("+€0.00");
		expect(formatSignedMoney(-0, "eur")).toBe("+€0.00");
		// -0.004 rounds to 0.00: the sign follows the ROUNDED amount, not the original float.
		expect(formatSignedMoney(-0.004, "usd")).toBe("+$0.00");
	});
});

describe("formatScryfallPrice", () => {
	it("formats a raw Scryfall search result's price", () => {
		const card = { prices: { usd: "1.25", eur: "1.10" } } as ScryfallCard;
		expect(formatScryfallPrice(card, "usd")).toBe("$1.25");
		expect(formatScryfallPrice(card, "eur")).toBe("€1.10");
	});

	it("returns an empty string when the price is missing", () => {
		const card = { prices: {} } as ScryfallCard;
		expect(formatScryfallPrice(card, "usd")).toBe("");
	});
});

describe("pickCoverImage", () => {
	it("returns an empty string for an empty list", () => {
		expect(pickCoverImage([], "usd")).toBe("");
	});

	it("returns the single card's art crop for a one-card list", () => {
		expect(pickCoverImage([makeCardEntry({ artCropUrl: "art.png" })], "usd")).toBe("art.png");
	});

	it("picks the most expensive card's art for 2+ cards", () => {
		const cards = [
			makeCardEntry({ artCropUrl: "cheap.png", priceUsd: "1.00" }),
			makeCardEntry({ artCropUrl: "expensive.png", priceUsd: "50.00" }),
		];
		expect(pickCoverImage(cards, "usd")).toBe("expensive.png");
	});

	// The cover is "the most expensive card" AS THE USER SEES IT: same function as the
	// price shown on the row (found 2026-10-12: it read priceUsd alone, so a list shown
	// in EUR could get the cover of a card that is not its most expensive one).
	it("follows the display currency", () => {
		const cards = [
			makeCardEntry({ artCropUrl: "usd-star.png", priceUsd: "50.00", priceEur: "1.00" }),
			makeCardEntry({ artCropUrl: "eur-star.png", priceUsd: "2.00", priceEur: "30.00" }),
		];
		expect(pickCoverImage(cards, "usd")).toBe("usd-star.png");
		expect(pickCoverImage(cards, "eur")).toBe("eur-star.png");
	});

	it("ranks a foiled copy by its foil price", () => {
		const cards = [
			makeCardEntry({ artCropUrl: "plain.png", priceUsd: "10.00" }),
			makeCardEntry({ artCropUrl: "foil.png", finish: "foiled", priceUsd: "5.00", priceUsdFoil: "40.00" }),
		];
		expect(pickCoverImage(cards, "usd")).toBe("foil.png");
	});

	it("ranks a foil-only printing by its foil price, like the row displays it", () => {
		const cards = [
			makeCardEntry({ artCropUrl: "plain.png", priceUsd: "", priceEur: "20.00" }),
			makeCardEntry({
				artCropUrl: "foil-only.png",
				priceUsd: "",
				priceEur: "",
				priceUsdFoil: "4000.00",
				priceEurFoil: "3000.00",
			}),
		];
		expect(pickCoverImage(cards, "eur")).toBe("foil-only.png");
	});

	it("never picks a proxy, which has no value", () => {
		const cards = [
			makeCardEntry({ artCropUrl: "real.png", priceUsd: "5.00" }),
			makeCardEntry({ artCropUrl: "proxy.png", finish: "proxy", priceUsd: "100.00" }),
		];
		expect(pickCoverImage(cards, "usd")).toBe("real.png");
	});

	it("keeps the first card when several share the top price (or none has one)", () => {
		const tied = [
			makeCardEntry({ artCropUrl: "first.png", priceUsd: "7.00" }),
			makeCardEntry({ artCropUrl: "second.png", priceUsd: "7.00" }),
		];
		expect(pickCoverImage(tied, "usd")).toBe("first.png");
		const unpriced = [
			makeCardEntry({ artCropUrl: "first.png", priceUsd: "" }),
			makeCardEntry({ artCropUrl: "second.png", priceUsd: "" }),
		];
		expect(pickCoverImage(unpriced, "usd")).toBe("first.png");
	});

	it("falls back to the full card image when the best card has no art crop", () => {
		const cards = [
			makeCardEntry({ artCropUrl: "cheap.png", priceUsd: "1.00" }),
			makeCardEntry({ artCropUrl: "", imageUrl: "pricey-full.png", priceUsd: "9.00" }),
		];
		expect(pickCoverImage(cards, "usd")).toBe("pricey-full.png");
	});
});

describe("resolveCoverImage", () => {
	const cards = [
		makeCardEntry({ id: "a", artCropUrl: "cheap.png", priceUsd: "1.00" }),
		makeCardEntry({ id: "b", artCropUrl: "expensive.png", priceUsd: "50.00" }),
	];

	it("falls back to pickCoverImage when no coverCardId is given", () => {
		expect(resolveCoverImage(cards, "usd")).toBe("expensive.png");
	});

	it("uses the manually chosen card's art when its id is found", () => {
		expect(resolveCoverImage(cards, "usd", "a")).toBe("cheap.png");
	});

	it("falls back to the automatic pick when coverCardId no longer matches any card", () => {
		expect(resolveCoverImage(cards, "usd", "gone")).toBe("expensive.png");
	});
});

describe("displayedPriceOf", () => {
	it("reads the price in the display currency", () => {
		const card = { priceUsd: "10.00", priceEur: "2.00" };
		expect(displayedPriceOf("usd")(card)).toBe(10);
		expect(displayedPriceOf("eur")(card)).toBe(2);
	});

	it("follows the finish like the row's displayed price", () => {
		const foiled = { finish: "foiled" as const, priceUsd: "1.00", priceUsdFoil: "3.00", priceEur: "0.80", priceEurFoil: "2.50" };
		expect(displayedPriceOf("usd")(foiled)).toBe(3);
		expect(displayedPriceOf("eur")(foiled)).toBe(2.5);
		const etched = { finish: "etched" as const, priceUsd: "1.00", priceUsdEtched: "4.00" };
		expect(displayedPriceOf("usd")(etched)).toBe(4);
	});

	it("shows a foil-only printing at its foil price, and a proxy at nothing", () => {
		expect(displayedPriceOf("eur")({ priceEurFoil: "4.50" })).toBe(4.5);
		expect(displayedPriceOf("usd")({ finish: "proxy", priceUsd: "100.00" })).toBe(0);
	});

	it("treats absent price fields (a deck card not caught up yet) as no price", () => {
		expect(displayedPriceOf("usd")({})).toBe(0);
		expect(displayedPriceOf("eur")({ priceUsd: "9.00" })).toBe(0);
	});

	it("agrees with getCardPriceNumber on a real collection card", () => {
		const card = makeCardEntry({ finish: "foiled", priceUsd: "1.00", priceUsdFoil: "6.00", priceEur: "0.90", priceEurFoil: "5.00" });
		expect(displayedPriceOf("usd")(card)).toBe(getCardPriceNumber(card, "usd"));
		expect(displayedPriceOf("eur")(card)).toBe(getCardPriceNumber(card, "eur"));
	});
});

describe("pickDeckCoverImage", () => {
	it("returns an empty string for an empty deck", () => {
		expect(pickDeckCoverImage([])).toBe("");
	});

	it("picks the commander's art when the deck has one, regardless of order", () => {
		// Commander is a Function (deckFunctionOverride), not a category, since
		// 2026-09-07.
		const cards = [
			{ artCropUrl: "main1.png", imageUrl: "main1-full.png" },
			{ artCropUrl: "commander.png", imageUrl: "commander-full.png", deckFunctionOverride: "Commander" },
			{ artCropUrl: "main2.png", imageUrl: "main2-full.png" },
		];
		expect(pickDeckCoverImage(cards)).toBe("commander.png");
	});

	it("falls back to the first card when the deck has no commander", () => {
		const cards = [
			{ artCropUrl: "first.png", imageUrl: "first-full.png" },
			{ artCropUrl: "second.png", imageUrl: "second-full.png" },
		];
		expect(pickDeckCoverImage(cards)).toBe("first.png");
	});
});

describe("resolveDeckCoverImage", () => {
	const cards = [
		{ scryfallId: "a", artCropUrl: "first.png", imageUrl: "first-full.png" },
		{
			scryfallId: "b",
			artCropUrl: "commander.png",
			imageUrl: "commander-full.png",
			deckFunctionOverride: "Commander",
		},
	];

	it("falls back to pickDeckCoverImage when no coverCardId is given", () => {
		expect(resolveDeckCoverImage(cards)).toBe("commander.png");
	});

	it("uses the manually chosen card's art when its scryfallId is found", () => {
		expect(resolveDeckCoverImage(cards, "a")).toBe("first.png");
	});

	it("falls back to the automatic pick when coverCardId no longer matches any card", () => {
		expect(resolveDeckCoverImage(cards, "gone")).toBe("commander.png");
	});
});

describe("toDeckPricedCard", () => {
	it("falls back to Regular/empty strings for a card never yet backfilled", () => {
		expect(toDeckPricedCard({ count: 3 })).toEqual({
			finish: "regular",
			priceUsd: "",
			priceUsdFoil: "",
			priceEur: "",
			priceEurFoil: "",
			priceUsdEtched: "",
			priceEurEtched: "",
			count: 3,
		});
	});

	it("carries over every real field once backfilled", () => {
		const priced = toDeckPricedCard({
			finish: "foiled",
			priceUsd: "1.00",
			priceUsdFoil: "5.00",
			priceEur: "0.90",
			priceEurFoil: "4.50",
			priceUsdEtched: "",
			priceEurEtched: "",
			count: 2,
		});
		expect(priced).toEqual({
			finish: "foiled",
			priceUsd: "1.00",
			priceUsdFoil: "5.00",
			priceEur: "0.90",
			priceEurFoil: "4.50",
			priceUsdEtched: "",
			priceEurEtched: "",
			count: 2,
		});
	});

	it("composes with getRawCardPrice/formatCardPrice exactly like a CardEntry would", () => {
		const priced = toDeckPricedCard({
			finish: "foiled",
			priceUsd: "1.00",
			priceUsdFoil: "5.00",
			count: 1,
		});
		expect(formatCardPrice(priced, "usd")).toBe("$5.00");
	});
});

describe("groupByList", () => {
	it("groups cards by list, computes totals, and sorts lists alphabetically", () => {
		const lists: CollectionList[] = [
			{ id: "list1", name: "Zeta" },
			{ id: "list2", name: "Alpha" },
		];
		const collection: CollectionCard[] = [
			makeCardEntry({ listId: "list1", priceUsd: "1.00", count: 2 }),
			makeCardEntry({ listId: "list2", priceUsd: "5.00", count: 1 }),
			makeCardEntry({ listId: "list2", priceUsd: "3.00", count: 1 }),
		];

		const groups = groupByList(lists, collection, "usd");
		expect(groups.map((g) => g.name)).toEqual(["Alpha", "Zeta"]);

		const alpha = groups.find((g) => g.name === "Alpha")!;
		expect(alpha.totalQty).toBe(2);
		expect(alpha.totalValue).toBe(8);

		const zeta = groups.find((g) => g.name === "Zeta")!;
		expect(zeta.totalQty).toBe(2);
		expect(zeta.totalValue).toBe(2);
	});

	it("gives an empty list a zero total and no cover image", () => {
		const lists: CollectionList[] = [{ id: "empty", name: "Empty" }];
		const groups = groupByList(lists, [], "usd");
		expect(groups[0].totalQty).toBe(0);
		expect(groups[0].totalValue).toBe(0);
		expect(groups[0].coverImage).toBe("");
	});

	it("uses the list's manually chosen cover card when set", () => {
		const lists: CollectionList[] = [{ id: "list1", name: "Zeta", coverCardId: "chosen" }];
		const collection: CollectionCard[] = [
			makeCardEntry({ id: "chosen", listId: "list1", priceUsd: "1.00", artCropUrl: "chosen.png" }),
			makeCardEntry({ listId: "list1", priceUsd: "50.00", artCropUrl: "pricey.png" }),
		];
		const groups = groupByList(lists, collection, "usd");
		expect(groups[0].coverImage).toBe("chosen.png");
	});

	it("picks the cover from the price shown in the display currency", () => {
		const lists: CollectionList[] = [{ id: "list1", name: "Zeta" }];
		const collection: CollectionCard[] = [
			makeCardEntry({ listId: "list1", artCropUrl: "usd-star.png", priceUsd: "50.00", priceEur: "1.00" }),
			makeCardEntry({ listId: "list1", artCropUrl: "eur-star.png", priceUsd: "2.00", priceEur: "30.00" }),
		];
		expect(groupByList(lists, collection, "usd")[0].coverImage).toBe("usd-star.png");
		expect(groupByList(lists, collection, "eur")[0].coverImage).toBe("eur-star.png");
	});

	it("passes the list's manually chosen icon through untouched", () => {
		const lists: CollectionList[] = [
			{ id: "list1", name: "Mono Red", listIcon: { kind: "mana", value: "R" } },
			{ id: "list2", name: "No Icon" },
		];
		const groups = groupByList(lists, [], "usd");
		expect(groups.find((g) => g.id === "list1")!.icon).toEqual({ kind: "mana", value: "R" });
		expect(groups.find((g) => g.id === "list2")!.icon).toBeUndefined();
	});
});

function makeWantlistCardEntry(overrides: Partial<WantlistCard> = {}): WantlistCard {
	idCounter += 1;
	return {
		id: `wid${idCounter}`,
		scryfallId: `wscry${idCounter}`,
		name: "Wanted Card",
		setCode: "set",
		setName: "Set",
		collectorNumber: "1",
		rarity: "common",
		manaCost: "",
		manaValue: 0,
		typeLine: "",
		artist: "",
		colors: [],
		keywords: [],
		releasedAt: "",
		imageUrl: "img.png",
		artCropUrl: "art.png",
		priceUsd: "1.00",
		priceUsdFoil: "",
		priceEur: "",
		priceEurFoil: "",
		priceUsdEtched: "",
		priceEurEtched: "",
		count: 1,
		finish: "regular",
		listId: "w1",
		dateAdded: 0,
		dateModified: 0,
		...overrides,
	};
}

describe("groupByWantlist", () => {
	it("mirrors groupByList for wantlist cards", () => {
		const wantlists: Wantlist[] = [{ id: "w1", name: "Wants" }];
		const wantlistCards: WantlistCard[] = [
			makeWantlistCardEntry({ listId: "w1", priceUsd: "10.00", count: 2 }),
		];
		const groups = groupByWantlist(wantlists, wantlistCards, "usd");
		expect(groups[0].totalQty).toBe(2);
		expect(groups[0].totalValue).toBe(20);
	});

	it("picks the cover from the price shown in the display currency", () => {
		const wantlists: Wantlist[] = [{ id: "w1", name: "Wants" }];
		const wantlistCards: WantlistCard[] = [
			makeWantlistCardEntry({ listId: "w1", artCropUrl: "usd-star.png", priceUsd: "50.00", priceEur: "1.00" }),
			makeWantlistCardEntry({ listId: "w1", artCropUrl: "eur-star.png", priceUsd: "2.00", priceEur: "30.00" }),
		];
		expect(groupByWantlist(wantlists, wantlistCards, "usd")[0].coverImage).toBe("usd-star.png");
		expect(groupByWantlist(wantlists, wantlistCards, "eur")[0].coverImage).toBe("eur-star.png");
	});
});
