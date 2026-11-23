import { describe, expect, it } from "vitest";
import { INITIAL_TEXT_BYTES, PackedTableBuilder, parseUuid } from "./packed-table";

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
// Same last word, different first word: the other way ids can pile up.
const uuidFirst = (n: number): string => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;

// Small deterministic generator (mulberry32): the random tests must fail the same way twice.
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("parseUuid", () => {
	const out = new Uint32Array(4);

	it("reads a canonical UUID, in either case, into four words", () => {
		expect(parseUuid("01234567-89ab-cdef-0123-456789abcdef", out)).toBe(true);
		expect([...out]).toEqual([0x01234567, 0x89abcdef, 0x01234567, 0x89abcdef]);
		const lower = [...out];
		expect(parseUuid("01234567-89AB-CDEF-0123-456789ABCDEF", out)).toBe(true);
		expect([...out]).toEqual(lower);
		expect(parseUuid("ffffffff-ffff-ffff-ffff-ffffffffffff", out)).toBe(true);
		expect([...out]).toEqual([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]); // unsigned: the top bit is not a sign
	});

	it("refuses anything else", () => {
		const bad = [
			"",
			"aaaa",
			"01234567-89ab-cdef-0123-456789abcde", // one short
			"01234567-89ab-cdef-0123-456789abcdef0", // one long
			"0123456789abcdef0123456789abcdef0123", // no dashes, right length
			"01234567-89ab-cdef-0123-456789abcdeg", // not hexadecimal
			"01234567_89ab-cdef-0123-456789abcdef", // wrong separator
			"0123456-789ab-cdef-0123-456789abcdef", // dash in the wrong place
			" 1234567-89ab-cdef-0123-456789abcdef",
		];
		for (const id of bad) expect(parseUuid(id, out), JSON.stringify(id)).toBe(false);
		expect(parseUuid(undefined as unknown as string, out)).toBe(false);
		expect(parseUuid(42 as unknown as string, out)).toBe(false);
	});
});

describe("PackedTable: what goes in comes out", () => {
	it("a row is found by its id and gives back its numbers and its text", () => {
		const b = new PackedTableBuilder({ columns: 2, numberType: "float64" });
		expect(b.add(uuid(1), 0, [9999.99, 0.1], "mtg/lea/black-lotus")).toBe(true);
		expect(b.add(uuid(2), 0, [1, 2], "")).toBe(true);
		const t = b.build();
		expect(t.size).toBe(2);
		const r = t.find(uuid(1));
		expect(r).toBeGreaterThanOrEqual(0);
		expect([t.number(r, 0), t.number(r, 1)]).toEqual([9999.99, 0.1]); // exact doubles, not rounded
		expect(t.text(r)).toBe("mtg/lea/black-lotus");
		expect(t.text(t.find(uuid(2)))).toBe(""); // an empty text is a text
		expect(t.find(uuid(3))).toBe(-1);
	});

	it("keeps every double exactly, including the awkward ones", () => {
		const values = [0, 0.1 + 0.2, 1e-7, 123456.789, Number.MAX_SAFE_INTEGER, 2 ** -1022, -0.5];
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		values.forEach((v, i) => b.add(uuid(i), 0, [v], ""));
		const t = b.build();
		values.forEach((v, i) => expect(t.number(t.find(uuid(i)), 0)).toBe(v));
	});

	it("whole numbers: a cell can say 'none' with -1, and the largest price still fits", () => {
		const b = new PackedTableBuilder({ columns: 3, numberType: "int32" });
		b.add(uuid(1), 0, [250, -1, 2 ** 31 - 1], "u");
		const t = b.build();
		const r = t.find(uuid(1));
		expect([t.number(r, 0), t.number(r, 1), t.number(r, 2)]).toEqual([250, -1, 2 ** 31 - 1]);
	});

	it("text survives as UTF-8: accents, CJK, an emoji (a surrogate pair) and a long text", () => {
		const texts = ["Lim-Dûl's Vault — \"Æther\"", "日本語のカード", "🂡 and 😀", "x".repeat(10_000), "mtg/x/y"];
		const b = new PackedTableBuilder({ columns: 0, numberType: "float64" });
		texts.forEach((s, i) => b.add(uuid(i), 0, [], s));
		const t = b.build();
		texts.forEach((s, i) => expect(t.text(t.find(uuid(i)))).toBe(s));
	});

	it("an id is found whatever its case", () => {
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		b.add("abcdef01-2345-4678-89ab-cdef01234567", 0, [7], "t");
		const t = b.build();
		expect(t.find("ABCDEF01-2345-4678-89AB-CDEF01234567")).toBe(t.find("abcdef01-2345-4678-89ab-cdef01234567"));
		expect(t.find("ABCDEF01-2345-4678-89AB-CDEF01234567")).toBeGreaterThanOrEqual(0);
	});
});

