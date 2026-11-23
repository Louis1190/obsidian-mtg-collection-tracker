import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// A source audit, like the `onClose` and HTML-injection ones: nothing in `src/` may read the global `document`. That one is ALWAYS the
// main window's. A view dragged into a popout window lives in another document with its own viewport, so a menu, a class or a listener put
// on `document` ends up in the wrong window. What to write instead depends on what the code has at hand: `activeDocument` (Obsidian's
// global: the document of the window that has focus) for "where is the person now", or `el.ownerDocument` for a node that belongs to a
// known element. The directory's lint (`obsidianmd/prefer-active-doc`) says the same, but the lint is not part of the release CI.
// The audit reads the syntax tree, so a comment, a string or a property called `document` never counts.
const root = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = `${dir}/${name}`;
		if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
	});
}

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

/** Every read of the main window's document, as "file:line what". */
export function bareDocumentSites(files: Record<string, string>): string[] {
	const found: string[] = [];
	for (const [file, text] of Object.entries(files)) {
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
		const report = (node: ts.Node, what: string) => {
			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
			found.push(`${file.startsWith(root) ? file.slice(root.length) : file}:${line} ${what}`);
		};
		const visit = (node: ts.Node) => {
			if (ts.isIdentifier(node) && node.text === "document") {
				const parent = node.parent;
				// `x.document`, a declaration's own name, an object key and an import/export name are not a read of the global.
				const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
				const isDeclaredName =
					((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node) ||
					((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) ||
					ts.isImportSpecifier(parent) ||
					ts.isExportSpecifier(parent);
				if (!isMemberName && !isDeclaredName) report(node, "reads `document`");
			}
			if (ts.isPropertyAccessExpression(node) && node.name.text === "document" && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)) {
				report(node, `reads ${node.expression.text}.document`);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return found;
}

describe("popout windows", () => {
	it("no source file reads the global `document` (it is the main window's): activeDocument or the element's ownerDocument", () => {
		const files = Object.fromEntries(sources(root).map((f) => [f, readFileSync(f, "utf8")]));
		expect(Object.keys(files).length).toBeGreaterThan(50);
		expect(bareDocumentSites(files)).toEqual([]);
	});

	it("the audit itself can fail: every spelling of a read is found, and comments, strings and members are not", () => {
		const bad: Record<string, string> = {
			"a.ts": "document.body.appendChild(el);",
			"b.ts": "\n\nconst b = document.body;",
			"c.ts": "if (typeof document === 'undefined') return;",
			"d.ts": "registerDomEvent(document, 'click', fn);",
			"e.ts": "window.document.body.focus();",
			"f.ts": "globalThis.document.querySelector('x');",
			"g.ts": "const d = document.createElementNS(ns, 'g');",
		};
		expect(bareDocumentSites(bad).map((s) => s.split(" ")[0])).toEqual(["a.ts:1", "b.ts:3", "c.ts:1", "d.ts:1", "e.ts:1", "f.ts:1", "g.ts:1"]);
		const fine: Record<string, string> = {
			"a.ts": "// document.body is the main window's\n/* document.body */\nconst s = 'document.body';",
			"b.ts": "activeDocument.body.appendChild(el);\nel.ownerDocument.createTextNode(t);\nconst d = anchor.doc;",
			"c.ts": "const x = evt.view.document;\nconst o = { document: 1 };\nfunction f(document: Document) {}\nconst { document } = ctx;",
		};
		expect(bareDocumentSites(fine)).toEqual([]);
	});
});
