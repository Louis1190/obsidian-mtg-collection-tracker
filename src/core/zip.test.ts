import { describe, it, expect } from "vitest";
import { buildZip } from "./zip";

// Small home-made "stored" ZIP reader, just enough to verify the round
// trip of files written by buildZip — no need for a real ZIP-reading
// dependency for that, the local header is enough since the content is
// never compressed.
function parseStoredZip(bytes: Uint8Array): { name: string; content: string }[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	const results: { name: string; content: string }[] = [];
	let offset = 0;
	while (offset < bytes.length && view.getUint32(offset, true) === 0x04034b50) {
		const compSize = view.getUint32(offset + 18, true);
		const nameLen = view.getUint16(offset + 26, true);
		const extraLen = view.getUint16(offset + 28, true);
		const nameStart = offset + 30;
		const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLen));
		const dataStart = nameStart + nameLen + extraLen;
		const content = decoder.decode(bytes.slice(dataStart, dataStart + compSize));
		results.push({ name, content });
		offset = dataStart + compSize;
	}
	return results;
}

describe("buildZip", () => {
	it("round-trips file names and content for multiple entries", () => {
		const zip = buildZip([
			{ name: "a.txt", content: "hello" },
			{ name: "b.csv", content: "Name,Count\nBolt,3" },
		]);
		expect(parseStoredZip(zip)).toEqual([
			{ name: "a.txt", content: "hello" },
			{ name: "b.csv", content: "Name,Count\nBolt,3" },
		]);
	});

	it("handles non-ASCII file names and content (UTF-8 flag)", () => {
		const zip = buildZip([{ name: "liste énumérée.txt", content: "3 - Éclair" }]);
		expect(parseStoredZip(zip)).toEqual([{ name: "liste énumérée.txt", content: "3 - Éclair" }]);
		// Bit 11 (0x0800) of the general purpose flag, in the local header — at
		// offset 6 — must be set for the UTF-8 name to be interpreted correctly by
		// a conforming extractor.
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
	});

	it("computes a known CRC-32 test vector correctly", () => {
		// "The quick brown fox jumps over the lazy dog" → 0x414FA339, a well-known
		// CRC-32 test vector.
		const zip = buildZip([{ name: "t.txt", content: "The quick brown fox jumps over the lazy dog" }]);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(view.getUint32(14, true)).toBe(0x414fa339);
	});

	it("writes a valid end-of-central-directory record", () => {
		const zip = buildZip([
			{ name: "x.txt", content: "y" },
			{ name: "z.txt", content: "w" },
		]);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		const eocdOffset = zip.length - 22;
		expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
		expect(view.getUint16(eocdOffset + 10, true)).toBe(2); // total entries
	});

	it("returns a structurally valid, empty archive for no entries", () => {
		const zip = buildZip([]);
		expect(zip.length).toBe(22);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(view.getUint32(0, true)).toBe(0x06054b50);
		expect(view.getUint16(10, true)).toBe(0);
	});

	it("central directory offsets point back to the correct local headers", () => {
		const zip = buildZip([
			{ name: "first.txt", content: "aaaa" },
			{ name: "second.txt", content: "bb" },
		]);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		// Locates the start of the central directory via the EOCD, then checks
		// that each entry in it references an offset pointing to a real local
		// header (signature 0x04034b50) at that position.
		const eocdOffset = zip.length - 22;
		let central = view.getUint32(eocdOffset + 16, true);
		for (let i = 0; i < 2; i++) {
			const localOffset = view.getUint32(central + 42, true);
			expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
			const nameLen = view.getUint16(central + 28, true);
			central += 46 + nameLen;
		}
	});
});