describe("PackedTable: variants, duplicates and ids that are not UUIDs", () => {
	it("the same id in two variants (Card Kingdom's foil and non-foil) is two rows, looked up apart", () => {
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		b.add(uuid(1), 0, [1.5], "plain");
		b.add(uuid(1), 1, [4.5], "foil");
		const t = b.build();
		expect(t.size).toBe(2);
		expect(t.number(t.find(uuid(1), 0), 0)).toBe(1.5);
		expect(t.number(t.find(uuid(1), 1), 0)).toBe(4.5);
		expect(t.text(t.find(uuid(1), 1))).toBe("foil");
		expect(t.find(uuid(1), 2)).toBe(-1);
	});

	it("a second row for the same id and variant is dropped: the FIRST one wins", () => {
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		expect(b.add(uuid(1), 0, [9999.99], "first")).toBe(true);
		expect(b.add(uuid(1), 0, [1], "second")).toBe(false);
		expect(b.size).toBe(1);
		const t = b.build();
		expect(t.size).toBe(1);
		expect(t.number(t.find(uuid(1)), 0)).toBe(9999.99);
		expect(t.text(t.find(uuid(1)))).toBe("first");
	});

	it("an id that is not a UUID is not kept, and asking for one finds nothing", () => {
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		expect(b.add("aaaa", 0, [1], "x")).toBe(false);
		expect(b.add("", 0, [1], "x")).toBe(false);
		b.add(uuid(1), 0, [1], "x");
		const t = b.build();
		expect(t.size).toBe(1);
		expect(t.find("aaaa")).toBe(-1);
		expect(t.find("")).toBe(-1);
		expect(t.find(undefined as unknown as string)).toBe(-1);
	});

	it("an empty table finds nothing", () => {
		const t = new PackedTableBuilder({ columns: 1, numberType: "float64" }).build();
		expect(t.size).toBe(0);
		expect(t.find(uuid(1))).toBe(-1);
	});

	it("refuses what is a programming error, loudly", () => {
		const b = new PackedTableBuilder({ columns: 2, numberType: "float64" });
		expect(() => b.add(uuid(1), 256, [1, 2], "")).toThrow(RangeError);
		expect(() => b.add(uuid(1), -1, [1, 2], "")).toThrow(RangeError);
		expect(() => b.add(uuid(1), 0.5, [1, 2], "")).toThrow(RangeError);
		expect(() => b.add(uuid(1), 0, [1], "")).toThrow(RangeError); // one number too few
		b.build();
		expect(() => b.add(uuid(1), 0, [1, 2], "")).toThrow(); // single use
		expect(() => b.build()).toThrow();
		expect(() => new PackedTableBuilder({ columns: -1, numberType: "int32" })).toThrow(RangeError);
	});
});

