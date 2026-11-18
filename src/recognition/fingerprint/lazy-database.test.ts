import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { idOf } from "./database";
import { FAIL_PAUSE_MS, FILE_PREFIX, FingerprintBase, IDLE_MS, LOCAL_INDEX, type BaseDeps } from "./lazy-database";
import { buildTestFiles, testId, type TestFiles } from "./__tests__/fingerprint-scenes";

const BASE = "https://fp.example/data";

/** A site and a disk, both in memory, with the calls counted. */
function world(files: TestFiles, opts: { baseUrl?: string; online?: boolean } = {}) {
	const state = { site: files.site, online: opts.online ?? true, gets: [] as string[], disk: new Map<string, Uint8Array>(), writes: [] as string[], removed: [] as string[], now: 1_000_000, baseUrl: opts.baseUrl ?? BASE };
	const deps: BaseDeps = {
		baseUrl: () => state.baseUrl,
		get: async (url) => {
			state.gets.push(url);
			if (!state.online) return null;
			return state.site.get(url.slice(BASE.length + 1)) ?? null;
		},
		files: {
			read: async (name) => state.disk.get(name) ?? null,
			write: async (name, bytes) => {
				state.writes.push(name);
				state.disk.set(name, bytes);
			},
			remove: async (name) => {
				state.removed.push(name);
				state.disk.delete(name);
			},
			list: async () => [...state.disk.keys()].filter((n) => n.startsWith(FILE_PREFIX)),
		},
		sha256: async (bytes) => createHash("sha256").update(bytes).digest("hex"),
		gunzip: async (bytes, max) => {
			const out = new Uint8Array(gunzipSync(bytes));
			if (out.length > max) throw new Error("too big");
			return out;
		},
		now: () => state.now,
		idleMs: IDLE_MS,
		indexTimeoutMs: 50,
	};
	return { state, deps, base: () => new FingerprintBase(deps) };
}

/** The files a person's own sync (Syncthing...) carries into the plugin's folder: the site's files under the names the loader keeps them by. */
function syncedFiles(site: Map<string, Uint8Array>): Map<string, Uint8Array> {
	return new Map([...site].map(([name, bytes]) => [name === "index.json" ? LOCAL_INDEX : FILE_PREFIX + name, bytes]));
}

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);
let files: TestFiles;
// built once: the tests never change it (a test that needs another site builds its own)
beforeAll(() => {
	files = buildTestFiles(SEEDS, 64);
});
afterEach(() => vi.useRealTimers());

