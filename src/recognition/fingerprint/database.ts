// The downloaded base of fingerprints (one row per illustration of Scryfall's "Unique Artwork" file) and the scan that finds a photo's card in it. Pure: typed arrays, no network, no DOM.
// PRIVATE like the rest of src/recognition/ (docs/history/card-recognition-fingerprint-plan.md).
//
// What the base holds is identifiers and vectors only, never Scryfall's names, sets or pictures: a row is an `illustration_id` (16 bytes) and the three descriptors of descriptors.ts quantised
// to 4 bits; the cards themselves are asked from Scryfall when the person looks at the result (api/scryfall.ts).
//
// Files (everything is gzipped on the site; the plugin gunzips with a size limit): `index.json` = { v: 1, date, n, m, shards } where `m` is the half range of each descriptor's quantisation (a
// value x is stored as round((x + m) / 2m * 15), 0..15) and each shard is a run of rows `{ file, rows, sha256 }`. A shard, once gunzipped, is `rows * 16` bytes of ids, then one block per
// descriptor in the order hog, tinylum, dct: `rows * dim` 4-bit values, row after row, two to a byte, the LOW nibble first, each block padded to a whole byte.
//
// The scan is the one measured on the real phone (docs/history/card-recognition-spike.md): the photo's card is straightened under two alignment hypotheses and described in both orientations
// (4 candidates), the gradient histogram is compared with EVERY row, the 300 nearest are kept, and those are ranked by the sum of z-scores of the three descriptors (the statistics of each taken on
// a fixed sample of 3 000 rows). A lower score is a closer card. Never "sure": it answers the best few, the caller shows them for the person to choose from.

import { findCard, type Quad } from "../card-finder";
import { downscaleRgba, FINDER_WIDTH, isCardEdge, type Photo } from "../scan";
import { DESCRIPTORS, DESCRIPTOR_DIMS, describeBothWays, type DescriptorName } from "./descriptors";
import { warpCard } from "./warp";

export const INDEX_VERSION = 1;
const ID_BYTES = 16;

export interface ShardInfo {
	file: string;
	rows: number;
	sha256: string;
}
export interface FingerprintIndex {
	v: number;
	date: string;
	n: number;
	m: Record<DescriptorName, number>;
	shards: ShardInfo[];
}

/**
 * The index read from the site, or null when it is not what this plugin reads. Strict on purpose: a shard's file name is appended to the site's address, so it is a bare name (no slash, no
 * dots that climb), and the sizes are bounded.
 */
export function parseIndex(json: unknown): FingerprintIndex | null {
	if (typeof json !== "object" || json === null) return null;
	const o = json as Record<string, unknown>;
	if (o.v !== INDEX_VERSION || typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return null;
	if (typeof o.n !== "number" || !Number.isInteger(o.n) || o.n < 1 || o.n > 200_000) return null;
	const m = o.m as Record<string, unknown> | null;
	if (typeof m !== "object" || m === null) return null;
	const ranges = {} as Record<DescriptorName, number>;
	for (const name of DESCRIPTORS) {
		const x = m[name];
		if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > 1000) return null;
		ranges[name] = x;
	}
	if (!Array.isArray(o.shards) || o.shards.length < 1 || o.shards.length > 200) return null;
	const shards: ShardInfo[] = [];
	let rows = 0;
	for (const s of o.shards as unknown[]) {
		if (typeof s !== "object" || s === null) return null;
		const { file, rows: r, sha256 } = s as Record<string, unknown>;
		if (typeof file !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(file) || file.includes("..")) return null;
		if (typeof r !== "number" || !Number.isInteger(r) || r < 1 || r > 50_000) return null;
		if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
		shards.push({ file, rows: r, sha256 });
		rows += r;
	}
	if (rows !== o.n) return null;
	return { v: INDEX_VERSION, date: o.date, n: o.n, m: ranges, shards };
}

/**
 * The address an index asks the plugin to move to (its optional `moved` field), or null when there is none or it is not an address this plugin follows. THE ONE PLACE a file downloaded from the site
 * chooses where the plugin sends its requests, so it is strict (the same rules as the price history's `site.json`): https only, no credentials, query or fragment, a named host with a dot (no IP, no
 * port-less name like `localhost`), at most 300 characters; the answer is the canonical form without a trailing slash, so what is stored and compared never depends on how it was written. The data job
 * checks the value it writes with this very function (tools/fingerprint-data), and an older plugin simply ignores the field.
 */
export function parseMovedAddress(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 300 || value !== value.trim()) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
	if (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) return null;
	return (url.origin + url.pathname).replace(/\/+$/, "");
}

