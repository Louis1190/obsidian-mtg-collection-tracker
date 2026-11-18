// Bytes and text of the files main.js carries (the `embed:` modules hold them as base64). Pure.

/** base64 -> bytes. `atob` exists everywhere the plugin runs (Electron, Android WebView, iOS WebKit). */
export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
