import { describe, it, expect } from "vitest";
import {
	displayImage,
	displayName,
	foldAccents,
	parsePrintedNameKey,
	printedImageFromBody,
	printedNameFromBody,
	printedNameKey,
	printedNameKeyOfHit,
	printedNameUrl,
} from "./printed-name";

const copy = { name: "Rocky Rebuke", setCode: "TLA", collectorNumber: "193", language: "fr" };

describe("printedNameKey", () => {
	it("is set, collector number and language of a copy in a foreign language, with the set in lower case", () => {
		expect(printedNameKey(copy)).toBe("tla:193:fr");
		expect(printedNameKey({ ...copy, language: "zhs" })).toBe("tla:193:zhs");
	});

	it("is null when the copy has no printed name of its own to look up", () => {
		expect(printedNameKey({ ...copy, language: "" })).toBeNull();
		expect(printedNameKey({ ...copy, language: undefined })).toBeNull();
		expect(printedNameKey({ ...copy, language: "en" })).toBeNull();
		// a language the plugin has no entry for
		expect(printedNameKey({ ...copy, language: "ph" })).toBeNull();
		expect(printedNameKey({ ...copy, setCode: "" })).toBeNull();
		expect(printedNameKey({ ...copy, collectorNumber: undefined })).toBeNull();
	});
});

describe("printedNameKeyOfHit", () => {
	it("gives the same key as the stored copy of that hit, so a copy added by its French name needs no request", () => {
		const hit = { set: "tla", collector_number: "193", lang: "fr" };
		expect(printedNameKeyOfHit(hit)).toBe(printedNameKey(copy));
		expect(printedNameKeyOfHit({ ...hit, lang: "en" })).toBeNull();
		expect(printedNameKeyOfHit({ set: "tla", collector_number: "193" })).toBeNull();
	});
});

describe("parsePrintedNameKey", () => {
	it("splits a key back into its parts", () => {
		expect(parsePrintedNameKey("tla:193:fr")).toEqual({ set: "tla", collectorNumber: "193", lang: "fr" });
	});

	it("keeps whatever sits between the first and the last colon as the collector number", () => {
		expect(parsePrintedNameKey("sld:12★:ja")).toEqual({ set: "sld", collectorNumber: "12★", lang: "ja" });
		expect(parsePrintedNameKey("x:a:b:zht")).toEqual({ set: "x", collectorNumber: "a:b", lang: "zht" });
	});

	it("refuses a malformed key", () => {
		expect(parsePrintedNameKey("")).toBeNull();
		expect(parsePrintedNameKey("tla")).toBeNull();
		expect(parsePrintedNameKey("tla:193")).toBeNull();
		expect(parsePrintedNameKey(":193:fr")).toBeNull();
	});
});

describe("printedNameUrl", () => {
	it("is Scryfall's card by set, number and language, with each part escaped", () => {
		expect(printedNameUrl({ set: "tla", collectorNumber: "193", lang: "fr" })).toBe("https://api.scryfall.com/cards/tla/193/fr");
		expect(printedNameUrl({ set: "sld", collectorNumber: "12★", lang: "ja" })).toBe(
			`https://api.scryfall.com/cards/sld/${encodeURIComponent("12★")}/ja`
		);
	});
});

describe("printedNameFromBody", () => {
	it("reads printed_name, trimmed, and gives an empty name for anything else", () => {
		expect(printedNameFromBody({ printed_name: "  Blâme de pierre " })).toBe("Blâme de pierre");
		expect(printedNameFromBody({ printed_name: "" })).toBe("");
		expect(printedNameFromBody({ printed_name: 3 })).toBe("");
		expect(printedNameFromBody({})).toBe("");
		expect(printedNameFromBody(null)).toBe("");
		expect(printedNameFromBody(undefined)).toBe("");
	});
});

describe("displayName", () => {
	it("shows the printed name only in printed mode and only when it is known", () => {
		expect(displayName(copy, "printed", "Blâme de pierre")).toBe("Blâme de pierre");
		expect(displayName(copy, "english", "Blâme de pierre")).toBe("Rocky Rebuke");
		expect(displayName(copy, "printed", undefined)).toBe("Rocky Rebuke");
		expect(displayName(copy, "printed", "")).toBe("Rocky Rebuke");
	});
});

describe("printedImageFromBody", () => {
	const normal = "https://cards.scryfall.io/normal/front/1/4/fr.jpg";

	it("gives the normal picture of a print that has a real scan, whatever its resolution", () => {
		expect(printedImageFromBody({ image_status: "highres_scan", image_uris: { normal } })).toBe(normal);
		expect(printedImageFromBody({ image_status: "lowres", image_uris: { normal } })).toBe(normal);
	});

	it("gives nothing for a stand-in or a missing picture, which must never replace the English one", () => {
		expect(printedImageFromBody({ image_status: "placeholder", image_uris: { normal } })).toBe("");
		expect(printedImageFromBody({ image_status: "missing", image_uris: { normal } })).toBe("");
		expect(printedImageFromBody({ image_status: "something-new", image_uris: { normal } })).toBe("");
		expect(printedImageFromBody({ image_uris: { normal } })).toBe("");
	});

	it("reads the front face of a double-faced card, as the English print is read", () => {
		expect(
			printedImageFromBody({ image_status: "lowres", card_faces: [{ image_uris: { normal } }, { image_uris: { normal: "back.jpg" } }] })
		).toBe(normal);
	});

	it("gives nothing for an address that is not https", () => {
		for (const bad of ["http://cards.scryfall.io/n.jpg", "data:image/svg+xml,x", "javascript:alert(1)", "//cards.scryfall.io/n.jpg", "ftp://x/n.jpg"]) {
			expect(printedImageFromBody({ image_status: "lowres", image_uris: { normal: bad } })).toBe("");
		}
	});

	it("gives nothing when there is no address, or the body is not a card", () => {
		expect(printedImageFromBody({ image_status: "lowres" })).toBe("");
		expect(printedImageFromBody({ image_status: "lowres", image_uris: { normal: 3 } })).toBe("");
		expect(printedImageFromBody(null)).toBe("");
		expect(printedImageFromBody(undefined)).toBe("");
	});
});

describe("displayImage", () => {
	it("shows the printed picture only in printed mode and only when it is known", () => {
		expect(displayImage("en.jpg", "printed", "fr.jpg")).toBe("fr.jpg");
		expect(displayImage("en.jpg", "english", "fr.jpg")).toBe("en.jpg");
		expect(displayImage("en.jpg", "printed", undefined)).toBe("en.jpg");
		expect(displayImage("en.jpg", "printed", "")).toBe("en.jpg");
	});
});

describe("foldAccents", () => {
	it("removes accents and lower-cases, so a name typed without them matches", () => {
		expect(foldAccents("Production de l'île de Braise")).toBe("production de l'ile de braise");
		expect(foldAccents("BLÂME")).toBe("blame");
		expect(foldAccents("Ñandú")).toBe("nandu");
	});

	it("leaves unaccented text and other scripts as they are (lower-cased)", () => {
		expect(foldAccents("Rocky Rebuke")).toBe("rocky rebuke");
		expect(foldAccents("闪电击")).toBe("闪电击");
		expect(foldAccents("Молния")).toBe("молния");
	});
});
