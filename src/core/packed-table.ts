/* -------------------------------------------------------------------------- */
/* A compact lookup table keyed by Scryfall id (2026-11-22, memory audit).

   Why it exists: the Card Kingdom (152,000 rows) and Mana Pool (104,000 rows) price lists were kept for the whole session as
   a `Map<string, { … url }>`. Measured with the plugin's own read path, a Map entry costs ~390 bytes (a 45-character key
   string, an object, a boxed number, the address as one more string): ~56 MB for Card Kingdom alone, ~90 MB on a computer with
   both lists, for a few prices of the cards the person actually owns.

   A row here costs about what its data is: the id as 16 bytes, the numbers as typed-array cells, the text as UTF-8 bytes in
   one shared buffer, and one 4-byte slot in an open-addressing hash table. Card Kingdom comes to ~12 MB, Mana Pool to ~10 MB,
   with the same answers and no new download. There is no per-row object, so nothing for the garbage collector to walk either.

   What it deliberately is NOT: a general container. Keys are canonical UUIDs (what Scryfall ids are; a row whose id is not one
   can never be asked for by a real card and is not kept), a row is never changed or removed, and the table is read-only once
   built. Pure and free of Obsidian. */
/* -------------------------------------------------------------------------- */

export type PackedNumberType = "float64" | "int32";

export interface PackedTableOptions {
	/** How many numbers each row carries. */
	columns: number;
	/** `float64`: exact doubles (a price as the vendor writes it). `int32`: whole numbers in 4 bytes (cents; the caller picks its own "none"). */
	numberType: PackedNumberType;
}

type NumberArray = Float64Array | Int32Array;

const UUID_LENGTH = 36;
const INITIAL_ROWS = 1 << 12;
// Exported for the tests, which put the end of the text buffer where it is hardest on the code.
export const INITIAL_TEXT_BYTES = 1 << 16;
const INITIAL_SLOTS = 1 << 13;
// Slots are filled to 60 % at most: probe sequences stay short (1.4 slots on average for a hit) and the table is never full.
const MAX_LOAD = 0.6;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// One reusable key: lookups parse the id into it instead of allocating. JavaScript is single-threaded and nothing here awaits.
const probe = new Uint32Array(4);

function hexValue(code: number): number {
	if (code >= 48 && code <= 57) return code - 48; // 0-9
	if (code >= 97 && code <= 102) return code - 87; // a-f
	if (code >= 65 && code <= 70) return code - 55; // A-F
	return -1;
}

/**
 * Parses a canonical UUID ("8-4-4-4-12" hexadecimal digits, either case) into four 32-bit words. Returns false for anything
 * else (nothing is written to `out` in a way the caller may rely on then).
 */
export function parseUuid(id: string, out: Uint32Array): boolean {
	if (typeof id !== "string" || id.length !== UUID_LENGTH) return false;
	let word = 0;
	let nibbles = 0;
	let words = 0;
	for (let i = 0; i < UUID_LENGTH; i++) {
		const code = id.charCodeAt(i);
		if (i === 8 || i === 13 || i === 18 || i === 23) {
			if (code !== 45) return false; // "-"
			continue;
		}
		const v = hexValue(code);
		if (v < 0) return false;
		word = (word << 4) | v;
		if (++nibbles === 8) {
			out[words++] = word >>> 0;
			word = 0;
			nibbles = 0;
		}
	}
	return words === 4;
}

// A 32-bit mix of the four words and the variant (murmur-style finalizer): any bit of the key reaches every bit of the result,
// so ids that only differ in one word (a test's sequential ids, a version-1 UUID's timestamp) do not pile up in neighbouring slots.
function hashKey(w0: number, w1: number, w2: number, w3: number, variant: number): number {
	let h = Math.imul(w0 ^ variant, 0x9e3779b1);
	h = Math.imul(h ^ (h >>> 15) ^ w1, 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13) ^ w2, 0xc2b2ae35);
	h = Math.imul(h ^ (h >>> 16) ^ w3, 0x27d4eb2f);
	return (h ^ (h >>> 15)) >>> 0;
}

// Row of a key, -1 when it is not there. `slots` holds row + 1 (0 = empty); its length is a power of two.
function findRow(keys: Uint32Array, variants: Uint8Array, slots: Int32Array, words: Uint32Array, variant: number): number {
	const mask = slots.length - 1;
	let i = hashKey(words[0], words[1], words[2], words[3], variant) & mask;
	for (;;) {
		const slot = slots[i];
		if (slot === 0) return -1;
		const row = slot - 1;
		const k = row * 4;
		if (keys[k] === words[0] && keys[k + 1] === words[1] && keys[k + 2] === words[2] && keys[k + 3] === words[3] && variants[row] === variant) return row;
		i = (i + 1) & mask;
	}
}

function insertSlot(keys: Uint32Array, variants: Uint8Array, slots: Int32Array, row: number): void {
	const mask = slots.length - 1;
	const k = row * 4;
	let i = hashKey(keys[k], keys[k + 1], keys[k + 2], keys[k + 3], variants[row]) & mask;
	while (slots[i] !== 0) i = (i + 1) & mask;
	slots[i] = row + 1;
}

function newNumbers(type: PackedNumberType, length: number): NumberArray {
	return type === "float64" ? new Float64Array(length) : new Int32Array(length);
}

// A copy of `source` with room for `length` elements (same type).
function grown<T extends Uint8Array | Uint32Array | Float64Array | Int32Array>(source: T, length: number): T {
	const out = new (source.constructor as new (n: number) => T)(length);
	out.set(source);
	return out;
}

