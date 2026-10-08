import { describe, it, expect } from "vitest";
import {
	categorizeToken,
	colorTokenMatches,
	rarityTokenMatches,
	languageTokenMatches,
	conditionTokenMatches,
	foilTokenMatches,
	typeTokenMatches,
	artistTokenMatches,
	setTokenMatches,
	cardNumTokenMatches,
	keywordTokenMatches,
	textTokenMatches,
	matchNumericField,
	parseNumericToken,
	numericTokenMatches,
	isNegatedToken,
	stripNegation,
	isExactToken,
	stripExact,
	chipTokenToScryfallClause,
	buildScryfallQueryFromChips,
	extractExactLookupHints,
	cardMatchesTokens,
	recognizeKeywordToken,
	SearchableCard,
	SUGGESTABLE_KEYWORDS,
	legalityTokenMatches,
	tokensNeedLegalityData,
	LEGALITY_SEARCH_FORMATS,
	borderTokenMatches,
	BORDER_SEARCH_OPTIONS,
	oracleTokenMatches,
	hasUnclosedQuote,
	stripQuotesFromCommittedToken,
	describeSearchFilters,
	legalityStatusClass,
	deckLegalityBadge,
} from "./card-search";

function makeSearchableCard(overrides: Partial<SearchableCard> = {}): SearchableCard {
	return {
		name: "Lightning Bolt",
		rarity: "common",
		typeLine: "Instant",
		setName: "Set",
		setCode: "set",
		collectorNumber: "1",
		artist: "Christopher Rush",
		colors: ["R"],
		...overrides,
	};
}

describe("categorizeToken", () => {
	it.each([
		["", "text"],
		["artist:John Avon", "artist"],
		["set:mid", "set"],
		["#235", "cardnum"],
		["#235a", "cardnum"],
		["cmc>3", "numeric_cmc"],
		["price<=5", "numeric_price"],
		["qty>=2", "numeric_qty"],
		["added=2026-01-01", "numeric_added"],
		["white", "color"],
		["mythic", "rarity"],
		["french", "language"],
		["nm", "condition"],
		["etched", "foil"],
		["recent", "recentlyadded"],
		["legal:modern", "legality"],
		["legal:", "legality"],
		["banned:legacy", "legality"],
		["restricted:vintage", "legality"],
		["border:showcase", "border"],
		["border:", "border"],
		["oracle:draw a card", "oracle"],
		["oracle:", "oracle"],
		["creature", "type"],
		["flying", "keyword"],
		["xyznonsense", "text"],
	])("categorizes %s as %s", (token, expected) => {
		expect(categorizeToken(token)).toBe(expected);
	});
});

describe("colorTokenMatches", () => {
	it("matches a card that has the named color", () => {
		expect(colorTokenMatches(makeSearchableCard({ colors: ["W"] }), "white")).toBe(true);
		expect(colorTokenMatches(makeSearchableCard({ colors: ["U"] }), "white")).toBe(false);
	});

	it("matches multicolor for 2+ colors", () => {
		expect(colorTokenMatches(makeSearchableCard({ colors: ["W", "U"] }), "multicolor")).toBe(true);
		expect(colorTokenMatches(makeSearchableCard({ colors: ["W"] }), "multicolor")).toBe(false);
	});

	it("matches colorless only for a non-land card with no colors", () => {
		expect(
			colorTokenMatches(makeSearchableCard({ colors: [], typeLine: "Artifact" }), "colorless")
		).toBe(true);
	});

	it("does not match colorless for a colorless land (excluded, same as colorGroupLabel)", () => {
		expect(colorTokenMatches(makeSearchableCard({ colors: [], typeLine: "Land" }), "colorless")).toBe(
			false
		);
	});
});

describe("rarityTokenMatches", () => {
	it("prefix-matches the card's rarity", () => {
		expect(rarityTokenMatches(makeSearchableCard({ rarity: "rare" }), "rare")).toBe(true);
		expect(rarityTokenMatches(makeSearchableCard({ rarity: "rare" }), "myth")).toBe(false);
	});
});

describe("languageTokenMatches", () => {
	it("matches the card's language, defaulting to English", () => {
		expect(languageTokenMatches(makeSearchableCard({ language: "fr" }), "french")).toBe(true);
		expect(languageTokenMatches(makeSearchableCard({ language: undefined }), "english")).toBe(true);
	});
});

describe("conditionTokenMatches", () => {
	it("matches via any of a condition's known keywords", () => {
		expect(conditionTokenMatches(makeSearchableCard({ condition: "NM" }), "near")).toBe(true);
		// "mint" alone now designates MT (Mint), a tier distinct from NM since the
		// switch to the Cardmarket scale — see CONDITION_SEARCH_ENTRIES.
		expect(conditionTokenMatches(makeSearchableCard({ condition: "MT" }), "mint")).toBe(true);
	});

	it("matches 'none' for an empty/missing condition", () => {
		expect(conditionTokenMatches(makeSearchableCard({ condition: "" }), "none")).toBe(true);
		expect(conditionTokenMatches(makeSearchableCard({ condition: undefined }), "none")).toBe(true);
	});
});

describe("foilTokenMatches", () => {
	it("matches etched/surged/proxy only against their exact finish", () => {
		expect(foilTokenMatches(makeSearchableCard({ finish: "etched" }), "etched")).toBe(true);
		expect(foilTokenMatches(makeSearchableCard({ finish: "surged" }), "surge")).toBe(true);
		expect(foilTokenMatches(makeSearchableCard({ finish: "proxy" }), "proxy")).toBe(true);
	});

	it("matches nonfoil for regular or proxy", () => {
		expect(foilTokenMatches(makeSearchableCard({ finish: "regular" }), "nonfoil")).toBe(true);
		expect(foilTokenMatches(makeSearchableCard({ finish: "proxy" }), "nonfoil")).toBe(true);
		expect(foilTokenMatches(makeSearchableCard({ finish: "foiled" }), "nonfoil")).toBe(false);
	});

	it("matches 'foil' for any finish with a foil look, including etched and surged", () => {
		expect(foilTokenMatches(makeSearchableCard({ finish: "foiled" }), "foil")).toBe(true);
		expect(foilTokenMatches(makeSearchableCard({ finish: "etched" }), "foil")).toBe(true);
		expect(foilTokenMatches(makeSearchableCard({ finish: "surged" }), "foil")).toBe(true);
		expect(foilTokenMatches(makeSearchableCard({ finish: "regular" }), "foil")).toBe(false);
	});

	it("defaults a missing finish to regular", () => {
		expect(foilTokenMatches(makeSearchableCard({ finish: undefined }), "foil")).toBe(false);
	});
});

