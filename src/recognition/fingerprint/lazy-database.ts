// The base of fingerprints as the plugin holds it: downloaded ONCE (a few shards of ~1.3 MB, kept in the plugin's private folder), read from there afterwards, kept in memory while a window that
// scans is open and for a minute after, then let go. With NO address it is only ever read from the files already in that folder (put there by the person's own sync, nothing is downloaded and
// nothing is deleted); with none there either, there is no base and the caller reads the title instead. Nothing is loaded at startup and nothing is shown to the person but a progress line in the scan panel. PRIVATE like the rest of
// src/recognition/; with no address it only reads the files already in the plugin's folder (config.ts). Obsidian is not imported here: the plugin hands in its own file access and requests (src/recognition/ui/fingerprint-base.ts).
//
// Rules this keeps (docs/history/card-recognition-fingerprint-plan.md): a body of more than a few MB never goes through `requestUrl` on a phone, hence shards; a shard is trusted only when its
// SHA-256 is the index's; a download that fails or does not fit answers null and is not tried again for a while; nothing here ever throws, and a base that is not there simply means the caller
// reads the title instead.

import { DbBuilder, indexMoved, parseIndex, parseMovedAddress, shardSize, type FingerprintDb, type FingerprintIndex } from "./database";

export interface BaseFiles {
	read(name: string): Promise<Uint8Array | null>;
	write(name: string, bytes: Uint8Array): Promise<void>;
	remove(name: string): Promise<void>;
	/** the names of the files this base keeps (every one starts with FILE_PREFIX) */
	list(): Promise<string[]>;
}
export interface BaseDeps {
	/** the address the files are under; "" = the feature is off */
	baseUrl: () => string;
	/** a binary GET; null on any failure */
	get: (url: string) => Promise<Uint8Array | null>;
	files: BaseFiles;
	sha256: (bytes: Uint8Array) => Promise<string>;
	gunzip: (bytes: Uint8Array, maxBytes: number) => Promise<Uint8Array>;
	now?: () => number;
	/** how long the base stays in memory after the last use */
	idleMs?: number;
	/** how long the site's index is waited for before the copy on disk is used */
	indexTimeoutMs?: number;
	/**
	 * Where this device was sent to by a `moved` pointer in the site's index, kept on the device and tied to the address it was learned FROM (`from`, the configured one): another configured address
	 * (a newer plugin) finds nothing. `write(from, null)` forgets it. Absent: a pointer is followed in this load only.
	 */
	moved?: { read: (from: string) => string | null; write: (from: string, to: string | null) => void };
}

export const FILE_PREFIX = "fp-";
export const LOCAL_INDEX = `${FILE_PREFIX}index.json`;
/** After a failed load nothing is tried again for this long. */
export const FAIL_PAUSE_MS = 30_000;
export const IDLE_MS = 60_000;
const DOWNLOADS_AT_ONCE = 4;
const INDEX_TIMEOUT_MS = 6000;

function withTimeout<T>(promise: Promise<T>, ms: number, otherwise: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => resolve(otherwise), ms);
		promise.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			() => {
				window.clearTimeout(timer);
				resolve(otherwise);
			},
		);
	});
}

export class FingerprintBase {
	private db: FingerprintDb | null = null;
	private loading: Promise<FingerprintDb | null> | null = null;
	private failedUntil = 0;
	private idleTimer: number | null = null;
	private pinned = false;

	constructor(private readonly deps: BaseDeps) {}

	/** True when an address is set (a site to download from); with none, the base can only come from the files in the plugin's folder. */
	get configured(): boolean {
		return this.deps.baseUrl().trim() !== "";
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	/**
	 * The base: from memory, else from disk (after a look at the site's index when there is an address), else downloaded. `onProgress(done, total)` counts shards. Null when there is none (no address
	 * and no files, offline with nothing on disk, a download that failed, a shard still missing from the disk because the sync has not brought it yet): the caller then falls back. Several callers share one load.
	 */
	database(onProgress?: (done: number, total: number) => void): Promise<FingerprintDb | null> {
		if (this.db) {
			this.touch();
			return Promise.resolve(this.db);
		}
		if (this.loading) return this.loading;
		if (this.now() < this.failedUntil) return Promise.resolve(null);
		const p = this.load(onProgress).then(
			(db) => db,
			() => null,
		);
		this.loading = p;
		void p.then((db) => {
			if (this.loading === p) this.loading = null;
			if (db) {
				this.db = db;
				this.touch();
			} else if (this.configured) this.failedUntil = this.now() + FAIL_PAUSE_MS;
		});
		return p;
	}

	/** Starts loading in the background (the camera button was tapped) and keeps the base up until `unpin`. Answers whether there is a base (false: the caller warms the title reader instead). */
	prepare(): Promise<boolean> {
		this.pin();
		return this.database().then((db) => db !== null);
	}

	pin(): void {
		this.pinned = true;
		this.clearIdle();
	}

	/** The window that scans closed: the base goes after the idle time. */
	unpin(): void {
		this.pinned = false;
		if (this.db) this.touch();
	}

	/** Lets the base go now (the setting went off, the plugin unloads). Files on disk stay. */
	stop(): void {
		this.clearIdle();
		this.db = null;
		this.loading = null;
		this.pinned = false;
	}

	private clearIdle(): void {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private touch(): void {
		this.clearIdle();
		if (this.pinned) return;
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null;
			if (!this.pinned) this.db = null;
		}, this.deps.idleMs ?? IDLE_MS);
	}