/** The `moved` field of an index as the site wrote it (the raw JSON, which `parseIndex` does not keep), or null. */
export function indexMoved(json: unknown): string | null {
	return typeof json === "object" && json !== null ? parseMovedAddress((json as Record<string, unknown>).moved) : null;
}

/** The base in memory: one byte per 4-bit value (a lookup stays a plain subtraction), and the ids. */
export interface FingerprintDb {
	n: number;
	/** `n * 16` bytes: each row's `illustration_id` */
	ids: Uint8Array;
	values: Record<DescriptorName, Uint8Array>;
	m: Record<DescriptorName, number>;
}

/** The size in bytes a gunzipped shard of `rows` rows must have. */
export function shardSize(rows: number): number {
	let size = rows * ID_BYTES;
	for (const name of DESCRIPTORS) size += Math.ceil((rows * DESCRIPTOR_DIMS[name]) / 2);
	return size;
}

/** A gunzipped shard unpacked, or null when its length is not exactly what `rows` rows take. */
export function unpackShard(raw: Uint8Array, rows: number): { ids: Uint8Array; values: Record<DescriptorName, Uint8Array> } | null {
	if (raw.length !== shardSize(rows)) return null;
	const ids = raw.slice(0, rows * ID_BYTES);
	let off = rows * ID_BYTES;
	const values = {} as Record<DescriptorName, Uint8Array>;
	for (const name of DESCRIPTORS) {
		const count = rows * DESCRIPTOR_DIMS[name];
		const out = new Uint8Array(count);
		for (let j = 0; j < count; j++) out[j] = j & 1 ? raw[off + (j >> 1)] >> 4 : raw[off + (j >> 1)] & 15;
		values[name] = out;
		off += Math.ceil(count / 2);
	}
	return { ids, values };
}

/** Puts shards together one at a time, so a loader never holds every shard's bytes and the whole base at once. */
export class DbBuilder {
	private readonly ids: Uint8Array;
	private readonly values = {} as Record<DescriptorName, Uint8Array>;
	private readonly offsets: number[] = [];
	private readonly added: boolean[];

	constructor(private readonly index: FingerprintIndex) {
		this.ids = new Uint8Array(index.n * ID_BYTES);
		for (const name of DESCRIPTORS) this.values[name] = new Uint8Array(index.n * DESCRIPTOR_DIMS[name]);
		let row = 0;
		for (const shard of index.shards) {
			this.offsets.push(row);
			row += shard.rows;
		}
		this.added = index.shards.map(() => false);
	}

	/** Adds the gunzipped shard number `shard` of the index; false (and nothing kept) when it does not fit. */
	add(shard: number, raw: Uint8Array): boolean {
		const info = this.index.shards[shard];
		if (!info) return false;
		const part = unpackShard(raw, info.rows);
		if (!part) return false;
		this.ids.set(part.ids, this.offsets[shard] * ID_BYTES);
		for (const name of DESCRIPTORS) this.values[name].set(part.values[name], this.offsets[shard] * DESCRIPTOR_DIMS[name]);
		this.added[shard] = true;
		return true;
	}

	/** The base, or null while a shard is missing. */
	finish(): FingerprintDb | null {
		return this.added.every(Boolean) ? { n: this.index.n, ids: this.ids, values: this.values, m: this.index.m } : null;
	}
}

/** The whole base from its index and the gunzipped shards, in the index's order; null when one of them does not fit. */
export function assembleDb(index: FingerprintIndex, shards: readonly Uint8Array[]): FingerprintDb | null {
	if (shards.length !== index.shards.length) return null;
	const builder = new DbBuilder(index);
	for (let s = 0; s < shards.length; s++) if (!builder.add(s, shards[s])) return null;
	return builder.finish();
}

