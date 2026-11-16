// JSON text that does not come from this device (a data file another device wrote, the GitHub data repository, a
// backup file someone sent) may carry a key named "__proto__": JSON.parse creates it as an OWN property, and any
// later `obj[key] = ...` / `obj[key] ??= {}` with that key reaches Object.prototype. The merge layer is guarded too
// (settings-merge.ts, UNSAFE_KEYS); dropping the key at the door means nothing else ever sees it, including code
// that does not exist yet. See docs/history/code-audit-2026-11-15.md.

// The reviver that removes it (returning undefined deletes the property).
const dropProtoKey = (key: string, value: unknown): unknown => (key === "__proto__" ? undefined : value);

// A reviver makes JSON.parse about six times slower (measured 2026-11-15 on the real 6.5 MB data.json: 24 ms against
// 136 ms), and this runs at every start and at every external change, so it is only used when the text can contain
// the key at all. The key can be written plainly ("__proto__") or through a \u escape (JSON decodes escapes in keys),
// and those are the only two ways: no other escape produces an underscore. Our own files never hold a backslash-u
// (JSON.stringify leaves non-ASCII text as it is), so legitimate data takes the plain path.
export function mayCarryProtoKey(text: string): boolean {
	return text.includes("__proto__") || text.includes("\\u");
}

// JSON.parse for text from outside: same result, minus any "__proto__" key at any depth. Throws on invalid JSON
// like JSON.parse does.
export function parseExternalJson(text: string): unknown {
	return mayCarryProtoKey(text) ? JSON.parse(text, dropProtoKey) : JSON.parse(text);
}

// The same, for the callers that want a plain object (a settings file, a shard): anything else is `null`, and so is
// invalid JSON.
export function parseExternalJsonObject(text: string): Record<string, unknown> | null {
	try {
		const v = parseExternalJson(text);
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}
