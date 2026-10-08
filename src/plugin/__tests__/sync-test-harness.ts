import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../core/data-model";
import { CORE_SHARD, assembleShards, isShardFileName, shardFileName } from "../../core/github-shards";
import {
	readSettingsFromDisk,
	markSettingsLoaded,
	persistSettings,
	checkForExternalChange,
	onExternalSettingsChange,
	loadDeviceLocalSettings,
	saveDeviceLocalSettings,
	changeDataFolder,
} from "../settings-sync";
import {
	createGithubState,
	getGithubToken,
	setGithubToken,
	githubSync,
	markGithubDirty,
	flushGithubSync,
	resetGithubSync,
	githubTestNow,
	subscribeGithubStatus,
	githubHomeStatus,
	setupGithubSync,
} from "../github-sync";

// Common tools for the synchronization tests (settings-sync.test.ts, github-sync.test.ts).
// This file is only imported by tests: never bundled into main.js. The
// `vi.mock("obsidian")` calls stay in each test file (vitest hoists them per file). The
// plugin's functions take `this` as a parameter (see CLAUDE.md, Phase 5): a minimal fake
// plugin is enough, two fake devices share the SAME logic but each have their own file
// system and their own local storage; "Syncthing" is simulated by copying data.json (mtime
// preserved) from one to the other.

export type Obj = Record<string, any>;
export const DIR = ".obsidian/plugins/mtg";
export const DATA = `${DIR}/data.json`;

/* ------------------------------ fake file system ------------------ */

export class FakeFs {
	files = new Map<string, { text: string; mtime: number }>();
	dirs = new Set<string>();
	reads = 0;
	dataWrites = 0;
	// "Deleted" directories: writing into them fails until they've been re-created (mkdir).
	missingDirs = new Set<string>();
	// Called right after every write of data.json: serves to simulate another
	// process rewriting the file in the tiny write→stat window.
	afterWrite: ((path: string) => void) | null = null;
	adapter = {
		exists: async (p: string) => this.files.has(p) || this.dirs.has(p),
		read: async (p: string) => {
			this.reads++;
			const f = this.files.get(p);
			if (!f) throw new Error("ENOENT");
			return f.text;
		},
		write: async (p: string, data: string, opts?: { mtime?: number }) => {
			if (p === DATA) this.dataWrites++;
			if (this.missingDirs.has(p.slice(0, p.lastIndexOf("/")))) throw new Error("ENOENT");
			this.files.set(p, { text: data, mtime: opts?.mtime ?? Date.now() });
			this.afterWrite?.(p);
		},
		stat: async (p: string) => {
			const f = this.files.get(p);
			return f ? { type: "file", ctime: f.mtime, mtime: f.mtime, size: f.text.length } : null;
		},
		mkdir: async (p: string) => {
			this.dirs.add(p);
			this.missingDirs.delete(p);
		},
		list: async (dir: string) => ({
			files: [...this.files.keys()].filter((k) => k.startsWith(`${dir}/`)),
			folders: [],
		}),
		remove: async (p: string) => {
			this.files.delete(p);
		},
	};
	data() {
		return this.files.get(DATA);
	}
	backups(kind: string) {
		return [...this.files.keys()].filter((k) => k.startsWith(`${DIR}/sync-backups/data-${kind}-`));
	}
}

// Syncthing: copies the file while preserving its mtime. The most recent wins
// (like conflict resolution); returns true if the file was replaced.
export function deliver(from: FakeFs, to: FakeFs): boolean {
	const f = from.data();
	if (!f) return false;
	const t = to.data();
	if (t && t.mtime >= f.mtime) return false;
	to.files.set(DATA, { text: f.text, mtime: f.mtime });
	return true;
}

/* -------------------------------- faux appareil --------------------------- */

