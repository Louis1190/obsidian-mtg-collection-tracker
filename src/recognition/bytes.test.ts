import { describe, expect, it } from "vitest";
import { base64ToBytes } from "./bytes";

describe("base64ToBytes", () => {
	it("decodes text, binary values, padding and the empty string", () => {
		expect(Array.from(base64ToBytes("SGVsbG8="))).toEqual([72, 101, 108, 108, 111]);
		expect(Array.from(base64ToBytes("AP8A/w=="))).toEqual([0, 255, 0, 255]);
		expect(Array.from(base64ToBytes("QQ=="))).toEqual([65]);
		expect(base64ToBytes("")).toHaveLength(0);
	});
	it("round-trips every byte value, and a megabyte without trouble", () => {
		const all = Uint8Array.from({ length: 256 }, (_, i) => i);
		expect(Array.from(base64ToBytes(Buffer.from(all).toString("base64")))).toEqual(Array.from(all));
		const big = new Uint8Array(1 << 20).map((_, i) => (i * 31) & 255);
		const t0 = performance.now();
		const back = base64ToBytes(Buffer.from(big).toString("base64"));
		expect(back).toHaveLength(big.length);
		expect(back[777777]).toBe(big[777777]);
		expect(performance.now() - t0).toBeLessThan(2000);
	});
});
