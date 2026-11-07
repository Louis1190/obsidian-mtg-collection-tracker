import { describe, it, expect } from "vitest";
import {
	hasLangClause,
	hasNameTerm,
	hasNonAsciiNameLetter,
	inAnyLanguage,
	isForeignPrint,
	languageCodeOfPrint,
	languageTooltip,
	printKey,
	shouldSearchAnyLanguageFirst,
	shouldTryAnyLanguage,
	withPrintLanguage,
	PrintFields,
} from "./foreign-print";

function print(overrides: Partial<PrintFields & { name: string }> = {}): PrintFields & { name: string } {
	return { id: "id1", name: "Rocky Rebuke", set: "tla", collector_number: "193", ...overrides };
}

describe("isForeignPrint", () => {
	it("is false for English and for a card with no lang at all", () => {
		expect(isForeignPrint({ lang: "en" })).toBe(false);
		expect(isForeignPrint({})).toBe(false);
		expect(isForeignPrint({ lang: "" })).toBe(false);
	});

	it("is true for any other language, known to the plugin or not", () => {
		expect(isForeignPrint({ lang: "fr" })).toBe(true);
		expect(isForeignPrint({ lang: "zhs" })).toBe(true);
		expect(isForeignPrint({ lang: "ph" })).toBe(true);
	});
});

describe("languageCodeOfPrint", () => {
	it("gives the plugin's own code for a language it knows", () => {
		for (const code of ["es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht"]) {
			expect(languageCodeOfPrint({ lang: code })).toBe(code);
		}
	});

	it("keeps the tag empty for English, for no language, and for a language the plugin has no flag for", () => {
		expect(languageCodeOfPrint({ lang: "en" })).toBe("");
		expect(languageCodeOfPrint({})).toBe("");
		for (const code of ["he", "la", "grc", "ar", "sa", "ph"]) {
			expect(languageCodeOfPrint({ lang: code })).toBe("");
		}
	});
});

describe("printKey", () => {
	it("is the same for the same printing whatever the case of the set code", () => {
		expect(printKey({ set: "TLA", collector_number: "193" })).toBe(printKey({ set: "tla", collector_number: "193" }));
		expect(printKey({ set: "tla", collector_number: "193" })).not.toBe(printKey({ set: "tla", collector_number: "194" }));
	});
});

describe("withPrintLanguage", () => {
	const french = print({ id: "fr-id", lang: "fr", printed_name: "Blâme de pierre" });
	const english = print({ id: "en-id", lang: "en" });

	it("folds a foreign hit onto the English card, keeping the hit's language and printed name", () => {
		const merged = withPrintLanguage(french, english);
		expect(merged.id).toBe("en-id");
		expect(merged.name).toBe("Rocky Rebuke");
		expect(merged.lang).toBe("fr");
		expect(merged.printed_name).toBe("Blâme de pierre");
	});

	it("does not change the English card it was given", () => {
		withPrintLanguage(french, english);
		expect(english.lang).toBe("en");
		expect(english.printed_name).toBeUndefined();
	});

	it("keeps the hit when there is no counterpart (not looked up, or confirmed missing)", () => {
		expect(withPrintLanguage(french, undefined)).toBe(french);
		expect(withPrintLanguage(french, null)).toBe(french);
	});

	it("keeps the hit when the counterpart is itself not English (a printing that exists in one foreign language only)", () => {
		const japaneseOnly = print({ id: "ja-id", lang: "ja" });
		expect(withPrintLanguage(french, japaneseOnly)).toBe(french);
	});

	it("keeps the hit when the counterpart is the hit itself", () => {
		expect(withPrintLanguage(french, french)).toBe(french);
	});

	it("treats a counterpart with no lang as English", () => {
		const bare = print({ id: "bare-id" });
		expect(withPrintLanguage(french, bare).id).toBe("bare-id");
	});
});

describe("hasLangClause", () => {
	it("finds a language clause written by the user or by a chip", () => {
		expect(hasLangClause("lang:fr")).toBe(true);
		expect(hasLangClause("foudre lang:any")).toBe(true);
		expect(hasLangClause("c:r -lang:ja")).toBe(true);
		expect(hasLangClause("(lang:fr or lang:de) bolt")).toBe(true);
		expect(hasLangClause("language:ja bolt")).toBe(true);
	});

	it("does not mistake a word that merely contains it", () => {
		expect(hasLangClause("Blâme de pierre")).toBe(false);
		expect(hasLangClause("o:\"slang:x\"")).toBe(false);
		expect(hasLangClause("")).toBe(false);
	});
});

