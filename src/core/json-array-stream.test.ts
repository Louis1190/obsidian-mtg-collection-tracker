import { describe, expect, it } from "vitest";
import { JsonArrayRowStream } from "./json-array-stream";

function run(chunks: string[], key = "data"): { rows: string[]; prefix: string; failed: boolean } {
	const rows: string[] = [];
	const stream = new JsonArrayRowStream(key, (r) => rows.push(r));
	for (const c of chunks) stream.push(c);
	return { rows, prefix: stream.prefix, failed: stream.failed };
}

// A document designed to trip up the reader: braces, quotes, brackets and backslashes INSIDE strings, nested
// objects, whitespace, a missing non-object value, a unicode escape.
const ROWS = [
	{ id: 1, name: "plain", n: { a: 1 } },
	{ id: 2, name: 'quote " inside', note: "brace } and { and ] and [ inside" },
	{ id: 3, name: "back\\slash", tail: "ends with a backslash \\" },
	{ id: 4, name: "unicode é 中 and \\u0041 escape", deep: { a: { b: { c: [1, 2, { d: "}" }] } } } },
	{ id: 5, name: "", empty: {} },
];
const DOC = `{"meta":{"created_at":"2026-10-05","base_url":"https:\\/\\/www.cardkingdom.com\\/"},"data":[ ${ROWS.map((r) => JSON.stringify(r)).join(",\n ")} ],"after":{"x":1}}`;

describe("JsonArrayRowStream", () => {
	it("hands over every object of the array as JSON text, and the text before the array as the prefix", () => {
		const { rows, prefix, failed } = run([DOC]);
		expect(failed).toBe(false);
		expect(rows.map((r) => JSON.parse(r))).toEqual(ROWS);
		expect(prefix).toBe('{"meta":{"created_at":"2026-10-05","base_url":"https:\\/\\/www.cardkingdom.com\\/"},');
	});

	it("gives the same rows however the text is cut: at every position, and one character at a time", () => {
		const expected = run([DOC]).rows;
		for (let cut = 1; cut < DOC.length; cut++) {
			expect(run([DOC.slice(0, cut), DOC.slice(cut)]).rows).toEqual(expected);
		}
		expect(run(DOC.split("")).rows).toEqual(expected);
	});

	it("gives the same rows with three cuts at once (a cut inside the key, inside an escape, inside a row)", () => {
		const expected = run([DOC]).rows;
		for (let a = 1; a < DOC.length; a += 7) {
			for (let b = a + 1; b < DOC.length; b += 11) {
				expect(run([DOC.slice(0, a), DOC.slice(a, b), DOC.slice(b)]).rows).toEqual(expected);
			}
		}
	});

	it("ignores whatever follows the array", () => {
		expect(run([DOC + '{"data":[{"late":true}]}']).rows).toHaveLength(ROWS.length);
	});

	it("handles an empty array, and a document with spaces around the key", () => {
		expect(run(['{"meta":{},"data":[]}']).rows).toEqual([]);
		expect(run(['{"meta":{},  "data" :  [ {"a":1} ]}']).rows).toEqual(['{"a":1}']);
	});

	it("flags a response that has no such array, and stops growing its buffer", () => {
		const stream = new JsonArrayRowStream("data", () => {});
		for (let i = 0; i < 30; i++) stream.push('{"error":"nothing here","filler":"' + "x".repeat(10_000) + '"}');
		expect(stream.failed).toBe(true);
	});

	it("reads another key (a regex-looking one is taken literally)", () => {
		expect(run(['{"rows":[{"a":1},{"a":2}]}'], "rows").rows).toEqual(['{"a":1}', '{"a":2}']);
		expect(run(['{"da.a":[{"a":1}]}'], "da.a").rows).toEqual(['{"a":1}']);
		expect(run(['{"daxa":[{"a":1}]}'], "da.a").failed).toBe(false); // not (yet) found: a short document is not a failure
	});

	it("is fast enough for a 150 000-row pricelist", () => {
		const rowJson = JSON.stringify({ id: 10000, sku: "4ED-117", scryfall_id: "a363bc91-8278-448e-9d5c-564e4b51eb62", url: "mtg/4th-edition/abomination", name: "Abomination", variation: "", edition: "4th Edition", is_foil: "false", price_retail: "0.25", qty_retail: 12, price_buy: "0.05", qty_buying: 0, condition_values: { nm_price: "0.25", ex_price: "0.19" } });
		const doc = '{"meta":{"base_url":"x"},"data":[' + Array(150_000).fill(rowJson).join(",") + "]}";
		const started = Date.now();
		let count = 0;
		const stream = new JsonArrayRowStream("data", () => count++);
		for (let i = 0; i < doc.length; i += 262_144) stream.push(doc.slice(i, i + 262_144));
		expect(count).toBe(150_000);
		expect(Date.now() - started).toBeLessThan(5000);
	}, 20000);
});