export function makeDevice(fs: FakeFs) {
	// The device's local storage (app.loadLocalStorage / saveLocalStorage): never shared.
	const store = new Map<string, unknown>();
	const dev: Obj = {
		manifest: { dir: DIR },
		app: {
			vault: { adapter: fs.adapter },
			loadLocalStorage: (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null),
			saveLocalStorage: (k: string, v: unknown) => void store.set(k, structuredClone(v)),
		},
		store,
		lastDeviceLocal: null,
		dataFolderInUse: "",
		settings: null,
		diskText: null,
		syncBaseText: null,
		diskSig: null,
		knownKeys: null,
		knownScalars: null,
		knownPrints: null,
		persistChain: Promise.resolve(),
		externalCheckQueued: false,
		mergeWrites: [] as number[],
		settingsLoaded: false,
		saveFailed: false,
		saveRetryTimer: null,
		dataVersion: 0,
		cachedArtists: null,
		cachedSets: null,
		refreshOpenViews: vi.fn(),
		loadData: async () => null,
		saveData: vi.fn(),
		github: createGithubState(),
	};
	const fns = {
		readSettingsFromDisk,
		markSettingsLoaded,
		persistSettings,
		checkForExternalChange,
		onExternalSettingsChange,
		loadDeviceLocalSettings,
		saveDeviceLocalSettings,
		changeDataFolder,
		getGithubToken,
		setGithubToken,
		githubSync,
		markGithubDirty,
		flushGithubSync,
		resetGithubSync,
		githubTestNow,
		subscribeGithubStatus,
		githubHomeStatus,
		setupGithubSync,
	};
	for (const [k, fn] of Object.entries(fns)) dev[k] = (fn as (...a: any[]) => any).bind(dev);
	dev.fs = fs;
	created.push(dev);
	return dev;
}

// Equivalent of loadSettings() (lifecycle.ts) without the migrations.
export async function boot(dev: Obj) {
	const loaded = await dev.readSettingsFromDisk();
	dev.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), loaded);
	dev.loadDeviceLocalSettings();
	dev.markSettingsLoaded();
}

export const card = (id: string, extra: Obj = {}): Obj => ({
	id,
	name: `Card ${id}`,
	count: 1,
	condition: "NM",
	priceUsd: "1.00",
	dateAdded: 100,
	dateModified: 100,
	...extra,
});

export const deckCard = (scryfallId: string, extra: Obj = {}): Obj => ({
	scryfallId,
	name: `DC ${scryfallId}`,
	count: 1,
	dateAdded: 100,
	dateModified: 100,
	...extra,
});

export const ids = (dev: Obj) => dev.settings.collection.map((c: Obj) => c.id).sort();

export const setNow = (t: number) => vi.setSystemTime(t);

// A ready device, started on a copy of the `seed` file (or empty).
export async function deviceWith(seed?: { text: string; mtime: number }) {
	const fs = new FakeFs();
	if (seed) fs.files.set(DATA, { ...seed });
	const dev = makeDevice(fs);
	await boot(dev);
	return dev;
}

// A device that has already written `cards`, and its file.
export async function seededDevice(cards: Obj[], t = 1000) {
	setNow(t);
	const dev = await deviceWith();
	dev.settings.collection = cards;
	await dev.persistSettings();
	return dev;
}

export async function cloneDevice(src: Obj) {
	return deviceWith(src.fs.data());
}


// A device's real queues and timers must not outlive its test.
const created: Obj[] = [];
export function disposeDevices() {
	for (const d of created) {
		if (d.github.pushTimer !== null) window.clearTimeout(d.github.pushTimer);
		if (d.saveRetryTimer !== null) window.clearTimeout(d.saveRetryTimer);
	}
	created.length = 0;
}

/* --------------------------------- faux GitHub ------------------------------ */

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

// Imitates the Contents API rules the plugin depends on: authentication, raw read with ETag /
// If-None-Match (304), 404 for a missing file, write with compare-and-swap on the git blob `sha`
// (409 if stale, 422 if missing while the file exists) and network failure. `beforePut` lets
// another device's write be injected just before the sha check.
export class FakeGithub {
	repo = "louis/mtg-data";
	branch = "main";
	token = "github_pat_test";
	files = new Map<string, { bytes: Buffer; sha: string; etag: string }>();
	/** "GET 200", "GET 304", "PUT 201", "PUT 409"… in order. */
	calls: string[] = [];
	offline = false;
	isPrivate = true;
	canPush = true;
	forcedStatus: number | null = null;
	/** Downloads of the file itself / listings of its folder (the lightweight polling). */
	rawGets = 0;
	/** Paths downloaded (raw reading), in order. */
	rawPaths: string[] = [];
	listings = 0;
	/** Paths written (successful or refused PUTs), in order: the order of the shards matters (the common one last). */
	putPaths: string[] = [];
	/** Simulates an unusable folder listing: "object" = not an array, or an HTTP status. */
	listingFault: "object" | number | null = null;
	beforePut: ((path: string) => void) | null = null;
	private counter = 0;