/** The finished, read-only table. Build it with PackedTableBuilder. */
export class PackedTable {
	/** @internal use PackedTableBuilder */
	constructor(
		readonly size: number,
		private readonly columns: number,
		private readonly keys: Uint32Array,
		private readonly variants: Uint8Array,
		private readonly numbers: NumberArray,
		private readonly textStart: Uint32Array,
		private readonly textBytes: Uint8Array,
		private readonly slots: Int32Array
	) {}

	/** The row of this id (and variant: Card Kingdom has one row per finish), or -1. An id that is not a UUID is never found. */
	find(id: string, variant = 0): number {
		if (!parseUuid(id, probe)) return -1;
		return findRow(this.keys, this.variants, this.slots, probe, variant);
	}

	number(row: number, column: number): number {
		return this.numbers[row * this.columns + column];
	}

	text(row: number): string {
		return decoder.decode(this.textBytes.subarray(this.textStart[row], this.textStart[row + 1]));
	}

	/** What the table holds in memory, in bytes (the typed arrays; the handful of fields of the object itself are not counted). */
	get byteLength(): number {
		return this.keys.byteLength + this.variants.byteLength + this.numbers.byteLength + this.textStart.byteLength + this.textBytes.byteLength + this.slots.byteLength;
	}
}

/** Collects rows, then hands over a PackedTable. Single use: `build()` ends it. */
export class PackedTableBuilder {
	private count = 0;
	private capacity = INITIAL_ROWS;
	private keys = new Uint32Array(INITIAL_ROWS * 4);
	private variants = new Uint8Array(INITIAL_ROWS);
	private numbers: NumberArray;
	private textStart = new Uint32Array(INITIAL_ROWS + 1);
	private textBytes = new Uint8Array(INITIAL_TEXT_BYTES);
	private textLength = 0;
	private slots = new Int32Array(INITIAL_SLOTS);
	private done = false;
	private readonly columns: number;
	private readonly numberType: PackedNumberType;
	private readonly words = new Uint32Array(4);

	constructor(options: PackedTableOptions) {
		if (!Number.isInteger(options.columns) || options.columns < 0) throw new RangeError("columns must be a whole number >= 0");
		this.columns = options.columns;
		this.numberType = options.numberType;
		this.numbers = newNumbers(options.numberType, INITIAL_ROWS * Math.max(1, options.columns));
	}

	get size(): number {
		return this.count;
	}

	/**
	 * Adds a row. Returns false, and keeps nothing, when `id` is not a UUID or the same (id, variant) is already there: the FIRST
	 * row of a key wins, as a Map that is not overwritten would.
	 */
	add(id: string, variant: number, numbers: ArrayLike<number>, text: string): boolean {
		if (this.done) throw new Error("PackedTableBuilder: the table is already built");
		if (!Number.isInteger(variant) || variant < 0 || variant > 255) throw new RangeError("variant must be a whole number from 0 to 255");
		if (numbers.length !== this.columns) throw new RangeError(`expected ${this.columns} numbers, got ${numbers.length}`);
		if (!parseUuid(id, this.words)) return false;
		if (findRow(this.keys, this.variants, this.slots, this.words, variant) >= 0) return false;

		if (this.count === this.capacity) this.growRows();
		if ((this.count + 1) > this.slots.length * MAX_LOAD) this.growSlots();
		// Worst case of UTF-8: three bytes per UTF-16 unit (a surrogate pair is four bytes for two units).
		const needed = this.textLength + text.length * 3;
		if (needed > this.textBytes.length) this.textBytes = grown(this.textBytes, Math.max(needed, this.textBytes.length * 2));

		const row = this.count++;
		this.keys.set(this.words, row * 4);
		this.variants[row] = variant;
		for (let c = 0; c < this.columns; c++) this.numbers[row * this.columns + c] = numbers[c];
		this.textLength += encoder.encodeInto(text, this.textBytes.subarray(this.textLength)).written;
		this.textStart[row + 1] = this.textLength;
		insertSlot(this.keys, this.variants, this.slots, row);
		return true;
	}

	/** The table, with every array cut to what it holds. The builder cannot be used afterwards. */
	build(): PackedTable {
		if (this.done) throw new Error("PackedTableBuilder: the table is already built");
		this.done = true;
		const n = this.count;
		const table = new PackedTable(
			n,
			this.columns,
			this.keys.slice(0, n * 4),
			this.variants.slice(0, n),
			this.numbers.slice(0, n * this.columns),
			this.textStart.slice(0, n + 1),
			this.textBytes.slice(0, this.textLength),
			this.slots
		);
		// Let go of the oversized working arrays (the slot table is kept as it is: it is already sized by its load).
		this.keys = new Uint32Array(0);
		this.variants = new Uint8Array(0);
		this.numbers = newNumbers(this.numberType, 0);
		this.textStart = new Uint32Array(0);
		this.textBytes = new Uint8Array(0);
		this.slots = new Int32Array(0);
		return table;
	}

	private growRows(): void {
		const capacity = this.capacity * 2;
		this.keys = grown(this.keys, capacity * 4);
		this.variants = grown(this.variants, capacity);
		this.numbers = grown(this.numbers, capacity * Math.max(1, this.columns));
		this.textStart = grown(this.textStart, capacity + 1);
		this.capacity = capacity;
	}

	// Doubles the slot table and puts every row back in it (a slot's place depends on the table's size).
	private growSlots(): void {
		const slots = new Int32Array(this.slots.length * 2);
		for (let row = 0; row < this.count; row++) insertSlot(this.keys, this.variants, slots, row);
		this.slots = slots;
	}
}