describe("legalityTokenMatches", () => {
	const legalMap: Map<string, Record<string, string>> = new Map([
		["abc123", { modern: "legal", standard: "not_legal", legacy: "banned" }],
	]);

	it("matches only when the resolved format's status is exactly 'legal'", () => {
		const card = makeSearchableCard({ scryfallId: "abc123" });
		expect(legalityTokenMatches(card, "legal:modern", legalMap)).toBe(true);
		expect(legalityTokenMatches(card, "legal:standard", legalMap)).toBe(false);
		expect(legalityTokenMatches(card, "legal:legacy", legalMap)).toBe(false);
	});

	it("resolves the format by prefix, on either the key or the display label", () => {
		const card = makeSearchableCard({ scryfallId: "abc123" });
		expect(legalityTokenMatches(card, "legal:mod", legalMap)).toBe(true);
		// "tlr" (key) has the label "Tiny Leaders" — it doesn't start with "tlr"
		// but with "tiny", so only label resolution can make this prefix match.
		const tinyLeadersMap: Map<string, Record<string, string>> = new Map([["abc123", { tlr: "legal" }]]);
		expect(legalityTokenMatches(card, "legal:tiny", tinyLeadersMap)).toBe(true);
	});

	it("never matches (positively) when the card's legalities aren't in the map yet", () => {
		const card = makeSearchableCard({ scryfallId: "not-fetched-yet" });
		expect(legalityTokenMatches(card, "legal:modern", legalMap)).toBe(false);
	});

	it("never matches without a scryfallId, an unrecognized format, or a bare 'legal:'", () => {
		expect(legalityTokenMatches(makeSearchableCard({ scryfallId: undefined }), "legal:modern", legalMap)).toBe(
			false
		);
		expect(legalityTokenMatches(makeSearchableCard({ scryfallId: "abc123" }), "legal:xyz", legalMap)).toBe(
			false
		);
		expect(legalityTokenMatches(makeSearchableCard({ scryfallId: "abc123" }), "legal:", legalMap)).toBe(false);
		expect(legalityTokenMatches(makeSearchableCard({ scryfallId: "abc123" }), "modern", legalMap)).toBe(false);
	});

	it("covers every LEGALITY_SEARCH_FORMATS key against a real legalities-shaped object", () => {
		// A key missing/misspelled in LEGALITY_SEARCH_FORMATS wouldn't break
		// anything visible (just "never legal") — this test would catch it by
		// explicitly checking each format against an object where all the keys are
		// "legal".
		const allLegal = Object.fromEntries(LEGALITY_SEARCH_FORMATS.map((f) => [f.key, "legal"]));
		const map = new Map([["abc123", allLegal]]);
		const card = makeSearchableCard({ scryfallId: "abc123" });
		LEGALITY_SEARCH_FORMATS.forEach((f) => {
			expect(legalityTokenMatches(card, `legal:${f.key}`, map)).toBe(true);
		});
	});

	// "banned:"/"restricted:" share legalityTokenMatches with "legal:" (see
	// LEGALITY_STATUS_PREFIXES, card-search.ts) — checks that the status
	// searched for is the one actually compared, not always "legal".
	it("matches 'banned:'/'restricted:' against their own status, not 'legal'", () => {
		const card = makeSearchableCard({ scryfallId: "abc123" });
		expect(legalityTokenMatches(card, "banned:legacy", legalMap)).toBe(true);
		expect(legalityTokenMatches(card, "banned:modern", legalMap)).toBe(false);
		expect(legalityTokenMatches(card, "restricted:modern", legalMap)).toBe(false);
		const restrictedMap: Map<string, Record<string, string>> = new Map([
			["abc123", { vintage: "restricted" }],
		]);
		expect(legalityTokenMatches(card, "restricted:vintage", restrictedMap)).toBe(true);
		expect(legalityTokenMatches(card, "legal:vintage", restrictedMap)).toBe(false);
		expect(legalityTokenMatches(card, "banned:vintage", restrictedMap)).toBe(false);
	});

	it("covers every LEGALITY_SEARCH_FORMATS key for 'banned:' and 'restricted:' too", () => {
		const card = makeSearchableCard({ scryfallId: "abc123" });
		const allBanned = Object.fromEntries(LEGALITY_SEARCH_FORMATS.map((f) => [f.key, "banned"]));
		const bannedMap = new Map([["abc123", allBanned]]);
		LEGALITY_SEARCH_FORMATS.forEach((f) => {
			expect(legalityTokenMatches(card, `banned:${f.key}`, bannedMap)).toBe(true);
			expect(legalityTokenMatches(card, `legal:${f.key}`, bannedMap)).toBe(false);
		});
		const allRestricted = Object.fromEntries(
			LEGALITY_SEARCH_FORMATS.map((f) => [f.key, "restricted"])
		);
		const restrictedMap = new Map([["abc123", allRestricted]]);
		LEGALITY_SEARCH_FORMATS.forEach((f) => {
			expect(legalityTokenMatches(card, `restricted:${f.key}`, restrictedMap)).toBe(true);
			expect(legalityTokenMatches(card, `legal:${f.key}`, restrictedMap)).toBe(false);
		});
	});
});

describe("legalityStatusClass", () => {
	it("maps legal/restricted/banned to their own tile class", () => {
		expect(legalityStatusClass("legal")).toBe("is-legal");
		expect(legalityStatusClass("restricted")).toBe("is-restricted");
		expect(legalityStatusClass("banned")).toBe("is-banned");
	});

	it("returns null for 'not_legal' and any unknown/missing value (neutral tile look)", () => {
		expect(legalityStatusClass("not_legal")).toBeNull();
		expect(legalityStatusClass(undefined)).toBeNull();
		expect(legalityStatusClass("something_unexpected")).toBeNull();
	});
});

describe("deckLegalityBadge", () => {
	it("maps legal/restricted/banned to their own badge class with a descriptive title", () => {
		expect(deckLegalityBadge("legal", "Commander")).toEqual({
			cls: "is-legal",
			title: "Legal in Commander",
		});
		expect(deckLegalityBadge("restricted", "Vintage")).toEqual({
			cls: "is-restricted",
			title: "Restricted in Vintage",
		});
		expect(deckLegalityBadge("banned", "Modern")).toEqual({
			cls: "is-banned",
			title: "Banned in Modern",
		});
	});

	it("treats 'not_legal' as a real, distinct status (unlike legalityStatusClass)", () => {
		expect(deckLegalityBadge("not_legal", "Standard")).toEqual({
			cls: "is-not-legal",
			title: "Not legal in Standard",
		});
	});

	it("returns null when the status isn't known yet or is unrecognized", () => {
		expect(deckLegalityBadge(undefined, "Commander")).toBeNull();
		expect(deckLegalityBadge("something_unexpected", "Commander")).toBeNull();
	});
});

