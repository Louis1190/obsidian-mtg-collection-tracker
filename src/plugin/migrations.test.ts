import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// migrations.ts imports the view (a class that extends Obsidian's ItemView) and api/scryfall.ts (which imports
// `requestUrl` from "obsidian": types only, no runtime); settings-sync.ts imports Notice and normalizePath. None of
// them is needed here: the view is a class with a `render` spy, and the one Scryfall function the catch-ups use is
// replaced.
vi.mock("obsidian", () => ({ requestUrl: vi.fn(), Notice: class {}, normalizePath: (p: string) => p }));
vi.mock("../view", () => ({ MTGCollectionView: class { render = vi.fn(); } }));
vi.mock("../api/scryfall", async (importOriginal) => ({
	...(await importOriginal<typeof import("../api/scryfall")>()),
	fetchScryfallCollection: vi.fn(),
}));

import { fetchScryfallCollection } from "../api/scryfall";
import type { ScryfallCard } from "../api/scryfall";
import { INBOX_WANTLIST_ID } from "../core/data-model";
import { MTGCollectionView } from "../view";
import * as collectionMutations from "./collection-mutations";
import { runSettingsMigrations } from "./lifecycle";
import * as migrations from "./migrations";
import { colCard, deckCard, makePlugin, saves, scry, wantCard } from "./__tests__/plugin-harness";
import type { Obj, TestPlugin } from "./__tests__/plugin-harness";

// Characterization tests (audit of 2026-11-15, lot 2): what each one-shot migration does TODAY to data written by an
// earlier version, that it does it ONCE, and that the runner survives a network that does not answer.

const NOW = 5_000_000;
const fetchMock = vi.mocked(fetchScryfallCollection);