describe("PackedTable: growth and lookups at size", () => {
	it("20,000 rows, past several doublings of the rows, the text and the slot table: every one is found with its own data, none invented", () => {
		const n = 20_000;
		const b = new PackedTableBuilder({ columns: 2, numberType: "float64" });
		for (let i = 0; i < n; i++) b.add(uuid(i), i % 2, [i, i / 7], `mtg/set-${i % 97}/card-${i}`);
		expect(b.size).toBe(n);
		const t = b.build();
		expect(t.size).toBe(n);
		for (let i = 0; i < n; i++) {
			const r = t.find(uuid(i), i % 2);
			expect(r, `row ${i}`).toBeGreaterThanOrEqual(0);
			expect(t.number(r, 0)).toBe(i);
			expect(t.number(r, 1)).toBe(i / 7);
			expect(t.text(r)).toBe(`mtg/set-${i % 97}/card-${i}`);
			expect(t.find(uuid(i), 1 - (i % 2)), `variant of row ${i}`).toBe(-1);
			expect(t.find(uuid(n + i))).toBe(-1);
		}
	});

	it("ids that differ in a single word (sequential, or only the first word) do not get lost", () => {
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		for (let i = 0; i < 6000; i++) {
			b.add(uuid(i), 0, [i], "");
			b.add(uuidFirst(i + 1), 0, [-i], "");
		}
		const t = b.build();
		for (let i = 0; i < 6000; i++) {
			expect(t.number(t.find(uuid(i)), 0)).toBe(i);
			expect(t.number(t.find(uuidFirst(i + 1)), 0)).toBe(-i);
		}
	});

	it("text made of 3-byte characters never overruns its buffer, wherever the buffer happens to end", () => {
		// A 150-byte text needs 150 bytes; room for only 50 to 149 is room for it IF it were one byte a character, which is the mistake to catch.
		const cjk = "日".repeat(50);
		for (const capacity of [INITIAL_TEXT_BYTES, INITIAL_TEXT_BYTES * 2]) {
			for (let room = 50; room < 150; room++) {
				const b = new PackedTableBuilder({ columns: 0, numberType: "float64" });
				let id = 0;
				// Fill with ASCII until `room` bytes are left before the end of the buffer (rows small enough that it doubles once, not twice).
				for (let filled = 0; filled < capacity - room; ) {
					const chunk = Math.min(40_000, capacity - room - filled);
					b.add(uuid(id++), 0, [], "x".repeat(chunk));
					filled += chunk;
				}
				b.add(uuid(id), 0, [], cjk);
				const t = b.build();
				expect(t.text(t.find(uuid(id))), `capacity ${capacity}, room ${room}`).toBe(cjk);
			}
		}
	});

	it("rows of 3-byte characters, thousands of them, across every doubling", () => {
		const b = new PackedTableBuilder({ columns: 0, numberType: "float64" });
		const texts: string[] = [];
		for (let i = 0; i < 3000; i++) {
			const s = "日".repeat(1 + (i % 29));
			texts.push(s);
			b.add(uuid(i), 0, [], s);
		}
		const t = b.build();
		texts.forEach((s, i) => expect(t.text(t.find(uuid(i)))).toBe(s));
	});

	it("answers like a Map on a long random session, duplicates and foreign ids included", () => {
		const rand = prng(20261122);
		const pool = Array.from({ length: 6000 }, (_, i) => uuid(i * 7919 + 13));
		const oracle = new Map<string, { n: number; text: string }>();
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		for (let step = 0; step < 30_000; step++) {
			const id = rand() < 0.02 ? `not-a-uuid-${step}` : pool[Math.floor(rand() * pool.length)];
			const variant = rand() < 0.5 ? 0 : 1;
			const n = Math.round(rand() * 1e6) / 100;
			const text = `row-${step}`;
			const key = `${id}:${variant}`;
			const accepted = b.add(id, variant, [n], text);
			const isUuid = !id.startsWith("not-a-uuid");
			expect(accepted).toBe(isUuid && !oracle.has(key));
			if (accepted) oracle.set(key, { n, text });
		}
		const t = b.build();
		expect(t.size).toBe(oracle.size);
		for (const id of pool) {
			for (const variant of [0, 1]) {
				const want = oracle.get(`${id}:${variant}`);
				const row = t.find(id, variant);
				if (!want) expect(row).toBe(-1);
				else {
					expect(row).toBeGreaterThanOrEqual(0);
					expect(t.number(row, 0)).toBe(want.n);
					expect(t.text(row)).toBe(want.text);
				}
			}
		}
	});
});

describe("PackedTable: what it costs", () => {
	it("is about what the data is: well under 90 bytes a row for a 16-byte id, a price and a 40-character address", () => {
		const n = 30_000;
		const b = new PackedTableBuilder({ columns: 1, numberType: "float64" });
		for (let i = 0; i < n; i++) b.add(uuid(i), i % 2, [i], `mtg/some-set-name/some-card-name-${String(i).padStart(6, "0")}`);
		const t = b.build();
		// A Map of objects costs ~390 bytes a row for the same rows (measured with the plugin's own read path).
		expect(t.byteLength / n).toBeLessThan(90);
		expect(t.byteLength / n).toBeGreaterThan(50); // and the number is the real one, not zero because something was not counted
	});
});