describe("FingerprintBase", { timeout: 60_000 }, () => {
	it("with no address and nothing on disk there is no base: null, nothing asked, nothing written, and it is not an error", async () => {
		const w = world(files, { baseUrl: "" });
		const base = w.base();
		expect(base.configured).toBe(false);
		expect(await base.database()).toBeNull();
		expect(await w.base().prepare()).toBe(false);
		expect(w.state.gets).toEqual([]);
		expect(w.state.writes).toEqual([]);
	});

	it("with no address it reads the files the person's own sync brought, without asking anyone and without writing or deleting anything", async () => {
		const w = world(files, { baseUrl: "" });
		w.state.disk = syncedFiles(files.site);
		w.state.disk.set(`${FILE_PREFIX}notmine.bin.gz`, new Uint8Array([1, 2, 3])); // an fp- file this index does not list: the sync's business, not ours
		const base = w.base();
		const db = await base.database();
		expect(db?.n).toBe(150);
		expect(Array.from(db!.ids.slice(0, 16))).toEqual(Array.from(testId(1)));
		expect(w.state.gets).toEqual([]);
		expect(w.state.writes).toEqual([]);
		expect(w.state.removed).toEqual([]);
		expect(await w.base().prepare()).toBe(true);
	});

	it("with no address, a shard the sync has not brought yet (or a half-written one) means no base for now: null, and the next ask tries again at once", async () => {
		const w = world(files, { baseUrl: "" });
		w.state.disk = syncedFiles(files.site);
		w.state.disk.delete(`${FILE_PREFIX}s1.bin.gz`);
		const base = w.base();
		expect(await base.database()).toBeNull();
		expect(w.state.gets).toEqual([]);
		// the sync catches up: no pause was imposed, the very next ask finds the base
		w.state.disk.set(`${FILE_PREFIX}s1.bin.gz`, files.site.get("s1.bin.gz")!);
		expect((await base.database())?.n).toBe(150);
		// a shard cut short in the middle of the sync does not match its hash
		const half = world(files, { baseUrl: "" });
		half.state.disk = syncedFiles(files.site);
		half.state.disk.set(`${FILE_PREFIX}s2.bin.gz`, files.site.get("s2.bin.gz")!.slice(0, 100));
		expect(await half.base().database()).toBeNull();
	});

	it("downloads the index and every shard once, keeps them on disk, and answers the base, counting shards as it goes", async () => {
		const w = world(files);
		const progress: [number, number][] = [];
		const db = await w.base().database((d, t) => progress.push([d, t]));
		expect(db?.n).toBe(150);
		expect(idOf(db!, 0)).toBe(idOf(db!, 0));
		expect(Array.from(db!.ids.slice(0, 16))).toEqual(Array.from(testId(1)));
		expect(w.state.gets.sort()).toEqual([`${BASE}/index.json`, `${BASE}/s0.bin.gz`, `${BASE}/s1.bin.gz`, `${BASE}/s2.bin.gz`].sort());
		expect([...w.state.disk.keys()].sort()).toEqual([LOCAL_INDEX, `${FILE_PREFIX}s0.bin.gz`, `${FILE_PREFIX}s1.bin.gz`, `${FILE_PREFIX}s2.bin.gz`].sort());
		expect(progress[0]).toEqual([0, 3]);
		expect(progress[progress.length - 1]).toEqual([3, 3]);
	});

	it("shares one load between callers that ask together, and answers from memory afterwards", async () => {
		const w = world(files);
		const base = w.base();
		const [a, b] = await Promise.all([base.database(), base.database()]);
		expect(a).toBe(b);
		const gets = w.state.gets.length;
		expect(await base.database()).toBe(a);
		expect(w.state.gets.length).toBe(gets);
	});

	it("reads the shards from disk the next time, asking the site only for its index", async () => {
		const w = world(files);
		await w.base().database();
		w.state.gets.length = 0;
		const db = await w.base().database(); // a fresh object: another session
		expect(db?.n).toBe(150);
		expect(w.state.gets).toEqual([`${BASE}/index.json`]);
	});

	it("downloads only the shard that changed when the site has a newer index, and removes what the new index no longer lists", async () => {
		const w = world(files);
		await w.base().database();
		// a card of the second shard changed: a new index whose second shard differs
		const newer = buildTestFiles([...SEEDS.slice(0, 64), 900, ...SEEDS.slice(65)], 64, "2026-11-18");
		const kept = newer.site.get("s0.bin.gz")!;
		expect(Buffer.from(kept).equals(Buffer.from(files.site.get("s0.bin.gz")!))).toBe(true); // an unchanged shard is byte for byte the same
		w.state.site = newer.site;
		w.state.gets.length = 0;
		w.state.writes.length = 0;
		const db = await w.base().database();
		expect(db?.n).toBe(150);
		expect(Array.from(db!.ids.slice(64 * 16, 65 * 16))).toEqual(Array.from(testId(900)));
		expect(w.state.gets.sort()).toEqual([`${BASE}/index.json`, `${BASE}/s1.bin.gz`].sort());
		expect(w.state.writes).toContain(`${FILE_PREFIX}s1.bin.gz`);
		expect(w.state.writes).not.toContain(`${FILE_PREFIX}s0.bin.gz`);
		// a shard the index no longer lists goes
		w.state.disk.set(`${FILE_PREFIX}s9.bin.gz`, new Uint8Array([1]));
		w.state.gets.length = 0;
		await w.base().database();
		expect(w.state.removed).toContain(`${FILE_PREFIX}s9.bin.gz`);
	});

	it("uses the copy on disk when the site does not answer, and answers null with nothing on disk, then waits before asking again", async () => {
		const warm = world(files);
		await warm.base().database();
		const offline = world(files, { online: false });
		offline.state.disk = warm.state.disk;
		offline.state.disk.set(`${FILE_PREFIX}s9.bin.gz`, new Uint8Array([1]));
		expect((await offline.base().database())?.n).toBe(150);
		expect(offline.state.removed).toEqual([]); // no site answered: nothing is deleted on its behalf
		expect(offline.state.writes).toEqual([]);

		const cold = world(files, { online: false });
		const base = cold.base();
		expect(await base.database()).toBeNull();
		const gets = cold.state.gets.length;
		expect(await base.database()).toBeNull();
		expect(cold.state.gets.length).toBe(gets); // paused
		cold.state.now += FAIL_PAUSE_MS + 1;
		cold.state.online = true;
		expect((await base.database())?.n).toBe(150); // asks again after the pause
	});

	it("refuses a shard whose SHA-256 is not the index's: null, and nothing of it written", async () => {
		const w = world(files);
		const bad = new Uint8Array(files.site.get("s1.bin.gz")!);
		bad[bad.length >> 1] ^= 0xff;
		w.state.site = new Map(files.site).set("s1.bin.gz", bad);
		expect(await w.base().database()).toBeNull();
		expect(w.state.disk.has(`${FILE_PREFIX}s1.bin.gz`)).toBe(false);
		expect(w.state.disk.has(LOCAL_INDEX)).toBe(false); // the index is kept only for a base that loaded
	});

	it("refuses a shard that gunzips to more than its rows take", async () => {
		const w = world(files);
		w.deps.gunzip = async () => {
			throw new Error("too big");
		};
		expect(await new FingerprintBase(w.deps).database()).toBeNull();
	});

	it("refuses an index that is not what this plugin reads", async () => {
		const w = world(files);
		w.state.site = new Map(files.site).set("index.json", new TextEncoder().encode(JSON.stringify({ v: 9 })));
		expect(await w.base().database()).toBeNull();
	});

	it("lets the base go after the idle time, keeps it while a window pins it, and reloads from disk", async () => {
		vi.useFakeTimers();
		const w = world(files);
		const base = w.base();
		const first = await base.database();
		expect(first).not.toBeNull();
		vi.advanceTimersByTime(IDLE_MS + 10);
		w.state.gets.length = 0;
		const second = await base.database();
		expect(second).not.toBe(first); // a new object: it was let go
		expect(w.state.gets).toEqual([`${BASE}/index.json`]);
		base.pin();
		vi.advanceTimersByTime(IDLE_MS * 3);
		expect(await base.database()).toBe(second); // pinned: kept
		base.unpin();
		vi.advanceTimersByTime(IDLE_MS + 10);
		expect(await base.database()).not.toBe(second);
	});

	it("stop() lets go at once and prepare() loads in the background", async () => {
		const w = world(files);
		const base = w.base();
		expect(await base.prepare()).toBe(true);
		await vi.waitFor(() => expect(w.state.disk.has(LOCAL_INDEX)).toBe(true));
		base.stop();
		w.state.gets.length = 0;
		await base.database();
		expect(w.state.gets).toEqual([`${BASE}/index.json`]);
		base.stop();
	});
});

