import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A source audit, like the SUGGESTABLE_KEYWORDS one: a window's clean-up lives in its class's `onClose()`, and assigning `modal.onClose = ...` on an INSTANCE replaces it, so whatever the class
// releases there is silently skipped. It happened: the view re-rendered on close that way, and the scan window's `onClose` (scan cancelled, title reader and fingerprint base released) never ran
// on the real phone, so the 30 MB base stayed in memory (found measuring P4, docs/history/card-recognition-fingerprint-plan.md). A caller that wants to know a window closed passes an option
// (`onClosed`) or, when the class has no option, keeps the class's own method by chaining it: `const originalOnClose = modal.onClose.bind(modal); modal.onClose = () => { originalOnClose(); ... }`.
const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = `${dir}/${name}`;
		if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
	});
}

/** Every instance-level assignment to `onClose` that does not chain the class's own method on one of the 4 lines before it. */
export function unsafeOnCloseOverrides(files: Record<string, string>): string[] {
	const found: string[] = [];
	for (const [file, text] of Object.entries(files)) {
		const lines = text.split("\n");
		lines.forEach((line, i) => {
			if (!/\b\w+\.onClose\s*=(?!=)/.test(line)) return;
			const before = lines.slice(Math.max(0, i - 4), i).join("\n");
			if (!/\.onClose\.bind\(/.test(before)) found.push(`${file.slice(root.length)}:${i + 1}`);
		});
	}
	return found;
}

describe("modal onClose overrides", () => {
	it("no source file replaces a window's onClose without chaining the class's own", () => {
		const files = Object.fromEntries(sources(root).map((f) => [f, readFileSync(f, "utf8")]));
		expect(Object.keys(files).length).toBeGreaterThan(50);
		expect(unsafeOnCloseOverrides(files)).toEqual([]);
	});

	it("the audit itself can fail: a bare override is found, a chained one is not", () => {
		const bare = "const modal = new X();\nmodal.onClose = () => {\n\tthis.render();\n};";
		const chained = "const modal = new X();\nconst originalOnClose = modal.onClose.bind(modal);\nmodal.onClose = () => {\n\toriginalOnClose();\n};";
		expect(unsafeOnCloseOverrides({ [`${root}a.ts`]: bare })).toEqual(["a.ts:2"]);
		expect(unsafeOnCloseOverrides({ [`${root}b.ts`]: chained })).toEqual([]);
		expect(unsafeOnCloseOverrides({ [`${root}c.ts`]: "if (this.onClose === other) {}" })).toEqual([]);
	});
});
