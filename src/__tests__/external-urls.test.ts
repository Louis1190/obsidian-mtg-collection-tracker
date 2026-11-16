import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// A source audit, like the HTML one: every link that opens in the browser either goes through `openExternalUrl`
// (ui/card-detail-fx.ts), which refuses anything that is not an https address, or is written out as a LITERAL https
// address in the call. Some addresses come from what a third-party API answered (purchase links) or from a table:
// those must use the door, so the https check cannot be forgotten by the next link someone adds. A literal needs no
// check (nothing external can reach it) and is kept on purpose where it exists: the directory's scanner lists the
// literal destinations, which is how the README's "Links that open in your browser" table gets checked
// (docs/obsidian-compliance.md, "Disclosures": moving them into the door was considered and declined). Found by the
// audit of 2026-11-15 (docs/history/code-audit-2026-11-15.md): two table-driven links still called `window.open`.
const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = `${dir}/${name}`;
		if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
	});
}

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "top", "parent"]);
const DOOR = "openExternalUrl";

function insideDoor(node: ts.Node): boolean {
	for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
		if (ts.isFunctionDeclaration(n) && n.name?.text === DOOR) return true;
	}
	return false;
}

// A destination that is written in the source: a plain string, or a template whose fixed head already names the
// host ("https://www.example.com/search?q=${encoded}"). Only what follows the host is computed, so nothing external
// can change where the link goes or its scheme.
function isLiteralHttps(arg: ts.Expression | undefined): boolean {
	if (!arg) return false;
	if (ts.isStringLiteralLike(arg)) return /^https:\/\/[^/]/i.test(arg.text);
	if (ts.isTemplateExpression(arg)) return /^https:\/\/[^/$]+\//i.test(arg.head.text);
	return false;
}

/** Every `window.open(...)` outside the door itself whose destination is not a literal https address, as "file:line". */
export function directOpenSites(files: Record<string, string>): string[] {
	const found: string[] = [];
	for (const [file, text] of Object.entries(files)) {
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression;
				const viaGlobal =
					ts.isPropertyAccessExpression(callee) &&
					callee.name.text === "open" &&
					ts.isIdentifier(callee.expression) &&
					GLOBAL_OBJECTS.has(callee.expression.text);
				const viaBracket =
					ts.isElementAccessExpression(callee) &&
					ts.isStringLiteralLike(callee.argumentExpression) &&
					callee.argumentExpression.text === "open" &&
					ts.isIdentifier(callee.expression) &&
					GLOBAL_OBJECTS.has(callee.expression.text);
				if ((viaGlobal || viaBracket) && !insideDoor(node) && !isLiteralHttps(node.arguments[0])) {
					const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
					found.push(`${file.startsWith(root) ? file.slice(root.length) : file}:${line}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return found;
}

describe("links that open in the browser", () => {
	it("every computed destination goes through openExternalUrl (a literal https address may stay)", () => {
		const files = Object.fromEntries(sources(root).map((f) => [f, readFileSync(f, "utf8")]));
		expect(Object.keys(files).length).toBeGreaterThan(50);
		expect(directOpenSites(files)).toEqual([]);
	});

	it("the door exists, still checks the scheme, and is the one place that opens a window", () => {
		const text = readFileSync(`${root}/ui/card-detail-fx.ts`, "utf8");
		const door = /export function openExternalUrl\([^)]*\): void \{([\s\S]*?)\n\}/.exec(text);
		expect(door).not.toBeNull();
		expect(door![1]).toMatch(/https:\\\/\\\//);
		expect(door![1]).toMatch(/window\.open\(/);
	});

	it("the audit itself can fail: a computed destination is found; the door's own call, literals, comments and strings are not", () => {
		const bad: Record<string, string> = {
			"a.ts": 'window.open(source.url, "_blank");',
			"b.ts": "\n\nel.addEventListener('click', () => window.open(url));",
			"c.ts": "globalThis.open(url);",
			"d.ts": 'window["open"](url);',
			// a computed head: the host itself comes from outside
			"e.ts": "window.open(`${base}/path`);",
			// not https
			"f.ts": 'window.open("http://example.com");',
			"g.ts": 'window.open("javascript:alert(1)");',
			// no host in the fixed part: only a scheme followed by data
			"h.ts": "window.open(`https://${host}/x`);",
			"i.ts": "window.open();",
		};
		expect(directOpenSites(bad)).toEqual(["a.ts:1", "b.ts:3", "c.ts:1", "d.ts:1", "e.ts:1", "f.ts:1", "g.ts:1", "h.ts:1", "i.ts:1"]);
		const fine: Record<string, string> = {
			"l.ts": 'window.open("https://example.com/page", "_blank");',
			"m.ts": "window.open(`https://www.example.com/search?q=${encodeURIComponent(name)}`, '_blank');",
			"a.ts": 'export function openExternalUrl(url: string): void {\n\tif (!/^https:\\/\\//i.test(url)) return;\n\twindow.open(url, "_blank");\n}',
			"b.ts": "// window.open(url) is only allowed in the door\nconst s = 'window.open(x)';\nopenExternalUrl(url);",
			"c.ts": "const file = reader.open(path);\nmodal.open();\nfs.open(p);",
		};
		expect(directOpenSites(fine)).toEqual([]);
	});
});
