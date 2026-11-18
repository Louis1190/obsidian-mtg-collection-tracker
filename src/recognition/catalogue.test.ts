import { describe, expect, it } from "vitest";
import { buildSetScopeIndex, catalogueIndex, matchedLanguage, namesOfRow, parseCatalogue, rowIndexByName, shortNameIndex, SHORT_NAME_MAX_LENGTH, SHORT_NAME_MIN_LENGTH, type CatalogueRow } from "./catalogue";
import { matchLine } from "./name-match";

const TSV = [
	"Soul Burn\tBrûlure des âmes\tSeelenbrand\tQuemadura del alma\tBruciatura dell'anima\tQueima de Alma\t魂の燃焼\t\t\t\t",
	"Fire // Ice\tFeu // Glace\tFeuer // Eis\t\t\t\t\t\t\t\t",
	"Goblin Spy\tEspion gobelin\t\t\t\t\t\t\t\t\t",
	"",
	"\tNo English name\t\t\t\t\t\t\t\t\t",
].join("\n");

describe("parseCatalogue", () => {
	const rows = parseCatalogue(TSV);
	it("reads one row per card, with the localized names that exist", () => {
		expect(rows).toHaveLength(3);
		expect(rows[0].english).toBe("Soul Burn");
		expect(rows[0].names.fr).toBe("Brûlure des âmes");
		expect(rows[0].names.de).toBe("Seelenbrand");
		expect(rows[0].names.ja).toBe("魂の燃焼");
		expect(rows[0].names.ko).toBeUndefined();
		expect(rows[2].names).toEqual({ fr: "Espion gobelin" });
	});
	it("skips blank lines and rows without an English name, and copes with Windows line ends", () => {
		expect(parseCatalogue("A\tb\r\nC\td\r\n").map((r) => r.english)).toEqual(["A", "C"]);
		expect(parseCatalogue("")).toEqual([]);
	});
});

describe("catalogueIndex", () => {
	const rows = parseCatalogue(TSV);
	it("finds a card by its English name and by the localized names of the languages asked for only", () => {
		const idx = catalogueIndex(rows, ["fr"]);
		expect(matchLine("Bralure des Ames", idx, 3, 0.75)[0].owner).toBe(0);
		expect(matchLine("Soul Burn", idx, 3, 0.75)[0].owner).toBe(0);
		expect(matchLine("Seelenbrand", idx, 3, 0.75)).toEqual([]); // German was not asked for
		expect(matchLine("Seelenbrand", catalogueIndex(rows, ["fr", "de"]), 3, 0.75)[0].owner).toBe(0);
	});
	it("makes a double-faced or split card findable by one face", () => {
		const idx = catalogueIndex(rows, ["fr"]);
		expect(matchLine("Feu // Glace", idx, 3, 0.75)[0].owner).toBe(1);
		expect(matchLine("Glace", idx, 3, 0.75)[0].owner).toBe(1); // a photo shows one face (the READER then refuses a key this short: reading.ts)
	});
	it("an empty list of languages is the English names only", () => {
		expect(matchLine("Espion gobelin", catalogueIndex(rows, []), 3, 0.75)).toEqual([]);
		expect(matchLine("Goblin Spy", catalogueIndex(rows, []), 3, 0.75)[0].owner).toBe(2);
	});
});

describe("matchedLanguage", () => {
	const rows = parseCatalogue(TSV);
	it("says which language's name matched, English when it is the English one", () => {
		expect(matchedLanguage(rows[0], "brulure des ames")).toBe("fr");
		expect(matchedLanguage(rows[0], "soul burn")).toBe("en");
		expect(matchedLanguage(rows[0], "seelenbrand")).toBe("de");
		expect(matchedLanguage(rows[2], "espion gobelin")).toBe("fr");
	});
	it("knows a face of a double-faced card by the language of the combined name that holds it", () => {
		expect(matchedLanguage(rows[1], "glace")).toBe("fr");
		expect(matchedLanguage(rows[1], "eis")).toBe("de");
		expect(matchedLanguage(rows[1], "fire")).toBe("en");
	});
	it("calls it English when a localized name is the very same text (a proper name that is not translated)", () => {
		const row = { english: "Sol Ring", names: { fr: "Sol Ring", de: "Sol Ring" } };
		expect(matchedLanguage(row, "sol ring")).toBe("en");
	});
	it("falls back to English for a key it does not know", () => {
		expect(matchedLanguage(rows[0], "something else")).toBe("en");
	});
});

describe("rowIndexByName", () => {
	const rows = parseCatalogue(TSV);
	it("finds a row by the lower-cased English name, and by each face of a double name", () => {
		const byName = rowIndexByName(rows);
		expect(byName.get("soul burn")).toBe(0);
		expect(byName.get("fire // ice")).toBe(1);
		expect(byName.get("fire")).toBe(1);
		expect(byName.get("ice")).toBe(1);
		expect(byName.get("goblin spy")).toBe(2);
		expect(byName.get("nothing")).toBeUndefined();
	});
	it("gives a name two rows share to the first", () => {
		const twice = parseCatalogue(["Mountain // Mountain\tMontagne", "Mountain\t"].join("\n"));
		expect(rowIndexByName(twice).get("mountain")).toBe(0);
	});
});

