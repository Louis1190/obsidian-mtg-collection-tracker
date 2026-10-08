import { ColorSlice, ManaCurveBucket, TypeSlice } from "../core/deck-stats";
import { setSvgMarkup } from "./svg-markup";

/* -------------------------------------------------------------------------- */
/* My Decks "Stats" view (2026-09-02) — 3 hand-drawn charts, no charting */
/* library (same stance already established for the "Price history" chart, */
/* see card-detail-fx.ts/CLAUDE.md: nothing in this plugin depends on an */
/* external library for a need of this size). Colored via CSS classes */
/* (styles.css), never SVG text with a direct fill — same convention as the */
/* rest of this plugin for a <text> embedded in SVG. Unlike the "Price */
/* history" chart, no preserveAspectRatio="none" here (nothing to stretch */
/* independently in X/Y like a time series): the default viewBox (xMidYMid */
/* meet) is enough, so classic SVG text stays correctly proportioned at any */
/* size — no need for the "labels in HTML on top" fallback that that chart */
/* had to use for this same reason. */
/* -------------------------------------------------------------------------- */

const CURVE_WIDTH = 400;
const CURVE_HEIGHT = 190;
const CURVE_BAR_GAP = 8;
const CURVE_BOTTOM_RESERVE = 22; // height reserved at the bottom for the CMC labels
// Height reserved at the TOP for the count label of the tallest bar — a real
// bug found by checking in the browser, not just by re-reading the code:
// without this reserve, a bar reaching 100% of plotHeight places its <text>
// at `y - 5`, hence ABOVE y=0 (outside the viewBox) — a root <svg> silently
// clips everything that exceeds its viewBox by default (no
// overflow:visible), so this label simply vanished for the tallest bin,
// precisely the one where the number is most important to read.
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
			// A floor height of 2px for a non-empty bin: a bar at 1px or less becomes
			// visually indistinguishable from an empty bar, whereas the count above
			// (see countLabel) does show that there really is at least one card.
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

// A single slice at 100% can't be drawn as ONE classic arc (start point
// === end point, the SVG arc degenerates) — a full circle, drawn as 2
// half-arcs, rather than a separate special case.
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
			// Real color (GROUP_LABEL_HEX, core/card-sorting.ts) directly as the fill
			// — not a theme-dependent value like the rest of this file (var(--...)):
			// these 5 colors of mana/Multicolor/Land/Colorless are facts about the
			// deck itself, not an interface tint that must adapt to the light/dark
			// theme.
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

// Horizontal bars in HTML/CSS rather than SVG (unlike the two charts above)
// — a horizontal bar of variable width is done as simply (and more
// readably, no coordinate calculation) with a plain `width: X%` in CSS as
// with an SVG <rect>, for a real benefit here: the type labels (e.g.
// "Planeswalker") are of very unequal length, normal HTML text handles them
// natively without reserving a fixed width as an SVG <text> would.
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
