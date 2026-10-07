import { ColorSlice, ManaCurveBucket, TypeSlice } from "../core/deck-stats";
import { setSvgMarkup } from "./svg-markup";

/* -------------------------------------------------------------------------- */
/*  Vue "Stats" de My Decks (2026-09-02) — 3 graphiques dessinés à la main,  */
/*  aucune librairie de charting (même posture déjà établie pour le graphique */
/*  "Price History", voir card-detail-fx.ts/CLAUDE.md : rien de ce plugin ne */
/*  dépend d'une librairie externe pour un besoin de cette taille). Coloré   */
/*  via des classes CSS (styles.css), jamais du texte SVG en fill direct —  */
/*  même convention que le reste de ce plugin pour un <text> intégré en SVG. */
/*  Contrairement au graphique "Price History", pas de preserveAspectRatio=  */
/*  "none" ici (rien à étirer indépendamment en X/Y comme une série          */
/*  temporelle) : le viewBox par défaut (xMidYMid meet) suffit, donc du      */
/*  texte SVG classique reste correctement proportionné à toute taille — pas */
/*  besoin du repli "labels en HTML par-dessus" que ce graphique-là a dû     */
/*  utiliser pour cette même raison.                                        */
/* -------------------------------------------------------------------------- */

const CURVE_WIDTH = 400;
const CURVE_HEIGHT = 190;
const CURVE_BAR_GAP = 8;
const CURVE_BOTTOM_RESERVE = 22; // hauteur réservée en bas pour les libellés de CMC
// Hauteur réservée en HAUT pour le libellé de compte de la barre la plus
// haute — un bug réel trouvé en vérifiant dans le navigateur, pas seulement
// en relisant le code : sans cette réserve, une barre atteignant 100% de
// plotHeight place son <text> à `y - 5`, donc AU-DESSUS de y=0 (hors du
// viewBox) — un <svg> racine clippe silencieusement tout ce qui dépasse son
// viewBox par défaut (pas d'overflow:visible), donc ce libellé disparaissait
// purement et simplement pour le bac le plus haut, précisément celui où le
// nombre est le plus important à lire.
const CURVE_TOP_RESERVE = 16;

