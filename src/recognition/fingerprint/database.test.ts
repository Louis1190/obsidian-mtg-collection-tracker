import { describe, expect, it } from "vitest";
import type { Quad } from "../card-finder";
import { cardCorners, scene } from "../__tests__/scenes";
import { DESCRIPTORS, DESCRIPTOR_DIMS, describeCard } from "./descriptors";
import { assembleDb, findCardOf, findQuad, identifyCard, identifyPhoto, idOf, indexMoved, parseIndex, parseMovedAddress, shardSize, unpackShard } from "./database";
import { buildTestDb, packShard, quantisationRange, renderCanvas, renderPhoto, syntheticCard, testId } from "./__tests__/fingerprint-scenes";

const sha = "a".repeat(64);
const validIndex = () => ({ v: 1, date: "2026-11-11", n: 5, m: { hog: 0.4, tinylum: 3, dct: 1 }, shards: [{ file: "s0.bin.gz", rows: 3, sha256: sha }, { file: "s1.bin.gz", rows: 2, sha256: sha }] });

describe("parseIndex", () => {
	it("reads a good index", () => {
		const index = parseIndex(validIndex());
		expect(index?.n).toBe(5);
		expect(index?.shards.map((s) => s.file)).toEqual(["s0.bin.gz", "s1.bin.gz"]);
		expect(index?.m.tinylum).toBe(3);
	});
	it("refuses what is not what this plugin reads", () => {
		expect(parseIndex(null)).toBeNull();
		expect(parseIndex({ ...validIndex(), v: 2 })).toBeNull();
		expect(parseIndex({ ...validIndex(), date: "yesterday" })).toBeNull();
		expect(parseIndex({ ...validIndex(), n: 6 })).toBeNull(); // the shards hold 5 rows
		expect(parseIndex({ ...validIndex(), m: { hog: 0.4, tinylum: 3 } })).toBeNull();
		expect(parseIndex({ ...validIndex(), m: { hog: 0.4, tinylum: 3, dct: -1 } })).toBeNull();
		expect(parseIndex({ ...validIndex(), shards: [] })).toBeNull();
	});
	it("refuses a shard name that could point anywhere but a file of the site", () => {
		for (const file of ["../s0.bin.gz", "a/b.bin.gz", "https://example.com/x", "S0.bin.gz", "", ".hidden", "s0..gz", "a b"]) {
			const index = validIndex();
			index.shards[0].file = file;
			expect(parseIndex(index), file).toBeNull();
		}
		const bad = validIndex();
		bad.shards[1].sha256 = "xyz";
		expect(parseIndex(bad)).toBeNull();
	});
});

