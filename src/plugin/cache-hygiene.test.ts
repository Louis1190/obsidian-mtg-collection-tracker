import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cache-hygiene.ts imports the file names from scryfall-cache.ts (which imports the view and api/scryfall.ts, which imports
// `requestUrl` from "obsidian": types only, no runtime): none of it is needed here.
vi.mock("obsidian", () => ({ normalizePath: (p: string) => p, requestUrl: vi.fn() }));
vi.mock("../view", () => ({ MTGCollectionView: class {} }));

import * as cacheHygiene from "./cache-hygiene";
import { makePlugin } from "./__tests__/plugin-harness";
import type { TestPlugin } from "./__tests__/plugin-harness";

const DIR = ".obsidian/plugins/mtg-collection-tracker";
const CONFLICT = "sync-conflict-20261114-120832-2EXFLOI";

// A fake adapter holding a flat list of paths: the real one lists a folder's files with their full path.
function plugin(files: string[], opts: { dir?: string | undefined; failRemove?: (p: string) => boolean; failList?: boolean } = {}): TestPlugin & { removed: string[]; adapter: { list: ReturnType<typeof vi.fn> } } {
	const removed: string[] = [];
	const adapter = {
		list: vi.fn(async () => {
			if (opts.failList) throw new Error("EBUSY");
			return { files, folders: [`${DIR}/sync-backups`] };
		}),
		remove: vi.fn(async (p: string) => {
			if (opts.failRemove?.(p)) throw new Error("EPERM");
			removed.push(p);
		}),
	};
	const p = makePlugin([cacheHygiene]) as TestPlugin & { removed: string[]; adapter: typeof adapter };
	Object.assign(p, { manifest: { dir: "dir" in opts ? opts.dir : DIR }, app: { vault: { adapter } }, removed, adapter });
	return p;
}

beforeEach(() => {
	vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("REGENERABLE_CACHE_FILES", () => {
	it("is exactly the caches the plugin writes, and never the user's data", () => {
		expect([...cacheHygiene.REGENERABLE_CACHE_FILES].sort()).toEqual([
			"all-sets-cache.json",
			"cardmarket-id-cache.json",
			"icon-cache.json",
			"legalities-cache.json",
			"print-languages-cache.json",
			"printed-images-cache.json",
			"printed-names-cache.json",
			"scryfall-immutable-cache.json",
		]);
		expect(cacheHygiene.REGENERABLE_CACHE_FILES.has("data.json")).toBe(false);
	});
});

describe("cleanCacheConflictCopies", () => {
	it("deletes the conflict copies of the caches in the plugin's folder and says how many", async () => {
		const p = plugin([
			`${DIR}/legalities-cache.json`,
			`${DIR}/legalities-cache.${CONFLICT}.json`,
			`${DIR}/scryfall-immutable-cache.${CONFLICT}.json`,
			`${DIR}/printed-names-cache.${CONFLICT}.json`,
		]);
		expect(await p.cleanCacheConflictCopies()).toBe(3);
		expect(p.removed.sort()).toEqual([
			`${DIR}/legalities-cache.${CONFLICT}.json`,
			`${DIR}/printed-names-cache.${CONFLICT}.json`,
			`${DIR}/scryfall-immutable-cache.${CONFLICT}.json`,
		]);
	});

	it("never touches data.json, its conflict copies, the plugin's own files, or anything that is not a cache", async () => {
		const keep = [
			`${DIR}/data.json`,
			`${DIR}/data.${CONFLICT}.json`,
			`${DIR}/legalities-cache.json`,
			`${DIR}/main.js`,
			`${DIR}/main.${CONFLICT}.js`,
			`${DIR}/styles.css`,
			`${DIR}/fp-s0.bin.gz`,
			`${DIR}/some-notes.${CONFLICT}.json`,
		];
		const p = plugin(keep);
		expect(await p.cleanCacheConflictCopies()).toBe(0);
		expect(p.removed).toEqual([]);
		expect(p.adapter.list).toHaveBeenCalledWith(DIR);
	});

	it("only looks at the direct children of the plugin's folder: a deeper path, or another folder, is left alone", async () => {
		const p = plugin([
			`${DIR}/sync-backups/legalities-cache.${CONFLICT}.json`,
			`${DIR}/deeper/folder/legalities-cache.${CONFLICT}.json`,
			`.obsidian/plugins/another-plugin/legalities-cache.${CONFLICT}.json`,
			`${DIR}-twin/legalities-cache.${CONFLICT}.json`,
			`legalities-cache.${CONFLICT}.json`,
			`${DIR}/legalities-cache.${CONFLICT}.json`,
		]);
		expect(await p.cleanCacheConflictCopies()).toBe(1);
		expect(p.removed).toEqual([`${DIR}/legalities-cache.${CONFLICT}.json`]);
	});

	it("a copy that cannot be deleted is left for a later start, and the others still go", async () => {
		const stuck = `${DIR}/legalities-cache.${CONFLICT}.json`;
		const p = plugin([stuck, `${DIR}/icon-cache.${CONFLICT}.json`], { failRemove: (path) => path === stuck });
		expect(await p.cleanCacheConflictCopies()).toBe(1);
		expect(p.removed).toEqual([`${DIR}/icon-cache.${CONFLICT}.json`]);
	});

	it("a folder that cannot be listed is not an error", async () => {
		const p = plugin([`${DIR}/legalities-cache.${CONFLICT}.json`], { failList: true });
		await expect(p.cleanCacheConflictCopies()).resolves.toBe(0);
		expect(p.removed).toEqual([]);
	});

	it("does nothing when the plugin has no folder", async () => {
		const p = plugin([`${DIR}/legalities-cache.${CONFLICT}.json`], { dir: undefined });
		expect(await p.cleanCacheConflictCopies()).toBe(0);
		expect(p.adapter.list).not.toHaveBeenCalled();
	});

	it("an empty folder, or one with no copy, deletes nothing and logs nothing", async () => {
		const p = plugin([]);
		expect(await p.cleanCacheConflictCopies()).toBe(0);
		expect(console.debug).not.toHaveBeenCalled();
	});

	it("is idempotent: a second pass over what is left finds nothing", async () => {
		const files = [`${DIR}/legalities-cache.json`, `${DIR}/legalities-cache.${CONFLICT}.json`];
		const first = plugin(files);
		expect(await first.cleanCacheConflictCopies()).toBe(1);
		const second = plugin(files.filter((f) => !first.removed.includes(f)));
		expect(await second.cleanCacheConflictCopies()).toBe(0);
	});
});
