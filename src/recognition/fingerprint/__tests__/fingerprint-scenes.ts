// Cards drawn in the tests (no picture in the repository): a procedural card, the straightened picture of it that goes into a test base, a "photo" of it through a perspective, and the
// writer of the base's shard format. NOT a test file: shared by the three fingerprint tests, in a __tests__ folder so that the directory's scanner skips it.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Quad } from "../../card-finder";
import { homography } from "../../strips";
import { CARD_H, CARD_W, DESCRIPTORS, DESCRIPTOR_DIMS, describeCard, type DescriptorName } from "../descriptors";
import { assembleDb, type FingerprintDb, type FingerprintIndex } from "../database";

/** A 96 x 134 RGB picture made of integers only (the same generator as the measurement kit's golden.mjs, so the golden file can be regenerated with it). */
export function syntheticCard(seed: number): Uint8Array {
	const rgb = new Uint8Array(CARD_W * CARD_H * 3);
	let s = (seed * 2654435761) >>> 0;
	for (let y = 0; y < CARD_H; y++)
		for (let x = 0; x < CARD_W; x++)
			for (let c = 0; c < 3; c++) {
				s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
				rgb[(y * CARD_W + x) * 3 + c] = ((((x * (3 + seed + c) + y * (5 + 2 * seed + 3 * c)) & 255) >> 1) + (s >>> 25)) & 255;
			}
	return rgb;
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** The colour of a card at (u, v) in card coordinates (0..1 across and down): a black border, a frame, a text box and an artwork of waves that depends on the seed. */
export function cardTexture(seed: number, u: number, v: number, variant = 0): [number, number, number] {
	if (u < 0.04 || u > 0.96 || v < 0.03 || v > 0.97) return [14, 14, 14];
	if (v >= 0.115 && v <= 0.545 && u >= 0.08 && u <= 0.92) {
		const a = seed * 0.37;
		return [
			clamp(128 + 100 * Math.sin(u * (6 + (seed % 7)) + a) * Math.cos(v * (5 + (seed % 5)) + a * 1.3)),
			clamp(128 + 90 * Math.sin(u * (4 + (seed % 11)) * 1.7 + v * (3 + (seed % 3)) * 2.1 + a * 0.7)),
			clamp(128 + 80 * Math.cos(u * (9 + (seed % 4)) - v * (7 + (seed % 6)) + a * 1.9)),
		];
	}
	// the variant is another printing of the same artwork: another frame colour, a dark text box
	if (v >= 0.6 && v <= 0.92 && u >= 0.08 && u <= 0.92) return variant ? [40, 36, 30] : [212, 200, 168];
	return variant ? [210, 196, 120] : [92 + (seed % 5) * 8, 64, 70];
}

/** The card as the base holds it: the texture sampled at the middle of each of the 96 x 134 pixels. */
export function renderCanvas(seed: number, variant = 0): Uint8Array {
	const rgb = new Uint8Array(CARD_W * CARD_H * 3);
	for (let y = 0; y < CARD_H; y++)
		for (let x = 0; x < CARD_W; x++) rgb.set(cardTexture(seed, (x + 0.5) / CARD_W, (y + 0.5) / CARD_H, variant), (y * CARD_W + x) * 3);
	return rgb;
}

/** A photo (RGBA) w x h of the card laid on a light table with its corners at `corners` (TL TR BR BL); the card's top edge is the TL-TR side. */
export function renderPhoto(seed: number, corners: Quad, w: number, h: number, variant = 0): { rgba: Uint8ClampedArray; w: number; h: number } {
	const toCard = homography(corners, [[0, 0], [1, 0], [1, 1], [0, 1]]);
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const q = toCard[6] * (x + 0.5) + toCard[7] * (y + 0.5) + 1;
			const u = (toCard[0] * (x + 0.5) + toCard[1] * (y + 0.5) + toCard[2]) / q;
			const v = (toCard[3] * (x + 0.5) + toCard[4] * (y + 0.5) + toCard[5]) / q;
			const i = (y * w + x) * 4;
			if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
				const [r, g, b] = cardTexture(seed, u, v, variant);
				rgba[i] = r;
				rgba[i + 1] = g;
				rgba[i + 2] = b;
			} else {
				const t = 205 + ((x * 7 + y * 13) % 5) - 2;
				rgba[i] = rgba[i + 1] = rgba[i + 2] = t;
			}
			rgba[i + 3] = 255;
		}
	return { rgba, w, h };
}