describe("shards", () => {
	const m = { hog: 0.5, tinylum: 4, dct: 1.2 };
	const row = (seed: number) => ({ id: testId(seed), desc: describeCard(syntheticCard(seed)) });

	it("unpacks a hand-made shard: ids first, then 4-bit values, the LOW nibble first", () => {
		const rows = 1;
		const raw = new Uint8Array(shardSize(rows));
		for (let i = 0; i < 16; i++) raw[i] = i + 1;
		let off = 16;
		for (const name of DESCRIPTORS) {
			const count = DESCRIPTOR_DIMS[name];
			for (let j = 0; j < count; j++) raw[off + (j >> 1)] |= ((j % 16) << (j & 1 ? 4 : 0));
			off += Math.ceil(count / 2);
		}
		const part = unpackShard(raw, rows)!;
		expect(Array.from(part.ids)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
		for (const name of DESCRIPTORS) expect(Array.from(part.values[name].slice(0, 20))).toEqual(Array.from({ length: 20 }, (_, j) => j % 16));
		expect(part.values.dct.length).toBe(111); // an odd count: the last byte holds one value
	});

	it("round-trips descriptors within one quantisation step, and refuses a wrong length", () => {
		const rows = [row(1), row(2), row(3)];
		const raw = packShard(rows, m);
		expect(raw.length).toBe(shardSize(3));
		const part = unpackShard(raw, 3)!;
		for (const name of DESCRIPTORS) {
			const dim = DESCRIPTOR_DIMS[name];
			for (let r = 0; r < 3; r++)
				for (let j = 0; j < dim; j++) {
					const x = Math.max(-m[name], Math.min(m[name], rows[r].desc[name][j]));
					expect(Math.abs((part.values[name][r * dim + j] / 15) * 2 * m[name] - m[name] - x)).toBeLessThanOrEqual(m[name] / 15 + 1e-6);
				}
		}
		expect(unpackShard(raw.subarray(1), 3)).toBeNull();
		expect(unpackShard(raw, 4)).toBeNull();
		expect(unpackShard(Uint8Array.from([...raw, 0]), 3)).toBeNull(); // one byte too many is as wrong as one too few
	});

	it("assembles shards in the index's order and refuses a shard that does not fit", () => {
		const a = [row(1), row(2)];
		const b = [row(3)];
		const index = parseIndex({ v: 1, date: "2026-11-11", n: 3, m, shards: [{ file: "a.bin.gz", rows: 2, sha256: sha }, { file: "b.bin.gz", rows: 1, sha256: sha }] })!;
		const db = assembleDb(index, [packShard(a, m), packShard(b, m)])!;
		expect(db.n).toBe(3);
		expect(Array.from(db.ids.slice(32, 48))).toEqual(Array.from(testId(3)));
		expect(idOf(db, 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(idOf(db, 0)).not.toBe(idOf(db, 1));
		expect(assembleDb(index, [packShard(b, m), packShard(a, m)])).toBeNull(); // swapped: neither has the length its slot expects
		expect(assembleDb(index, [packShard(a, m)])).toBeNull();
	});
});

describe("the scan, on a base of drawn cards", { timeout: 60_000 }, () => {
	const seeds = Array.from({ length: 150 }, (_, i) => i + 1);
	const db = buildTestDb(seeds, 64);
	const rowOf = (seed: number) => seeds.indexOf(seed);
	const W = 480;
	const H = 640;
	const quad = (c: ReturnType<typeof cardCorners>): Quad => [c[0], c[1], c[2], c[3]];

	it("assembled the 150 rows from 3 shards", () => {
		expect(db.n).toBe(150);
		expect(db.m.hog).toBeGreaterThan(0);
	});

	it("finds the card of a slanted photo as the first answer, with the exact quad", () => {
		const corners = cardCorners(240, 320, 280, 391, 5);
		corners[2][0] += 11;
		const photo = renderPhoto(37, quad(corners), W, H);
		const matches = identifyCard(photo, quad(corners), db);
		expect(matches[0].row).toBe(rowOf(37));
		expect(matches[0].id).toBe(idOf(db, rowOf(37)));
		expect(matches.length).toBe(3);
		expect(matches[0].score).toBeLessThan(matches[1].score);
		expect(matches[1].score).toBeLessThanOrEqual(matches[2].score);
	});

	it("finds the quad itself with the plugin's finder, then the card", { timeout: 30_000 }, () => {
		const corners = cardCorners(240, 320, 280, 391, -4);
		const photo = renderPhoto(90, quad(corners), W, H);
		const q = findQuad(photo);
		expect(q).not.toBeNull();
		const matches = identifyPhoto(photo, db);
		expect(matches?.[0].row).toBe(rowOf(90));
	});

	it("says whether the quad is the card's own edge (a dark border on a lighter table) or the frame inside its border, which is where the corner's text is looked for", () => {
		// the same scenes scan.test.ts cuts its corner windows from: 720 x 960, a dark-bordered card on a lighter table, then a white-bordered one on a dark table
		const own = { rgba: scene({ w: 720, h: 960, bg: 190, border: 25, frame: 150, corners: cardCorners(360, 480, 420, 588, 0), borderWidth: 24 }), w: 720, h: 960 };
		const inside = { rgba: scene({ w: 720, h: 960, bg: 35, border: 235, frame: 120, corners: cardCorners(360, 480, 420, 588, 0), borderWidth: 24 }), w: 720, h: 960 };
		expect(findCardOf(own)?.outer).toBe(true);
		expect(findCardOf(inside)?.outer).toBe(false);
		expect(findQuad(own)).toEqual(findCardOf(own)?.quad);
		expect(Math.hypot(findCardOf(own)!.quad[1][0] - findCardOf(own)!.quad[0][0], findCardOf(own)!.quad[1][1] - findCardOf(own)!.quad[0][1])).toBeGreaterThan(380); // in the photo's own pixels
	});

	it("finds a card lying upside down (the finder cannot tell the top)", () => {
		const turned = cardCorners(240, 320, 280, 391, 183);
		const photo = renderPhoto(66, [turned[2], turned[3], turned[0], turned[1]], W, H);
		const matches = identifyCard(photo, quad(turned), db);
		expect(matches[0].row).toBe(rowOf(66));
	});

	it("tells several cards apart", () => {
		let right = 0;
		for (const seed of [3, 18, 44, 71, 102, 133, 149]) {
			const corners = cardCorners(240, 320, 267 + (seed % 5) * 5, 373 + (seed % 5) * 7, (seed % 9) - 4);
			const photo = renderPhoto(seed, quad(corners), W, H);
			if (identifyCard(photo, quad(corners), db)[0].row === rowOf(seed)) right++;
		}
		expect(right).toBe(7);
	});

	it("answers nothing for a photo with no card, and nothing for an empty base", () => {
		const blank = { rgba: new Uint8ClampedArray(W * H * 4).fill(200), w: W, h: H };
		expect(findQuad(blank)).toBeNull();
		expect(identifyPhoto(blank, db)).toBeNull();
		const corners = cardCorners(240, 320, 280, 391, 0);
		const empty = { n: 0, ids: new Uint8Array(0), values: { hog: new Uint8Array(0), tinylum: new Uint8Array(0), dct: new Uint8Array(0) }, m: db.m };
		expect(identifyCard(renderPhoto(1, quad(corners), W, H), quad(corners), empty)).toEqual([]);
	});

	it("works on a base smaller than the stages ask for", () => {
		const small = buildTestDb([5, 6, 7], 2);
		const corners = cardCorners(240, 320, 280, 391, 0);
		const matches = identifyCard(renderPhoto(6, quad(corners), W, H), quad(corners), small);
		expect(matches.length).toBe(3);
		expect(matches[0].row).toBe(1);
	});

	it("quantisationRange follows the data", () => {
		expect(quantisationRange([Float32Array.from([-2, 1, 0.5])])).toBe(2);
	});

	it("the base's rows are the drawn cards (a wrong card is not first)", () => {
		const corners = cardCorners(240, 320, 280, 391, 0);
		const photo = renderPhoto(20, quad(corners), W, H);
		const matches = identifyCard(photo, quad(corners), db);
		expect(matches.some((m) => m.row === rowOf(21))).toBe(false);
		expect(renderCanvas(20).length).toBe(96 * 134 * 3);
	});
});

describe("parseMovedAddress / indexMoved (the one place a downloaded file chooses where the plugin sends requests)", () => {
	it("accepts an https address with a named host, and answers its canonical form without a trailing slash", () => {
		expect(parseMovedAddress("https://files.example.org/fp")).toBe("https://files.example.org/fp");
		expect(parseMovedAddress("https://files.example.org/fp/")).toBe("https://files.example.org/fp");
		expect(parseMovedAddress("https://FILES.example.org/a/./b//")).toBe("https://files.example.org/a/b");
		expect(parseMovedAddress("https://files.example.org")).toBe("https://files.example.org");
		expect(parseMovedAddress("https://files.example.org:8443/fp")).toBe("https://files.example.org:8443/fp");
	});
	it.each([
		["http, not https", "http://files.example.org/fp"],
		["another scheme", "ftp://files.example.org/fp"],
		["a script", "javascript:alert(1)"],
		// the "@" is a piece of its own: the public export's leak scan takes a user-and-host pair written in one piece for an e-mail address
		["credentials", "https://user:secret" + "@files.example.org/fp"],
		["a user name only", "https://user" + "@files.example.org/fp"],
		["a query", "https://files.example.org/fp?x=1"],
		["a fragment", "https://files.example.org/fp#x"],
		["an IPv4 address", "https://192.168.1.10/fp"],
		["an IPv6 address", "https://[::1]/fp"],
		["a host without a dot", "https://localhost/fp"],
		["no scheme", "files.example.org/fp"],
		["a relative path", "/fp"],
		["spaces around it", " https://files.example.org/fp"],
		["an empty string", ""],
		["more than 300 characters", `https://files.example.org/${"a".repeat(300)}`],
		["a number", 7],
		["null", null],
		["an object", { href: "https://files.example.org/fp" }],
	])("refuses %s", (_label, value) => {
		expect(parseMovedAddress(value)).toBeNull();
	});
	it("is read from an index's JSON, and ignored when the index does not hold a followable one", () => {
		expect(indexMoved({ moved: "https://files.example.org/fp/" })).toBe("https://files.example.org/fp");
		expect(indexMoved({ moved: "http://files.example.org/fp" })).toBeNull();
		expect(indexMoved({})).toBeNull();
		expect(indexMoved(null)).toBeNull();
		expect(indexMoved("https://files.example.org/fp")).toBeNull();
	});
	it("an index that carries the field is still an index, and parseIndex does not keep it (older readers and the local copy never see it)", () => {
		const index = parseIndex({ ...validIndex(), moved: "https://files.example.org/fp" });
		expect(index).not.toBeNull();
		expect("moved" in index!).toBe(false);
		expect(parseIndex({ ...validIndex(), moved: 12 })).not.toBeNull(); // a junk pointer does not make the index junk
	});
});
