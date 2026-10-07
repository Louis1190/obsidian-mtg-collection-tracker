import { describe, it, expect } from "vitest";
import {
	effectiveViewMode,
	viewModeClass,
	primaryType,
	isLand,
	colorSortKey,
	colorGroupLabel,
	deckColorIdentity,
	collectorNumberCompare,
	groupSortValue,
	groupLabelFor,
	sliceGroupsForRender,
	compareCardsBy,
	groupAndSortCards,
	SortableCard,
	CardGroup,
	DECK_GROUP_BY_OPTIONS,
	GROUP_BY_OPTIONS,
	estimateStackColumnHeight,
} from "./card-sorting";

function makeCard(overrides: Partial<SortableCard> & { releasedAt?: string; listId?: string } = {}): SortableCard {
	return {
		name: "Card",
		setName: "Set",
		setCode: "set",
		collectorNumber: "1",
		rarity: "common",
		manaValue: 0,
		typeLine: "Creature — Human",
		artist: "Artist",
		colors: [],
		count: 1,
		dateAdded: 0,
		dateModified: 0,
		priceUsd: "0",
		...overrides,
	};
}

const lists = [
	{ id: "list1", name: "Zeta list" },
	{ id: "list2", name: "Alpha list" },
];

describe("viewModeClass", () => {
	it("returns the grid class regardless of scope", () => {
		expect(viewModeClass("grid", "list")).toBe(" mtg-collection-list-grid");
		expect(viewModeClass("grid", "deck")).toBe(" mtg-collection-list-grid");
	});

	it("returns the stacks class regardless of scope", () => {
		expect(viewModeClass("stacks", "deck")).toBe(" mtg-collection-list-stacks");
		expect(viewModeClass("stacks", "list")).toBe(" mtg-collection-list-stacks");
	});

	it("returns a scope-specific table class", () => {
		expect(viewModeClass("table", "list")).toBe(
			" mtg-collection-list-table mtg-collection-list-table-collection"
		);
		expect(viewModeClass("table", "deck")).toBe(
			" mtg-collection-list-table mtg-collection-list-table-deck"
		);
		expect(viewModeClass("table", "wantlist")).toBe(
			" mtg-collection-list-table mtg-collection-list-table-wantlist"
		);
	});

	it("returns an empty class for list mode", () => {
		expect(viewModeClass("list", "list")).toBe("");
	});

	it("returns the cards class regardless of scope", () => {
		expect(viewModeClass("card", "list")).toBe(" mtg-collection-list-cards");
		expect(viewModeClass("card", "deck")).toBe(" mtg-collection-list-cards");
		expect(viewModeClass("card", "wantlist")).toBe(" mtg-collection-list-cards");
	});
});

describe("primaryType", () => {
	it("extracts the main type before the em dash", () => {
		expect(primaryType("Creature — Human Wizard")).toBe("Creature");
		expect(primaryType("Legendary Creature — Elf Warrior")).toBe("Creature");
		expect(primaryType("Land")).toBe("Land");
	});

	it("falls back to the raw prefix, then Other, when no known type matches", () => {
		expect(primaryType("Nonsense Card Type")).toBe("Nonsense Card Type");
		expect(primaryType("")).toBe("Other");
	});
});

describe("isLand", () => {
	it("matches the whole word Land", () => {
		expect(isLand("Land")).toBe(true);
		expect(isLand("Basic Land — Forest")).toBe(true);
	});

	it("does not match on a case-insensitive substring like 'Island'", () => {
		expect(isLand("Island")).toBe(false);
	});

	it("is false for non-land types and empty input", () => {
		expect(isLand("Creature")).toBe(false);
		expect(isLand("")).toBe(false);
	});
});

describe("colorSortKey", () => {
	it("puts lands at 6 regardless of colors", () => {
		expect(colorSortKey(makeCard({ typeLine: "Land", colors: ["U"] }))).toBe(6);
	});

	it("puts colorless non-lands at 7", () => {
		expect(colorSortKey(makeCard({ typeLine: "Artifact", colors: [] }))).toBe(7);
	});

	it("orders single colors WUBRG", () => {
		expect(colorSortKey(makeCard({ colors: ["W"] }))).toBe(0);
		expect(colorSortKey(makeCard({ colors: ["U"] }))).toBe(1);
		expect(colorSortKey(makeCard({ colors: ["G"] }))).toBe(4);
	});

	it("keeps multicolor cards strictly between single-color and Land (5,6)", () => {
		const key = colorSortKey(makeCard({ colors: ["W", "U"] }));
		expect(key).toBeGreaterThan(5);
		expect(key).toBeLessThan(6);
	});
});