describe("hasNameTerm", () => {
	it("is true when the query holds a piece of a card name, in any script", () => {
		expect(hasNameTerm("Blâme de pierre")).toBe(true);
		expect(hasNameTerm("闪电击")).toBe(true);
		expect(hasNameTerm("Молния")).toBe(true);
		expect(hasNameTerm("c:r Foudre")).toBe(true);
		expect(hasNameTerm('!"Rocky Rebuke"')).toBe(true);
		expect(hasNameTerm("-forêt t:land")).toBe(true);
	});

	it("is false for a query made of clauses only", () => {
		expect(hasNameTerm("c:r t:elf")).toBe(false);
		expect(hasNameTerm("c=wu cmc>=3 -is:foil")).toBe(false);
		expect(hasNameTerm("s:tla cn:193")).toBe(false);
		expect(hasNameTerm('o:"draw a card" r:rare')).toBe(false);
		expect(hasNameTerm("(s:tla or s:inv) r:rare")).toBe(false);
		expect(hasNameTerm("")).toBe(false);
	});

	it("does not split a quoted phrase on its spaces", () => {
		expect(hasNameTerm('o:"draw a card"')).toBe(false);
		expect(hasNameTerm('keyword:"first strike" t:creature')).toBe(false);
	});
});

describe("shouldTryAnyLanguage / inAnyLanguage", () => {
	it("asks again in every language for a name search that found nothing", () => {
		expect(shouldTryAnyLanguage("Blâme de pierre")).toBe(true);
		expect(inAnyLanguage("Blâme de pierre")).toBe("Blâme de pierre lang:any");
	});

	it("does not, when the user already chose a language or typed no name", () => {
		expect(shouldTryAnyLanguage("Blâme lang:fr")).toBe(false);
		expect(shouldTryAnyLanguage("c:r t:elf")).toBe(false);
	});
});

describe("languageTooltip", () => {
	it("says prices are the English printing's for a copy in another language, and only then", () => {
		expect(languageTooltip("fr")).toBe("French. Prices are those of the English printing.");
		expect(languageTooltip("zhs")).toBe("Chinese (Simplified). Prices are those of the English printing.");
		expect(languageTooltip("en")).toBe("English");
		expect(languageTooltip("")).toBe("None");
	});
});

describe("hasNonAsciiNameLetter / shouldSearchAnyLanguageFirst", () => {
	it("is true when a piece of the name has an accent or a non-Latin letter", () => {
		for (const query of ["Blâme de pierre", "Forêt", "Fuego", "闪电击", "稲妻", "Молния", "c:r Éclair", '!"Dûl"', "-forêt"]) {
			expect(hasNonAsciiNameLetter(query)).toBe(query !== "Fuego");
		}
	});

	it("is false for plain ASCII names, for clauses, and for symbols that are not letters", () => {
		expect(hasNonAsciiNameLetter("Blame de pierre")).toBe(false);
		expect(hasNonAsciiNameLetter("Rocky Rebuke")).toBe(false);
		expect(hasNonAsciiNameLetter("c:r t:elf")).toBe(false);
		// a clause with an accent in its value is not a name
		expect(hasNonAsciiNameLetter('o:"à"')).toBe(false);
		// a typographic apostrophe or a dash is not a letter
		expect(hasNonAsciiNameLetter("Urza\u2019s Saga")).toBe(false);
		expect(hasNonAsciiNameLetter("Fire \u2014 Ice")).toBe(false);
		expect(hasNonAsciiNameLetter("")).toBe(false);
	});

	it("goes to every language first only for such a name, and never when the user chose a language", () => {
		expect(shouldSearchAnyLanguageFirst("Blâme de pierre")).toBe(true);
		expect(shouldSearchAnyLanguageFirst("Blame de pierre")).toBe(false);
		expect(shouldSearchAnyLanguageFirst("Blâme lang:fr")).toBe(false);
		expect(shouldSearchAnyLanguageFirst("c:r t:elf")).toBe(false);
	});
});
