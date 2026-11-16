import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../core/data-model";
import type MTGCollectionPlugin from "../../plugin";
import type { ScryfallCard } from "../../api/scryfall";

// Common tools for the tests of the code that CHANGES the user's data (plugin/collection-mutations.ts,
// wantlist-mutations.ts, deck-mutations.ts, migrations.ts, import-export.ts). Only imported by tests: never bundled.
//
// The plugin's methods are plain functions taking `this` as a parameter, and plugin.ts assigns them back as class
// fields (see CLAUDE.md, "Phase 5"). `makePlugin` does the same on a bare object, with the REAL functions, so a
// mutation that calls another one (`this.removeCollectionCard(...)`, `this.mergeListDuplicateGroup(...)`) goes through
// the real code and not through a stub. `vi.mock("obsidian")` stays in each test file (vitest hoists it per file).

export type Obj = Record<string, any>;
export type TestPlugin = MTGCollectionPlugin & Obj;

// The fake `this`: real settings (a clean copy of the defaults, overridable), a save that only counts, and every
// function the given modules export, as methods. Nothing else exists on it, so a mutation that starts needing
// something new fails loudly ("is not a function") instead of silently doing nothing.
export function makePlugin(modules: Record<string, unknown>[], settings: Obj = {}): TestPlugin {
	const plugin: Obj = {
		settings: { ...structuredClone(DEFAULT_SETTINGS), ...structuredClone(settings) },
		recentlyAddedCollectionCardIds: new Set<string>(),
		recentlyAddedWantlistCardIds: new Set<string>(),
		saveSettings: vi.fn(async () => {}),
		rememberPrintedName: vi.fn(),
	};
	for (const mod of modules) {
		for (const [name, value] of Object.entries(mod)) {
			if (typeof value === "function") plugin[name] = value;
		}
	}
	return plugin as TestPlugin;
}

// How many times the data was saved: a mutation saves once, and a "no such id" call saves nothing.
export const saves = (plugin: TestPlugin): number => (plugin.saveSettings as ReturnType<typeof vi.fn>).mock.calls.length;

// A Scryfall card as the API answers it, with the fields the mutations copy; override what a test cares about.
export function scry(id: string, over: Partial<ScryfallCard> = {}): ScryfallCard {
	return {
		id,
		name: `Card ${id}`,
		set: "lea",
		set_name: "Limited Edition Alpha",
		collector_number: "1",
		rarity: "rare",
		mana_cost: "{1}{R}",
		cmc: 2,
		type_line: "Creature — Elf",
		oracle_text: `Rules text of ${id}`,
		artist: "Artist A",
		colors: ["R"],
		keywords: ["Haste"],
		released_at: "1993-08-05",
		border_color: "black",
		frame: "1993",
		frame_effects: [],
		image_uris: { normal: `https://img/${id}-normal.jpg`, art_crop: `https://img/${id}-art.jpg` },
		prices: { usd: "1.00", usd_foil: "2.00", eur: "0.90", eur_foil: "1.80", usd_etched: "3.00", eur_etched: "2.70" },
		...over,
	};
}

// Rows as the plugin stores them. The identity fields are the ones a test overrides; the rest is a plausible filler.
export function colCard(over: Obj = {}): Obj {
	return {
		id: "c1",
		scryfallId: "s1",
		name: "Old name",
		setCode: "old",
		setName: "Old set",
		collectorNumber: "9",
		rarity: "common",
		manaCost: "{W}",
		manaValue: 1,
		typeLine: "Instant",
		artist: "Old artist",
		colors: ["W"],
		keywords: [],
		releasedAt: "2000-01-01",
		imageUrl: "https://img/old.jpg",
		artCropUrl: "https://img/old-art.jpg",
		priceUsd: "0.10",
		priceUsdFoil: "0.20",
		priceEur: "0.09",
		priceEurFoil: "0.19",
		priceUsdEtched: "",
		priceEurEtched: "",
		count: 1,
		finish: "regular",
		language: "en",
		condition: "NM",
		listId: "l1",
		dateAdded: 1000,
		dateModified: 1000,
		borderColor: "white",
		frame: "1997",
		frameEffects: [],
		oracleText: "Old rules text",
		...over,
	};
}

// A wanted card: the same fields without language/condition.
export function wantCard(over: Obj = {}): Obj {
	const { language: _l, condition: _c, ...rest } = colCard({ id: "w1", listId: "wl1", ...over });
	return rest;
}

// A card of a deck: no id of its own (a deck row is found by scryfallId), no list.
export function deckCard(over: Obj = {}): Obj {
	const { id: _id, listId: _list, ...rest } = colCard({ language: undefined, condition: undefined, ...over });
	if (over.language === undefined) delete rest.language;
	if (over.condition === undefined) delete rest.condition;
	return rest;
}

export const idsOf = (rows: Obj[]): string[] => rows.map((r) => r.id);
export const scryfallIdsOf = (rows: Obj[]): string[] => rows.map((r) => r.scryfallId);

// Total number of physical copies in a set of rows: the quantity every merge, copy-and-delete or move must conserve.
export const totalCount = (rows: Obj[]): number => rows.reduce((n, r) => n + r.count, 0);