describe("colorGroupLabel", () => {
	it("labels lands and colorless separately", () => {
		expect(colorGroupLabel(makeCard({ typeLine: "Land", colors: [] }))).toBe("Land");
		expect(colorGroupLabel(makeCard({ typeLine: "Artifact", colors: [] }))).toBe("Colorless");
	});

	it("labels a single color by name", () => {
		expect(colorGroupLabel(makeCard({ colors: ["B"] }))).toBe("Black");
	});

	it("joins multicolor combinations in WUBRG order", () => {
		expect(colorGroupLabel(makeCard({ colors: ["U", "W"] }))).toBe("White/Blue");
	});
});

describe("deckColorIdentity", () => {
	it("returns an empty array for an all-colorless deck", () => {
		expect(deckColorIdentity([{ colors: [] }, { colors: [] }])).toEqual([]);
	});

	it("unions colors across every card, deduplicated", () => {
		expect(
			deckColorIdentity([{ colors: ["U"] }, { colors: ["U", "W"] }, { colors: [] }])
		).toEqual(["W", "U"]);
	});

	it("sorts the result in canonical WUBRG order regardless of card order", () => {
		expect(
			deckColorIdentity([{ colors: ["G"] }, { colors: ["R"] }, { colors: ["W"] }])
		).toEqual(["W", "R", "G"]);
	});
});

describe("collectorNumberCompare", () => {
	it("compares purely numeric collector numbers numerically", () => {
		expect(collectorNumberCompare("2", "10")).toBeLessThan(0);
	});

	it("falls back to alphabetical comparison when the numeric prefixes tie", () => {
		// parseInt("23a") === parseInt("23b") === 23 : le nombre seul ne
		// distingue pas ces deux numéros de collection.
		expect(collectorNumberCompare("23a", "23b")).toBeLessThan(0);
	});

	it("falls back to alphabetical comparison when either side isn't numeric", () => {
		expect(collectorNumberCompare("abc", "abd")).toBeLessThan(0);
	});
});

describe("groupSortValue / groupLabelFor", () => {
	it("sorts and labels by rarity consistently", () => {
		const mythic = makeCard({ rarity: "mythic" });
		const common = makeCard({ rarity: "common" });
		expect(groupSortValue("rarity", mythic) as number).toBeGreaterThan(groupSortValue("rarity", common) as number);
		expect(groupLabelFor("rarity", mythic)).toBe("Mythic");
	});

	it("labels a missing artist as Unknown artist", () => {
		expect(groupLabelFor("artist", makeCard({ artist: "" }))).toBe("Unknown artist");
	});

	it("labels mana value and quantity groups", () => {
		expect(groupLabelFor("manaValue", makeCard({ manaValue: 3 }))).toBe("Mana value 3");
		expect(groupLabelFor("quantity", makeCard({ count: 4 }))).toBe("4x");
	});

	it("groups by Function: override wins, then auto-detection, then falls back to card type", () => {
		const overridden = makeCard({ deckFunctionOverride: "Wincon", typeLine: "Creature — Dragon" });
		const detected = makeCard({ typeLine: "Sorcery", oracleText: "Draw two cards." });
		const fallback = makeCard({ typeLine: "Creature — Human", oracleText: "A perfectly vanilla bear." });
		expect(groupLabelFor("function", overridden)).toBe("Wincon");
		expect(groupLabelFor("function", detected)).toBe("Draw");
		expect(groupLabelFor("function", fallback)).toBe("Creature");
		// Land (une catégorie connue de DECK_FUNCTION_CATEGORIES) doit trier
		// avant un repli de type inconnu de cette même liste (ex. "Creature"
		// y est bien présent, donc ce test compare plutôt deux catégories
		// connues entre elles pour confirmer que le tri suit bien
		// DECK_FUNCTION_CATEGORIES et non l'ordre alphabétique).
		const land = makeCard({ typeLine: "Land" });
		const ramp = makeCard({ typeLine: "Artifact", oracleText: "{T}: Add {C}." });
		expect(String(groupSortValue("function", land)).localeCompare(String(groupSortValue("function", ramp)))).toBeLessThan(
			0
		);
	});
});