describe("borderTokenMatches", () => {
	it("matches a border color value against borderColor", () => {
		expect(borderTokenMatches(makeSearchableCard({ borderColor: "black" }), "border:black")).toBe(true);
		expect(borderTokenMatches(makeSearchableCard({ borderColor: "white" }), "border:black")).toBe(false);
		expect(borderTokenMatches(makeSearchableCard({ borderColor: "borderless" }), "border:borderless")).toBe(
			true
		);
	});

	it("matches extended/showcase against frameEffects, not borderColor", () => {
		const extended = makeSearchableCard({ borderColor: "black", frameEffects: ["legendary", "extendedart"] });
		expect(borderTokenMatches(extended, "border:extended")).toBe(true);
		expect(borderTokenMatches(extended, "border:showcase")).toBe(false);
		const showcase = makeSearchableCard({ borderColor: "borderless", frameEffects: ["showcase"] });
		expect(borderTokenMatches(showcase, "border:showcase")).toBe(true);
	});

	it("matches retro against frame, not a frameEffect or borderColor", () => {
		expect(borderTokenMatches(makeSearchableCard({ frame: "1997" }), "border:retro")).toBe(true);
		expect(borderTokenMatches(makeSearchableCard({ frame: "2015" }), "border:retro")).toBe(false);
	});

	it("resolves the option by prefix, on either the value or the display label", () => {
		const card = makeSearchableCard({ borderColor: "borderless" });
		expect(borderTokenMatches(card, "border:border")).toBe(true);
		// "showcase" (value) and its label "Showcase" coincide here, so we rather
		// check a case where only the label tells them apart (e.g. "Extended Art"
		// has a space, "extended" alone only appears in value/label both — used
		// "yellow" vs its label "Yellow Border" instead, "yellow bo" only matches
		// through the label).
		expect(borderTokenMatches(makeSearchableCard({ borderColor: "yellow" }), "border:yellow bo")).toBe(true);
	});

	it("never matches a card not yet backfilled (borderColor/frame/frameEffects all undefined)", () => {
		const card = makeSearchableCard({ borderColor: undefined, frame: undefined, frameEffects: undefined });
		BORDER_SEARCH_OPTIONS.forEach((o) => {
			expect(borderTokenMatches(card, `border:${o.value}`)).toBe(false);
		});
	});

	it("never matches an unrecognized value, a bare 'border:', or a token without the prefix", () => {
		expect(borderTokenMatches(makeSearchableCard({ borderColor: "black" }), "border:xyz")).toBe(false);
		expect(borderTokenMatches(makeSearchableCard({ borderColor: "black" }), "border:")).toBe(false);
		expect(borderTokenMatches(makeSearchableCard({ borderColor: "black" }), "black")).toBe(false);
	});

	it("covers every BORDER_SEARCH_OPTIONS entry against a real card-shaped object", () => {
		// Same safety net as the equivalent test for LEGALITY_SEARCH_FORMATS above
		// — an entry whose matches() never matches anything (a typo in a field
		// name, for example) wouldn't break anything visible, just "never found".
		BORDER_SEARCH_OPTIONS.forEach((o) => {
			const card = makeSearchableCard({
				borderColor: o.value,
				frame: o.value === "retro" ? "1997" : "2015",
				frameEffects: o.value === "extended" ? ["extendedart"] : o.value === "showcase" ? ["showcase"] : [],
			});
			expect(borderTokenMatches(card, `border:${o.value}`)).toBe(true);
		});
	});
});

describe("oracleTokenMatches", () => {
	it("matches a substring of oracleText, case-insensitively", () => {
		const card = makeSearchableCard({ oracleText: "Draw a card." });
		expect(oracleTokenMatches(card, "oracle:draw a card")).toBe(true);
		expect(oracleTokenMatches(card, "oracle:DRAW A CARD")).toBe(true);
		expect(oracleTokenMatches(card, "oracle:instant speed")).toBe(false);
	});

	it("never matches a card with no oracleText yet (not backfilled)", () => {
		expect(oracleTokenMatches(makeSearchableCard({ oracleText: undefined }), "oracle:draw")).toBe(false);
	});

	it("never matches a bare 'oracle:' or a token without the prefix", () => {
		const card = makeSearchableCard({ oracleText: "Draw a card." });
		expect(oracleTokenMatches(card, "oracle:")).toBe(false);
		expect(oracleTokenMatches(card, "draw a card")).toBe(false);
	});

	it("matches embedded mana symbol notation literally, not the English word", () => {
		// Scryfall writes the mana symbols "{C}"/"{X}" in oracle_text — documented
		// as a known limitation rather than normalized (see the comment of
		// oracleTokenMatches).
		const card = makeSearchableCard({ oracleText: "{T}: Add {C}." });
		expect(oracleTokenMatches(card, "oracle:{c}")).toBe(true);
		expect(oracleTokenMatches(card, "oracle:add mana")).toBe(false);
	});
});

describe("hasUnclosedQuote", () => {
	it("is false with no quotes, or an even count", () => {
		expect(hasUnclosedQuote("oracle:draw")).toBe(false);
		expect(hasUnclosedQuote('oracle:"draw a card"')).toBe(false);
		expect(hasUnclosedQuote('oracle:"draw a card" ')).toBe(false);
	});

	it("is true with an odd count (a still-open quoted phrase)", () => {
		expect(hasUnclosedQuote('oracle:"prevent all')).toBe(true);
		expect(hasUnclosedQuote('oracle:"prevent all ')).toBe(true);
	});
});

describe("stripQuotesFromCommittedToken", () => {
	it("unwraps a quoted oracle: value", () => {
		expect(stripQuotesFromCommittedToken('oracle:"prevent all damage"')).toBe(
			"oracle:prevent all damage"
		);
		expect(stripQuotesFromCommittedToken('-oracle:"prevent all damage"')).toBe(
			"-oracle:prevent all damage"
		);
	});

	it("leaves an unquoted oracle: value untouched", () => {
		expect(stripQuotesFromCommittedToken("oracle:reach")).toBe("oracle:reach");
	});

	it("leaves non-oracle tokens untouched, even with quotes", () => {
		expect(stripQuotesFromCommittedToken('blue')).toBe("blue");
		expect(stripQuotesFromCommittedToken('artist:"John Avon"')).toBe('artist:"John Avon"');
	});
});

describe("typeTokenMatches", () => {
	it("substring-matches the type line", () => {
		expect(typeTokenMatches(makeSearchableCard({ typeLine: "Creature — Human Wizard" }), "human")).toBe(
			true
		);
	});
});

describe("artistTokenMatches", () => {
	it("requires an exact (case-insensitive) match, not a prefix", () => {
		expect(artistTokenMatches(makeSearchableCard({ artist: "John Avon" }), "artist:john avon")).toBe(
			true
		);
		expect(artistTokenMatches(makeSearchableCard({ artist: "John Avon Jr" }), "artist:john avon")).toBe(
			false
		);
	});
});

describe("setTokenMatches / cardNumTokenMatches", () => {
	it("compares set code and collector number case-insensitively", () => {
		expect(setTokenMatches(makeSearchableCard({ setCode: "MID" }), "set:mid")).toBe(true);
		expect(cardNumTokenMatches(makeSearchableCard({ collectorNumber: "235" }), "#235")).toBe(true);
		expect(cardNumTokenMatches(makeSearchableCard({ collectorNumber: "236" }), "#235")).toBe(false);
	});
});

describe("keywordTokenMatches", () => {
	it("prefix-matches any of the card's keywords", () => {
		const card = makeSearchableCard({ keywords: ["Flying", "First strike"] });
		expect(keywordTokenMatches(card, "fly")).toBe(true);
		expect(keywordTokenMatches(card, "first")).toBe(true);
		expect(keywordTokenMatches(card, "trample")).toBe(false);
	});
});

