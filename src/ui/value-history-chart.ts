import { formatMoney, type PriceCurrency } from "../core/price";
import {
	dayToTime,
	formatCompactMoney,
	formatDayLabel,
	seriesNeedsYear,
	valueBounds,
	valueIn,
	type ValuePoint,
} from "../core/value-history";
import { setSvgMarkup } from "./svg-markup";

/* -------------------------------------------------------------------------- */
/* The curve of the collection's value (2026-11-22), drawn on Home (view/home-render.ts, renderHomeValueHistory).
   Same family as the card detail's price history chart (ui/card-detail-fx.ts): a hand-written SVG stretched over
   its box (so its labels are HTML, never SVG text), a crosshair and a tooltip that follow the pointer. What differs:
   one curve, the vertical axis does not start at zero (a collection that moves 2 % would draw a flat line), and the
   tooltip also says how many cards were held that day, because a jump with no price move is a purchase. */
/* -------------------------------------------------------------------------- */

const W = 300;
const H = 80;

/**
 * Draws `series` (at least two points, sorted by day) into `container`, replacing what it holds. Fewer than two
 * points draws nothing: the caller says why there is no curve.
 */
export function renderValueHistoryChart(container: HTMLElement, series: readonly ValuePoint[], currency: PriceCurrency): void {
	container.empty();
	if (series.length < 2) return;

	const t0 = dayToTime(series[0].day);
	const span = dayToTime(series[series.length - 1].day) - t0 || 1;
	const values = series.map((p) => valueIn(p, currency));
	const bounds = valueBounds(values);
	const range = bounds.max - bounds.min || 1;
	const toX = (day: string) => ((dayToTime(day) - t0) / span) * W;
	const toY = (v: number) => H - ((v - bounds.min) / range) * H;

	const coords = series.map((p, i) => ({ x: toX(p.day), y: toY(values[i]) }));
	const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
	const last = coords[coords.length - 1];
	const withYear = seriesNeedsYear(series);
	const firstLabel = formatDayLabel(series[0].day, withYear);
	const lastLabel = formatDayLabel(series[series.length - 1].day, withYear);

	const row = container.createDiv({ cls: "mtg-value-chart-row" });
	const yLabels = row.createDiv({ cls: "mtg-value-chart-y-labels" });
	yLabels.createSpan({ text: formatCompactMoney(bounds.max, currency) });
	yLabels.createSpan({ text: formatCompactMoney(bounds.min, currency) });

	const plot = row.createDiv({ cls: "mtg-value-chart-plot" });
	const accent = "var(--mtg-accent, var(--interactive-accent))";
	setSvgMarkup(
		plot,
		`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
			`aria-label="${formatMoney(values[0], currency)} on ${firstLabel}, ${formatMoney(values[values.length - 1], currency)} on ${lastLabel}">` +
			`<line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--background-modifier-border)" stroke-width="1" vector-effect="non-scaling-stroke" />` +
			`<line x1="0" y1="0" x2="${W}" y2="0" stroke="var(--background-modifier-border)" stroke-width="1" stroke-dasharray="3,3" vector-effect="non-scaling-stroke" />` +
			`<path d="${line} L${W},${H} L0,${H} Z" fill="${accent}" fill-opacity="0.14" stroke="none" />` +
			`<path d="${line}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />` +
			`<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="${accent}" />` +
			`</svg>`
	);

	const dates = container.createDiv({ cls: "mtg-value-chart-dates" });
	dates.createSpan({ text: firstLabel });
	dates.createSpan({ text: lastLabel });

	setupCrosshair(plot, series, values, coords, currency);
}

// A vertical line, a dot and a tooltip on the point nearest to the pointer. Added with the DOM API on top of the
// static drawing so that moving does not rebuild the chart. Pointer events, not mouse events: a finger dragged along
// the curve reads it too (the plot only claims the horizontal pan, the page keeps scrolling vertically).
function setupCrosshair(
	plot: HTMLElement,
	series: readonly ValuePoint[],
	values: readonly number[],
	coords: readonly { x: number; y: number }[],
	currency: PriceCurrency
): void {
	const svg = plot.querySelector("svg");
	if (!svg) return;
	const ns = "http://www.w3.org/2000/svg";
	// Nodes belong to the chart's own document (a popout window has its own), not the main window's.
	const doc = svg.ownerDocument;

	const cursor = doc.createElementNS(ns, "line");
	cursor.setAttribute("y1", "0");
	cursor.setAttribute("y2", String(H));
	cursor.setAttribute("stroke", "var(--text-muted)");
	cursor.setAttribute("stroke-width", "1");
	cursor.setAttribute("vector-effect", "non-scaling-stroke");
	cursor.addClass("mtg-hidden");
	svg.appendChild(cursor);

	const dot = doc.createElementNS(ns, "circle");
	dot.setAttribute("r", "3");
	dot.setAttribute("fill", "var(--mtg-accent, var(--interactive-accent))");
	dot.addClass("mtg-hidden");
	svg.appendChild(dot);

	const tooltip = plot.createDiv({ cls: "mtg-value-chart-tooltip" });
	const withYear = seriesNeedsYear(series);

	const show = (clientX: number) => {
		const rect = svg.getBoundingClientRect();
		if (rect.width === 0) return;
		const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		const targetX = frac * W;
		let nearest = 0;
		let best = Infinity;
		coords.forEach((c, i) => {
			const d = Math.abs(c.x - targetX);
			if (d < best) {
				best = d;
				nearest = i;
			}
		});
		const c = coords[nearest];
		cursor.setAttribute("x1", String(c.x));
		cursor.setAttribute("x2", String(c.x));
		cursor.removeClass("mtg-hidden");
		dot.setAttribute("cx", String(c.x));
		dot.setAttribute("cy", String(c.y));
		dot.removeClass("mtg-hidden");

		const p = series[nearest];
		tooltip.empty();
		tooltip.createDiv({
			text: `${formatDayLabel(p.day, withYear)} · ${p.cards} ${p.cards === 1 ? "card" : "cards"}`,
		});
		tooltip.createDiv({ cls: "mtg-value-chart-tooltip-value", text: formatMoney(values[nearest], currency) });
		tooltip.addClass("is-visible");
		// Anchored on the point actually drawn, and flipped to its left past 75 % so it never overflows on the right.
		const snapped = c.x / W;
		const nearRight = snapped > 0.75;
		tooltip.style.left = nearRight ? "" : `${snapped * 100}%`;
		tooltip.style.right = nearRight ? `${(1 - snapped) * 100}%` : "";
	};

	const hide = () => {
		cursor.addClass("mtg-hidden");
		dot.addClass("mtg-hidden");
		tooltip.removeClass("is-visible");
	};

	plot.addEventListener("pointerdown", (evt) => show(evt.clientX));
	plot.addEventListener("pointermove", (evt) => show(evt.clientX));
	plot.addEventListener("pointerleave", hide);
	plot.addEventListener("pointercancel", hide);
	// A finger that lifts has finished reading; a mouse pointer stays where it is until it leaves.
	plot.addEventListener("pointerup", (evt) => {
		if (evt.pointerType === "touch") hide();
	});
}
