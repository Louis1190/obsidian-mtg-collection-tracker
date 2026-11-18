// Whether this device's browser engine can run the OCR engine at all. The engine the plugin embeds is the WebAssembly build that uses SIMD instructions
// (tesseract-core-simd-lstm, see assets.ts); an engine without them (an old iOS, an old Android WebView; the exact versions are not checked here)
// cannot even compile it, and Tesseract.js then fails with whatever the browser says about an unknown instruction. Asking first turns that raw message into a
// plain sentence, and spares the device decoding 8 MB of engine it cannot run.

/**
 * The module Tesseract.js's own feature detector (wasm-feature-detect 1.9.0, `simd`) validates: a function returning a v128 value. A browser that does not know SIMD
 * says it is not valid, whatever else it supports. Kept byte for byte equal to that detector's (a test reads it in node_modules).
 */
export const WASM_SIMD_PROBE = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** The part of the WebAssembly object this file uses. */
export interface WasmValidator {
	validate(bytes: BufferSource): boolean;
}

/** True only when the engine says the SIMD probe is valid; no WebAssembly at all (`null`), or a `validate` that throws, is "no". */
export function wasmSimdSupported(wasm: WasmValidator | null = typeof WebAssembly === "undefined" ? null : WebAssembly): boolean {
	if (!wasm) return false;
	try {
		return wasm.validate(WASM_SIMD_PROBE) === true;
	} catch {
		return false;
	}
}

/** Thrown, before anything is decoded or started, when the OCR engine cannot run on this device (the title cannot be read; the image fingerprint does not need it). */
export class ReaderUnsupportedError extends Error {
	constructor() {
		super("This device's browser engine does not support WebAssembly SIMD.");
		this.name = "ReaderUnsupportedError";
	}
}