describe("textTokenMatches", () => {
	it("matches name, type, set, artist, or keywords", () => {
		const card = makeSearchableCard({ name: "Lightning Bolt", artist: "Christopher Rush" });
		expect(textTokenMatches(card, "bolt")).toBe(true);
		expect(textTokenMatches(card, "rush")).toBe(true);
		expect(textTokenMatches(card, "nonexistent")).toBe(false);
	});

	it("matches everything for an empty token", () => {
		expect(textTokenMatches(makeSearchableCard(), "")).toBe(true);
	});
});

describe("matchNumericField", () => {
	it("prefix-matches a field alias", () => {
		expect(matchNumericField("cm")?.key).toBe("cmc");
		expect(matchNumericField("pri")?.key).toBe("price");
	});

	it("requires at least 2 characters and returns null otherwise", () => {
		expect(matchNumericField("q")).toBeNull();
		expect(matchNumericField("zzz")).toBeNull();
	});
});

describe("parseNumericToken", () => {
	it("parses a numeric comparison", () => {
		const parsed = parseNumericToken("cmc>3");
		expect(parsed?.field.key).toBe("cmc");
		expect(parsed?.operator).toBe(">");
		expect(parsed?.value).toBe(3);
	});

	it("parses a date comparison and keeps the raw date string", () => {
		const parsed = parseNumericToken("added=2026-01-15");
		expect(parsed?.field.key).toBe("added");
		expect(parsed?.rawDateStr).toBe("2026-01-15");
	});

	it("returns null for malformed or unknown-field tokens", () => {
		expect(parseNumericToken("cmc>>3")).toBeNull();
		expect(parseNumericToken("foo>3")).toBeNull();
	});
});

describe("numericTokenMatches", () => {
	it("compares number fields with all 5 operators", () => {
		const card = makeSearchableCard({ manaValue: 4 });
		expect(numericTokenMatches(card, "cmc>3")).toBe(true);
		expect(numericTokenMatches(card, "cmc<3")).toBe(false);
		expect(numericTokenMatches(card, "cmc=4")).toBe(true);
		expect(numericTokenMatches(card, "cmc>=4")).toBe(true);
		expect(numericTokenMatches(card, "cmc<=3")).toBe(false);
	});

	it("compares price and quantity fields", () => {
		expect(numericTokenMatches(makeSearchableCard({ priceUsd: "2.50" }), "price>2")).toBe(true);
		expect(numericTokenMatches(makeSearchableCard({ count: 3 }), "qty>=3")).toBe(true);
	});

	it("compares the date field by whole day, not exact timestamp", () => {
		const noon15th = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
		const card = makeSearchableCard({ dateAdded: noon15th });
		expect(numericTokenMatches(card, "added=2026-01-15")).toBe(true);
		expect(numericTokenMatches(card, "added>2026-01-15")).toBe(false);
		expect(numericTokenMatches(card, "added>=2026-01-15")).toBe(true);
		expect(numericTokenMatches(card, "added<2026-01-15")).toBe(false);
		expect(numericTokenMatches(card, "added<=2026-01-15")).toBe(true);
	});

	it("never matches a date field when dateAdded is missing", () => {
		expect(numericTokenMatches(makeSearchableCard({ dateAdded: undefined }), "added>=2020-01-01")).toBe(
			false
		);
	});

	it("returns false for an unparseable token", () => {
		expect(numericTokenMatches(makeSearchableCard(), "cmc?3")).toBe(false);
	});
});

describe("isNegatedToken / stripNegation", () => {
	it("recognizes a leading dash with content after it", () => {
		expect(isNegatedToken("-red")).toBe(true);
		expect(isNegatedToken("-")).toBe(false);
		expect(isNegatedToken("red")).toBe(false);
	});

	it("strips exactly the leading dash", () => {
		expect(stripNegation("-red")).toBe("red");
	});
});

describe("isExactToken / stripExact", () => {
	it("recognizes a leading equals sign with content after it", () => {
		expect(isExactToken("=blue")).toBe(true);
		expect(isExactToken("=")).toBe(false);
		expect(isExactToken("blue")).toBe(false);
		// Mutually exclusive with negation: a "-=blue" does not start with "=" (it
		// starts with "-"), so it isn't an "exact" token.
		expect(isExactToken("-blue")).toBe(false);
	});

	it("strips exactly the leading equals sign", () => {
		expect(stripExact("=blue")).toBe("blue");
	});
});

describe("chipTokenToScryfallClause", () => {
	it.each([
		["blue", "c:u"],
		["-blue", "-c:u"],
		["rare", "r:rare"],
		["creature", "t:creature"],
		["flying", 'keyword:"Flying"'],
		["etched", "is:etched"],
		["nonfoil", "-is:foil"],
		["-nonfoil", "is:foil"],
		["foil", "is:foil"],
		["french", "lang:fr"],
		["cmc>3", "cmc>3"],
		["price>3", "usd>3"],
		["legal:modern", "legal:modern"],
		["legal:mod", "legal:modern"],
		["-legal:modern", "-legal:modern"],
		["banned:legacy", "banned:legacy"],
		["restricted:vin", "restricted:vintage"],
		["-banned:legacy", "-banned:legacy"],
		["border:borderless", "border:borderless"],
		["border:black", "border:black"],
		["border:extended", "frame:extendedart"],
		["border:showcase", "frame:showcase"],
		["border:retro", "frame:1997"],
		["border:ext", "frame:extendedart"],
		["-border:black", "-border:black"],
		['oracle:draw a card', 'oracle:"draw a card"'],
		['-oracle:draw a card', '-oracle:"draw a card"'],
	])("translates %s to %s", (token, expected) => {
		expect(chipTokenToScryfallClause(token)).toBe(expected);
	});

	it("returns null for an unrecognized format after 'legal:'", () => {
		expect(chipTokenToScryfallClause("legal:xyz")).toBeNull();
	});

	it("returns null for an unrecognized value after 'border:'", () => {
		expect(chipTokenToScryfallClause("border:xyz")).toBeNull();
	});

	it("returns null for a bare 'oracle:' with no value, and strips a stray quote", () => {
		expect(chipTokenToScryfallClause("oracle:")).toBeNull();
		expect(chipTokenToScryfallClause('oracle:say "hello"')).toBe('oracle:"say hello"');
	});

	it("has no Scryfall equivalent for surged or proxy (collection-only concepts)", () => {
		expect(chipTokenToScryfallClause("surged")).toBeNull();
		expect(chipTokenToScryfallClause("proxy")).toBeNull();
	});

	it("translates multicolor/colorless to their Scryfall color clauses", () => {
		// categorizeToken's color check used to be only `COLOR_SEARCH_KEYWORDS
		// name startsWith(query)` — a prefix check the wrong way round for these
		// two values, since no 5-6 letter color name can start with the 9-10
		// letter "multicolor"/"colorless". Fixed by adding an explicit
		// fixed-string-startsWith-query check for these two values, so they now
		// reach chipTokenToScryfallClause's dedicated multicolor/colorless
		// branches like every other SUGGESTABLE_KEYWORDS color entry.
		expect(chipTokenToScryfallClause("multicolor")).toBe("c:m");
		expect(chipTokenToScryfallClause("colorless")).toBe("c:c");
	});

	it("returns null for excluded categories (condition, qty, added, recentlyadded, artist, set)", () => {
		expect(chipTokenToScryfallClause("nm")).toBeNull();
		expect(chipTokenToScryfallClause("qty>2")).toBeNull();
		expect(chipTokenToScryfallClause("added=2026-01-01")).toBeNull();
		expect(chipTokenToScryfallClause("recent")).toBeNull();
		expect(chipTokenToScryfallClause("artist:john")).toBeNull();
		expect(chipTokenToScryfallClause("set:mid")).toBeNull();
	});

	it("returns null for empty input and for plain unrecognized text", () => {
		expect(chipTokenToScryfallClause("")).toBeNull();
		expect(chipTokenToScryfallClause("xyzfreetext")).toBeNull();
	});

	it("returns null for a lone exact-color token — aggregation into 'c=' happens in buildScryfallQueryFromChips, not here", () => {
		// Deliberate: this isolated token doesn't know the other "=" tokens that
		// may be present, so it cannot build a correct combined c= clause on its
		// own — see buildScryfallQueryFromChips below.
		expect(chipTokenToScryfallClause("=blue")).toBeNull();
	});
});