/** The half range of a descriptor's quantisation: the 99.9th percentile of the absolute values (what the data job does). */
export function quantisationRange(values: Float32Array[]): number {
	const all: number[] = [];
	for (const v of values) for (const x of v) all.push(Math.abs(x));
	all.sort((a, b) => a - b);
	return all[Math.floor(all.length * 0.999)] || 1;
}

/** A gunzipped shard (the base's file format, see database.ts) of the given rows. */
export function packShard(rows: { id: Uint8Array; desc: Record<DescriptorName, Float32Array> }[], m: Record<DescriptorName, number>): Uint8Array {
	const parts: Uint8Array[] = [];
	const ids = new Uint8Array(rows.length * 16);
	rows.forEach((r, i) => ids.set(r.id, i * 16));
	parts.push(ids);
	for (const name of DESCRIPTORS) {
		const count = rows.length * DESCRIPTOR_DIMS[name];
		const packed = new Uint8Array(Math.ceil(count / 2));
		let j = 0;
		for (const r of rows)
			for (const x of r.desc[name]) {
				const q = Math.min(15, Math.max(0, Math.round(((x + m[name]) / (2 * m[name])) * 15)));
				packed[j >> 1] |= j & 1 ? q << 4 : q;
				j++;
			}
		parts.push(packed);
	}
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/** The 16 bytes of a test illustration id. */
export function testId(seed: number): Uint8Array {
	const id = new Uint8Array(16);
	let s = (seed * 40503 + 7) >>> 0;
	for (let i = 0; i < 16; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		id[i] = s >>> 24;
	}
	return id;
}

/** A base of the cards `seeds` (one row each, in that order), packed in shards of `perShard` rows and assembled back through the real reader. */
export function buildTestDb(seeds: number[], perShard = 64): FingerprintDb {
	const rows = seeds.map((seed) => ({ id: testId(seed), desc: describeCard(renderCanvas(seed)) }));
	const m = {} as Record<DescriptorName, number>;
	for (const name of DESCRIPTORS) m[name] = quantisationRange(rows.map((r) => r.desc[name]));
	const shards: Uint8Array[] = [];
	const infos: FingerprintIndex["shards"] = [];
	for (let i = 0; i < rows.length; i += perShard) {
		const part = rows.slice(i, i + perShard);
		shards.push(packShard(part, m));
		infos.push({ file: `s${infos.length}.bin.gz`, rows: part.length, sha256: "0".repeat(64) });
	}
	const db = assembleDb({ v: 1, date: "2026-11-11", n: rows.length, m, shards: infos }, shards);
	if (!db) throw new Error("the test base did not assemble");
	return db;
}

export interface TestFiles {
	index: FingerprintIndex;
	/** the site's files by name: `index.json` and the gzipped shards */
	site: Map<string, Uint8Array>;
}

/** What the site would serve for the cards `seeds`: the index (real SHA-256 of each gzipped shard) and the gzipped shards. */
export function buildTestFiles(seeds: number[], perShard = 64, date = "2026-11-11"): TestFiles {
	const rows = seeds.map((seed) => ({ id: testId(seed), desc: describeCard(renderCanvas(seed)) }));
	const m = {} as Record<DescriptorName, number>;
	for (const name of DESCRIPTORS) m[name] = quantisationRange(rows.map((r) => r.desc[name]));
	const site = new Map<string, Uint8Array>();
	const shards: FingerprintIndex["shards"] = [];
	for (let i = 0; i < rows.length; i += perShard) {
		const part = rows.slice(i, i + perShard);
		const gz = new Uint8Array(gzipSync(packShard(part, m)));
		const file = `s${shards.length}.bin.gz`;
		site.set(file, gz);
		shards.push({ file, rows: part.length, sha256: createHash("sha256").update(gz).digest("hex") });
	}
	const index: FingerprintIndex = { v: 1, date, n: rows.length, m, shards };
	site.set("index.json", new TextEncoder().encode(JSON.stringify(index)));
	return { index, site };
}
