// The card recognition (beta) is private and the public build leaves src/recognition/ out (docs/history/public-stubs-plan.md). That only works while the rest of `src/` reaches it
// through ONE door, src/card-recognition-entry.ts, whose public stand-in (src/card-recognition-entry.stub.ts) offers the same names. These tests fail the day someone imports the
// folder directly (the public copy would then not compile) or adds a name to one side only. Imports are read from the syntax tree, so a comment that merely quotes one is no problem.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `typescript` is CommonJS and the project has no `esModuleInterop`: `require` is the one form both `tsc` and Vitest accept (same reason as the publish script's own import).
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");

const SRC = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RECOGNITION = path.join(SRC, "recognition");
const ENTRY = path.join(SRC, "card-recognition-entry.ts");
const STUB = path.join(SRC, "card-recognition-entry.stub.ts");
const TYPES = path.join(SRC, "card-recognition-types.ts");

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" ? [] : sourceFiles(p);
		return e.name.endsWith(".ts") ? [p] : [];
	});
}

/** Every module specifier a file names: imports, `export … from`, `import()`, `require()` and the `vi.mock`/`vi.doMock`/`vi.importActual` of tests. */
export function moduleSpecifiers(text: string, fileName = "x.ts"): string[] {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const visit = (node: import("typescript").Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
		if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
			const callee = node.expression.getText(sf);
			if (callee === "import" || callee === "require" || /^vi\.(mock|doMock|importActual|importMock)$/.test(callee)) found.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

/** True when a relative specifier written in `fromFile` lands in src/recognition/. */
export function reachesRecognition(fromFile: string, specifier: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const target = path.resolve(path.dirname(fromFile), specifier);
	return target === RECOGNITION || target.startsWith(RECOGNITION + path.sep);
}

describe("the one door into src/recognition/", () => {
	it("nothing outside the folder imports it, except src/card-recognition-entry.ts", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC)) {
			if (file.startsWith(RECOGNITION + path.sep) || file === ENTRY) continue;
			for (const spec of moduleSpecifiers(fs.readFileSync(file, "utf8"), file)) {
				if (reachesRecognition(file, spec)) offenders.push(`${path.relative(SRC, file)} imports "${spec}"`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the entry only names the folder through its own re-export, and the stub and the types name nothing private", () => {
		for (const file of [STUB, TYPES]) {
			const specs = moduleSpecifiers(fs.readFileSync(file, "utf8"), file);
			expect(specs.filter((s) => reachesRecognition(file, s)), path.basename(file)).toEqual([]);
		}
		const entrySpecs = moduleSpecifiers(fs.readFileSync(ENTRY, "utf8"), ENTRY);
		expect(entrySpecs).toEqual(["./recognition/entry"]);
	});

	it("the real entry, the stub and the contract offer exactly the same names", () => {
		const entryText = fs.readFileSync(ENTRY, "utf8");
		const reexport = /export\s*\{([^}]*)\}\s*from/.exec(entryText);
		expect(reexport, "the entry must be one `export { … } from` line (never `export *`)").not.toBeNull();
		const entryNames = (reexport?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();

		const stubNames = [...fs.readFileSync(STUB, "utf8").matchAll(/^export const (\w+)/gm)].map((m) => m[1]).sort();

		const typesText = fs.readFileSync(TYPES, "utf8");
		const block = /export interface CardRecognitionEntry \{([\s\S]*?)\n\}/.exec(typesText);
		expect(block, "CardRecognitionEntry must stay an interface of the contract file").not.toBeNull();
		const contractNames = [...(block?.[1] ?? "").matchAll(/^\t(?:readonly )?(\w+)\s*[(:]/gm)].map((m) => m[1]).sort();

		expect(entryNames.length).toBeGreaterThan(0);
		expect(stubNames).toEqual(entryNames);
		expect(contractNames).toEqual(entryNames);
	});

	it("sees what it is meant to see (the detector can fail)", () => {
		const file = path.join(SRC, "modals", "x.ts");
		const text = [
			'import a from "../recognition/shared";',
			'export { b } from "../recognition/ui/card-scan";',
			'const c = await import("../recognition/scan");',
			'vi.mock("../recognition/fingerprint/scan-fingerprint", () => ({}));',
			'import type { D } from "../card-recognition-types";',
			'// import e from "../recognition/quoted-in-a-comment";',
		].join("\n");
		const hits = moduleSpecifiers(text, file).filter((s) => reachesRecognition(file, s));
		expect(hits).toEqual(["../recognition/shared", "../recognition/ui/card-scan", "../recognition/scan", "../recognition/fingerprint/scan-fingerprint"]);
		expect(reachesRecognition(path.join(SRC, "x.ts"), "./recognition")).toBe(true);
		expect(reachesRecognition(path.join(SRC, "x.ts"), "./recognition-other")).toBe(false);
	});
});