	/** The index at an address, with the address it points to when it says the files moved (a pointer to itself is none). */
	private async fetchIndex(base: string): Promise<{ index: FingerprintIndex; moved: string | null } | null> {
		const bytes = await withTimeout(this.deps.get(`${base}/index.json`), this.deps.indexTimeoutMs ?? INDEX_TIMEOUT_MS, null);
		if (!bytes) return null;
		try {
			const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
			const index = parseIndex(json);
			if (!index) return null;
			const moved = indexMoved(json);
			return { index, moved: moved !== null && moved !== base ? moved : null };
		} catch {
			return null;
		}
	}

	/**
	 * Where the files are and their index: the address learned from an earlier pointer and the configured one are asked together (a move that was followed once keeps working when the old site is
	 * gone); the first that answers wins, the learned one first. A pointer in the answer is followed ONCE (a chain is walked one step per load); if where it points does not answer an index, the
	 * data stays where it was found. The learned address is forgotten only when the configured site answers with no pointer any more (the move was cancelled).
	 */
	private async locate(configured: string): Promise<{ base: string; remote: FingerprintIndex } | null> {
		const learned = this.deps.moved?.read(configured) ?? null;
		const usable = learned !== null && learned !== configured ? parseMovedAddress(learned) : null;
		const addresses = usable ? [usable, configured] : [configured];
		const answers = await Promise.all(addresses.map((a) => this.fetchIndex(a)));
		const i = answers.findIndex((a) => a !== null);
		if (i < 0) return null;
		let base = addresses[i];
		let found = answers[i]!;
		if (found.moved) {
			const next = await this.fetchIndex(found.moved);
			if (next) {
				base = found.moved;
				found = next;
			}
		}
		if (this.deps.moved) {
			if (base !== configured) {
				if (base !== usable) this.deps.moved.write(configured, base); // nothing to write when it is what the device already knew
			}
			else if (usable && !answers[i]!.moved) this.deps.moved.write(configured, null);
		}
		return { base, remote: found.index };
	}

	private async readLocalIndex(): Promise<FingerprintIndex | null> {
		try {
			const bytes = await this.deps.files.read(LOCAL_INDEX);
			return bytes ? parseIndex(JSON.parse(new TextDecoder().decode(bytes))) : null;
		} catch {
			return null;
		}
	}

	private async load(onProgress?: (done: number, total: number) => void): Promise<FingerprintDb | null> {
		const configured = this.deps.baseUrl().trim().replace(/\/+$/, "");
		// no address: only the files in the plugin's folder (the person's own sync carries them there)
		const located = configured ? await this.locate(configured) : null;
		const base = located?.base ?? configured;
		const remote = located?.remote ?? null;
		const index = remote ?? (await this.readLocalIndex());
		if (!index) return null;
		const total = index.shards.length;
		let done = 0;
		onProgress?.(0, total);
		// every shard is taken from disk when it is there and is the index's, downloaded otherwise
		const builder = new DbBuilder(index);
		const missing: number[] = [];
		for (let i = 0; i < total; i++) {
			const info = index.shards[i];
			let kept = false;
			try {
				const local = await this.deps.files.read(FILE_PREFIX + info.file);
				if (local && (await this.deps.sha256(local)) === info.sha256) kept = builder.add(i, await this.deps.gunzip(local, shardSize(info.rows) + 1));
			} catch {
				kept = false;
			}
			if (kept) onProgress?.(++done, total);
			else missing.push(i);
		}
		if (missing.length > 0 && !base) return null; // nothing to download from: a shard the sync has not brought yet is a base that is not there yet
		let next = 0;
		let failed = false;
		const worker = async (): Promise<void> => {
			while (!failed && next < missing.length) {
				const i = missing[next++];
				const info = index.shards[i];
				try {
					const bytes = await this.deps.get(`${base}/${info.file}`);
					if (!bytes || (await this.deps.sha256(bytes)) !== info.sha256) throw new Error("shard");
					if (!builder.add(i, await this.deps.gunzip(bytes, shardSize(info.rows) + 1))) throw new Error("shard");
					try {
						await this.deps.files.write(FILE_PREFIX + info.file, bytes);
					} catch {
						// not kept on disk: it will be downloaded again next time
					}
					onProgress?.(++done, total);
				} catch {
					failed = true;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, missing.length) }, worker));
		const db = failed ? null : builder.finish();
		if (!db) return null;
		// what the SITE's index says is what stays on disk: its index, its shards, nothing older. Without an answer from a site nothing is written or removed: the files may be the person's own, brought by their sync.
		try {
			if (remote) {
				await this.deps.files.write(LOCAL_INDEX, new TextEncoder().encode(JSON.stringify(remote)));
				const keep = new Set([LOCAL_INDEX, ...index.shards.map((s) => FILE_PREFIX + s.file)]);
				for (const name of await this.deps.files.list()) if (!keep.has(name)) await this.deps.files.remove(name);
			}
		} catch {
			// housekeeping only
		}
		return db;
	}
}