describe("namesOfRow", () => {
	const rows = parseCatalogue(TSV);
	it("is the English name then the localized names of the languages asked for, once each", () => {
		expect(namesOfRow(rows[0], ["fr", "de"])).toEqual(["Soul Burn", "Brûlure des âmes", "Seelenbrand"]);
		expect(namesOfRow(rows[0], [])).toEqual(["Soul Burn"]);
		expect(namesOfRow(rows[2], ["fr", "de"])).toEqual(["Goblin Spy", "Espion gobelin"]);
		expect(namesOfRow({ english: "Sol Ring", names: { fr: "Sol Ring" } }, ["fr"])).toEqual(["Sol Ring"]);
	});
});

describe("buildSetScopeIndex", () => {
	const rows = parseCatalogue(TSV);
	const byName = rowIndexByName(rows);

	it("owns a card the catalogue knows by its row, with its localized names, so the title can be read in French", () => {
		const extra: CatalogueRow[] = [];
		const index = buildSetScopeIndex(["Soul Burn", "Goblin Spy"], rows, byName, ["fr"], extra);
		expect(extra).toEqual([]);
		expect(matchLine("Brulure des ames", index, 3, 0.85)).toMatchObject([{ owner: 0, key: "brulure des ames", score: 1, partial: false }]);
		expect(matchLine("Goblin Spy", index, 3, 0.85)[0].owner).toBe(2);
	});

	it("gives a card the catalogue does not know a row of its own after the catalogue's, and keeps numbering across calls", () => {
		const extra: CatalogueRow[] = [];
		const first = buildSetScopeIndex(["Shock", "Soul Burn"], rows, byName, ["fr"], extra);
		expect(extra).toEqual([{ english: "Shock", names: {} }]);
		expect(matchLine("Shock", first, 3, 0.85)[0].owner).toBe(rows.length);
		const second = buildSetScopeIndex(["Thwip"], rows, byName, ["fr"], extra);
		expect(extra.map((r) => r.english)).toEqual(["Shock", "Thwip"]);
		expect(matchLine("Thwip", second, 3, 0.85)[0].owner).toBe(rows.length + 1);
	});

	it("lists a name once however it is written, and finds either face of a double-faced card", () => {
		const extra: CatalogueRow[] = [];
		const index = buildSetScopeIndex(["Fire // Ice", "fire // ice", "FIRE // ICE"], rows, byName, ["fr"], extra);
		expect(extra).toEqual([]);
		expect(matchLine("Glace", index, 3, 0.85)[0].owner).toBe(1);
		expect(matchLine("Fire", index, 3, 0.85)[0].owner).toBe(1);
		expect(index.keys.filter((k) => k === "fire ice")).toHaveLength(1);
	});

	it("gives one row to a card the catalogue does not know however many times its name is listed", () => {
		const extra: CatalogueRow[] = [];
		buildSetScopeIndex(["Thwip", "thwip", "THWIP"], rows, byName, ["fr"], extra);
		expect(extra.map((r) => r.english)).toEqual(["Thwip"]);
	});

	it("is empty for a set with no name", () => {
		const index = buildSetScopeIndex([], rows, byName, ["fr"], []);
		expect(index.keys).toEqual([]);
		expect(matchLine("Goblin Spy", index, 3, 0.75)).toEqual([]);
	});
});

describe("shortNameIndex", () => {
	const rows = parseCatalogue(["Swamp\tMarais", "Fog\t", "Opt\t", "Serra Angel\tAnge de Serra", "Island\tÎle", "Fire // Ice\tFeu // Glace", "Ox\t", "Counterspell\tContresort", "Shock\tChoc"].join("\n"));
	const owners = (line: string, langs: ("fr" | "de")[] = ["fr"]) => matchLine(line, shortNameIndex(rows, langs), 5, 0.85).map((m) => m.owner);

	it("holds the names of 3 to 5 letters, English and the languages asked for, and nothing else", () => {
		expect(SHORT_NAME_MIN_LENGTH).toBe(3);
		expect(SHORT_NAME_MAX_LENGTH).toBe(5);
		expect(owners("Swamp")).toEqual([0]);
		expect(owners("Fog")).toEqual([1]);
		expect(owners("Opt")).toEqual([2]);
		expect(owners("Shock")).toEqual([8]);
		expect(owners("Choc")).toEqual([8]); // the French name of 4 letters
		expect(owners("Ile")).toEqual([4]); // "Île", 3 letters once the accent is gone: the French name of Island, which is itself too long (6)
	});

	it("leaves out the names that are too short, too long, or an A // B name", () => {
		expect(owners("Ox")).toEqual([]);
		expect(owners("Serra Angel")).toEqual([]);
		expect(owners("Island")).toEqual([]);
		expect(owners("Counterspell")).toEqual([]);
		expect(owners("Fire")).toEqual([]);
		expect(owners("Ice")).toEqual([]);
	});

	it("leaves out the localized names of a language that was not asked for", () => {
		expect(owners("Choc", [])).toEqual([]);
		expect(owners("Marais")).toEqual([]);
	});

	it("takes nothing but a whole line: a short name inside a longer text matches nothing", () => {
		expect(owners("Swamp U")).toEqual([]);
		expect(owners("Fog Bank")).toEqual([]);
		expect(owners("Opt out")).toEqual([]);
	});
});