// Scryfall answers for the ids it knows, calling the per-batch callback like the real function does.
function scryfallKnows(...ids: string[]) {
	fetchMock.mockImplementation(async (wanted: string[], _progress?: unknown, onChunk?: (m: Map<string, ScryfallCard>) => void) => {
		const found = new Map<string, ScryfallCard>(wanted.filter((id) => ids.includes(id)).map((id) => [id, scry(id, { name: `Fresh ${id}`, artist: "Fresh artist" })]));
		onChunk?.(found);
		return found;
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(new Map());
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function plugin(settings: Obj = {}): TestPlugin {
	const p = makePlugin([migrations, collectionMutations, { runSettingsMigrations }], settings);
	p.app = { workspace: { getLeavesOfType: vi.fn(() => []) } } as never;
	return p;
}
const dc = (scryfallId: string, over: Obj = {}) => {
	const r = deckCard({ scryfallId, ...over });
	for (const k of Object.keys(over)) if (over[k] === undefined) delete r[k];
	return r;
};
// A row exactly as an old version wrote it: only the listed fields exist.
const legacy = (fields: Obj): Obj => fields;

describe("dates of creation", () => {
	it("migrateListDateCreated gives undated lists a date from their position (older first) and leaves dated ones", () => {
		const p = plugin({ lists: [{ id: "a", name: "A" }, { id: "b", name: "B", dateCreated: 42 }, { id: "c", name: "C" }] });
		p.migrateListDateCreated();
		expect(p.settings.lists.map((l: Obj) => l.dateCreated)).toEqual([NOW - 3000, 42, NOW - 1000]);
		expect(saves(p)).toBe(1);
	});

	it("migrateDeckDateCreated does the same for decks", () => {
		const p = plugin({ decks: [{ id: "a", name: "A", cards: [] }, { id: "b", name: "B", cards: [], dateCreated: 7 }] });
		p.migrateDeckDateCreated();
		expect(p.settings.decks.map((d: Obj) => d.dateCreated)).toEqual([NOW - 2000, 7]);
	});

	it("neither saves when nothing is missing", () => {
		const p = plugin({ lists: [{ id: "a", name: "A", dateCreated: 1 }], decks: [{ id: "d", name: "D", cards: [], dateCreated: 1 }] });
		p.migrateListDateCreated();
		p.migrateDeckDateCreated();
		expect(saves(p)).toBe(0);
	});
});

describe("migrateFoilSplit (rows with a foil count, or with no id)", () => {
	const old = (over: Obj) => legacy({ scryfallId: "s1", name: "Bolt", setCode: "lea", setName: "Alpha", collectorNumber: "1", rarity: "common", manaCost: "{R}", typeLine: "Instant", imageUrl: "https://i/1", priceUsd: "1.00", listId: "l1", ...over });

	it("splits a row with a foil count into a regular row and a foiled row, conserving the copies", () => {
		const p = plugin({ collection: [old({ count: 3, foilCount: 2 })] });
		p.migrateFoilSplit();
		const rows = p.settings.collection;
		expect(rows.map((r: Obj) => [r.finish, r.count])).toEqual([["regular", 3], ["foiled", 2]]);
		expect(rows[0].id).toBeTruthy();
		expect(rows[0].id).not.toBe(rows[1].id);
		expect(rows.every((r: Obj) => r.scryfallId === "s1" && r.listId === "l1" && r.name === "Bolt")).toBe(true);
		expect(rows.every((r: Obj) => !("foilCount" in r))).toBe(true);
		expect(saves(p)).toBe(1);
	});

	it.each([
		["only regular copies", { count: 4, foilCount: 0 }, [["regular", 4]]],
		["only foil copies", { count: 0, foilCount: 2 }, [["foiled", 2]]],
		["no copy at all (kept as an empty regular row)", { count: 0, foilCount: 0 }, [["regular", 0]]],
	])("a row with %s", (_label, over, expected) => {
		const p = plugin({ collection: [old(over)] });
		p.migrateFoilSplit();
		expect(p.settings.collection.map((r: Obj) => [r.finish, r.count])).toEqual(expected);
	});

	it("gives an id-less row an id and turns the old boolean `foil` into a finish", () => {
		const p = plugin({ collection: [old({ count: 2, foil: true }), old({ scryfallId: "s2", count: 1 })] });
		p.migrateFoilSplit();
		expect(p.settings.collection.map((r: Obj) => [r.scryfallId, r.finish, r.count])).toEqual([["s1", "foiled", 2], ["s2", "regular", 1]]);
		expect(p.settings.collection.every((r: Obj) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
	});

	it("fills what an old row lacked: language 'en', no condition, the picture as artwork, today's dates", () => {
		const p = plugin({ collection: [old({ count: 1, foilCount: 0 })] });
		p.migrateFoilSplit();
		expect(p.settings.collection[0]).toMatchObject({ language: "en", condition: "", artCropUrl: "https://i/1", dateAdded: NOW, dateModified: NOW, colors: [], keywords: [], manaValue: 0, artist: "" });
	});

	it("keeps the dates, language and condition an old row had", () => {
		const p = plugin({ collection: [old({ count: 1, foilCount: 0, language: "fr", condition: "LP", dateAdded: 11, dateModified: 12 })] });
		p.migrateFoilSplit();
		expect(p.settings.collection[0]).toMatchObject({ language: "fr", condition: "LP", dateAdded: 11, dateModified: 12 });
	});

	it("leaves an up-to-date collection completely alone (same objects, no save)", () => {
		const rows = [colCard({ id: "a" }), colCard({ id: "b", scryfallId: "s2" })];
		const p = plugin({ collection: rows });
		const before = [...p.settings.collection];
		p.migrateFoilSplit();
		expect(p.settings.collection).toEqual(before);
		expect(p.settings.collection[0]).toBe(before[0]);
		expect(saves(p)).toBe(0);
	});

	it("rebuilds EVERY row from a fixed list of fields as soon as one row is old: fields outside the list (grading, custom price) are dropped", () => {
		const p = plugin({ collection: [colCard({ id: "a", gradingCompany: "PSA", gradingGrade: 9, customPrice: "50" }), old({ count: 1, foilCount: 0 })] });
		p.migrateFoilSplit();
		expect(p.settings.collection).toHaveLength(2);
		expect(p.settings.collection[0]).toMatchObject({ id: "a", scryfallId: "s1", count: 1 });
		expect(p.settings.collection[0]).not.toHaveProperty("gradingCompany");
		expect(p.settings.collection[0]).not.toHaveProperty("customPrice");
	});

	it("is a no-op the second time", () => {
		const p = plugin({ collection: [old({ count: 3, foilCount: 2 })] });
		p.migrateFoilSplit();
		const once = structuredClone(p.settings.collection);
		const savesAfterOnce = saves(p);
		p.migrateFoilSplit();
		expect(p.settings.collection).toEqual(once);
		expect(saves(p)).toBe(savesAfterOnce);
	});
});

describe("migrateFoilToFinish", () => {
	it("turns `foil` into a finish on the collection AND the wantlist, drops `foil`, and adds the etched price fields", () => {
		const p = plugin({
			collection: [legacy({ id: "a", foil: true }), legacy({ id: "b", foil: false }), legacy({ id: "c" })],
			wantlist: [legacy({ id: "w", foil: true })],
		});
		p.migrateFoilToFinish();
		expect(p.settings.collection.map((c: Obj) => c.finish)).toEqual(["foiled", "regular", "regular"]);
		expect(p.settings.wantlist[0].finish).toBe("foiled");
		expect(p.settings.collection.every((c: Obj) => !("foil" in c))).toBe(true);
		expect(p.settings.collection[0]).toMatchObject({ priceUsdEtched: "", priceEurEtched: "" });
		expect(saves(p)).toBe(1);
	});

	it("never touches a row that already has a finish, nor its etched prices", () => {
		const p = plugin({ collection: [colCard({ id: "a", finish: "etched", priceUsdEtched: "9.99" })] });
		p.migrateFoilToFinish();
		expect(p.settings.collection[0]).toMatchObject({ finish: "etched", priceUsdEtched: "9.99" });
		expect(saves(p)).toBe(0);
	});

	it("keeps etched prices an old row already had", () => {
		const p = plugin({ collection: [legacy({ id: "a", foil: false, priceUsdEtched: "4.00" })] });
		p.migrateFoilToFinish();
		expect(p.settings.collection[0]).toMatchObject({ finish: "regular", priceUsdEtched: "4.00", priceEurEtched: "" });
	});
});

describe("migrateDamagedCondition", () => {
	it("turns 'DMG' into 'PO' and touches no other condition", () => {
		const p = plugin({ collection: [colCard({ id: "a", condition: "DMG" }), colCard({ id: "b", condition: "PO" }), colCard({ id: "c", condition: "NM" }), colCard({ id: "d", condition: "" })] });
		p.migrateDamagedCondition();
		expect(p.settings.collection.map((c: Obj) => c.condition)).toEqual(["PO", "PO", "NM", ""]);
		expect(saves(p)).toBe(1);
		p.migrateDamagedCondition();
		expect(saves(p)).toBe(1);
	});
});

describe("migrateDeckCommanderCategory", () => {
	it("turns the old category 'commander' into a plain row whose function is Commander, replacing any other function", () => {
		const p = plugin({ decks: [{ id: "d", name: "D", cards: [dc("s1", { category: "commander" }), dc("s2", { category: "commander", deckFunctionOverride: "Ramp" }), dc("s3", { category: "sideboard" })] }] });
		p.migrateDeckCommanderCategory();
		const [a, b, c] = p.settings.decks[0].cards;
		expect(a.category).toBeUndefined();
		expect(a.deckFunctionOverride).toBe("Commander");
		expect(b.category).toBeUndefined();
		expect(b.deckFunctionOverride).toBe("Commander");
		expect(c).toMatchObject({ category: "sideboard" });
		expect(c.deckFunctionOverride).toBeUndefined();
		expect(saves(p)).toBe(1);
	});

	it("is a no-op the second time", () => {
		const p = plugin({ decks: [{ id: "d", name: "D", cards: [dc("s1", { category: "commander" })] }] });
		p.migrateDeckCommanderCategory();
		p.migrateDeckCommanderCategory();
		expect(saves(p)).toBe(1);
	});
});

describe("the Inboxes", () => {
	it("ensureInboxList creates one at the head of the lists when there is none, and does nothing when there is one", () => {
		const p = plugin({ lists: [{ id: "a", name: "A" }] });
		p.ensureInboxList();
		expect(p.settings.lists).toHaveLength(2);
		expect(p.settings.lists[0]).toMatchObject({ name: "Inbox", isInbox: true, dateCreated: NOW });
		const before = structuredClone(p.settings.lists);
		p.ensureInboxList();
		expect(p.settings.lists).toEqual(before);
	});

	it("ensureInboxList keeps a single Inbox when several came along, giving it the cards of the others", () => {
		const p = plugin({
			lists: [{ id: "i1", name: "Inbox", isInbox: true, dateCreated: 10 }, { id: "i2", name: "Inbox", isInbox: true, dateCreated: 20 }],
			collection: [colCard({ id: "a", listId: "i1" }), colCard({ id: "b", scryfallId: "s2", listId: "i2" })],
		});
		p.ensureInboxList();
		expect(p.settings.lists.map((l: Obj) => l.id)).toEqual(["i1"]);
		expect(p.settings.collection.map((c: Obj) => c.listId)).toEqual(["i1", "i1"]);
		expect(p.settings.syncTombstones?.lists?.i2).toBe(NOW);
		expect(saves(p)).toBe(1);
	});

	it("ensureInboxWantlist creates the wantlist Inbox with its FIXED id, and does nothing when there is one", () => {
		const p = plugin({ wantlists: [{ id: "w", name: "W", dateCreated: 1 }] });
		p.ensureInboxWantlist();
		expect(p.settings.wantlists[0]).toMatchObject({ id: INBOX_WANTLIST_ID, isInbox: true });
		p.ensureInboxWantlist();
		expect(p.settings.wantlists).toHaveLength(2);
	});
});

describe("migrateCollectionToLists (rows from before lists existed)", () => {
	it("puts each list-less card into a list named after its set, creating the list once per set", () => {
		const p = plugin({
			lists: [{ id: "existing", name: "Alpha", dateCreated: 1 }],
			collection: [
				colCard({ id: "a", listId: undefined, setCode: "lea", setName: "Alpha" }),
				colCard({ id: "b", scryfallId: "s2", listId: undefined, setCode: "m10", setName: "Magic 2010" }),
				colCard({ id: "c", scryfallId: "s3", listId: undefined, setCode: "m10", setName: "Magic 2010" }),
				colCard({ id: "d", scryfallId: "s4", listId: "l9" }),
			],
		});
		p.migrateCollectionToLists();
		const byId = (id: string) => p.settings.collection.find((c: Obj) => c.id === id)!;
		expect(byId("a").listId).toBe("existing");
		expect(byId("b").listId).toBe(byId("c").listId);
		const created = p.settings.lists.find((l: Obj) => l.name === "Magic 2010")!;
		expect(created.id).toBe(byId("b").listId);
		expect(p.settings.lists).toHaveLength(2);
		expect(byId("d").listId).toBe("l9");
		expect(saves(p)).toBe(1);
	});

	it("two list-less cards of a set with no set name share ONE list named after the set code", () => {
		const p = plugin({ collection: [colCard({ id: "a", listId: undefined, setCode: "xyz", setName: "" }), colCard({ id: "b", scryfallId: "s2", listId: undefined, setCode: "xyz", setName: "" })] });
		p.migrateCollectionToLists();
		expect(p.settings.lists).toHaveLength(1);
		expect(p.settings.lists[0].name).toBe("xyz");
		expect(p.settings.collection.map((c: Obj) => c.listId)).toEqual([p.settings.lists[0].id, p.settings.lists[0].id]);
	});

	it("names a list after the set code, or 'Unsorted', when the set name is missing", () => {
		const p = plugin({ collection: [colCard({ id: "a", listId: undefined, setCode: "xyz", setName: "" }), colCard({ id: "b", scryfallId: "s2", listId: undefined, setCode: "", setName: "" })] });
		p.migrateCollectionToLists();
		expect(p.settings.lists.map((l: Obj) => l.name).sort()).toEqual(["Unsorted", "xyz"]);
	});

	it("does nothing when every card has a list", () => {
		const p = plugin({ collection: [colCard()] });
		p.migrateCollectionToLists();
		expect(saves(p)).toBe(0);
	});
});

describe("migrateDeckCardDefaults", () => {
	it("fills the fields a deck card written long ago lacks, and keeps the ones it has", () => {
		const bare = { scryfallId: "s1", name: "Sol Ring", count: 1, imageUrl: "https://i/1" };
		const p = plugin({ decks: [{ id: "d", name: "D", cards: [bare, { ...bare, scryfallId: "s2", manaValue: 3, artist: "Me", colors: ["R"], setName: "Set", artCropUrl: "https://i/art", keywords: ["Haste"], dateAdded: 5, dateModified: 6 }] }] });
		p.migrateDeckCardDefaults();
		const [a, b] = p.settings.decks[0].cards;
		expect(a).toMatchObject({ dateAdded: NOW, dateModified: NOW, manaValue: 0, artist: "", colors: [], setName: "", artCropUrl: "https://i/1", keywords: [] });
		expect(b).toMatchObject({ manaValue: 3, artist: "Me", colors: ["R"], setName: "Set", artCropUrl: "https://i/art", keywords: ["Haste"], dateAdded: 5, dateModified: 6 });
		expect(saves(p)).toBe(1);
		p.migrateDeckCardDefaults();
		expect(saves(p)).toBe(1);
	});
});

describe("catch-ups that ask Scryfall for what an old row lacks", () => {
	describe("migrateEnrichMetadata (collection cards with no artist)", () => {
		it("asks once for each distinct missing card and fills artist, colors, mana value and release date", async () => {
			scryfallKnows("s1", "s2");
			const p = plugin({ collection: [colCard({ id: "a", scryfallId: "s1", artist: "" }), colCard({ id: "b", scryfallId: "s1", artist: "", listId: "l2" }), colCard({ id: "c", scryfallId: "s2", artist: "" }), colCard({ id: "ok", scryfallId: "s3", artist: "Has one" })] });
			await p.migrateEnrichMetadata();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls[0][0]).toEqual(["s1", "s2"]);
			expect(p.settings.collection[0]).toMatchObject({ artist: "Fresh artist", colors: ["R"], manaValue: 2, releasedAt: "1993-08-05" });
			expect(p.settings.collection[1].artist).toBe("Fresh artist");
			expect(p.settings.collection[3].artist).toBe("Has one");
			expect(saves(p)).toBe(1);
		});

		it("does not ask for a card that has no Scryfall id at all", async () => {
			const p = plugin({ collection: [colCard({ scryfallId: "", artist: "" })] });
			await p.migrateEnrichMetadata();
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("asks nothing when no card lacks an artist, and does not save", async () => {
			const p = plugin({ collection: [colCard()] });
			await p.migrateEnrichMetadata();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(saves(p)).toBe(0);
		});

		it("changes nothing when Scryfall answers with nothing, and leaves a card it does not know", async () => {
			const none = plugin({ collection: [colCard({ artist: "" })] });
			await none.migrateEnrichMetadata();
			expect(none.settings.collection[0].artist).toBe("");
			expect(saves(none)).toBe(0);
			scryfallKnows("s1");
			const some = plugin({ collection: [colCard({ id: "a", scryfallId: "s1", artist: "" }), colCard({ id: "b", scryfallId: "unknown", artist: "" })] });
			await some.migrateEnrichMetadata();
			expect(some.settings.collection.map((c: Obj) => c.artist)).toEqual(["Fresh artist", ""]);
		});

		it("lets a network failure through (the runner is the one that tolerates it)", async () => {
			fetchMock.mockRejectedValue(new Error("offline"));
			const p = plugin({ collection: [colCard({ artist: "" })] });
			await expect(p.migrateEnrichMetadata()).rejects.toThrow("offline");
		});
	});

	describe("migrateArtCropUrls", () => {
		it.each([
			["no artwork", { artCropUrl: "" }],
			["the whole card as its artwork", { artCropUrl: "https://img/same", imageUrl: "https://img/same" }],
			["no keywords field", { keywords: undefined }],
			["no foil price field", { priceUsdFoil: undefined }],
		])("fetches a card with %s", async (_label, over) => {
			scryfallKnows("s1");
			const row = colCard({ ...over });
			for (const k of Object.keys(over)) if ((over as Obj)[k] === undefined) delete row[k];
			const p = plugin({ collection: [row] });
			await p.migrateArtCropUrls();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(p.settings.collection[0]).toMatchObject({ artCropUrl: "https://img/s1-art.jpg", keywords: ["Haste"], priceUsdFoil: "2.00", priceEur: "0.90", priceEurFoil: "1.80", priceUsdEtched: "3.00", priceEurEtched: "2.70" });
		});

		it("does not ask for a complete card", async () => {
			const p = plugin({ collection: [colCard()] });
			await p.migrateArtCropUrls();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(saves(p)).toBe(0);
		});
	});

	describe("migrateEnrichDeckMetadata", () => {
		it("fills artist, colors, mana value, artwork and keywords of deck cards that lack them, and the set name only if empty", async () => {
			scryfallKnows("s1");
			const p = plugin({ decks: [{ id: "d", name: "D", cards: [dc("s1", { artist: "", setName: "" }), dc("s1", { artist: "", setName: "Kept" })] }] });
			await p.migrateEnrichDeckMetadata();
			const [a, b] = p.settings.decks[0].cards;
			expect(a).toMatchObject({ artist: "Fresh artist", colors: ["R"], manaValue: 2, artCropUrl: "https://img/s1-art.jpg", keywords: ["Haste"], setName: "Limited Edition Alpha" });
			expect(b.setName).toBe("Kept");
			expect(saves(p)).toBe(1);
		});

		it("asks nothing for complete deck cards", async () => {
			const p = plugin({ decks: [{ id: "d", name: "D", cards: [dc("s1")] }] });
			await p.migrateEnrichDeckMetadata();
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe("backfillBorderData / backfillOracleTextData / backfillDeckCardPrices", () => {
		it("backfillBorderData fills border, frame and frame effects on every row that shares a missing card, wherever it is", async () => {
			scryfallKnows("s1");
			const p = plugin({
				collection: [colCard({ id: "a", borderColor: undefined, frame: undefined, frameEffects: undefined }), colCard({ id: "done", scryfallId: "s9", borderColor: "" })],
				wantlist: [wantCard({ id: "w", scryfallId: "s1", borderColor: undefined })],
				decks: [{ id: "d", name: "D", cards: [dc("s1", { borderColor: undefined })] }],
			});
			const rowsOfS1: Obj[] = [p.settings.collection[0], p.settings.wantlist[0], p.settings.decks[0].cards[0]];
			for (const r of rowsOfS1) delete r.borderColor;
			await p.backfillBorderData();
			expect(fetchMock.mock.calls[0][0]).toEqual(["s1"]);
			for (const r of rowsOfS1) {
				expect(r).toMatchObject({ borderColor: "black", frame: "1993", frameEffects: [] });
			}
			expect(p.settings.collection[1].borderColor).toBe("");
			expect(saves(p)).toBe(1);
		});

		it("backfillOracleTextData fills rules text, but not where one exists (even an empty one)", async () => {
			scryfallKnows("s1");
			const p = plugin({ collection: [colCard({ id: "a" }), colCard({ id: "b", scryfallId: "s2", oracleText: "" })] });
			delete p.settings.collection[0].oracleText;
			await p.backfillOracleTextData();
			expect(fetchMock.mock.calls[0][0]).toEqual(["s1"]);
			expect(p.settings.collection[0].oracleText).toBe("Rules text of s1");
			expect(p.settings.collection[1].oracleText).toBe("");
		});

		it("backfillDeckCardPrices fills prices of deck cards that never had any, and leaves collection and wantlist alone", async () => {
			scryfallKnows("s1");
			const p = plugin({
				decks: [{ id: "d", name: "D", cards: [dc("s1", { priceUsd: undefined }), dc("s2", { priceUsd: "" })] }],
				collection: [colCard({ priceUsd: undefined })],
			});
			delete (p.settings.collection[0] as Obj).priceUsd;
			await p.backfillDeckCardPrices();
			expect(fetchMock.mock.calls[0][0]).toEqual(["s1"]);
			expect(p.settings.decks[0].cards[0]).toMatchObject({ priceUsd: "1.00", priceEur: "0.90", priceUsdEtched: "3.00" });
			expect(p.settings.decks[0].cards[1].priceUsd).toBe("");
			expect(p.settings.collection[0].priceUsd).toBeUndefined();
		});

		it.each(["backfillBorderData", "backfillOracleTextData", "backfillDeckCardPrices"] as const)("%s asks nothing when nothing is missing", async (method) => {
			const p = plugin({ collection: [colCard()], decks: [{ id: "d", name: "D", cards: [dc("s1")] }] });
			await p[method]();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(saves(p)).toBe(0);
		});

		it.each(["backfillBorderData", "backfillOracleTextData", "backfillDeckCardPrices"] as const)("%s saves nothing when Scryfall answers with nothing", async (method) => {
			const p = plugin({ decks: [{ id: "d", name: "D", cards: [dc("s1", { borderColor: undefined, oracleText: undefined, priceUsd: undefined })] }] });
			await p[method]();
			expect(saves(p)).toBe(0);
		});

		it("an open view is redrawn once the data arrived, and other views are left alone", async () => {
			scryfallKnows("s1");
			const p = plugin({ decks: [{ id: "d", name: "D", cards: [dc("s1", { priceUsd: undefined })] }] });
			const view = new (MTGCollectionView as never as new () => { render: ReturnType<typeof vi.fn> })();
			const other = { render: vi.fn() };
			p.app.workspace.getLeavesOfType = vi.fn(() => [{ view }, { view: other }]) as never;
			await p.backfillDeckCardPrices();
			expect(view.render).toHaveBeenCalledTimes(1);
			expect(other.render).not.toHaveBeenCalled();
		});
	});
});

describe("runSettingsMigrations (the runner, at every load and after a restore)", () => {
	it("runs the migrations in a fixed order", async () => {
		const p = plugin();
		const order: string[] = [];
		for (const name of ["ensureInboxList", "ensureInboxWantlist", "migrateFoilSplit", "migrateFoilToFinish", "migrateDamagedCondition", "migrateDeckCommanderCategory", "migrateCollectionToLists", "migrateListDateCreated", "migrateDeckDateCreated", "migrateEnrichMetadata", "migrateArtCropUrls", "migrateDeckCardDefaults", "migrateEnrichDeckMetadata"]) {
			p[name] = vi.fn(async () => {
				order.push(name);
			});
		}
		await p.runSettingsMigrations();
		expect(order).toEqual(["ensureInboxList", "ensureInboxWantlist", "migrateFoilSplit", "migrateFoilToFinish", "migrateDamagedCondition", "migrateDeckCommanderCategory", "migrateCollectionToLists", "migrateListDateCreated", "migrateDeckDateCreated", "migrateEnrichMetadata", "migrateArtCropUrls", "migrateDeckCardDefaults", "migrateEnrichDeckMetadata"]);
	});

	it("an offline network does not stop the load: the three Scryfall catch-ups are skipped, the local migrations still ran", async () => {
		fetchMock.mockRejectedValue(new Error("SSLHandshakeException"));
		const p = plugin({
			// no artist (asks for the metadata), no artwork (asks for the art crops), a deck card with no artist (asks for the deck's)
			collection: [colCard({ id: "a", artist: "", artCropUrl: "", condition: "DMG" })],
			decks: [{ id: "d", name: "D", cards: [dc("s1", { artist: "" })] }],
		});
		await expect(p.runSettingsMigrations()).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(p.settings.collection[0].condition).toBe("PO");
		expect(p.settings.lists.some((l: Obj) => l.isInbox)).toBe(true);
		expect(console.warn).toHaveBeenCalledTimes(3);
	});

	it("brings data written by an old version up to date, and a second run changes nothing and saves nothing", async () => {
		scryfallKnows("s1", "s2");
		const p = plugin({
			lists: [{ id: "l1", name: "Alpha" }],
			wantlists: [],
			collection: [
				legacy({ scryfallId: "s1", name: "Bolt", setCode: "lea", setName: "Alpha", collectorNumber: "1", rarity: "common", imageUrl: "https://i/1", priceUsd: "1.00", listId: "l1", count: 3, foilCount: 2 }),
				legacy({ id: "x", scryfallId: "s2", name: "Ancestral", setCode: "lea", setName: "Alpha", collectorNumber: "2", rarity: "rare", imageUrl: "https://i/2", priceUsd: "9.00", count: 1, foil: true, condition: "DMG" }),
			],
			wantlist: [legacy({ id: "w", scryfallId: "s1", foil: false, count: 1, listId: "wl" })],
			decks: [{ id: "d", name: "D", cards: [{ scryfallId: "s1", name: "Bolt", count: 1, imageUrl: "https://i/1", category: "commander" }] }],
		});
		await p.runSettingsMigrations();
		const afterFirst = structuredClone(p.settings);
		expect(afterFirst.collection.map((c: Obj) => [c.scryfallId, c.finish, c.count, c.condition])).toEqual([["s1", "regular", 3, ""], ["s1", "foiled", 2, ""], ["s2", "foiled", 1, "PO"]]);
		expect(afterFirst.collection.every((c: Obj) => c.artist === "Fresh artist")).toBe(true);
		expect(afterFirst.wantlist[0].finish).toBe("regular");
		expect(afterFirst.decks[0].cards[0]).toMatchObject({ deckFunctionOverride: "Commander", artist: "Fresh artist" });
		expect(afterFirst.lists.filter((l: Obj) => l.isInbox)).toHaveLength(1);
		expect(afterFirst.wantlists.filter((w: Obj) => w.isInbox)).toHaveLength(1);
		expect(afterFirst.lists.every((l: Obj) => typeof l.dateCreated === "number")).toBe(true);

		const savesBefore = saves(p);
		await p.runSettingsMigrations();
		expect(p.settings).toEqual(afterFirst);
		expect(saves(p)).toBe(savesBefore);
	});
});