/** A row's `illustration_id` as Scryfall writes it (8-4-4-4-12 lower-case hex). */
export function idOf(db: FingerprintDb, row: number): string {
	let hex = "";
	for (let i = 0; i < ID_BYTES; i++) hex += db.ids[row * ID_BYTES + i].toString(16).padStart(2, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The card in a photo (the finder on a 360 px copy, the quad scaled back up), or null when there is none. `outer` is the finder's polarity: the quad is the card's own edge, which decides where
 * the corner's text sits in it (scan.ts `isCardEdge`); the descriptors do not care.
 */
export function findCardOf(photo: Photo): { quad: Quad; outer: boolean } | null {
	const small = downscaleRgba(photo, FINDER_WIDTH);
	const found = findCard(small.rgba, small.w, small.h);
	if (!found || !found.quad) return null;
	const k = photo.w / small.w;
	return { quad: found.quad.map(([x, y]): [number, number] => [x * k, y * k]) as Quad, outer: isCardEdge(found) };
}

/** The quad of the card in a photo, or null when there is none. */
export function findQuad(photo: Photo): Quad | null {
	return findCardOf(photo)?.quad ?? null;
}

export interface Match {
	row: number;
	/** the illustration's id */
	id: string;
	/** sum of the z-scores of the three descriptors: lower is closer. On the 38 real photos the right card scored -24 to -12 and the best OTHER card -12 to -7.5 (docs/history): no threshold is trusted yet */
	score: number;
}
export interface IdentifyOptions {
	/** alignment hypotheses: the card's edge as found, and 4 % further out (a frame found inside the black border) */
	expands?: readonly number[];
	/** how many rows the first stage keeps for the second */
	keep?: number;
	/** how many rows the z-scores' statistics are taken on */
	sample?: number;
	/** how many matches are answered */
	top?: number;
}
export const DEFAULT_EXPANDS: readonly number[] = [0, 0.04];
export const KEEP_ROWS = 300;
export const SAMPLE_ROWS = 3000;

// distance, in 4-bit steps, of the smallest query (over the candidates) to the given rows (null: every row)
function distances(db: FingerprintDb, name: DescriptorName, queries: readonly Float32Array[], rows: Int32Array | null): Float32Array {
	const dim = DESCRIPTOR_DIMS[name];
	const data = db.values[name];
	const n = rows ? rows.length : db.n;
	const out = new Float32Array(n).fill(Infinity);
	for (const q of queries) {
		for (let r = 0; r < n; r++) {
			const o = (rows ? rows[r] : r) * dim;
			let s = 0;
			for (let j = 0; j < dim; j++) {
				const e = q[j] - data[o + j];
				s += e * e;
			}
			if (s < out[r]) out[r] = s;
		}
	}
	for (let r = 0; r < n; r++) out[r] = Math.sqrt(out[r]);
	return out;
}

/**
 * The cards of the base that look most like the card inside `quad` in the photo, best first (at most `top`, 3 by default). The base may hold fewer rows than the stages ask for; an empty base answers nothing.
 */
export function identifyCard(photo: Photo, quad: Quad, db: FingerprintDb, opts: IdentifyOptions = {}): Match[] {
	if (db.n === 0) return [];
	const keep = Math.min(opts.keep ?? KEEP_ROWS, db.n);
	const sampleSize = Math.min(opts.sample ?? SAMPLE_ROWS, db.n);
	// the query, in the base's own units: the 3 descriptors of the card in both orientations under every alignment hypothesis
	const queries: Record<DescriptorName, Float32Array[]> = { hog: [], tinylum: [], dct: [] };
	for (const expand of opts.expands ?? DEFAULT_EXPANDS) {
		for (const d of describeBothWays(warpCard(photo, quad, expand)))
			for (const name of DESCRIPTORS) {
				const m = db.m[name];
				queries[name].push(Float32Array.from(d[name], (v) => ((v + m) / (2 * m)) * 15));
			}
	}
	// stage 1: the gradient histogram against every row; keep the nearest
	const first = distances(db, "hog", queries.hog, null);
	const threshold = Float32Array.from(first).sort()[keep - 1];
	const rows: number[] = [];
	for (let i = 0; i < db.n && rows.length < keep; i++) if (first[i] <= threshold) rows.push(i);
	const kept = Int32Array.from(rows);
	// stage 2: the fused score on those rows
	const sample = Int32Array.from({ length: sampleSize }, (_, i) => Math.floor((i * db.n) / sampleSize));
	const fused = new Float32Array(kept.length);
	for (const name of DESCRIPTORS) {
		const ds = distances(db, name, queries[name], sample);
		let mean = 0;
		for (const x of ds) mean += x;
		mean /= ds.length;
		let sd = 0;
		for (const x of ds) sd += (x - mean) ** 2;
		sd = Math.sqrt(sd / ds.length) || 1;
		const dk = distances(db, name, queries[name], kept);
		for (let r = 0; r < kept.length; r++) fused[r] += (dk[r] - mean) / sd;
	}
	const order = Array.from(fused.keys()).sort((a, b) => fused[a] - fused[b]);
	return order.slice(0, opts.top ?? 3).map((r): Match => ({ row: kept[r], id: idOf(db, kept[r]), score: fused[r] }));
}

/** The photo's card in the base: finds the card, then `identifyCard`. Null when the finder sees no card. */
export function identifyPhoto(photo: Photo, db: FingerprintDb, opts: IdentifyOptions = {}): Match[] | null {
	const quad = findQuad(photo);
	return quad ? identifyCard(photo, quad, db, opts) : null;
}
