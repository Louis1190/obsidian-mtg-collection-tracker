import { afterEach, describe, expect, it } from "vitest";
import { mayCarryProtoKey, parseExternalJson, parseExternalJsonObject } from "./safe-json";

const BASELINE = new Set(Object.getOwnPropertyNames(Object.prototype));
const polluted = (): string[] => Object.getOwnPropertyNames(Object.prototype).filter((k) => !BASELINE.has(k));
afterEach(() => {
	for (const k of polluted()) delete (Object.prototype as any)[k];
});

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// Every own key at every depth, arrays walked through.
function allKeys(v: unknown, out: string[] = []): string[] {
	if (v === null || typeof v !== "object") return out;
	for (const k of Object.keys(v)) {
		out.push(k);
		allKeys((v as Record<string, unknown>)[k], out);
	}
	return out;
}

describe("parseExternalJson", () => {
	it("returns exactly what JSON.parse returns for ordinary data", () => {
		const text = JSON.stringify({
			collection: [{ id: "a", name: "Café", count: 2, nested: { x: [1, 2, { y: null }] } }],
			priceCurrency: "eur",
			n: 1.5,
			t: true,
		});
		expect(parseExternalJson(text)).toEqual(JSON.parse(text));
	});

	it("drops a __proto__ key at the top level, in a nested object and inside an array of objects", () => {
		const text = '{"a":1,"__proto__":{"polluted":1},"b":{"__proto__":{"polluted":2},"c":3},"d":[{"__proto__":{"polluted":3},"e":4}]}';
		const v = parseExternalJson(text) as any;
		expect(allKeys(v)).not.toContain("__proto__");
		expect(v).toEqual({ a: 1, b: { c: 3 }, d: [{ e: 4 }] });
		expect(polluted()).toEqual([]);
	});

	it("drops the key when it is written through \\u escapes (JSON decodes escapes in keys)", () => {
		for (const key of ["\\u005f\\u005fproto\\u005f\\u005f", "__proto\\u005f_", "\\u005f_proto__", "__\\u0070roto__"]) {
			const v = parseExternalJson(`{"keep":1,"${key}":{"polluted":1}}`) as any;
			expect(allKeys(v)).toEqual(["keep"]);
		}
	});

	it("leaves keys that merely resemble it alone", () => {
		const v = parseExternalJson('{"proto":1,"__proto":2,"proto__":3,"_proto_":4,"constructor":5}') as any;
		expect(v).toEqual({ proto: 1, __proto: 2, proto__: 3, _proto_: 4, constructor: 5 });
	});

	it("keeps a string VALUE that contains the word or a \\u escape (only keys are dropped)", () => {
		const v = parseExternalJson('{"note":"the __proto__ key","accent":"caf\\u00e9"}') as any;
		expect(v).toEqual({ note: "the __proto__ key", accent: "café" });
	});

	it("still throws on invalid JSON, on both paths", () => {
		expect(() => parseExternalJson("{nope")).toThrow();
		expect(() => parseExternalJson('{"__proto__": ')).toThrow();
	});

	it("the result gives no way back to Object.prototype through a later write", () => {
		const v = parseExternalJson('{"__proto__":{"polluted":1}}') as any;
		v.anything = 1;
		expect(({} as any).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
	});
});

describe("mayCarryProtoKey (the fast path must never let a hostile text through)", () => {
	it("is false for the kind of text our own files hold", () => {
		expect(mayCarryProtoKey(JSON.stringify({ collection: [{ id: "a", name: "Black Lotus" }], accent: "#fff" }))).toBe(false);
		// JSON.stringify leaves non-ASCII text as it is: no escape, so no slow path for accented names.
		expect(mayCarryProtoKey(JSON.stringify({ name: "Lim-Dûl's Cohort — Æther" }))).toBe(false);
	});

	it("is true for the plain key and for any escaped form", () => {
		expect(mayCarryProtoKey('{"__proto__":{}}')).toBe(true);
		expect(mayCarryProtoKey('{"\\u005f\\u005fproto\\u005f\\u005f":{}}')).toBe(true);
		expect(mayCarryProtoKey('{"__proto\\u005f_":{}}')).toBe(true);
	});

	// The property that matters: whatever the spelling, the result of parseExternalJson never holds the key.
	it("every spelling of the key that JSON.parse really resolves to __proto__ is caught", () => {
		const spellings: string[] = [];
		const chars = "__proto__".split("");
		// Each character written plainly or as a \u escape: 2^9 spellings.
		for (let mask = 0; mask < 1 << chars.length; mask++) {
			spellings.push(
				chars.map((c, i) => (mask & (1 << i) ? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0") : c)).join("")
			);
		}
		expect(spellings.length).toBe(512);
		for (const s of spellings) {
			const text = `{"${s}":{"polluted":1},"ok":1}`;
			// premise: this spelling really is the key, as plain JSON.parse sees it
			expect(Object.keys(JSON.parse(text))).toContain("__proto__");
			expect(allKeys(parseExternalJson(text))).toEqual(["ok"]);
		}
	});
});

describe("parseExternalJsonObject", () => {
	it("returns a plain object, and null for anything else", () => {
		expect(parseExternalJsonObject('{"a":1}')).toEqual({ a: 1 });
		expect(parseExternalJsonObject("[1,2]")).toBeNull();
		expect(parseExternalJsonObject('"text"')).toBeNull();
		expect(parseExternalJsonObject("null")).toBeNull();
		expect(parseExternalJsonObject("42")).toBeNull();
		expect(parseExternalJsonObject("not json")).toBeNull();
		expect(parseExternalJsonObject("")).toBeNull();
	});

	it("strips the key from a settings-shaped file", () => {
		const o = parseExternalJsonObject('{"collection":[],"syncTombstones":{"__proto__":{"polluted":1},"lists":{"x":1}}}') as any;
		expect(o.syncTombstones).toEqual({ lists: { x: 1 } });
		expect(hasOwn(o.syncTombstones, "__proto__")).toBe(false);
	});
});