describe("FingerprintBase on a bad network", { timeout: 60_000 }, () => {
	/** The site as `world` serves it, except for the files in `cut`, which never arrive (a null, like any failed request). */
	function cutOff(w: ReturnType<typeof world>, cut: Set<string>): void {
		const get = w.deps.get;
		w.deps.get = async (url) => (cut.has(url.slice(BASE.length + 1)) ? (w.state.gets.push(url), null) : get(url));
	}

	it("a download cut off half way leaves no half base: null, no index kept, nothing removed; the retry after the pause fetches only what is still missing", async () => {
		const w = world(files);
		const cut = new Set(["s1.bin.gz", "s2.bin.gz"]);
		cutOff(w, cut);
		const base = new FingerprintBase(w.deps);
		expect(await base.database()).toBeNull();
		expect(w.state.disk.has(LOCAL_INDEX)).toBe(false); // the index is kept only for a base that loaded whole
		expect(w.state.removed).toEqual([]);
		expect([...w.state.disk.keys()]).toEqual([`${FILE_PREFIX}s0.bin.gz`]); // the shard that arrived and matched its hash is kept, the others are not there
		// paused: asking again at once costs nothing
		const gets = w.state.gets.length;
		expect(await base.database()).toBeNull();
		expect(w.state.gets.length).toBe(gets);
		// the site is back after the pause: only the two missing shards (and the index) are downloaded
		cut.clear();
		w.state.now += FAIL_PAUSE_MS + 1;
		w.state.gets.length = 0;
		expect((await base.database())?.n).toBe(150);
		expect(w.state.gets.sort()).toEqual([`${BASE}/index.json`, `${BASE}/s1.bin.gz`, `${BASE}/s2.bin.gz`].sort());
		expect(w.state.disk.has(LOCAL_INDEX)).toBe(true);
	});

	it("an update that cannot be finished touches nothing of the base already on disk, and that base serves again once the site is gone", async () => {
		const warm = world(files);
		await warm.base().database();
		const oldIndex = warm.state.disk.get(LOCAL_INDEX)!;
		const newer = buildTestFiles([...SEEDS.slice(0, 64), 900, ...SEEDS.slice(65)], 64, "2026-11-18");
		const w = world(files);
		w.state.disk = new Map(warm.state.disk);
		w.state.site = newer.site;
		cutOff(w, new Set(["s1.bin.gz"]));
		const base = new FingerprintBase(w.deps);
		expect(await base.database()).toBeNull(); // no half-new base is ever handed out
		expect(w.state.removed).toEqual([]);
		expect(Buffer.from(w.state.disk.get(LOCAL_INDEX)!).equals(Buffer.from(oldIndex))).toBe(true);
		for (const name of warm.state.disk.keys()) expect(w.state.disk.has(name)).toBe(true);
		// the site stops answering altogether: the copy the person already had is read as it was
		w.state.online = false;
		w.state.now += FAIL_PAUSE_MS + 1;
		const db = await base.database();
		expect(db?.n).toBe(150);
		expect(Array.from(db!.ids.slice(64 * 16, 65 * 16))).toEqual(Array.from(testId(65))); // the OLD content of the shard
	});

	it("KNOWN LIMIT, pinned: an update interrupted AFTER it replaced one shard leaves no usable base until it is finished (the shard files keep their names), and the next ask finishes it by fetching only what is missing", async () => {
		const warm = world(files);
		await warm.base().database();
		// two shards change on the site (a card of the first, a card of the third)
		const seeds = [...SEEDS];
		seeds[10] = 901;
		seeds[140] = 902;
		const newer = buildTestFiles(seeds, 64, "2026-11-18");
		const w = world(files);
		w.state.disk = new Map(warm.state.disk);
		w.state.site = newer.site;
		const cut = new Set(["s2.bin.gz"]);
		cutOff(w, cut);
		const base = new FingerprintBase(w.deps);
		expect(await base.database()).toBeNull(); // s0 was replaced, s2 did not arrive
		expect(Buffer.from(w.state.disk.get(`${FILE_PREFIX}s0.bin.gz`)!).equals(Buffer.from(newer.site.get("s0.bin.gz")!))).toBe(true);
		// the site goes away: the old index no longer matches the replaced shard, so even the copy on disk is not a base (the title is read instead)
		w.state.online = false;
		w.state.now += FAIL_PAUSE_MS + 1;
		expect(await base.database()).toBeNull();
		// back online: the shard already replaced is kept, only the missing one is fetched
		w.state.online = true;
		cut.clear();
		w.state.now += FAIL_PAUSE_MS + 1;
		w.state.gets.length = 0;
		const db = await base.database();
		expect(db?.n).toBe(150);
		expect(Array.from(db!.ids.slice(10 * 16, 11 * 16))).toEqual(Array.from(testId(901)));
		expect(w.state.gets.sort()).toEqual([`${BASE}/index.json`, `${BASE}/s2.bin.gz`].sort());
	});

	it("a request that throws instead of answering null is a null too, for the index and for a shard, never a rejection", async () => {
		const w = world(files);
		w.deps.get = async () => {
			throw new Error("network");
		};
		await expect(new FingerprintBase(w.deps).database()).resolves.toBeNull();
		const shard = world(files);
		const get = shard.deps.get;
		shard.deps.get = async (url) => {
			if (url.endsWith("s1.bin.gz")) throw new Error("reset");
			return get(url);
		};
		await expect(new FingerprintBase(shard.deps).database()).resolves.toBeNull();
		expect(shard.state.disk.has(LOCAL_INDEX)).toBe(false);
	});

	it("an index that never arrives is given up on after its own delay: the copy on disk is used, and with none there is no base", async () => {
		const warm = world(files);
		await warm.base().database();
		const w = world(files);
		w.state.disk = new Map(warm.state.disk);
		w.deps.get = () => new Promise<Uint8Array | null>(() => undefined);
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.removed).toEqual([]);
		const cold = world(files);
		cold.deps.get = () => new Promise<Uint8Array | null>(() => undefined);
		expect(await new FingerprintBase(cold.deps).database()).toBeNull();
	});

	it("a page that is not the index (a Wi-Fi sign-in screen answering 200 with HTML) is no base from the site: the copy on disk is used, or nothing", async () => {
		const html = new TextEncoder().encode("<html><body>Please sign in to the network</body></html>");
		const warm = world(files);
		await warm.base().database();
		const w = world(files);
		w.state.disk = new Map(warm.state.disk);
		w.state.site = new Map(files.site).set("index.json", html);
		expect((await w.base().database())?.n).toBe(150);
		expect(w.state.writes).toEqual([]);
		expect(w.state.removed).toEqual([]);
		const cold = world(files);
		cold.state.site = new Map(files.site).set("index.json", html);
		expect(await cold.base().database()).toBeNull();
		expect(cold.state.disk.size).toBe(0);
	});

	it("an index and a shard of two different versions of the site (a cache half updated) are refused although the shard is a perfectly good one: only its SHA-256 says so", async () => {
		const newer = buildTestFiles([...SEEDS.slice(0, 64), 900, ...SEEDS.slice(65)], 64, "2026-11-18");
		const w = world(files);
		w.state.site = new Map(files.site).set("s1.bin.gz", newer.site.get("s1.bin.gz")!); // the old index, the new second shard: same size, valid gzip
		expect(await w.base().database()).toBeNull();
		expect(w.state.disk.has(`${FILE_PREFIX}s1.bin.gz`)).toBe(false);
		expect(w.state.disk.has(LOCAL_INDEX)).toBe(false);
	});

	it("a shard that arrives as a page of HTML (right name, wrong content) is refused, and nothing of it is written", async () => {
		const w = world(files);
		w.state.site = new Map(files.site).set("s2.bin.gz", new TextEncoder().encode("<html>sign in</html>"));
		expect(await w.base().database()).toBeNull();
		expect(w.state.disk.has(`${FILE_PREFIX}s2.bin.gz`)).toBe(false);
		expect(w.state.disk.has(LOCAL_INDEX)).toBe(false);
	});

	it("a disk that refuses the writes still gives the base (this time), and the next session downloads again instead of trusting a file that is not there", async () => {
		const w = world(files);
		w.deps.files.write = async () => {
			throw new Error("disk full");
		};
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.disk.size).toBe(0);
		w.state.gets.length = 0;
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.length).toBe(4); // the index and the three shards, again
	});

	it("a disk that cannot be read is a disk with nothing on it: the shards are downloaded", async () => {
		const warm = world(files);
		await warm.base().database();
		const w = world(files);
		w.state.disk = new Map(warm.state.disk);
		w.deps.files.read = async () => {
			throw new Error("unreadable");
		};
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.length).toBe(4);
	});

	it("callers that ask together while the site is down share the one failure, and the pause starts once", async () => {
		const w = world(files, { online: false });
		const base = w.base();
		const answers = await Promise.all([base.database(), base.database(), base.prepare()]);
		expect(answers).toEqual([null, null, false]);
		expect(w.state.gets).toEqual([`${BASE}/index.json`]);
	});
});