describe("DECK_GROUP_BY_OPTIONS", () => {
	it("adds Function right after Don't group, keeping every other option from GROUP_BY_OPTIONS in order", () => {
		// "Category" retiré le 2026-09-07 (Commander est devenu une Function,
		// pas une catégorie — voir DeckCardCategory, data-model.ts) : Function
		// est désormais la seule option propre aux decks.
		expect(DECK_GROUP_BY_OPTIONS[0]).toEqual(GROUP_BY_OPTIONS[0]);
		expect(DECK_GROUP_BY_OPTIONS[1]).toEqual({ value: "function", label: "Function" });
		expect(DECK_GROUP_BY_OPTIONS.slice(2)).toEqual(GROUP_BY_OPTIONS.slice(1));
	});
});

describe("sliceGroupsForRender", () => {
	const groups: CardGroup<number>[] = [
		{ label: "A", cards: [1, 2, 3] },
		{ label: "B", cards: [4, 5] },
	];

	it("cuts the last visible group in the middle to hit the exact limit", () => {
		const result = sliceGroupsForRender(groups, 4);
		expect(result).toEqual([
			{ label: "A", cards: [1, 2, 3] },
			{ label: "B", cards: [4] },
		]);
	});

	it("returns everything when the limit exceeds the total card count", () => {
		expect(sliceGroupsForRender(groups, 100)).toEqual(groups);
	});

	it("returns nothing for a zero limit", () => {
		expect(sliceGroupsForRender(groups, 0)).toEqual([]);
	});
});

describe("compareCardsBy", () => {
	const a = makeCard({
		name: "Beta",
		artist: "Zed",
		collectorNumber: "20",
		colors: ["U"],
		manaValue: 5,
		count: 1,
		dateAdded: 100,
		dateModified: 200,
		rarity: "common",
		setName: "Alpha Set",
		typeLine: "Instant",
		priceUsd: "1.00",
		listId: "list2",
		releasedAt: "2020-01-01",
	} as any);
	const b = makeCard({
		name: "Alpha",
		artist: "Amy",
		collectorNumber: "3",
		colors: ["B"],
		manaValue: 2,
		count: 3,
		dateAdded: 50,
		dateModified: 400,
		rarity: "mythic",
		setName: "Beta Set",
		typeLine: "Creature",
		priceUsd: "9.00",
		listId: "list1",
		releasedAt: "2021-01-01",
	} as any);

	it("sorts by name by default", () => {
		expect(compareCardsBy("name", lists)(a, b)).toBeGreaterThan(0);
	});

	it.each([
		["artist", 1],
		["collectorNumber", 1],
		["color", -1],
		["manaValue", 1],
		["quantity", -1],
		["dateAdded", 1],
		["dateModified", -1],
		["rarity", -1],
		["price", -1],
		["set", -1],
		["type", 1],
		["releasedAt", -1],
	] as const)("sorts by %s in the expected direction", (sortBy, expectedSign) => {
		const result = compareCardsBy(sortBy, lists)(a, b);
		expect(Math.sign(result)).toBe(expectedSign);
	});

	it("resolves listName sort against the collection's lists", () => {
		// a est sur "list2" (Alpha list), b sur "list1" (Zeta list) : "Alpha
		// list" < "Zeta list" donc a doit passer avant b.
		expect(compareCardsBy("listName", lists)(a, b)).toBeLessThan(0);
	});
});