describe("buildScryfallQueryFromChips", () => {
	it("combines recognized chips into Scryfall clauses", () => {
		expect(buildScryfallQueryFromChips(["blue", "rare"], "")).toBe("c:u r:rare");
	});

	it("passes free text through untouched, appending the draft", () => {
		expect(buildScryfallQueryFromChips([], "Lightning Bolt")).toBe("Lightning Bolt");
		expect(buildScryfallQueryFromChips(["blue"], "dragon")).toBe("c:u dragon");
	});

	it("intercepts set: and #number specially, ahead of the generic chip logic", () => {
		expect(buildScryfallQueryFromChips(["set:mid"], "")).toBe("s:mid");
		expect(buildScryfallQueryFromChips(["#235"], "")).toBe("cn:235");
	});

	it("merges several set: chips into ONE parenthesized OR clause, not separate AND'd ones", () => {
		// Reported bug: separate "s:znr s:khm" (joined by a space = AND for
		// Scryfall) would require a card to belong to TWO sets at once, which no
		// card can ever satisfy — same class of bug as exact color identity,
		// tested just further down in this file.
		expect(buildScryfallQueryFromChips(["set:znr", "set:khm"], "")).toBe("(s:znr or s:khm)");
	});

	it("keeps a single set: chip as a bare clause, no parentheses needed", () => {
		expect(buildScryfallQueryFromChips(["set:znr"], "")).toBe("s:znr");
	});

	it("keeps negated set: chips as separate AND'd clauses, not merged", () => {
		// Excluding two sets at once is a perfectly valid AND (unlike inclusion) —
		// not the same merge as the positive tokens above.
		expect(buildScryfallQueryFromChips(["-set:znr", "-set:khm"], "")).toBe("-s:znr -s:khm");
	});

	it("combines a merged set: OR-clause with an unrelated facet via AND", () => {
		expect(buildScryfallQueryFromChips(["set:znr", "set:khm", "rare"], "")).toBe(
			"(s:znr or s:khm) r:rare"
		);
	});

	it("negates a recognized chip's clause", () => {
		expect(buildScryfallQueryFromChips(["-red"], "")).toBe("-c:r");
	});

	it("drops chips from excluded categories entirely, rather than emitting an empty clause", () => {
		expect(buildScryfallQueryFromChips(["nm"], "")).toBe("");
	});

	it("translates a single exact-color chip to Scryfall's exact color identity operator", () => {
		expect(buildScryfallQueryFromChips(["=blue"], "")).toBe("c=u");
	});

	it("merges several exact-color chips into ONE combined c= clause, not several separate ones", () => {
		// Two separate c= clauses ("c=u c=w") would be contradictory for Scryfall
		// (an identity can't equal two values at once) — see the comment of
		// buildScryfallQueryFromChips.
		expect(buildScryfallQueryFromChips(["=blue", "=white"], "")).toBe("c=wu");
	});

	it("orders a merged exact-color clause canonically (WUBRG), regardless of chip insertion order", () => {
		expect(buildScryfallQueryFromChips(["=black", "=white"], "")).toBe("c=wb");
	});

	it("dedupes a repeated exact-color chip rather than doubling the letter", () => {
		expect(buildScryfallQueryFromChips(["=blue", "=blue"], "")).toBe("c=u");
	});

	it("combines an exact-color clause with an unrelated facet via AND, same as any other chip", () => {
		expect(buildScryfallQueryFromChips(["=blue", "rare"], "")).toBe("c=u r:rare");
	});

	it("falls back a non-color exact-marked chip to its ordinary bare clause", () => {
		// "=rare" is never produced by the UI (the "=" toggle only appears on a
		// color chip), but a hand-typed/imported token must remain useful rather
		// than be silently ignored.
		expect(buildScryfallQueryFromChips(["=rare"], "")).toBe("r:rare");
	});
});

describe("extractExactLookupHints", () => {
	it("extracts set code and collector number hints", () => {
		expect(extractExactLookupHints(["set:mid", "#235"], "")).toEqual({
			setCode: "mid",
			collectorNumber: "235",
		});
	});

	it("ignores negated hints", () => {
		expect(extractExactLookupHints(["-set:mid"], "")).toEqual({ setCode: "", collectorNumber: "" });
	});

	it("includes the in-progress draft", () => {
		expect(extractExactLookupHints([], "set:war")).toEqual({ setCode: "war", collectorNumber: "" });
	});

	it("skips the exact-lookup shortcut when two set: chips are active (bug: silently dropped one set)", () => {
		expect(extractExactLookupHints(["set:ltr", "set:lte", "#139"], "")).toEqual({
			setCode: "",
			collectorNumber: "139",
		});
	});
});