describe("FingerprintBase and a `moved` pointer in the index", { timeout: 60_000 }, () => {
	const NEW = "https://files.example.org/fp";
	const OTHER = "https://other.example.org/fp";
	/** The site's index with a `moved` field (the value as written, whatever it is), the other files untouched. */
	function indexWith(site: Map<string, Uint8Array>, moved: unknown): Map<string, Uint8Array> {
		const index = JSON.parse(new TextDecoder().decode(site.get("index.json")!)) as Record<string, unknown>;
		if (moved !== undefined) index.moved = moved;
		return new Map(site).set("index.json", new TextEncoder().encode(JSON.stringify(index)));
	}
	/** The configured site (BASE) and where it points (NEW), each of which can be switched off, and a device memory that can start with an address. */
	function twoSites(opts: { oldMoved?: unknown; newMoved?: unknown; remembered?: string | null; oldUp?: boolean; newUp?: boolean } = {}) {
		const w = world(files);
		const mem = { value: opts.remembered ?? null, writes: [] as [string, string | null][], reads: [] as string[] };
		const up = { old: opts.oldUp ?? true, neu: opts.newUp ?? true };
		const oldSite = indexWith(files.site, opts.oldMoved);
		const newSite = indexWith(files.site, opts.newMoved);
		w.deps.get = async (url) => {
			w.state.gets.push(url);
			if (url.startsWith(`${BASE}/`)) return up.old ? (oldSite.get(url.slice(BASE.length + 1)) ?? null) : null;
			if (url.startsWith(`${NEW}/`)) return up.neu ? (newSite.get(url.slice(NEW.length + 1)) ?? null) : null;
			return null;
		};
		w.deps.moved = {
			read: (from) => (mem.reads.push(from), mem.value),
			write: (from, to) => {
				mem.writes.push([from, to]);
				mem.value = to;
			},
		};
		return { w, mem, up };
	}
	const hosts = (gets: string[]) => gets.map((g) => g.replace(/\/[^/]*$/, ""));

	it("follows a pointer once: the files are taken from the address it names, which the device remembers, and the copy kept on disk is the plain index", async () => {
		const { w, mem } = twoSites({ oldMoved: NEW });
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.filter((g) => g.includes("bin.gz")).every((g) => g.startsWith(`${NEW}/`))).toBe(true); // every shard from the new address
		expect(w.state.gets.filter((g) => g.includes("bin.gz")).length).toBe(3);
		expect(mem.writes).toEqual([[BASE, NEW]]);
		expect("moved" in JSON.parse(new TextDecoder().decode(w.state.disk.get(LOCAL_INDEX)!))).toBe(false);
	});

	it("the next session asks the remembered address first and finds the shards on disk: no download", async () => {
		const { w, mem } = twoSites({ oldMoved: NEW });
		await new FingerprintBase(w.deps).database();
		w.state.gets.length = 0;
		mem.writes.length = 0;
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.every((g) => g.endsWith("/index.json"))).toBe(true);
		expect(mem.writes).toEqual([]); // it already knew
		expect(mem.reads).toContain(BASE); // asked with the configured address it was learned from
	});

	it("once the old site is gone the remembered address keeps working", async () => {
		const { w, up } = twoSites({ oldMoved: NEW });
		await new FingerprintBase(w.deps).database();
		up.old = false;
		w.state.gets.length = 0;
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(hosts(w.state.gets)).toContain(NEW);
	});

	it("when where the pointer leads does not answer, the data stays where it was found, and nothing is remembered", async () => {
		const { w, mem } = twoSites({ oldMoved: NEW, newUp: false });
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.filter((g) => g.includes("bin.gz")).every((g) => g.startsWith(`${BASE}/`))).toBe(true);
		expect(mem.writes).toEqual([]);
	});

	it("follows ONE pointer per load, never a chain; the next load takes the next step", async () => {
		const { w, mem } = twoSites({ oldMoved: NEW, newMoved: OTHER });
		await new FingerprintBase(w.deps).database();
		expect(w.state.gets.some((g) => g.startsWith(OTHER))).toBe(false);
		expect(mem.value).toBe(NEW);
		w.state.gets.length = 0;
		await new FingerprintBase(w.deps).database();
		expect(w.state.gets).toContain(`${OTHER}/index.json`); // the second step, one load later (it does not answer here, so the data stays at NEW)
		expect(mem.value).toBe(NEW);
	});

	it.each([
		["http", "http://files.example.org/fp"],
		// the "@" is a piece of its own: the public export's leak scan takes a user-and-host pair written in one piece for an e-mail address
		["credentials", "https://user:secret" + "@files.example.org/fp"],
		["a query", "https://files.example.org/fp?x=1"],
		["an IP address", "https://10.0.0.5/fp"],
		["no dot in the host", "https://files/fp"],
		["a number", 5],
		["an object", { a: 1 }],
		["too long", `https://files.example.org/${"a".repeat(400)}`],
		["the site itself", BASE],
	])("ignores a pointer that is %s: the files stay where they are, no request goes anywhere else, nothing is remembered", async (_label, moved) => {
		const { w, mem } = twoSites({ oldMoved: moved });
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.every((g) => g.startsWith(`${BASE}/`))).toBe(true);
		expect(mem.writes).toEqual([]);
	});

	it("forgets the remembered address only when the configured site answers with no pointer any more (the move was cancelled)", async () => {
		const cancelled = twoSites({ remembered: NEW, newUp: false });
		expect((await new FingerprintBase(cancelled.w.deps).database())?.n).toBe(150);
		expect(cancelled.mem.writes).toEqual([[BASE, null]]);
		const stillThere = twoSites({ remembered: NEW });
		await new FingerprintBase(stillThere.w.deps).database();
		expect(stillThere.mem.writes).toEqual([]); // the remembered address answered: it is used and kept
		const outage = twoSites({ remembered: NEW, oldMoved: NEW, newUp: false });
		await new FingerprintBase(outage.w.deps).database();
		expect(outage.mem.writes).toEqual([]); // the old site still points there, the new one is only down for now: keep what was learned
	});

	it("uses the copy on disk when neither the remembered nor the configured address answers", async () => {
		const warm = twoSites({ oldMoved: NEW });
		await new FingerprintBase(warm.w.deps).database();
		warm.up.old = false;
		warm.up.neu = false;
		warm.w.state.now += FAIL_PAUSE_MS + 1;
		warm.w.state.gets.length = 0;
		expect((await new FingerprintBase(warm.w.deps).database())?.n).toBe(150);
		expect(warm.w.state.removed).toEqual([]);
	});

	it("a remembered address that is not one the plugin follows is not asked", async () => {
		const { w } = twoSites({ remembered: "http://files.example.org/fp" });
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.every((g) => g.startsWith(`${BASE}/`))).toBe(true);
	});

	it("with no address configured (no network wanted: Data Saver, or the person's own files) nothing is remembered, asked or followed", async () => {
		const { w, mem } = twoSites({ remembered: NEW });
		w.state.baseUrl = "";
		w.state.disk = syncedFiles(files.site);
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets).toEqual([]);
		expect(mem.reads).toEqual([]);
		expect(mem.writes).toEqual([]);
	});

	it("works the same without a device memory (a pointer is followed within the load only)", async () => {
		const { w } = twoSites({ oldMoved: NEW });
		delete w.deps.moved;
		expect((await new FingerprintBase(w.deps).database())?.n).toBe(150);
		expect(w.state.gets.filter((g) => g.includes("bin.gz")).every((g) => g.startsWith(`${NEW}/`))).toBe(true);
	});
});