describe("groupAndSortCards", () => {
	const cards: SortableCard[] = [
		makeCard({ name: "Bolt", rarity: "common", colors: ["R"], manaValue: 1 }),
		makeCard({ name: "Ancestral", rarity: "mythic", colors: ["U"], manaValue: 1 }),
		makeCard({ name: "Colorless Golem", rarity: "uncommon", colors: [], typeLine: "Artifact" }),
	];

	it("returns a single unlabeled group when not grouping, sorted per sortBy", () => {
		const groups = groupAndSortCards(cards, "none", "name", false, false, lists);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("");
		expect(groups[0].cards.map((c) => c.name)).toEqual(["Ancestral", "Bolt", "Colorless Golem"]);
	});

	it("respects sortReverse within groups", () => {
		const groups = groupAndSortCards(cards, "none", "name", true, false, lists);
		expect(groups[0].cards.map((c) => c.name)).toEqual(["Colorless Golem", "Bolt", "Ancestral"]);
	});

	it("groups by rarity in RARITY_ORDER (common, uncommon, mythic)", () => {
		const groups = groupAndSortCards(cards, "rarity", "name", false, false, lists);
		expect(groups.map((g) => g.label)).toEqual(["Common", "Uncommon", "Mythic"]);
	});

	it("reverses group order when groupReverse is set", () => {
		const groups = groupAndSortCards(cards, "rarity", "name", false, true, lists);
		expect(groups.map((g) => g.label)).toEqual(["Mythic", "Uncommon", "Common"]);
	});

	it("attaches colorKeys for single-color groups and the Colorless special case", () => {
		const groups = groupAndSortCards(cards, "color", "name", false, false, lists);
		const colorless = groups.find((g) => g.label === "Colorless");
		expect(colorless?.colorKeys).toEqual(["C"]);
		const red = groups.find((g) => g.label === "Red");
		expect(red?.colorKeys).toEqual(["R"]);
	});
});

describe("estimateStackColumnHeight", () => {
	// Recalculé indépendamment des constantes internes du module (pas un
	// import) pour que ce test détecte vraiment un changement du ratio
	// carte/du recouvrement, pas seulement qu'il "matche ce que le code fait
	// déjà".
	const HEADER = 47;
	const W = 220;
	const cardHeight = W * (680 / 488);
	const sliverHeight = cardHeight - 1.2 * W;

	it("a single-card pile is just the header plus one full card, no sliver", () => {
		expect(estimateStackColumnHeight(1)).toBeCloseTo(HEADER + cardHeight, 5);
	});

	it("adds exactly one sliver height per card beyond the first", () => {
		expect(estimateStackColumnHeight(5)).toBeCloseTo(HEADER + cardHeight + 4 * sliverHeight, 5);
		expect(estimateStackColumnHeight(45)).toBeCloseTo(HEADER + cardHeight + 44 * sliverHeight, 5);
	});

	it("treats a zero/negative count the same as a single card", () => {
		expect(estimateStackColumnHeight(0)).toBe(estimateStackColumnHeight(1));
		expect(estimateStackColumnHeight(-3)).toBe(estimateStackColumnHeight(1));
	});

	it("is strictly increasing with card count", () => {
		const heights = [1, 2, 5, 10, 45].map(estimateStackColumnHeight);
		for (let i = 1; i < heights.length; i++) {
			expect(heights[i]).toBeGreaterThan(heights[i - 1]);
		}
	});

	// La vraie disparité qui a fait s'effondrer le nombre de colonnes que
	// column-fill: balance choisissait de peupler pour "Group by Type" (voir
	// docs/history/deck-stats-and-stacks-views.md) — un seul groupe bien plus
	// long que les autres fixe une hauteur de colonne cible que balance ne
	// pouvait plus jamais redescendre.
	it("a 45-card pile is dramatically taller than four separate 4-card piles combined", () => {
		expect(estimateStackColumnHeight(45)).toBeGreaterThan(estimateStackColumnHeight(4) * 4);
	});
});

describe("effectiveViewMode", () => {
	it("falls back to list on a phone for the modes whose buttons are hidden there", () => {
		expect(effectiveViewMode("grid", true)).toBe("list");
		expect(effectiveViewMode("table", true)).toBe("list");
		expect(effectiveViewMode("stacks", true)).toBe("list");
	});

	it("keeps the two modes a phone offers", () => {
		expect(effectiveViewMode("list", true)).toBe("list");
		expect(effectiveViewMode("card", true)).toBe("card");
	});

	it("never changes anything off a phone", () => {
		for (const mode of ["list", "grid", "table", "card", "stacks"] as const) {
			expect(effectiveViewMode(mode, false)).toBe(mode);
		}
	});
});
