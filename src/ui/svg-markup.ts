/* -------------------------------------------------------------------------- */
/*  Injection de SVG dans le DOM                                              */
/* -------------------------------------------------------------------------- */

// Seul endroit du plugin qui transforme une chaîne de balisage SVG en nœuds du DOM. Les entrées sont soit
// des constantes embarquées (logos, pictogrammes : brand-assets.ts), soit des SVG Scryfall (déjà passés par
// sanitizeSvg, api/scryfall.ts, avant leur mise en cache), soit du balisage généré par le plugin à partir de
// nombres (graphiques), soit — le seul cas réellement non maîtrisé — l'icône de ruban choisie par
// l'utilisateur (customIconSvg).
//
// Ce n'est plus `el.innerHTML = svg` (refusé par la revue du répertoire des plug-ins d'Obsidian) : la chaîne
// est analysée par DOMParser dans un document inerte, puis les nœuds sont RECONSTRUITS un à un, uniquement
// ceux d'une liste d'autorisations (éléments, attributs). Rien n'est ré-sérialisé, donc rien ne peut être
// réinterprété (pas de mXSS), et ce qui n'est pas listé disparaît : <script>, <style>, <foreignObject>, <a>,
// <image>, <use>, animations, attributs on*, href, style, commentaires. L'analyse reste celle du HTML (comme
// innerHTML) : un <svg> sans xmlns, ce que génèrent les graphiques, reste un <svg>.
//
// Liste établie sur les 470 SVG réellement injectés (84 symboles et 365 icônes d'édition Scryfall, logos,
// drapeaux, pictogrammes ; tools/harness/ab/svg-markup.html) : svg, g, path, rect, circle, defs, linearGradient,
// stop — et text/line/path/circle des graphiques, dont vector-effect (le trait de l'historique de prix garde son
// épaisseur malgré preserveAspectRatio="none" : oublié d'abord, c'est le banc A/B qui l'a montré). Le reste de la liste couvre les formes et le texte usuels
// d'une icône SVG fournie par l'utilisateur, pas plus.
//
// Conséquence assumée : une icône de ruban qui compte sur un <style> ou un attribut style (export Illustrator
// avec des classes st0/st1) perd ses couleurs ; ce <style> n'était de toute façon pas limité à son <svg>
// (une règle globale sur tout le plugin, voir le commentaire de brand-assets.ts).

const SVG_NS = "http://www.w3.org/2000/svg";

const ALLOWED_ELEMENTS = new Set([
	"svg", "g", "defs", "title", "desc",
	"path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
	"text", "tspan",
	"linearGradient", "radialGradient", "stop", "clipPath", "mask",
]);

const ALLOWED_ATTRIBUTES = new Set([
	// structure
	"xmlns", "version", "id", "class", "role", "viewBox", "preserveAspectRatio", "transform",
	// géométrie
	"x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "d", "points", "dx", "dy",
	// dégradés, masques
	"gradientTransform", "gradientUnits", "spreadMethod", "offset", "clipPathUnits", "maskUnits", "maskContentUnits",
	// présentation
	"fill", "fill-opacity", "fill-rule", "clip-rule", "clip-path", "mask", "opacity", "isolation", "vector-effect", "shape-rendering",
	"stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
	"stop-color", "stop-opacity",
	// texte
	"text-anchor", "dominant-baseline", "font-family", "font-size", "font-weight", "letter-spacing",
]);

// Un nom d'attribut accepté : celui de la liste, ou data-*/aria-* (inertes).
function isAllowedAttributeName(name: string): boolean {
	return ALLOWED_ATTRIBUTES.has(name) || /^(data|aria)-[a-z0-9_.-]+$/i.test(name);
}

// Une valeur acceptée : toute référence url(...) ne pointe que vers un identifiant du même SVG (« url(#id) »,
// celui des dégradés). Aucune ressource externe ne peut être chargée par un attribut de présentation.
function isSafeAttributeValue(value: string): boolean {
	for (const match of value.matchAll(/url\(\s*['"]?\s*([^)'"]*)/gi)) {
		if (!match[1].trim().startsWith("#")) return false;
	}
	return true;
}

function cloneAllowed(node: Node, doc: Document): Node | null {
	if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.nodeValue ?? "");
	// Commentaires, instructions (<?xml … ?>), tout le reste : jamais utiles à l'affichage.
	if (node.nodeType !== Node.ELEMENT_NODE) return null;
	const source = node as Element;
	if (source.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(source.localName)) return null;

	const copy = doc.createElementNS(SVG_NS, source.localName);
	for (const attr of Array.from(source.attributes)) {
		if (!isAllowedAttributeName(attr.name) || !isSafeAttributeValue(attr.value)) continue;
		// xmlns est le seul attribut à espace de noms de la liste (celui de xmlns lui-même) : l'analyse HTML le range
		// dans l'espace de noms XMLNS, il est recopié tel quel pour que le DOM soit celui qu'innerHTML produisait.
		if (attr.namespaceURI) copy.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
		else copy.setAttribute(attr.name, attr.value);
	}
	for (const child of Array.from(source.childNodes)) {
		const clean = cloneAllowed(child, doc);
		if (clean) copy.appendChild(clean);
	}
	return copy;
}

export function setSvgMarkup(el: HTMLElement, svg: string): void {
	const parsed = new DOMParser().parseFromString(svg, "text/html");
	const nodes: Node[] = [];
	for (const node of Array.from(parsed.body.childNodes)) {
		const clean = cloneAllowed(node, el.ownerDocument);
		if (clean) nodes.push(clean);
	}
	el.replaceChildren(...nodes);
}