describe("cardMatchesTokens", () => {
	it("matches everything when there are no tokens", () => {
		expect(cardMatchesTokens(makeSearchableCard(), [], "")).toBe(true);
	});

	it("excludes a card matching a negative token", () => {
		const card = makeSearchableCard({ rarity: "rare" });
		expect(cardMatchesTokens(card, ["-rare"], "")).toBe(false);
	});

	it("combines same-category chips with OR", () => {
		const card = makeSearchableCard({ colors: ["U"] });
		expect(cardMatchesTokens(card, ["white", "blue"], "")).toBe(true);
	});

	it("combines different-category chips with AND", () => {
		const card = makeSearchableCard({ colors: ["U"], rarity: "common" });
		expect(cardMatchesTokens(card, ["blue", "rare"], "")).toBe(false);
		expect(cardMatchesTokens(makeSearchableCard({ colors: ["U"], rarity: "rare" }), ["blue", "rare"], "")).toBe(
			true
		);
	});

	it("treats multiple numeric constraints on the same field as a range (AND)", () => {
		const card = makeSearchableCard({ manaValue: 3 });
		expect(cardMatchesTokens(card, ["cmc>2", "cmc<5"], "")).toBe(true);
		expect(cardMatchesTokens(makeSearchableCard({ manaValue: 6 }), ["cmc>2", "cmc<5"], "")).toBe(false);
	});

	it("handles the recentlyadded category via the session id set, positively and negatively", () => {
		const card = { ...makeSearchableCard(), id: "c1" };
		const recentIds = new Set(["c1"]);
		expect(cardMatchesTokens(card, ["recent"], "", recentIds)).toBe(true);
		expect(cardMatchesTokens(card, ["recent"], "", new Set())).toBe(false);
		expect(cardMatchesTokens(card, ["-recent"], "", recentIds)).toBe(false);
	});

	it("handles the legality category via the legalities map, positively, negatively, and OR'd across formats", () => {
		const card = makeSearchableCard({ scryfallId: "abc123" });
		const legalMap: Map<string, Record<string, string>> = new Map([
			["abc123", { modern: "legal", standard: "not_legal" }],
		]);
		expect(cardMatchesTokens(card, ["legal:modern"], "", undefined, legalMap)).toBe(true);
		expect(cardMatchesTokens(card, ["legal:standard"], "", undefined, legalMap)).toBe(false);
		// OR between several formats, same convention as color/rarity/etc.
		expect(cardMatchesTokens(card, ["legal:standard", "legal:modern"], "", undefined, legalMap)).toBe(true);
		expect(cardMatchesTokens(card, ["-legal:modern"], "", undefined, legalMap)).toBe(false);
		expect(cardMatchesTokens(card, ["-legal:standard"], "", undefined, legalMap)).toBe(true);
	});

	it("handles 'banned:'/'restricted:' tokens the same way, each against its own status", () => {
		const card = makeSearchableCard({ scryfallId: "abc123" });
		const map: Map<string, Record<string, string>> = new Map([
			["abc123", { legacy: "banned", vintage: "restricted", modern: "legal" }],
		]);
		expect(cardMatchesTokens(card, ["banned:legacy"], "", undefined, map)).toBe(true);
		expect(cardMatchesTokens(card, ["banned:modern"], "", undefined, map)).toBe(false);
		expect(cardMatchesTokens(card, ["restricted:vintage"], "", undefined, map)).toBe(true);
		expect(cardMatchesTokens(card, ["-banned:legacy"], "", undefined, map)).toBe(false);
		expect(cardMatchesTokens(card, ["-restricted:vintage"], "", undefined, map)).toBe(false);
		// Same "legality" bucket as legal: (OR across all, whatever the status
		// searched by each token) — see CATEGORY_CLAUSE_BUILDERS.
		expect(cardMatchesTokens(card, ["legal:standard", "banned:legacy"], "", undefined, map)).toBe(
			true
		);
	});

	it("treats a card with no cached legalities yet as not (yet) matching, positive or negative", () => {
		const card = makeSearchableCard({ scryfallId: "not-fetched-yet" });
		const emptyMap: Map<string, Record<string, string>> = new Map();
		expect(cardMatchesTokens(card, ["legal:modern"], "", undefined, emptyMap)).toBe(false);
		// A negative token must NOT exclude a card whose legality isn't known yet
		// — see the comment of cardMatchesTokens.
		expect(cardMatchesTokens(card, ["-legal:modern"], "", undefined, emptyMap)).toBe(true);
	});

	it("handles the border category as an intrinsic card field, OR'd across values, AND'd with other categories", () => {
		const card = makeSearchableCard({ borderColor: "borderless", frameEffects: ["showcase"], rarity: "rare" });
		expect(cardMatchesTokens(card, ["border:showcase"], "")).toBe(true);
		expect(cardMatchesTokens(card, ["border:black"], "")).toBe(false);
		// OR between several values, same convention as legal:.
		expect(cardMatchesTokens(card, ["border:black", "border:showcase"], "")).toBe(true);
		// AND with another category.
		expect(cardMatchesTokens(card, ["border:showcase", "common"], "")).toBe(false);
		expect(cardMatchesTokens(card, ["-border:showcase"], "")).toBe(false);
		expect(cardMatchesTokens(card, ["-border:black"], "")).toBe(true);
	});

	it("handles the oracle category as an AND (every phrase must appear), unlike border's OR", () => {
		const card = makeSearchableCard({ oracleText: "Draw a card. Instant speed.", rarity: "rare" });
		expect(cardMatchesTokens(card, ['oracle:draw a card'], "")).toBe(true);
		expect(cardMatchesTokens(card, ['oracle:instant'], "")).toBe(true);
		// Two "oracle:" tokens = AND (both must appear), not OR like
		// border:/legal: — see the comment of oracleTokenMatches.
		expect(cardMatchesTokens(card, ['oracle:draw a card', 'oracle:instant'], "")).toBe(true);
		expect(cardMatchesTokens(card, ['oracle:draw a card', 'oracle:flying'], "")).toBe(false);
		// AND with another category.
		expect(cardMatchesTokens(card, ['oracle:draw a card', 'common'], "")).toBe(false);
		expect(cardMatchesTokens(card, ['-oracle:draw a card'], "")).toBe(false);
		expect(cardMatchesTokens(card, ['-oracle:flying'], "")).toBe(true);
	});

	it("a 'multicolor' chip includes a genuinely multicolor card via colorTokenMatches", () => {
		// Continuation of the same categorizeToken bug (now fixed): the token now
		// goes through the "color" bucket and therefore through colorTokenMatches,
		// which already knows how to recognize a multicolor card.
		const trulyMulticolor = makeSearchableCard({ colors: ["W", "U"], typeLine: "Legendary Creature" });
		expect(cardMatchesTokens(trulyMulticolor, ["multicolor"], "")).toBe(true);
	});

	it("an exact-color token ('=blue') only matches a card whose colors are EXACTLY that, unlike a plain 'blue' chip", () => {
		const monoBlue = makeSearchableCard({ colors: ["U"] });
		const azorius = makeSearchableCard({ colors: ["W", "U"] });
		// A plain "blue" token matches both (containment).
		expect(cardMatchesTokens(monoBlue, ["blue"], "")).toBe(true);
		expect(cardMatchesTokens(azorius, ["blue"], "")).toBe(true);
		// "=blue" only matches mono-blue.
		expect(cardMatchesTokens(monoBlue, ["=blue"], "")).toBe(true);
		expect(cardMatchesTokens(azorius, ["=blue"], "")).toBe(false);
	});

	it("combines several exact-color tokens with AND into an exact multicolor identity check", () => {
		const azorius = makeSearchableCard({ colors: ["W", "U"] });
		const monoBlue = makeSearchableCard({ colors: ["U"] });
		const jeskai = makeSearchableCard({ colors: ["W", "U", "R"] });
		expect(cardMatchesTokens(azorius, ["=blue", "=white"], "")).toBe(true);
		expect(cardMatchesTokens(monoBlue, ["=blue", "=white"], "")).toBe(false);
		// Neither more nor less: a 3rd color too many also excludes.
		expect(cardMatchesTokens(jeskai, ["=blue", "=white"], "")).toBe(false);
	});

	it("combines an exact-color constraint with an unrelated category via AND, same as any other facet", () => {
		const card = makeSearchableCard({ colors: ["U"], rarity: "common" });
		expect(cardMatchesTokens(card, ["=blue", "rare"], "")).toBe(false);
		expect(
			cardMatchesTokens(makeSearchableCard({ colors: ["U"], rarity: "rare" }), ["=blue", "rare"], "")
		).toBe(true);
	});

	it("still evaluates an exact-color constraint even when it's the only token present", () => {
		// Potential trap: positiveTokens can be empty once the "=" token is
		// extracted separately — the early "return true" for that case must not
		// short-circuit the exact-identity check.
		expect(cardMatchesTokens(makeSearchableCard({ colors: ["U", "W"] }), ["=blue"], "")).toBe(false);
	});

	it("falls back a non-color exact-marked token to an ordinary positive token", () => {
		expect(cardMatchesTokens(makeSearchableCard({ rarity: "rare" }), ["=rare"], "")).toBe(true);
		expect(cardMatchesTokens(makeSearchableCard({ rarity: "common" }), ["=rare"], "")).toBe(false);
	});
});

