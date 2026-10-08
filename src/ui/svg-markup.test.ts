// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { setSvgMarkup } from "./svg-markup";

const SVG_NS = "http://www.w3.org/2000/svg";

function inject(svg: string): HTMLElement {
	const el = document.createElement("div");
	setSvgMarkup(el, svg);
	return el;
}

// All the elements (and their attributes) of the result, to assert what remained.
function describeTree(root: Element): string[] {
	const out: string[] = [];
	const walk = (e: Element) => {
		out.push(`${e.namespaceURI === SVG_NS ? "svg:" : "other:"}${e.localName}[${Array.from(e.attributes).map((a) => a.name).join(",")}]`);
		for (const c of Array.from(e.children)) walk(c);
	};
	for (const c of Array.from(root.children)) walk(c);
	return out;
}

describe("setSvgMarkup: what a real icon keeps", () => {
	it("keeps an icon exactly as innerHTML parsed it (case-adjusted names, xmlns, gradients, paint references)", () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" version="1.1"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="1">' +
			'<stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0L5 5" fill="url(#g)" fill-rule="evenodd"/><circle cx="1" cy="1" r="1"/><rect x="0" y="0" width="2" height="2" rx="1"/></svg>';
		const el = inject(svg);
		const reference = document.createElement("div");
		reference.innerHTML = svg;
		expect(el.innerHTML).toBe(reference.innerHTML);
		expect(el.querySelector("linearGradient")).not.toBeNull();
		expect(el.querySelector("svg")?.namespaceURI).toBe(SVG_NS);
	});

	it("still makes an <svg> of markup without xmlns (the generated charts)", () => {
		const el = inject('<svg viewBox="0 0 10 10" class="chart" role="img" aria-label="Mana curve"><text x="1" y="2" text-anchor="middle">7</text><line x1="0" y1="0" x2="1" y2="1" stroke="#999" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>');
		expect(el.querySelector("line")?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
		const svg = el.querySelector("svg");
		expect(svg?.namespaceURI).toBe(SVG_NS);
		expect(svg?.getAttribute("aria-label")).toBe("Mana curve");
		expect(el.querySelector("text")?.textContent).toBe("7");
		expect(el.querySelector("line")?.namespaceURI).toBe(SVG_NS);
	});

	it("keeps the whitespace after the element and drops the <?xml?> preamble and comments", () => {
		const el = inject('<?xml version="1.0" encoding="UTF-8"?><!-- generator --><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>\n');
		expect(el.childNodes.length).toBe(2);
		expect(el.firstElementChild?.localName).toBe("svg");
		expect(el.lastChild?.nodeValue).toBe("\n");
	});

	it("replaces what the element already held", () => {
		const el = document.createElement("div");
		el.append("old text", document.createElement("span"));
		setSvgMarkup(el, '<svg viewBox="0 0 1 1"/>');
		expect(el.childNodes.length).toBe(1);
		expect(el.firstElementChild?.localName).toBe("svg");
	});

	it("keeps text as text, never as markup", () => {
		const el = inject('<svg><text>a &lt;b&gt; &amp; "c"</text></svg>');
		expect(el.querySelector("text")?.textContent).toBe('a <b> & "c"');
		expect(el.querySelector("b")).toBeNull();
	});
});

describe("setSvgMarkup: what it refuses", () => {
	it("drops scripts, event handlers and javascript links", () => {
		const el = inject(
			'<svg onload="alert(1)" viewBox="0 0 1 1"><script>alert(2)</script><path d="M0 0" onclick="alert(3)" onmouseover=alert(4)/>' +
				'<a href="javascript:alert(5)"><path d="M1 1"/></a></svg>'
		);
		expect(describeTree(el)).toEqual(["svg:svg[viewBox]", "svg:path[d]"]);
		expect(el.innerHTML).not.toMatch(/alert|script|onload|onclick|javascript/i);
	});

	it("drops foreignObject (and the HTML inside it), animations, images, use, style and unknown elements", () => {
		const el = inject(
			'<svg><foreignObject><div onclick="x()">hi</div><iframe src="//evil.test"></iframe></foreignObject>' +
				'<animate attributeName="href" values="javascript:alert(1)"/><set attributeName="onload" to="alert(1)"/><animateTransform/>' +
				'<image href="https://evil.test/p.png"/><use href="https://evil.test/x.svg#a"/><style>@import url(https://evil.test/a.css);</style>' +
				'<filter><feImage href="https://evil.test/p.png"/></filter><marquee>m</marquee><path d="M0 0"/></svg>'
		);
		expect(describeTree(el)).toEqual(["svg:svg[]", "svg:path[d]"]);
		expect(el.innerHTML).not.toMatch(/evil|alert|iframe|import/i);
	});

	it("drops HTML elements at the top level and mutation-XSS shapes", () => {
		const el = inject(
			'<div id="x"><img src=x onerror=alert(1)></div><svg></p><style><a id="</style><img src=1 onerror=alert(2)>"></style><path d="M0 0"/></svg><img src=y onerror=alert(3)>'
		);
		// Where the HTML parser puts the rest of the payload matters little: only allowed SVG elements must remain, and
		// none of the dangerous nodes (neither <style> nor <img>) that it was trying to make appear.
		const tree = describeTree(el);
		expect(tree.length).toBeGreaterThan(0);
		expect(tree.every((line) => line.startsWith("svg:"))).toBe(true);
		expect(el.innerHTML).not.toMatch(/onerror|alert|<img|<div|<style/i);
	});

	it("drops href, xlink:href, style and any attribute outside the list", () => {
		const el = inject(
			'<svg xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0" href="#a" xlink:href="https://evil.test" style="position:fixed;background:url(https://evil.test/x)" ' +
				'data-v-abc="1" aria-hidden="true" tabindex="0" autofocus nonsense="1"/></svg>'
		);
		expect(describeTree(el)).toEqual(["svg:svg[]", "svg:path[d,data-v-abc,aria-hidden]"]);
	});

	it("only lets url() point inside the SVG", () => {
		const el = inject(
			'<svg><path d="M0 0" fill="url(#ok)"/><path d="M1 1" fill="url(https://evil.test/a.svg#x)"/><path d="M2 2" stroke="url( \'#quoted\' )"/>' +
				'<path d="M3 3" filter="url(//evil.test/f.svg#f)"/><path d="M4 4" fill="URL(data:image/svg+xml;base64,AAAA)"/></svg>'
		);
		expect(describeTree(el)).toEqual(["svg:svg[]", "svg:path[d,fill]", "svg:path[d]", "svg:path[d,stroke]", "svg:path[d]", "svg:path[d]"]);
	});

	it("survives garbage without throwing", () => {
		for (const junk of ["", "   ", "<", "<svg", "<<<>>>", "<svg><path d='", "\u0000<svg>\u0000", "<svg><svg><svg>".repeat(200), "<svg a:b='1' data-a:b='2' data-=\"3\"/>"]) {
			expect(() => inject(junk)).not.toThrow();
		}
		expect(inject("").childNodes.length).toBe(0);
	});
});