export function renderManaCurveChart(container: HTMLElement, buckets: ManaCurveBucket[]) {
	container.createDiv({ cls: "mtg-deck-stats-title", text: "Mana curve" });
	const total = buckets.reduce((s, b) => s + b.count, 0);
	if (total === 0) {
		container.createDiv({ cls: "mtg-deck-stats-empty", text: "No non-land spells in this deck yet." });
		return;
	}
	const maxCount = Math.max(1, ...buckets.map((b) => b.count));
	const n = buckets.length;
	const barWidth = (CURVE_WIDTH - CURVE_BAR_GAP * (n - 1)) / n;
	const baseline = CURVE_HEIGHT - CURVE_BOTTOM_RESERVE;
	const plotHeight = baseline - CURVE_TOP_RESERVE;
	const bars = buckets
		.map((b, i) => {
			const x = i * (barWidth + CURVE_BAR_GAP);
			// Une hauteur plancher de 2px pour un bac non-vide : une barre à
			// 1px ou moins devient visuellement indiscernable d'une barre
			// vide, alors que le compte au-dessus (voir countLabel) montre
			// bien qu'il y a réellement au moins une carte.
			const h = b.count > 0 ? Math.max((b.count / maxCount) * plotHeight, 2) : 0;
			const y = baseline - h;
			const countLabel =
				b.count > 0
					? `<text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" class="mtg-deck-stats-bar-count">${b.count}</text>`
					: "";
			return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="3" class="mtg-deck-stats-bar" />${countLabel}<text x="${x + barWidth / 2}" y="${CURVE_HEIGHT - 6}" text-anchor="middle" class="mtg-deck-stats-bar-label">${b.label}</text>`;
		})
		.join("");
	const wrap = container.createDiv({ cls: "mtg-deck-stats-svg-wrap" });
	setSvgMarkup(wrap, `<svg viewBox="0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}" class="mtg-deck-stats-svg" role="img" aria-label="Mana curve">${bars}</svg>`);
}

const PIE_SIZE = 120;
const PIE_CENTER = PIE_SIZE / 2;
const PIE_RADIUS = 54;

function polarToCartesian(angleDeg: number): { x: number; y: number } {
	const rad = ((angleDeg - 90) * Math.PI) / 180;
	return { x: PIE_CENTER + PIE_RADIUS * Math.cos(rad), y: PIE_CENTER + PIE_RADIUS * Math.sin(rad) };
}

// Une seule tranche à 100% ne peut pas se dessiner comme UN arc classique
// (point de départ === point d'arrivée, l'arc SVG dégénère) — un cercle
// complet, dessiné en 2 demi-arcs, plutôt qu'un cas particulier séparé.
function describeSlice(startAngle: number, endAngle: number): string {
	if (endAngle - startAngle >= 359.99) {
		return `M ${PIE_CENTER - PIE_RADIUS} ${PIE_CENTER} A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 0 ${PIE_CENTER + PIE_RADIUS} ${PIE_CENTER} A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 0 ${PIE_CENTER - PIE_RADIUS} ${PIE_CENTER} Z`;
	}
	const start = polarToCartesian(endAngle);
	const end = polarToCartesian(startAngle);
	const largeArcFlag = endAngle - startAngle > 180 ? "1" : "0";
	return `M ${PIE_CENTER} ${PIE_CENTER} L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArcFlag} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

// showTitle=false (2026-09-23, Home's "By Color"/"By Rarity" blocks,
// home-render.ts): those already carry their own icon+title via
// makeHomeBlock, so this function's own internal title would just double
// it up — the Deck Stats modal call site (unchanged, no 3rd argument)
// keeps its title exactly as before via the default.
export function renderColorPieChart(container: HTMLElement, slices: ColorSlice[], showTitle = true) {
	if (showTitle) container.createDiv({ cls: "mtg-deck-stats-title", text: "Color breakdown" });
	const total = slices.reduce((s, sl) => s + sl.count, 0);
	if (total === 0) {
		container.createDiv({ cls: "mtg-deck-stats-empty", text: "No cards to break down yet." });
		return;
	}
	let angle = 0;
	const paths = slices
		.map((s) => {
			const sweep = (s.count / total) * 360;
			const d = describeSlice(angle, angle + sweep);
			angle += sweep;
			// Couleur réelle (GROUP_LABEL_HEX, core/card-sorting.ts) directement
			// en fill — pas une valeur dépendante du thème comme le reste de ce
			// fichier (var(--...)) : ces 5 couleurs de mana/Multicolor/Land/
			// Colorless sont des faits sur le deck lui-même, pas une teinte
			// d'interface qui doit s'adapter au thème clair/sombre.
			return `<path d="${d}" fill="${s.color}" />`;
		})
		.join("");
	const flex = container.createDiv({ cls: "mtg-deck-stats-pie-row" });
	const wrap = flex.createDiv({ cls: "mtg-deck-stats-svg-wrap mtg-deck-stats-pie-wrap" });
	setSvgMarkup(wrap, `<svg viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}" class="mtg-deck-stats-svg mtg-deck-stats-pie" role="img" aria-label="Color breakdown">${paths}</svg>`);

	const legend = flex.createDiv({ cls: "mtg-deck-stats-legend" });
	slices.forEach((s) => {
		const row = legend.createDiv({ cls: "mtg-deck-stats-legend-row" });
		const swatch = row.createDiv({ cls: "mtg-deck-stats-legend-swatch" });
		swatch.style.background = s.color;
		row.createSpan({ cls: "mtg-deck-stats-legend-label", text: s.label });
		const pct = Math.round((s.count / total) * 100);
		row.createSpan({ cls: "mtg-deck-stats-legend-count", text: `${s.count} (${pct}%)` });
	});
}

// Barres horizontales en HTML/CSS plutôt qu'en SVG (contrairement aux deux
// graphiques ci-dessus) — une barre horizontale à largeur variable se fait
// aussi simplement (et plus lisiblement, pas de calcul de coordonnées) avec
// un simple `width: X%` en CSS qu'avec un <rect> SVG, pour un vrai bénéfice
// ici : les libellés de type (ex. "Planeswalker") sont de longueur très
// inégale, un texte HTML normal les gère nativement sans réserver une
// largeur fixe comme le ferait un <text> SVG.
export function renderTypeBarChart(container: HTMLElement, slices: TypeSlice[]) {
	container.createDiv({ cls: "mtg-deck-stats-title", text: "Card types" });
	if (slices.length === 0) {
		container.createDiv({ cls: "mtg-deck-stats-empty", text: "No cards to break down yet." });
		return;
	}
	const maxCount = Math.max(...slices.map((s) => s.count));
	const list = container.createDiv({ cls: "mtg-deck-stats-typebar-list" });
	slices.forEach((s) => {
		const row = list.createDiv({ cls: "mtg-deck-stats-typebar-row" });
		row.createDiv({ cls: "mtg-deck-stats-typebar-label", text: s.label });
		const track = row.createDiv({ cls: "mtg-deck-stats-typebar-track" });
		const fill = track.createDiv({ cls: "mtg-deck-stats-typebar-fill" });
		fill.style.width = `${Math.max((s.count / maxCount) * 100, 2)}%`;
		row.createDiv({ cls: "mtg-deck-stats-typebar-count", text: String(s.count) });
	});
}