describe("recognizeKeywordToken", () => {
	it("recognizes artist/set/cardnum prefixed tokens", () => {
		expect(recognizeKeywordToken("artist:John Avon")).toEqual({ kind: "artist", label: "John Avon" });
		expect(recognizeKeywordToken("set:mid")).toEqual({ kind: "set", code: "mid", label: "MID" });
		expect(recognizeKeywordToken("#235")).toEqual({ kind: "cardnum", label: "# 235" });
	});

	it("recognizes a numeric token with its operator symbol", () => {
		expect(recognizeKeywordToken("cmc>3")).toEqual({ kind: "numeric", label: "Mana value > 3" });
		expect(recognizeKeywordToken("added=2026-01-01")).toEqual({
			kind: "numeric",
			label: "Date added = 2026-01-01",
		});
	});

	it("requires an exact match for color/rarity/language, not a prefix", () => {
		expect(recognizeKeywordToken("blue")).toEqual({ kind: "color", letter: "U" });
		expect(recognizeKeywordToken("bl")).toBeNull();
		expect(recognizeKeywordToken("rare")).toEqual({ kind: "rarity", label: "Rare" });
		expect(recognizeKeywordToken("french")).toEqual({ kind: "language", flag: "fr", label: "French" });
	});

	it("recognizes condition keywords and the special 'none' case", () => {
		expect(recognizeKeywordToken("nm")).toEqual({ kind: "condition", glyph: "NM", color: "#5fad60", label: "Near Mint" });
		expect(recognizeKeywordToken("none")).toEqual({
			kind: "condition",
			glyph: "–",
			color: "var(--text-faint)",
			label: "None",
		});
	});

	it("recognizes all foil-family literals", () => {
		expect(recognizeKeywordToken("foil")).toEqual({ kind: "foil", label: "Foil" });
		expect(recognizeKeywordToken("nonfoil")).toEqual({ kind: "foil", label: "Non-foil" });
		expect(recognizeKeywordToken("etched")).toEqual({ kind: "foil", label: "Etched" });
		expect(recognizeKeywordToken("surge")).toEqual({ kind: "foil", label: "Surge Foil" });
		expect(recognizeKeywordToken("proxy")).toEqual({ kind: "foil", label: "Proxy" });
	});

	it("recognizes 'recent' as a keyword-styled Recently added chip", () => {
		expect(recognizeKeywordToken("recent")).toEqual({ kind: "keyword", label: "Recently added" });
	});

	it("recognizes an exact 'legal:<key>' token as a keyword-styled chip", () => {
		expect(recognizeKeywordToken("legal:modern")).toEqual({ kind: "keyword", label: "Legal: Modern" });
		expect(recognizeKeywordToken("legal:tlr")).toEqual({ kind: "keyword", label: "Legal: Tiny Leaders" });
	});

	it("does not recognize a 'legal:' token that isn't an exact format key (only a prefix)", () => {
		// Still a valid filter (legalityTokenMatches matches by prefix), but no
		// "recognized" chip rendering — same trade-off as color/rarity/language
		// earlier in this describe.
		expect(recognizeKeywordToken("legal:mod")).toBeNull();
		expect(recognizeKeywordToken("legal:xyz")).toBeNull();
	});

	it("recognizes an exact 'banned:<key>'/'restricted:<key>' token too, labelled with its own status", () => {
		expect(recognizeKeywordToken("banned:legacy")).toEqual({
			kind: "keyword",
			label: "Banned: Legacy",
		});
		expect(recognizeKeywordToken("restricted:vintage")).toEqual({
			kind: "keyword",
			label: "Restricted: Vintage",
		});
		expect(recognizeKeywordToken("banned:mod")).toBeNull();
	});

	it("recognizes an exact 'border:<value>' token as a keyword-styled chip", () => {
		expect(recognizeKeywordToken("border:showcase")).toEqual({ kind: "keyword", label: "Border: Showcase" });
		expect(recognizeKeywordToken("border:extended")).toEqual({
			kind: "keyword",
			label: "Border: Extended art",
		});
	});

	it("does not recognize a 'border:' token that isn't an exact value (only a prefix)", () => {
		expect(recognizeKeywordToken("border:ext")).toBeNull();
		expect(recognizeKeywordToken("border:xyz")).toBeNull();
	});

	it("recognizes any non-empty 'oracle:<phrase>' as a keyword-styled chip, original case kept", () => {
		// Unlike border:/legal: above, there is no fixed value to match exactly —
		// any non-empty phrase counts.
		expect(recognizeKeywordToken("oracle:Draw a Card")).toEqual({
			kind: "keyword",
			label: 'Card text: "Draw a Card"',
		});
	});

	it("does not recognize a bare 'oracle:' with no value", () => {
		expect(recognizeKeywordToken("oracle:")).toBeNull();
	});

	it("recognizes exact type and keyword-ability matches", () => {
		expect(recognizeKeywordToken("creature")).toEqual({ kind: "type", label: "Creature" });
		expect(recognizeKeywordToken("flying")).toEqual({ kind: "keyword", label: "Flying" });
	});

	it("returns null for unrecognized text", () => {
		expect(recognizeKeywordToken("xyzfreetext")).toBeNull();
	});
});

describe("SUGGESTABLE_KEYWORDS consistency", () => {
	it("categorizeToken agrees with every suggestion's own declared category", () => {
		// This is exactly the test that would have caught the multicolor/colorless
		// bug directly: these two entries declare category "color" in
		// SUGGESTABLE_KEYWORDS, but categorizeToken(entry.value) was routing them
		// to "text" before the fix. Checked for the ~90 entries at once rather
		// than case by case.
		const mismatches = SUGGESTABLE_KEYWORDS.filter(
			(entry) => categorizeToken(entry.value) !== entry.category
		);
		expect(mismatches).toEqual([]);
	});
});