	static sha(bytes: Buffer): string {
		return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
	}

	// A .gz path is stored compressed (as the plugin does), any other as is.
	setFile(path: string, text: string) {
		this.setRaw(path, path.endsWith(".gz") ? gzipSync(Buffer.from(text, "utf8")) : Buffer.from(text, "utf8"));
	}

	setRaw(path: string, bytes: Buffer) {
		this.files.set(path, { bytes, sha: FakeGithub.sha(bytes), etag: `W/"${++this.counter}"` });
	}

	text(path: string): string | null {
		const f = this.files.get(path);
		if (!f) return null;
		return path.endsWith(".gz") ? gunzipSync(f.bytes).toString("utf8") : f.bytes.toString("utf8");
	}

	count(prefix: string): number {
		return this.calls.filter((c) => c.startsWith(prefix)).length;
	}

	private reply(status: number, json: unknown = {}, headers: Record<string, string> = {}, raw?: Buffer) {
		const bytes = raw ?? Buffer.from(JSON.stringify(json));
		const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		return { status, headers, json, text: bytes.toString("utf8"), arrayBuffer: ab };
	}

	request = async (p: { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }) => {
		if (this.offline) throw new Error("net::ERR_INTERNET_DISCONNECTED");
		const method = p.method ?? "GET";
		const url = new URL(p.url);
		const log = (status: number) => this.calls.push(`${method} ${status}`);
		const done = (status: number, json?: unknown, headers?: Record<string, string>, raw?: Buffer) => {
			log(status);
			return this.reply(status, json, headers, raw);
		};
		if (this.forcedStatus !== null) return done(this.forcedStatus, { message: "forced" });
		if (p.headers?.Authorization !== `Bearer ${this.token}`) return done(401, { message: "Bad credentials" });
		if (url.pathname === "/user") return done(200, { login: "louis" });
		const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
		if (!m || `${m[1]}/${m[2]}` !== this.repo) return done(404, { message: "Not Found" });
		const rest = m[3];
		if (!rest) return done(200, { private: this.isPrivate, permissions: { push: this.canPush } });
		if (rest.startsWith("/branches/")) {
			return rest === `/branches/${this.branch}` ? done(200, { name: this.branch }) : done(404, { message: "Branch not found" });
		}
		if (rest !== "/contents" && !rest.startsWith("/contents/")) return done(404, { message: "Not Found" });
		const path =
			rest === "/contents"
				? ""
				: rest
						.slice("/contents/".length)
						.split("/")
						.map(decodeURIComponent)
						.join("/");
		if (method === "GET") {
			if (url.searchParams.get("ref") !== this.branch) return done(404, { message: "No commit found for the provided ref." });
			const f = this.files.get(path);
			if (!f) {
				// Not a file: the listing of a folder (small response, whatever the size of the files).
				const dir = path.replace(/\/+$/, "");
				const children = [...this.files].filter(([fp]) => fp.slice(0, Math.max(0, fp.lastIndexOf("/"))) === dir);
				if (children.length === 0) return done(404, { message: "Not Found" });
				if (typeof this.listingFault === "number") return done(this.listingFault, { message: "Unprocessable" });
				const listing = children.map(([fp, file]) => ({ name: fp.split("/").pop(), path: fp, type: "file", sha: file.sha, size: file.bytes.length }));
				const etag = `W/"L${createHash("sha1").update(listing.map((e) => e.sha).join(",")).digest("hex")}"`;
				if (p.headers?.["If-None-Match"] === etag) return done(304, {}, { etag });
				this.listings++;
				return done(200, this.listingFault === "object" ? { entries: listing } : listing, { etag });
			}
			if (p.headers?.["If-None-Match"] === f.etag) return done(304, {}, { etag: f.etag });
			this.rawGets++;
			this.rawPaths.push(path);
			return done(200, {}, { etag: f.etag }, f.bytes);
		}
		if (method === "PUT") {
			const body = JSON.parse(String(p.body)) as { content: string; sha?: string; branch?: string };
			this.putPaths.push(path);
			if (body.branch !== this.branch) return done(404, { message: "Branch not found" });
			this.beforePut?.(path);
			this.beforePut = null;
			const existing = this.files.get(path);
			if (existing && !body.sha) return done(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
			if (existing && body.sha !== existing.sha) return done(409, { message: `${path} does not match ${existing.sha}` });
			if (!existing && body.sha) return done(422, { message: 'Invalid request.\n\n"sha" is not needed for a new file.' });
			const bytes = Buffer.from(body.content, "base64");
			const sha = FakeGithub.sha(bytes);
			this.files.set(path, { bytes, sha, etag: `W/"${++this.counter}"` });
			return done(existing ? 200 : 201, { content: { sha } });
		}
		return done(404, { message: "Not Found" });
	};
}

type CachedRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer };

// Imitates Chromium's HTTP cache, which Obsidian desktop's requests go through (`requestUrl` = Electron's
// `net.request`, default session): GitHub answers `Cache-Control: private, max-age=60`, so a 200 response
// already received is SERVED AGAIN for 60 s without querying the server — even if the caller adds its own
// If-None-Match (Chromium only treats If-Unmodified-Since / If-Match / If-Range as "bypass"). Only a
// `Cache-Control: no-cache` (or another URL) forces the request. A 304 received refreshes the entry. To be
// plugged into ONE device's turn (each machine has its own cache):
//   gh.request = cache.wrap(real); await dev.githubSync(...); gh.request = real;
export class HttpCache {
	private entries = new Map<string, { at: number; res: { status: number } }>();
	/** Responses served again without touching the server. */
	served = 0;

	constructor(private maxAgeMs = 60_000) {}

	wrap<R extends { status: number }>(next: (p: CachedRequest) => Promise<R>): (p: CachedRequest) => Promise<R> {
		return async (p) => {
			if ((p.method ?? "GET") !== "GET") return next(p);
			const h = Object.fromEntries(Object.entries(p.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
			const bypass = /no-cache/i.test(h["cache-control"] ?? "") || /no-cache/i.test(h["pragma"] ?? "");
			const key = `${p.url}|${h["authorization"] ?? ""}`;
			const hit = this.entries.get(key);
			if (!bypass && hit && Date.now() - hit.at < this.maxAgeMs) {
				this.served++;
				return hit.res as R;
			}
			const res = await next(p);
			if (res.status === 200) this.entries.set(key, { at: Date.now(), res });
			else if (res.status === 304 && hit) hit.at = Date.now();
			return res;
		};
	}
}

// Configures a fake device to synchronize through `gh` (token in its storage, settings specific to it).
export function enableGithub(dev: Obj, gh: FakeGithub, overrides: Partial<Record<string, unknown>> = {}) {
	dev.settings.githubSyncEnabled = true;
	dev.settings.githubRepo = gh.repo;
	dev.settings.githubBranch = gh.branch;
	dev.settings.githubPath = "mtg-collection";
	Object.assign(dev.settings, overrides);
	dev.setGithubToken(gh.token);
}

// The fake repository's data folder (githubPath = "mtg-collection", see enableGithub).
export const GH_DIR = "mtg-collection";
export const GH_CORE = `${GH_DIR}/${CORE_SHARD}`;
// The old single files: data.json.gz (1.0.507 to 1.0.511), data.json (≤ 1.0.506).
export const GH_FILE = `${GH_DIR}/data.json.gz`;
export const GH_LEGACY_FILE = `${GH_DIR}/data.json`;

// Path of a shard in the fake repository.
export const ghShard = (kind: "list" | "wantlist" | "deck", id: string) => `${GH_DIR}/${shardFileName(kind, id)}`;

// The complete state the fake repository holds: all the shards recomposed (what a new device would see).
export function ghState(gh: FakeGithub): Obj {
	const shards = new Map<string, Obj>();
	for (const path of gh.files.keys()) {
		if (!path.startsWith(`${GH_DIR}/`)) continue;
		const name = path.slice(GH_DIR.length + 1);
		if (isShardFileName(name)) shards.set(name, JSON.parse(gh.text(path)!));
	}
	return assembleShards(shards);
}

// The shards present (file names, sorted).
export function ghShardNames(gh: FakeGithub): string[] {
	return [...gh.files.keys()]
		.filter((p) => p.startsWith(`${GH_DIR}/`) && isShardFileName(p.slice(GH_DIR.length + 1)))
		.map((p) => p.slice(GH_DIR.length + 1))
		.sort();
}
