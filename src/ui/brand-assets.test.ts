import { describe, it, expect } from "vitest";
import { LANGUAGES } from "../core/card-model";
import { getFlagSvgDataUri, FLAG_SVGS } from "./brand-assets";

describe("getFlagSvgDataUri", () => {
	it("builds a data: URI embedding the matching flag's own SVG", () => {
		const uri = getFlagSvgDataUri("fr");
		expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
		expect(decodeURIComponent(uri.slice("data:image/svg+xml,".length))).toBe(
			FLAG_SVGS.fr
		);
	});

	it("falls back to the US flag for an unknown country code", () => {
		expect(getFlagSvgDataUri("zz")).toBe(getFlagSvgDataUri("us"));
	});

	it("has an entry for every country code used by LANGUAGES", () => {
		for (const lang of LANGUAGES) {
			expect(FLAG_SVGS[lang.flag]).toBeTruthy();
		}
	});
});
