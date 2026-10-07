import { describe, it, expect } from "vitest";
import {
	getFinishLabel,
	finishHasFoilLook,
	parseFinishValue,
	getLanguage,
	LANGUAGES,
	getCondition,
	CONDITIONS,
	isAlphaSet,
} from "./card-model";

describe("getFinishLabel", () => {
	it("returns the matching label for each known finish", () => {
		expect(getFinishLabel("regular")).toBe("Regular");
		expect(getFinishLabel("foiled")).toBe("Foiled");
		expect(getFinishLabel("etched")).toBe("Etched");
		expect(getFinishLabel("surged")).toBe("Surge Foil");
		expect(getFinishLabel("proxy")).toBe("Proxy");
	});
});

describe("finishHasFoilLook", () => {
	it("is true for foiled, etched, and surged", () => {
		expect(finishHasFoilLook("foiled")).toBe(true);
		expect(finishHasFoilLook("etched")).toBe(true);
		expect(finishHasFoilLook("surged")).toBe(true);
	});

	it("is false for regular and proxy", () => {
		expect(finishHasFoilLook("regular")).toBe(false);
		expect(finishHasFoilLook("proxy")).toBe(false);
	});
});

describe("parseFinishValue", () => {
	it("recognizes the current Finish column values", () => {
		expect(parseFinishValue("Etched")).toBe("etched");
		expect(parseFinishValue("etched")).toBe("etched");
		expect(parseFinishValue("Surge Foil")).toBe("surged");
		expect(parseFinishValue("surged")).toBe("surged");
		expect(parseFinishValue("surge")).toBe("surged");
		expect(parseFinishValue("Proxy")).toBe("proxy");
		expect(parseFinishValue("Foiled")).toBe("foiled");
	});

	it("falls back to the legacy Foil boolean column values", () => {
		expect(parseFinishValue("foil")).toBe("foiled");
		expect(parseFinishValue("true")).toBe("foiled");
		expect(parseFinishValue("yes")).toBe("foiled");
		expect(parseFinishValue("1")).toBe("foiled");
	});

	it("defaults to regular for empty or unrecognized values", () => {
		expect(parseFinishValue(undefined)).toBe("regular");
		expect(parseFinishValue("")).toBe("regular");
		expect(parseFinishValue("false")).toBe("regular");
		expect(parseFinishValue("0")).toBe("regular");
		expect(parseFinishValue("garbage")).toBe("regular");
	});

	it("never produces etched/surged/proxy from a legacy boolean value", () => {
		// Régression : migrateFoilToFinish (main.ts) ne doit jamais inventer une
		// finition qui n'existait pas avant l'introduction de Finish.
		for (const legacy of ["true", "false", "1", "0", "yes", "", undefined]) {
			const result = parseFinishValue(legacy);
			expect(["regular", "foiled"]).toContain(result);
		}
	});
});

describe("getLanguage", () => {
	it("returns the matching language for a known code", () => {
		expect(getLanguage("fr").label).toBe("French");
		expect(getLanguage("ja").label).toBe("Japanese");
	});

	it("returns a virtual \"None\" entry for an unknown or empty code, without it being a member of LANGUAGES", () => {
		// "None" a été essayé comme véritable entrée LANGUAGES[0] avant d'être
		// retiré sur demande explicite (types.ts) — ce test protège contre une
		// régression qui la réintroduirait dans le tableau lui-même, ce qui la
		// ferait réapparaître comme choix dans tous les pickers de langue.
		expect(LANGUAGES.some((l) => !l.code)).toBe(false);
		expect(getLanguage("").label).toBe("None");
		expect(getLanguage("xx").label).toBe("None");
	});
});

describe("getCondition", () => {
	it("returns the matching condition for a known value", () => {
		expect(getCondition("NM").label).toBe("Near Mint");
		expect(getCondition("PO").label).toBe("Poor");
	});

	it("returns a virtual \"None\" entry for an empty or unknown value, without it being a member of CONDITIONS", () => {
		// Même garde-fou que pour LANGUAGES ci-dessus — "None" ne doit pas
		// réapparaître comme choix dans le picker de condition.
		expect(CONDITIONS.some((c) => !c.value)).toBe(false);
		expect(getCondition("").label).toBe("None");
		expect(getCondition("xx").label).toBe("None");
	});
});

describe("isAlphaSet", () => {
	it("is true only for Limited Edition Alpha, case-insensitively", () => {
		expect(isAlphaSet("lea")).toBe(true);
		expect(isAlphaSet("LEA")).toBe(true);
	});

	it("is false for any other set code", () => {
		expect(isAlphaSet("leb")).toBe(false);
		expect(isAlphaSet("")).toBe(false);
	});
});
