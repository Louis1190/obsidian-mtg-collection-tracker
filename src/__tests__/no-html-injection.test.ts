import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// A source audit, like the `onClose` one: nothing in `src/` may turn a string into DOM by HTML parsing. The ONE place that
// turns SVG text into nodes is `setSvgMarkup` (ui/svg-markup.ts): it parses in an inert document and rebuilds only an
// allow-list of elements and attributes. The regex cleanup that used to sit in front of it (`sanitizeSvg`) was removed on
// 2026-11-14 because CodeQL kept flagging it as incomplete and the allow-list already did everything it did, so that
// allow-list is the single barrier now: a path that put markup into the page another way (`innerHTML`, `outerHTML`,
// `insertAdjacentHTML`, `createContextualFragment`, `srcdoc`, `document.write`) would skip it, with nothing behind it.
// The directory's own review rejects `innerHTML` as well. The audit reads the syntax tree, not the text, so a comment,
// a string, or a plain READ of `innerHTML` (tests and benches do that) never counts.
const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = `${dir}/${name}`;
		if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
	});
}

const SINK_PROPERTIES = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const SINK_METHODS = new Set(["insertAdjacentHTML", "createContextualFragment", "setHTMLUnsafe", "parseHTMLUnsafe"]);
const WRITE_ASSIGNMENTS = new Set<ts.SyntaxKind>([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken]);

function isDocumentLike(expr: ts.Expression): boolean {
	return (ts.isIdentifier(expr) && expr.text === "document") || (ts.isPropertyAccessExpression(expr) && (expr.name.text === "document" || expr.name.text === "ownerDocument"));
}

/** Every place that writes HTML into the page, as "file:line what". */
export function htmlInjectionSites(files: Record<string, string>): string[] {
	const found: string[] = [];
	for (const [file, text] of Object.entries(files)) {
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
		const report = (node: ts.Node, what: string) => {
			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
			found.push(`${file.startsWith(root) ? file.slice(root.length) : file}:${line} ${what}`);
		};
		const visit = (node: ts.Node) => {
			if (ts.isBinaryExpression(node) && WRITE_ASSIGNMENTS.has(node.operatorToken.kind)) {
				const left = node.left;
				if (ts.isPropertyAccessExpression(left) && SINK_PROPERTIES.has(left.name.text)) report(node, `assigns .${left.name.text}`);
				if (ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression) && SINK_PROPERTIES.has(left.argumentExpression.text)) {
					report(node, `assigns ["${left.argumentExpression.text}"]`);
				}
			}
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
				const callee = node.expression;
				if (SINK_METHODS.has(callee.name.text)) report(node, `calls .${callee.name.text}()`);
				if ((callee.name.text === "write" || callee.name.text === "writeln") && isDocumentLike(callee.expression)) report(node, `calls document.${callee.name.text}()`);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return found;
}

describe("HTML injection", () => {
	it("no source file turns a string into DOM by HTML parsing (setSvgMarkup is the one barrier)", () => {
		const files = Object.fromEntries(sources(root).map((f) => [f, readFileSync(f, "utf8")]));
		expect(Object.keys(files).length).toBeGreaterThan(50);
		expect(htmlInjectionSites(files)).toEqual([]);
	});

	it("the audit itself can fail: every sink is found, and comments, strings and reads are not", () => {
		const bad: Record<string, string> = {
			"a.ts": "el.innerHTML = svg;",
			"b.ts": "\n\nel.outerHTML += x;",
			"c.ts": 'el["innerHTML"] = svg;',
			"d.ts": 'el.insertAdjacentHTML("beforeend", svg);',
			"e.ts": "const f = range.createContextualFragment(svg);",
			"f.ts": "document.write(svg);",
			"g.ts": "frame.srcdoc = html;",
			"h.ts": "el.ownerDocument.writeln(svg);",
		};
		expect(htmlInjectionSites(bad).map((s) => s.split(" ")[0])).toEqual(["a.ts:1", "b.ts:3", "c.ts:1", "d.ts:1", "e.ts:1", "f.ts:1", "g.ts:1", "h.ts:1"]);
		const fine: Record<string, string> = {
			"a.ts": "// this is no longer `el.innerHTML = svg`\n/* el.outerHTML = x */\nconst s = 'el.innerHTML = svg';",
			"b.ts": "const html = el.innerHTML;\nif (el.innerHTML === other.innerHTML) {}",
			"c.ts": "await adapter.write(path, data);\nstream.write(chunk);\nel.replaceChildren(...nodes);",
		};
		expect(htmlInjectionSites(fine)).toEqual([]);
	});
});
