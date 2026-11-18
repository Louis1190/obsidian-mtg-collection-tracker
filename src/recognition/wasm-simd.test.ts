import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReaderUnsupportedError, WASM_SIMD_PROBE, wasmSimdSupported } from "./wasm-simd";

describe("wasmSimdSupported", () => {
	it("is true when the engine validates the probe and hands it the probe's own bytes", () => {
		const seen: BufferSource[] = [];
		expect(
			wasmSimdSupported({
				validate: (b) => {
					seen.push(b);
					return true;
				},
			}),
		).toBe(true);
		expect(seen).toEqual([WASM_SIMD_PROBE]);
	});

	it("is false when the engine refuses the probe (a browser without SIMD)", () => {
		expect(wasmSimdSupported({ validate: () => false })).toBe(false);
	});

	it("is false when there is no WebAssembly at all, or validate throws, or answers something that is not true", () => {
		expect(wasmSimdSupported(null)).toBe(false);
		expect(
			wasmSimdSupported({
				validate: () => {
					throw new Error("boom");
				},
			}),
		).toBe(false);
		expect(wasmSimdSupported({ validate: () => "yes" as unknown as boolean })).toBe(false);
	});

	it("asks the real engine of this machine, and the probe is a real SIMD module there", () => {
		// the default argument: node's own WebAssembly, which has SIMD
		expect(wasmSimdSupported()).toBe(true);
		expect(WebAssembly.validate(WASM_SIMD_PROBE)).toBe(true);
		// it can fail: the same bytes with the SIMD instruction broken are not a valid module
		const broken = WASM_SIMD_PROBE.slice();
		broken[broken.length - 3] = 0xff;
		expect(WebAssembly.validate(broken)).toBe(false);
		expect(wasmSimdSupported({ validate: () => WebAssembly.validate(broken) })).toBe(false);
		// and the probe uses the SIMD prefix (0xfd) twice, which is what a browser without SIMD cannot compile
		expect(Array.from(WASM_SIMD_PROBE).filter((b) => b === 0xfd)).toHaveLength(2);
	});

	// the worker script of the engine carries wasm-feature-detect: the probe must be the module ITS `simd()` validates, or this check could say yes where the engine says no
	const detector = "node_modules/wasm-feature-detect/dist/esm/index.js";
	it.skipIf(!existsSync(detector))("is the module wasm-feature-detect's own SIMD detector validates", () => {
		expect(readFileSync(detector, "utf8")).toContain(`simd=async()=>WebAssembly.validate(new Uint8Array([${Array.from(WASM_SIMD_PROBE).join(",")}]))`);
	});
});

describe("ReaderUnsupportedError", () => {
	it("is an Error with a plain message and its own name", () => {
		const e = new ReaderUnsupportedError();
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("ReaderUnsupportedError");
		expect(e.message).toContain("WebAssembly SIMD");
	});
});