describe("tokensNeedLegalityData", () => {
	it("is true when a committed token is a legality filter", () => {
		expect(tokensNeedLegalityData(["legal:modern"], "")).toBe(true);
		expect(tokensNeedLegalityData(["-legal:modern"], "")).toBe(true);
	});

	it("is true for an in-progress draft too, so the prefetch can warm up before Enter", () => {
		expect(tokensNeedLegalityData([], "legal:mod")).toBe(true);
	});

	it("is false when no token/draft is a legality filter", () => {
		expect(tokensNeedLegalityData(["blue", "rare"], "")).toBe(false);
		expect(tokensNeedLegalityData([], "")).toBe(false);
		expect(tokensNeedLegalityData([], "modern")).toBe(false);
	});
});

describe("LEGALITY_SEARCH_FORMATS ordering", () => {
	// Reported bug: typing "legal:" alone (to browse the formats without yet
	// knowing which one to look for) never made "Legal: Commander" appear in
	// the suggestions — cut off by the suggestion cap (getKeywordSuggestions,
	// view.ts; renderChipSuggestions, add-cards-modal.ts) since the raw order
	// of the Scryfall API puts "commander" in 12th position. Fixed by moving
	// the 10 best-known formats to the front of this list, in that precise
	// order. Since LEGALITY_FORMATS (price.ts) became a simple alias of this
	// same list (2026-08-21, see its own comment), comparing the two no longer
	// locks anything down — the 10 expected keys are therefore hard-coded here
	// to keep guarding this order, regardless of whether LEGALITY_FORMATS
	// points to this list in the future.
	it("front-loads the 10 best-known formats, in a fixed order, before the rest", () => {
		const firstTen = LEGALITY_SEARCH_FORMATS.slice(0, 10).map((f) => f.key);
		expect(firstTen).toEqual([
			"standard",
			"pioneer",
			"modern",
			"legacy",
			"vintage",
			"commander",
			"pauper",
			"brawl",
			"gladiator",
			"timeless",
		]);
	});
});

describe("describeSearchFilters", () => {
	it("returns an empty string for no tokens", () => {
		expect(describeSearchFilters([])).toBe("");
	});

	it("matches the feature's own motivating example", () => {
		expect(describeSearchFilters(["green", "aragorn", "vigilance"])).toBe(
			'Show every green card containing "aragorn", with the "Vigilance" ability.'
		);
	});

	it("joins multiple values in the same category with 'or'", () => {
		expect(describeSearchFilters(["green", "blue"])).toBe("Show every green or blue card.");
		expect(describeSearchFilters(["green", "blue", "red"])).toBe(
			"Show every green, blue, or red card."
		);
	});

	it("combines different categories with separate clauses", () => {
		expect(describeSearchFilters(["blue", "instant"])).toBe(
			"Show every blue card of type Instant."
		);
	});

	it("describes exact color identity as a subject qualifier", () => {
		expect(describeSearchFilters(["=blue", "=white"])).toBe(
			"Show every card whose color identity is exactly blue and white."
		);
	});

	it("describes negation independently per token, not grouped", () => {
		expect(describeSearchFilters(["-blue", "-black"])).toBe(
			"Show every card not blue, not black."
		);
	});

	it("describes oracle text and free text differently", () => {
		// The stored token no longer has its quotes at this stage — commitToken
		// (add-cards-modal.ts) already removes them via
		// stripQuotesFromCommittedToken before the token reaches chipTokens; this
		// test reflects the form actually stored, not what was typed.
		expect(describeSearchFilters(["oracle:draw a card"])).toBe(
			'Show every card whose rules text mentions "draw a card".'
		);
	});

	it("describes numeric comparisons using the field's own label", () => {
		expect(describeSearchFilters(["cmc>3"])).toBe("Show every card mana value > 3.");
	});

	it("describes 'legal:'/'banned:'/'restricted:' with their own status word", () => {
		expect(describeSearchFilters(["legal:modern"])).toBe("Show every card legal in Modern.");
		expect(describeSearchFilters(["banned:legacy"])).toBe("Show every card banned in Legacy.");
		expect(describeSearchFilters(["restricted:vintage"])).toBe(
			"Show every card restricted in Vintage."
		);
		expect(describeSearchFilters(["-banned:legacy"])).toBe(
			"Show every card not banned in Legacy."
		);
	});

	it("groups mixed legality statuses separately, so a mix isn't mislabelled 'legal in'", () => {
		// Two "legal:" tokens always group with "or" within the same status; a
		// "banned:" token next to them forms its own group rather than being
		// wrongly described as "legal in".
		expect(describeSearchFilters(["legal:modern", "legal:legacy"])).toBe(
			"Show every card legal in Modern or Legacy."
		);
		expect(describeSearchFilters(["legal:modern", "banned:legacy"])).toBe(
			"Show every card legal in Modern or banned in Legacy."
		);
	});

	it("describes set/artist/collector-number tokens", () => {
		expect(describeSearchFilters(["set:znr"])).toBe("Show every card from ZNR.");
		expect(describeSearchFilters(["artist:Rebecca Guay"])).toBe("Show every card by Rebecca Guay.");
		expect(describeSearchFilters(["#123"])).toBe("Show every card numbered #123.");
	});

	it("resolves a set code to its full name via the optional resolver, when given", () => {
		const resolve = (code: string) => (code === "inr" ? "Innistrad Remastered" : undefined);
		expect(describeSearchFilters(["set:inr"], resolve)).toBe(
			"Show every card from Innistrad Remastered."
		);
	});

	it("falls back to the uppercased code when the resolver doesn't know it (cache not warm yet)", () => {
		const resolve = () => undefined;
		expect(describeSearchFilters(["set:inr"], resolve)).toBe("Show every card from INR.");
	});

	it("resolves multiple set codes independently and joins them with 'or'", () => {
		const names: Record<string, string> = { znr: "Zendikar Rising", khm: "Kaldheim" };
		const resolve = (code: string) => names[code];
		expect(describeSearchFilters(["set:znr", "set:khm"], resolve)).toBe(
			"Show every card from Zendikar Rising or Kaldheim."
		);
	});

	it("resolves the set name for a negated set: chip too", () => {
		const resolve = (code: string) => (code === "inr" ? "Innistrad Remastered" : undefined);
		expect(describeSearchFilters(["-set:inr"], resolve)).toBe(
			"Show every card not from Innistrad Remastered."
		);
	});

	it("falls back to the raw token text for anything unrecognized", () => {
		// A word matching no known category is categorized "text" (free search of
		// name/type/set/artist) — same fallback as renderSearchChipBar for
		// displaying the chips themselves.
		expect(describeSearchFilters(["shivan dragon"])).toBe(
			'Show every card containing "shivan dragon".'
		);
	});
});
