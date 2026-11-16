import { describe, expect, it } from "vitest";
import { cacheConflictCopies, syncConflictOrigin } from "./conflict-copies";

const CACHES: ReadonlySet<string> = new Set(["legalities-cache.json", "scryfall-immutable-cache.json", "icon-cache.json"]);

// The 17 conflict copies that had piled up in a real vault by 2026-11-15, with the other files of the folder.
const REAL_FOLDER = [
	"data.json",
	"main.js",
	"manifest.json",
	"styles.css",
	"legalities-cache.json",
	"scryfall-immutable-cache.json",
	"icon-cache.json",
	"fp-s0.bin.gz",
	"data.sync-conflict-20261007-223032-7UNLEII.json",
	"legalities-cache.sync-conflict-20261027-114444-NLG4MGJ.json",
	"legalities-cache.sync-conflict-20261027-123042-NLG4MGJ.json",
	"legalities-cache.sync-conflict-20261027-184043-NLG4MGJ.json",
	"legalities-cache.sync-conflict-20261107-193606-NLG4MGJ.json",
	"legalities-cache.sync-conflict-20261109-145357-LGEWUHX.json",
	"legalities-cache.sync-conflict-20261114-120832-2EXFLOI.json",
	"printed-images-cache.sync-conflict-20261111-190000-LGEWUHX.json",
	"scryfall-immutable-cache.sync-conflict-20261017-101010-LGEWUHX.json",
	"scryfall-immutable-cache.sync-conflict-20261020-101010-NLG4MGJ.json",
];

describe("syncConflictOrigin", () => {
	it("gives the file a Syncthing conflict copy is a copy of", () => {
		expect(syncConflictOrigin("legalities-cache.sync-conflict-20261114-120832-2EXFLOI.json")).toBe("legalities-cache.json");
		expect(syncConflictOrigin("data.sync-conflict-20261007-223032-7UNLEII.json")).toBe("data.json");
		expect(syncConflictOrigin("my.notes.sync-conflict-20260101-000000-ABCDEFG.md")).toBe("my.notes.md");
	});

	it.each([
		"legalities-cache.json",
		"sync-conflict-20261114-120832-2EXFLOI.json",
		"legalities-cache.sync-conflict-20261114-120832.json",
		"legalities-cache.sync-conflict-2026114-120832-2EXFLOI.json",
		"legalities-cache.sync-conflict-20261114-120832-2exfloi.json",
		"legalities-cache.sync-conflict-20261114-120832-2EXFLOIZZ.json",
		"legalities-cache.sync-conflict-20261114-120832-2EXFLOI",
		"legalities-cache.sync-conflict-20261114-120832-2EXFLOI.json.bak",
		"legalities-cache (conflicted copy).json",
		"legalities-cache.sync-conflict-20261114-120832-2EXFLOI.",
		"",
	])("is not fooled by %j", (name) => {
		expect(syncConflictOrigin(name)).toBeNull();
	});
});

describe("cacheConflictCopies", () => {
	it("finds the conflict copies of the caches in a real folder, and only those", () => {
		const found = cacheConflictCopies(REAL_FOLDER, CACHES);
		expect(found).toEqual([
			"legalities-cache.sync-conflict-20261027-114444-NLG4MGJ.json",
			"legalities-cache.sync-conflict-20261027-123042-NLG4MGJ.json",
			"legalities-cache.sync-conflict-20261027-184043-NLG4MGJ.json",
			"legalities-cache.sync-conflict-20261107-193606-NLG4MGJ.json",
			"legalities-cache.sync-conflict-20261109-145357-LGEWUHX.json",
			"legalities-cache.sync-conflict-20261114-120832-2EXFLOI.json",
			"scryfall-immutable-cache.sync-conflict-20261017-101010-LGEWUHX.json",
			"scryfall-immutable-cache.sync-conflict-20261020-101010-NLG4MGJ.json",
		]);
	});

	it("never offers the conflict copy of data.json, nor of any file that is not a cache", () => {
		expect(cacheConflictCopies(["data.sync-conflict-20261007-223032-7UNLEII.json", "main.sync-conflict-20261007-223032-7UNLEII.js"], CACHES)).toEqual([]);
	});

	it("never offers a cache file itself, nor a name that merely resembles a conflict copy", () => {
		expect(cacheConflictCopies(["legalities-cache.json", "legalities-cache.sync-conflict.json", "legalities-cache.sync-conflict-x-y-z.json"], CACHES)).toEqual([]);
	});

	it("matches the extension too: a conflict copy of a cache file under another extension is not the cache file", () => {
		expect(cacheConflictCopies(["legalities-cache.sync-conflict-20261114-120832-2EXFLOI.txt"], CACHES)).toEqual([]);
	});

	it("an empty list or an empty set of caches gives nothing", () => {
		expect(cacheConflictCopies([], CACHES)).toEqual([]);
		expect(cacheConflictCopies(REAL_FOLDER, new Set())).toEqual([]);
	});
});
