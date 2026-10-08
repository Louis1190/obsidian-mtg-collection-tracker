import { Platform } from "obsidian";
import { Finish } from "../core/card-model";
import { CardbaseDayChange, CardbaseFinish, CardbasePriceHistory, CardbasePricePoint, CardbaseVendor } from "../api/cardbase";
import { UsdEurRate, convertUsdEur } from "../api/frankfurter";
import { CardTextFace } from "../api/scryfall";
import { setSvgMarkup } from "./svg-markup";

// Opens an external URL (clickable "Store Prices" columns: Card
// Kingdom/Mana Pool/TCGplayer —
// CardDetailModal/DeckCardDetailModal/WantlistCardDetailModal) after first
// checking the scheme. These URLs never come from user input, but from a
// JSON response of a third-party API
// (card-kingdom.ts/manapool.ts/scryfall.ts purchase_uris) — trusted
// partners today, but nothing guarantees that a malformed/compromised
// response will never contain anything other than a real http(s) product
// link. Cheap defense in depth rather than a blind window.open(url) on a
// string of external origin.
export function openExternalUrl(url: string | null | undefined): void {
	if (!url || !/^https:\/\//i.test(url)) return;
	window.open(url, "_blank");
}

// Blurred background layer (art crop) + scrim of a card-detail modal, with a
// crossfade between two illustrations when navigating previous/next rather
// than a fade to black then to the new image. Shared by the three detail
// modals (Collection/Deck/Wantlist), which rebuild all their content on
// every draw(): this layer must be explicitly preserved (see
// clearSiblingsIn) so that the transition in progress isn't interrupted by
// the rebuild of the rest.
// Stacks a new layer per card rather than going back and forth between two
// reused layers: each layer only ever does one thing, once — fade in — and
// is never touched again afterwards. A previous version reused two layers
// (top/bottom) and "handed over" from one to the other at the end of each
// transition; this handover (changing the image of the bottom layer then
// hiding the top one, even on the real end of the CSS transition plus an
// extra waiting frame) remained noticeable as a scrim that fades out then
// suddenly reappears. By simply stacking the layers (the scrim, for its
// part, is created only once and never touched), there is no longer any
// "reset" step that could produce this artifact.
export class BackgroundCrossfader {
	el: HTMLElement | null = null;
	private lastUrl: string | null = null;
	private token = 0;
	private layers: HTMLElement[] = [];
	// Layers covered by a more recent one are invisible but not free (each one
	// carries a 45px blur): we only keep a bounded number of them so they
	// don't accumulate indefinitely over a session where the user browses many
	// cards in the same window.
	private static readonly MAX_LAYERS = 10;

	// Removes all the children of `container` EXCEPT this layer, so that
	// draw() can rebuild the rest of the content (panel, header…) without
	// destroying the background and its transition in progress. Equivalent of
	// contentEl.empty() that spares this single element.
	clearSiblingsIn(container: HTMLElement) {
		Array.from(container.children).forEach((child) => {
			if (child !== this.el) child.remove();
		});
	}

	update(container: HTMLElement, url: string) {
		const token = ++this.token;
		if (!this.el) {
			this.el = container.createDiv();
			container.prepend(this.el);
			// The scrim is created once and for all here and is never recreated or
			// modified afterwards — its z-index (see CSS) keeps it above all the image
			// layers added later, regardless of their own insertion order.
			this.el.createDiv({ cls: "mtg-card-detail-scrim" });
		}

		if (url === this.lastUrl) return;
		this.lastUrl = url;

		const preload = new Image();
		preload.onload = () => {
			if (token !== this.token) return;
			const layer = this.el!.createDiv({ cls: "mtg-card-detail-bg" });
			layer.style.backgroundImage = `url("${url}")`;
			this.layers.push(layer);
			// Two nested requestAnimationFrame calls (same idiom as the modal opening)
			// to guarantee that the browser really paints the initial opacity:0 state
			// before triggering the transition to the visible state — otherwise the
			// two changes can be batched into the same frame and skip the transition.
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					if (token !== this.token) return;
					layer.addClass("mtg-card-detail-bg-loaded");
				});
			});
			while (this.layers.length > BackgroundCrossfader.MAX_LAYERS) {
				this.layers.shift()!.remove();
			}
		};
		preload.src = url;
	}

	// No image for the displayed card: removes everything rather than leaving
	// an obsolete illustration visible.
	clear() {
		this.el?.remove();
		this.el = null;
		this.layers = [];
		this.lastUrl = null;
	}
}

// The right column of the card detail (.mtg-card-detail-panel) scrolls
// internally rather than letting the whole window grow with the content (see
// max-height on .mtg-card-detail-modal). The top/bottom fade (mask-image in
// CSS, see styles.css) is only displayed on the side where there really is
// hidden content left — not a permanent gradient — hence this class toggle on
// scroll rather than a static mask.
export function setupPanelScrollFade(panel: HTMLElement) {
	const update = () => {
		const atTop = panel.scrollTop <= 0;
		const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
		panel.toggleClass("mtg-panel-fade-top", !atTop);
		panel.toggleClass("mtg-panel-fade-bottom", !atBottom);
	};
	panel.addEventListener("scroll", update);
	update();
}

// Responsive corner radius (--mtg-card-radius, consumed by
// .mtg-card-detail-tilt/.mtg-card-detail-image in styles.css, plus the Alpha
// variant derived via calc()) — a fixed radius in px stays properly round
// (unlike a %, which resolves per axis and distorts into an oval on a
// non-square card, see the historical note on these two classes) but didn't
// shrink with the card itself — explicit feedback: "if my window gets smaller,
// the radius becomes too large".
// RATIO calibrated to equal exactly MAX at the real maximum width of the card
// (~402px, once .mtg-card-detail-modal-frame is capped at 1100px wide — see the
// calculation in the CLAUDE.md history of this change): no visible change on a
// normal/wide screen, only a narrow window now sees the radius shrink. MIN
// prevents the card from becoming almost square on a very narrow mobile screen.
// Explicit bump (2026-09-10): "the radius doesn't seem large enough", both here
// and for --mtg-card-tile-radius further down — MAX/MIN increased
// proportionally (14→20 / 6→8) keeping the same reference width (~402px,
// calculation above unchanged) so as to change nothing else about the mechanism
// itself: on a normal/wide screen (already capped at MAX before this change, as
// documented above) it's this new MAX that is directly visible; the Alpha ratio
// (*29/14, styles.css) applies to the LIVE value of --mtg-card-radius, so the
// Alpha also grows proportionally without needing to be touched separately.
const CARD_RADIUS_RATIO = 0.05;
const CARD_RADIUS_MIN = 8;
const CARD_RADIUS_MAX = 20;

// Factored out of setupCardTilt (which remains the only caller) the day the
// Card view needed the same mechanism for its own radius — see
// computeCardTileRadius further down for why the Card view does NOT use this
// function itself (it needs to observe a persistent element rather than an
// individual tile, for reasons specific to view.ts).
// ResizeObserver (not a simple resize listener on window): fires again for
// any cause of size change (the container changes width when the panel is
// resized, not only the window), and also serves as the initial measurement
// by firing immediately upon observation. No explicit disconnect(): `tilt`
// (the only caller) is always recreated on every draw() by its callers
// (never reused), so once the old element is detached with no other
// reference, this observer also becomes eligible for garbage collection —
// same reasoning already applied to the mousemove/mouseleave listeners of
// setupCardTilt further down.
function setupResponsiveRadius(el: HTMLElement, ratio: number, min: number, max: number, cssVar: string) {
	const observer = new ResizeObserver((entries) => {
		const width = entries[0]?.contentRect.width;
		if (!width) return;
		const radius = Math.min(max, Math.max(min, width * ratio));
		el.style.setProperty(cssVar, `${radius}px`);
	});
	observer.observe(el);
}

const CARD_TILE_RADIUS_RATIO = 16 / 320;
const CARD_TILE_RADIUS_MIN = 5;
const CARD_TILE_RADIUS_MAX = 16;

export function computeCardTileRadius(width: number): number {
	return Math.min(CARD_TILE_RADIUS_MAX, Math.max(CARD_TILE_RADIUS_MIN, width * CARD_TILE_RADIUS_RATIO));
}

// "Holo" effect in the style of a Pokémon card (3D tilt + glare following
// the mouse), reserved for foil/etched finishes — a "regular" card doesn't
// physically sparkle, so it doesn't here either.
// `anchor` (the element whose mouse position is read) and `tilt` (the
// element actually tilted) are deliberately two distinct elements: tracking
// the mouse on the SAME element being transformed would create a feedback
// loop (the tracked box moves slightly with each tilt, so the mouse
// coordinates we then deduce from it become slightly wrong). `anchor` also
// remains free to carry the transform of the Cover Flow carousel
// (animateCardNav) without ever conflicting with it, the tilt being set here
// on `tilt`, nested inside.
export function setupCardTilt(anchor: HTMLElement, tilt: HTMLElement) {
	// Measures the width ACTUALLY RENDERED of `tilt` (see setupResponsiveRadius
	// above) — unrelated to the 3D tilt below, but placed in this same setup
	// since both need the same `tilt` element and are called from the same 3
	// call sites (Card/Deck/Wantlist detail) — one function, a single call per
	// modal, rather than two.
	setupResponsiveRadius(tilt, CARD_RADIUS_RATIO, CARD_RADIUS_MIN, CARD_RADIUS_MAX, "--mtg-card-radius");

	// 12 (not 6, then 8): second strengthening requested — the previous angle
	// was still judged too subtle.
	const maxTiltDeg = 12;
	const handleMove = (evt: MouseEvent) => {
		const rect = anchor.getBoundingClientRect();
		const px = (evt.clientX - rect.left) / rect.width;
		const py = (evt.clientY - rect.top) / rect.height;
		const rotateY = (px - 0.5) * maxTiltDeg * 2;
		const rotateX = (0.5 - py) * maxTiltDeg * 2;
		if (!Platform.isMobile) {
			tilt.style.transform = `perspective(1400px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
		}
		tilt.style.setProperty("--holo-x", `${px * 100}%`);
		tilt.style.setProperty("--holo-y", `${py * 100}%`);
		// Position of the rainbow glare (.mtg-card-detail-holo-shine): damped over
		// a narrowed range (20-80%) rather than the raw cursor position
		// (--holo-x/-y, 0-100%, used by the white spot
		// .mtg-card-detail-holo-sweep) — the colored band drifts gently across the
		// card instead of following the mouse sharply up to the edges, like a real
		// physical holographic glare. Cf. the reference project pokemon-cards-css
		// (Card.svelte, `adjust(percent, 0, 100, 37, 63)`), which likewise
		// separates the position of the colored glare (damped) from that of the
		// sharp glare (raw).
		tilt.style.setProperty("--holo-bg-x", `${20 + px * 60}%`);
		tilt.style.setProperty("--holo-bg-y", `${20 + py * 60}%`);
		// Hue rotation (--holo-hue, read by the filter: hue-rotate() of
		// .mtg-card-detail-holo-shine) derived from the SAME rotateX/rotateY
		// angles as the tilt: without it, the gradient merely slides while always
		// keeping the same colors at the same places (a pure parallax effect) — a
		// real holographic card changes COLOR at a given spot depending on the
		// viewing angle (diffraction grating), not only position. hue-rotate
		// recolors the whole layer uniformly, so a same area displayed on screen
		// sees its hue vary as the card is tilted.
		// Factor *8 (not *5, still judged too subtle): over the real amplitude of
		// rotateX/rotateY (±16deg each with maxTiltDeg=8), that covers up to
		// ~512deg of hue variation across the whole gesture — hue-rotate being
		// cyclic (mod 360), it never "jumps", it just sweeps a good part of the
		// color wheel more than once between two opposite mouse positions.
		const hueShift = (rotateX - rotateY) * 8;
		tilt.style.setProperty("--holo-hue", `${hueShift}deg`);
		// Intensity of the rainbow glare (--holo-intensity, read by the opacity of
		// .mtg-card-detail-holo-shine) modulated by the distance of the cursor
		// from the CENTER of the card — 0 right at the center (card flat, facing
		// the screen), up to 1 when approaching the edges. Without this, the glare
		// stayed fully visible even with the card flat, which makes no physical
		// sense: a real holographic film only changes color at an oblique viewing
		// angle, not head-on (reported). /0.5 (not /0.7071, the distance to the
		// corner): we already want full intensity when approaching an EDGE, not
		// only the corners, otherwise the effect would stay attenuated over most
		// of the card.
		const distFromCenter = Math.min(1, Math.hypot(px - 0.5, py - 0.5) / 0.5);
		tilt.style.setProperty("--holo-intensity", `${distFromCenter}`);
		tilt.addClass("is-tilting");
	};
	const handleLeave = () => {
		tilt.style.removeProperty("transform");
		tilt.removeClass("is-tilting");
	};
	anchor.addEventListener("mousemove", handleMove);
	anchor.addEventListener("mouseleave", handleLeave);
}

// Animates the previous/next navigation Cover Flow style: the old and the new
// card are both visible and animated AT THE SAME TIME (not one after the
// other) — the old one slides/rotates out of the frame on the side we're
// navigating toward while the new one slides/rotates in from the opposite
// side to the center. This requires keeping the old
// .mtg-card-detail-image-wrap alive across the redraw of draw() (which would
// otherwise destroy it along with the rest of the panel): we detach it BEFORE
// calling update(), then reinsert it into the new "viewport" (see
// .mtg-card-detail-nav-viewport, styles.css) right after, so that it shares
// exactly the same clipped frame (overflow:hidden) as the new card — that is
// what keeps the animation within the bounds of the column rather than
// spilling onto the neighboring panel.
// Both cards switch to position:absolute (mtg-card-nav-animating) for the
// duration of the transition, so they can overlap — outside this short
// moment, the card stays in normal flow (see styles.css) so that its real
// height (that of the image, not an approximation) determines that of the
// viewport. Since two position:absolute cards no longer take part at all in
// the parent's height calculation, the viewport's height is frozen in px just
// before (captured on the old one, while it is still in normal flow) and
// carried over to the new one, without which this box would collapse during
// the animation. onDone signals the launch (not the visual end) of the
// transition — enough to release the anti-double-click lock without blocking
// needlessly long.
export function animateCardNav(
	contentEl: HTMLElement,
	direction: "prev" | "next",
	update: () => void,
	onDone?: () => void
) {
	const oldWrap = contentEl.querySelector(".mtg-card-detail-image-wrap");
	if (!oldWrap) {
		update();
		onDone?.();
		return;
	}
	const oldViewport = oldWrap.closest(".mtg-card-detail-nav-viewport");
	const frozenHeight = oldViewport ? `${oldViewport.getBoundingClientRect().height}px` : null;
	oldWrap.addClass("mtg-card-nav-animating");
	oldWrap.remove();
	update();
	const newViewport = contentEl.querySelector<HTMLElement>(".mtg-card-detail-nav-viewport");
	const newWrap = newViewport?.querySelector(".mtg-card-detail-image-wrap");
	if (!newViewport || !newWrap) {
		onDone?.();
		return;
	}
	if (frozenHeight) newViewport.style.height = frozenHeight;
	newWrap.addClass("mtg-card-nav-animating");
	const outClass = direction === "next" ? "mtg-card-nav-out-left" : "mtg-card-nav-out-right";
	const inClass = direction === "next" ? "mtg-card-nav-in-right" : "mtg-card-nav-in-left";

	newViewport.appendChild(oldWrap);
	newWrap.addClass("mtg-card-nav-no-transition");
	newWrap.addClass(inClass);
	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			newWrap.removeClass("mtg-card-nav-no-transition");
			newWrap.removeClass(inClass);
			oldWrap.addClass(outClass);
			onDone?.();
		});
	});
	window.setTimeout(() => {
		oldWrap.remove();
		newWrap.removeClass("mtg-card-nav-animating");
		newViewport.style.removeProperty("height");
	}, 420);
}

/* -------------------------------------------------------------------------- */
/* "Price history" box (cardbase.dev) — hand-made chart, without a charting */
/* library (see CLAUDE.md/Conventions: this plugin never needed one */
/* elsewhere). Shared by the three detail modals (Collection/Deck/Wantlist) — */
/* each builds its own box (same convention as renderStorePricesBox, */
/* duplicated per modal) but delegates all the calculation/drawing of the */
/* chart itself here, like setupCardTilt/animateCardNav higher up in this */
/* file. */
/* -------------------------------------------------------------------------- */

// "surged" has no dedicated field at cardbase (as at Scryfall/Card
// Kingdom/Mana Pool elsewhere in this plugin) — treated as "foil". "proxy"
// has no equivalent here: callers must already exclude Proxy cards before
// calling getCardbasePriceHistory (same exclusion as for Store Prices), so
// it is never passed to this function.
export function toCardbaseFinish(finish: Finish): CardbaseFinish {
	if (finish === "etched") return "etched";
	if (finish === "foiled" || finish === "surged") return "foil";
	return "normal";
}

// 4 of the 5 cardbase vendors — cardhoarder (Magic Online, not paper) stays
// excluded, see cardbase.ts. cardsphere has an entry here even though its
// coverage currently seems empty in practice (see cardbase.ts) — wired
// anyway, `series` already filters out series without a point further down,
// so a curve with no data simply isn't displayed rather than crashing.
const PRICE_HISTORY_VENDOR_LABELS: Partial<Record<CardbaseVendor, string>> = {
	cardkingdom: "Card Kingdom",
	tcgplayer: "TCGplayer",
	cardmarket: "Cardmarket",
	cardsphere: "Cardsphere",
};

// 4 standard, clearly distinguishable Obsidian hues, available in any
// theme — not var(--text-accent)/var(--text-success), already loaded with
// meaning elsewhere in this panel (current price, legal format).
const PRICE_HISTORY_VENDOR_COLORS: Partial<Record<CardbaseVendor, string>> = {
	cardkingdom: "var(--color-blue)",
	tcgplayer: "var(--color-orange)",
	cardmarket: "var(--color-green)",
	cardsphere: "var(--color-pink)",
};

// Cardmarket is the only one of the 4 vendors displayed here to answer in
// EUR (see cardbase.ts/fetchCardbasePriceHistory) — all the others, in USD.
// Mixing the two on a single Y axis would display a number at the wrong
// height (a "10" EUR is not the same real value as a "10" USD) without
// conversion. Since the addition of frankfurter.ts, a real exchange rate is
// available: renderPriceHistoryChart then converts Cardmarket to
// settings.priceCurrency and displays a single unified axis (more readable
// than a dual axis, explicitly reported — see the discussion leading to this
// file). If the rate isn't available (frankfurter.dev network failure),
// falls back to the old independent dual axis below rather than losing the
// Cardmarket curve — see renderPriceHistoryChart.
const CARDBASE_VENDOR_CURRENCY: Partial<Record<CardbaseVendor, "usd" | "eur">> = {
	cardkingdom: "usd",
	tcgplayer: "usd",
	cardsphere: "usd",
	cardmarket: "eur",
};

// Thousands separators (Intl, not formatMoney/price.ts — it would stay
// "$150000.00" otherwise, hard to read on a card like Black Lotus that can
// exceed $150,000). "en-US" for both currencies (not just USD) — same
// reasoning as formatHistoryDate further down: English everywhere, not the
// system locale. Local to this chart only: doesn't touch the shared
// formatting used elsewhere in the plugin (Store Prices box, collection
// totals, etc.), not requested there and out of scope here.
const CHART_PRICE_FORMATTERS: Record<"usd" | "eur", Intl.NumberFormat> = {
	usd: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
	eur: new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }),
};
function formatChartPrice(amount: number, currency: "usd" | "eur" = "usd"): string {
	return CHART_PRICE_FORMATTERS[currency].format(amount);
}

function formatHistoryDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface DrawnPriceSeries {
	vendor: CardbaseVendor;
	color: string;
	currency: "usd" | "eur";
	// true if this series was converted from its native currency (see
	// convertUsdEur below) to join the unified axis — never true in dual-axis
	// mode (fallback without a rate). Drives the dashed line + the
	// "(converted)" mention everywhere this series is displayed, so as never
	// to confuse a converted price with the store's real native price.
	converted: boolean;
	points: CardbasePricePoint[];
	toY: (price: number) => number;
	d: string;
	lastX: number;
	lastY: number;
	lastPrice: number;
}

interface YAxis {
	currency: "usd" | "eur";
	yMax: number;
	toY: (price: number) => number;
}

// Axis anchored at 0 (explicitly requested) rather than a floor padded around
// the minimum — a true zero at the bottom keeps the scale honest, no false
// impression of a big variation over a gap that is actually small. The margin
// above the observed maximum combines two terms and keeps the larger of the
// two: a fraction of the amplitude ACTUALLY observed (so that a real price
// movement keeps a margin proportionate to its magnitude, without being
// artificially squashed) and a fraction of the price itself (so that a nearly
// flat card — little amplitude to work with — still keeps a visible margin
// rather than sticking to the ceiling). Never an arbitrary round value like
// "$100" that would squash a $1 card.
function buildYAxis(seriesForAxis: { currency: "usd" | "eur"; points: CardbasePricePoint[] }[], H: number): YAxis | null {
	if (seriesForAxis.length === 0) return null;
	let maxPrice = -Infinity;
	let minPrice = Infinity;
	for (const s of seriesForAxis) {
		for (const p of s.points) {
			if (p.price > maxPrice) maxPrice = p.price;
			if (p.price < minPrice) minPrice = p.price;
		}
	}
	const priceRange = maxPrice - minPrice;
	const pad = Math.max(priceRange * 0.4, maxPrice * 0.3, 0.05);
	const yMax = maxPrice + pad;
	const yScale = yMax || 1;
	return {
		currency: seriesForAxis[0].currency,
		yMax,
		toY: (price: number) => H - (price / yScale) * H,
	};
}

// `history` can be undefined (network failure after retry) or have an
// empty `series` (confirmed success, but none of the 4 stores has history
// for this printing/finish) — both cases display the same neutral message,
// the distinction is of no interest to the end user.
export function renderPriceHistoryChart(
	container: HTMLElement,
	history: CardbasePriceHistory | undefined,
	targetCurrency: "usd" | "eur",
	exchangeRate: UsdEurRate | undefined
) {
	container.empty();
	// The container has carried the loading class/icon (see the callers in
	// modals/*.ts) until now — no longer needed once the real content (chart
	// or "no history" message) is about to be built.
	container.removeClass("mtg-price-history-loading");
	const rawSeries = (history?.series ?? [])
		.filter((s) => s.points.length > 0 && CARDBASE_VENDOR_CURRENCY[s.vendor] !== undefined)
		.map((s) => ({ ...s, currency: CARDBASE_VENDOR_CURRENCY[s.vendor]! }));
	if (rawSeries.length === 0) {
		container.createDiv({ cls: "mtg-price-history-empty", text: "No price history available yet." });
		return;
	}

	// Single axis if an exchange rate is available (see frankfurter.ts,
	// getUsdEurRate): any series not already in `targetCurrency` (in practice
	// Cardmarket, the only EUR vendor — see CARDBASE_VENDOR_CURRENCY) is
	// converted and marked `converted`, for a dashed line + a "(converted)"
	// tooltip rather than blending in with a real price displayed by this
	// store (see DrawnPriceSeries). A single "today" rate applies to the whole
	// history of the series (see convertUsdEur) — a deliberate approximation,
	// stated in the tooltip. Without a rate (frankfurter.dev network failure),
	// explicit fallback to the old independent dual axis rather than losing
	// the Cardmarket curve.
	const series = exchangeRate
		? rawSeries.map((s) => {
				const converted = s.currency !== targetCurrency;
				return {
					...s,
					currency: targetCurrency,
					converted,
					points: converted
						? s.points.map((p) => ({
								date: p.date,
								price: convertUsdEur(p.price, s.currency, targetCurrency, exchangeRate),
						  }))
						: s.points,
				};
		  })
		: rawSeries.map((s) => ({ ...s, converted: false }));

	// Common reference (dates only) shared by all the curves, so they compare
	// on the same X axis — the price axis, for its part, depends on the
	// availability of an exchange rate (see just above).
	let minDate = Infinity;
	let maxDate = -Infinity;
	for (const s of series) {
		for (const p of s.points) {
			const t = new Date(`${p.date}T00:00:00Z`).getTime();
			if (t < minDate) minDate = t;
			if (t > maxDate) maxDate = t;
		}
	}
	const dateRange = maxDate - minDate || 1;

	const W = 300;
	const H = 80;
	const toX = (t: number) => ((t - minDate) / dateRange) * W;

	// With a rate (exchangeRate defined): all the series already share
	// `targetCurrency` (see above), a single axis is enough, no secondary
	// column. Without a rate: fallback to the old USD (left column, primary —
	// this is the case for nearly all cards, Card Kingdom/TCGplayer being the
	// best-covered vendors on cardbase) / EUR (right column, optional) split;
	// in the rare case where ONLY Cardmarket has data for this card, EUR
	// becomes the primary axis rather than leaving the left column empty.
	let primaryAxis: YAxis;
	let secondaryAxis: YAxis | null;
	if (exchangeRate) {
		primaryAxis = buildYAxis(series, H)!;
		secondaryAxis = null;
	} else {
		const usdSeries = series.filter((s) => s.currency === "usd");
		const eurSeries = series.filter((s) => s.currency === "eur");
		const primarySeries = usdSeries.length > 0 ? usdSeries : eurSeries;
		const secondarySeries = usdSeries.length > 0 ? eurSeries : [];
		primaryAxis = buildYAxis(primarySeries, H)!;
		secondaryAxis = buildYAxis(secondarySeries, H);
	}
	const axisFor = (currency: "usd" | "eur") => (currency === primaryAxis.currency ? primaryAxis : secondaryAxis!);

	const drawn: DrawnPriceSeries[] = series.map((s) => {
		// Safety net only — `series` is already restricted to the 4 vendors of
		// CARDBASE_VENDOR_CURRENCY just above, this key always exists in practice;
		// the fallback merely avoids propagating an `undefined` into the SVG if
		// that filter ever changed without updating these maps.
		const color = PRICE_HISTORY_VENDOR_COLORS[s.vendor] ?? "var(--text-muted)";
		const toY = axisFor(s.currency).toY;
		const d = s.points
			.map((p, i) => {
				const x = toX(new Date(`${p.date}T00:00:00Z`).getTime());
				const y = toY(p.price);
				return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(" ");
		const last = s.points[s.points.length - 1];
		const lastX = toX(new Date(`${last.date}T00:00:00Z`).getTime());
		const lastY = toY(last.price);
		return {
			vendor: s.vendor,
			color,
			currency: s.currency,
			converted: s.converted,
			points: s.points,
			toY,
			d,
			lastX,
			lastY,
			lastPrice: last.price,
		};
	});

	// Y label columns (0 / middle / max) in HTML on either side of the SVG,
	// not as SVG <text>: the SVG has preserveAspectRatio="none" (it stretches
	// to fill its box, X and Y in different proportions), which would distort
	// an SVG text horizontally — same reasoning already applied to dateRow
	// further down. Width of the columns deliberately NOT fixed (see
	// styles.css) — a card like Black Lotus can exceed $150,000, a fixed width
	// cut off that kind of label (reported); each column sizes itself on its
	// own content, whatever its length.
	const chartRow = container.createDiv({ cls: "mtg-price-history-chart-row" });
	const yLabelsLeft = chartRow.createDiv({ cls: "mtg-price-history-y-labels" });
	yLabelsLeft.createSpan({ text: formatChartPrice(primaryAxis.yMax, primaryAxis.currency) });
	yLabelsLeft.createSpan({ text: formatChartPrice(primaryAxis.yMax / 2, primaryAxis.currency) });
	yLabelsLeft.createSpan({ text: formatChartPrice(0, primaryAxis.currency) });

	const plot = chartRow.createDiv({ cls: "mtg-price-history-plot" });
	// Everything STATIC (grid, curves, end point) is built as a string then injected via setSvgMarkup
	// (ui/svg-markup.ts) — same convention as all the other SVGs of this plugin. The interactive
	// cursor (vertical line + hovered points) is added ON TOP afterwards through the DOM API (see
	// setupPriceHistoryCrosshair), since it must be updated continuously on mousemove without
	// rebuilding the whole chart on every frame.
	setSvgMarkup(plot, `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
		// Horizontal grid (0 / middle / max) — one and the same triplet of lines
		// serves as a reference for BOTH axes at once (each goes from its own 0 to
		// its own max over the same pixel height, so the top line represents both
		// the primary max AND the secondary max, each with its own label on either
		// side); the exact values are already given by the HTML labels, so there
		// is no need to label the grid itself.
		`<line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--background-modifier-border)" stroke-width="1" vector-effect="non-scaling-stroke" />` +
		`<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="var(--background-modifier-border)" stroke-width="1" stroke-dasharray="3,3" vector-effect="non-scaling-stroke" />` +
		`<line x1="0" y1="0" x2="${W}" y2="0" stroke="var(--background-modifier-border)" stroke-width="1" vector-effect="non-scaling-stroke" />` +
		drawn
			.map(
				(p) =>
					// stroke-dasharray only on a converted series (see DrawnPriceSeries) —
					// distinguishes at first glance an estimated price (converted at today's
					// rate) from a real native price, without waiting for a hover over the
					// legend/tooltip.
					`<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="2"${
						p.converted ? ' stroke-dasharray="4,3"' : ""
					} vector-effect="non-scaling-stroke" />` +
					`<circle cx="${p.lastX.toFixed(1)}" cy="${p.lastY.toFixed(1)}" r="2.5" fill="${p.color}" />`
			)
			.join("") +
		`</svg>`);

	// Optional right column — only if a secondary currency really has data for
	// this card (see secondaryAxis above), not an empty axis displayed by
	// default.
	if (secondaryAxis) {
		const yLabelsRight = chartRow.createDiv({ cls: "mtg-price-history-y-labels mtg-price-history-y-labels-right" });
		yLabelsRight.createSpan({ text: formatChartPrice(secondaryAxis.yMax, secondaryAxis.currency) });
		yLabelsRight.createSpan({ text: formatChartPrice(secondaryAxis.yMax / 2, secondaryAxis.currency) });
		yLabelsRight.createSpan({ text: formatChartPrice(0, secondaryAxis.currency) });
	}

	const dateRow = container.createDiv({ cls: "mtg-price-history-dates" });
	dateRow.createSpan({ text: formatHistoryDate(minDate) });
	dateRow.createSpan({ text: formatHistoryDate(maxDate) });

	const legend = container.createDiv({ cls: "mtg-price-history-legend" });
	for (const p of drawn) {
		const item = legend.createDiv({ cls: "mtg-price-history-legend-item" });
		if (p.converted) item.addClass("is-converted");
		item.createSpan({ cls: "mtg-price-history-legend-dot" }).style.background = p.color;
		item.createSpan({
			cls: "mtg-price-history-legend-label",
			text: `${PRICE_HISTORY_VENDOR_LABELS[p.vendor] ?? p.vendor} · ${formatChartPrice(p.lastPrice, p.currency)}${
				p.converted ? " *" : ""
			}`,
		});
		if (p.converted) {
			// Original currency deduced rather than stored separately: only USD/EUR
			// exist here (see CARDBASE_VENDOR_CURRENCY), so "converted to
			// targetCurrency" unambiguously determines which of the two was the native
			// currency.
			const originalCurrency = targetCurrency === "usd" ? "EUR" : "USD";
			item.setAttribute(
				"title",
				`Converted from ${originalCurrency} to ${targetCurrency.toUpperCase()} using today's exchange rate (frankfurter.dev) — the whole history uses today's rate, not the rate on each specific day.`
			);
		}
	}

	setupPriceHistoryCrosshair(plot, drawn, toX, minDate, dateRange, W, H);
}

// Vertical line + one point per curve that follow the mouse, with a
// date/price tooltip — added on top of the static SVG (see
// renderPriceHistoryChart above) via the DOM API rather than rebuilt as a
// string on every mousemove, to stay smooth. `allTimestamps` is the union of
// the dates of all the curves (not just one) in case one store misses a day
// that the other has — the exact point on the hovered day is looked up
// independently per curve, a curve with no data that day just hides its own
// point rather than interpolating an invented value. Each curve already
// carries its own `toY` (see DrawnPriceSeries) — no more need for a function
// here to know which axis/currency corresponds to which vendor.
function setupPriceHistoryCrosshair(
	plot: HTMLElement,
	drawn: DrawnPriceSeries[],
	toX: (t: number) => number,
	minDate: number,
	dateRange: number,
	W: number,
	H: number
) {
	const svgEl = plot.querySelector("svg");
	if (!svgEl) return;
	const svgNS = "http://www.w3.org/2000/svg";

	const allTimestamps = Array.from(
		new Set(drawn.flatMap((s) => s.points.map((p) => new Date(`${p.date}T00:00:00Z`).getTime())))
	).sort((a, b) => a - b);
	if (allTimestamps.length === 0) return;

	const crosshairLine = document.createElementNS(svgNS, "line");
	crosshairLine.setAttribute("y1", "0");
	crosshairLine.setAttribute("y2", String(H));
	crosshairLine.setAttribute("stroke", "var(--text-muted)");
	crosshairLine.setAttribute("stroke-width", "1");
	crosshairLine.setAttribute("vector-effect", "non-scaling-stroke");
	crosshairLine.addClass("mtg-hidden");
	svgEl.appendChild(crosshairLine);

	const crosshairDots = drawn.map((s) => {
		const dot = document.createElementNS(svgNS, "circle");
		dot.setAttribute("r", "3");
		dot.setAttribute("fill", s.color);
		dot.addClass("mtg-hidden");
		svgEl.appendChild(dot);
		return dot;
	});

	const tooltip = plot.createDiv({ cls: "mtg-price-history-tooltip" });

	const update = (clientX: number) => {
		const rect = svgEl.getBoundingClientRect();
		if (rect.width === 0) return;
		const cursorFrac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		const targetT = minDate + cursorFrac * dateRange;

		let nearest = allTimestamps[0];
		let bestDiff = Infinity;
		for (const t of allTimestamps) {
			const diff = Math.abs(t - targetT);
			if (diff < bestDiff) {
				bestDiff = diff;
				nearest = t;
			}
		}

		const x = toX(nearest);
		crosshairLine.setAttribute("x1", String(x));
		crosshairLine.setAttribute("x2", String(x));
		crosshairLine.removeClass("mtg-hidden");

		const lines = [formatHistoryDate(nearest)];
		drawn.forEach((s, i) => {
			const point = s.points.find((p) => new Date(`${p.date}T00:00:00Z`).getTime() === nearest);
			const dot = crosshairDots[i];
			if (point) {
				dot.setAttribute("cx", String(x));
				dot.setAttribute("cy", String(s.toY(point.price)));
				dot.removeClass("mtg-hidden");
				lines.push(
					`${PRICE_HISTORY_VENDOR_LABELS[s.vendor] ?? s.vendor}: ${formatChartPrice(point.price, s.currency)}${
						s.converted ? " (converted)" : ""
					}`
				);
			} else {
				dot.addClass("mtg-hidden");
			}
		});

		tooltip.empty();
		lines.forEach((line) => tooltip.createDiv({ text: line }));
		tooltip.addClass("is-visible");
		// Anchored on the position ACTUALLY drawn of the cursor (x/W, the nearest
		// snapped point), not the raw fraction of the mouse — without this the
		// tooltip and the vertical line can diverge slightly on a chart with a low
		// point resolution. Flips to the left of the cursor past 75% of the width
		// so as never to overflow on the right.
		const snappedFrac = x / W;
		const nearRightEdge = snappedFrac > 0.75;
		tooltip.style.left = nearRightEdge ? "" : `${snappedFrac * 100}%`;
		tooltip.style.right = nearRightEdge ? `${(1 - snappedFrac) * 100}%` : "";
	};

	const hide = () => {
		crosshairLine.addClass("mtg-hidden");
		crosshairDots.forEach((d) => d.addClass("mtg-hidden"));
		tooltip.removeClass("is-visible");
	};

	plot.addEventListener("mousemove", (evt) => update(evt.clientX));
	plot.addEventListener("mouseleave", hide);
}

// Attribution of the source — a STATIC element, separate from `body` (see
// renderPriceHistoryChart above), added only once to the box itself by each
// modal (see renderPriceHistoryBox) rather than rebuilt each time the fetch
// resolves: it therefore stays visible from the very first paint (during
// loading) and not only once the data has arrived, which answers the
// passing request "can we display the source" even while waiting rather
// than only afterwards.
export function renderPriceHistorySourceFooter(box: HTMLElement): HTMLElement {
	const footer = box.createDiv({ cls: "mtg-price-history-source" });
	footer.setText("Source: cardbase.dev");
	footer.addEventListener("click", () => window.open("https://cardbase.dev", "_blank"));
	return footer;
}

// Completes the footer once the history is resolved, with the freshness
// date of the cardbase data (CardbasePriceHistory.asOf — see cardbase.ts
// for why it comes from the same response already fetched, no separate GET
// /status call). Called from the .then() of renderPriceHistoryBox (the 3
// modals), after renderPriceHistoryChart — separate from
// renderPriceHistorySourceFooter above rather than merged, since this
// information is only known after the fetch whereas the footer itself must
// exist from the first paint (see its own comment). A missing asOf (network
// failure, or malformed response) leaves the existing "Source:
// cardbase.dev" text as is rather than adding a missing date.
export function appendAsOfToSourceFooter(footer: HTMLElement, asOf: string | undefined) {
	if (!asOf) return;
	footer.setText(`Source: cardbase.dev · Data as of ${asOf}`);
}

export function renderLoadingDots(container: HTMLElement) {
	container.addClass("mtg-loading-dots");
	container.createSpan();
	container.createSpan();
	container.createSpan();
}

// Small "▲ +2.1%"/"▼ -1.3%" badge under the Card
// Kingdom/TCGplayer/Cardmarket price, previous day → today — see
// getCardbaseDayChange (cardbase.ts) for the calculation. Unicode glyph
// rather than a Lucide/setIcon icon: this file otherwise has no dependency
// on "obsidian" (see its file header — pure rendering helpers), and a solid
// triangle colored via `color` is more than enough for an indicator this
// small, no need to introduce that dependency for so little.
// `undefined`/"flat" (exactly 0% — the last two points are identical)
// render nothing at all rather than a gray "0.0%" badge: a day without
// movement is not interesting data to put forward here, and many cards
// simply won't have moved from one day to the next. The container is
// emptied/recolored on every call (not only filled once) to stay correct if
// ever called several times on the same element (not the case today, but
// avoids a silent trap if a future caller reuses the element).
export function renderDayChangeBadge(container: HTMLElement, change: CardbaseDayChange | undefined) {
	container.empty();
	container.removeClass("is-up", "is-down");
	if (!change || change.direction === "flat") return;
	container.addClass(change.direction === "up" ? "is-up" : "is-down");
	container.createSpan({ cls: "mtg-store-price-col-change-arrow", text: change.direction === "up" ? "▲" : "▼" });
	const sign = change.changePct > 0 ? "+" : "";
	container.createSpan({ text: `${sign}${change.changePct.toFixed(1)}%` });
}

// Builds an icon for a single mana symbol ("W", "2", "T", "2/W"...), shared
// by renderManaCostIcons (full cost) and renderTextWithManaSymbols (isolated
// symbols in the middle of rules text) below — same asynchronous lookup
// (`getSymbolSvg`, in practice `plugin.getManaSymbolSvg` on the caller's
// side, already used for the color-grouping icons in view.ts — same
// /symbology endpoint, same "{X}" keys), only the render size differs between
// the two uses. Each unrecognized symbol (very rare: a brand-new symbol not
// yet synchronized in the cache) falls back to its own raw text ("{W}")
// rather than a silent empty box.
function buildManaSymbolIcon(
	container: HTMLElement,
	letter: string,
	rawToken: string,
	getSymbolSvg: (letter: string) => Promise<string | null>,
	size: number
): HTMLElement {
	const iconEl = container.createSpan({ cls: "mtg-mana-symbol-icon" });
	void getSymbolSvg(letter).then((svg) => {
		if (!svg) {
			iconEl.setText(rawToken);
			return;
		}
		setSvgMarkup(iconEl, svg);
		const svgEl = iconEl.querySelector("svg");
		svgEl?.setAttribute("width", String(size));
		svgEl?.setAttribute("height", String(size));
	});
	return iconEl;
}

// Splits a Scryfall mana cost ("{2}{W}{W}") into official icons, one <span>
// per symbol — this function stays pure (no dependency on
// MTGCollectionPlugin, unlike the rest of this file) by receiving the
// lookup as a parameter, see buildManaSymbolIcon above.
export function renderManaCostIcons(
	container: HTMLElement,
	manaCost: string,
	getSymbolSvg: (letter: string) => Promise<string | null>
) {
	const symbols = manaCost.match(/\{[^}]+\}/g);
	if (!symbols) return;
	symbols.forEach((sym) => {
		buildManaSymbolIcon(container, sym.slice(1, -1), sym, getSymbolSvg, 16).addClass(
			"mtg-card-description-mana-symbol"
		);
	});
}

// Renders rules text by replacing each isolated mana symbol it contains
// (e.g. "{T}: Add {W}.") with its official icon, like renderManaCostIcons
// above but with normal text between the symbols — unlike a mana cost
// ("{2}{W}{W}"), oracle_text mixes plain text and symbols. The capturing
// regex (parentheses around the pattern) makes String.split keep the
// delimiters in the resulting array, unlike match() used by
// renderManaCostIcons — this is what allows rebuilding text and icons in the
// right order. Each text fragment is added as a real text node (no
// setText/markup) so as never to interpret a `<`/`&` of the rules text as
// HTML.
export function renderTextWithManaSymbols(
	container: HTMLElement,
	text: string,
	getSymbolSvg: (letter: string) => Promise<string | null>
) {
	const parts = text.split(/(\{[^}]+\})/g);
	parts.forEach((part) => {
		if (/^\{[^}]+\}$/.test(part)) {
			buildManaSymbolIcon(container, part.slice(1, -1), part, getSymbolSvg, 14).addClass(
				"mtg-card-description-inline-mana-symbol"
			);
		} else if (part) {
			container.appendChild(document.createTextNode(part));
		}
	});
}

// "Card Text" block of a multi-faced card (split, adventure, flip,
// transform, modal_dfc...) — see CardTextInfo.faces (scryfall.ts) for the
// full reasoning. One section per face (name, type+mana cost, rules text,
// stats), separated by a discreet line, rather than the original merged
// version ("Instant // Instant", the two mana costs end to end) — explicit
// feedback ("I'd prefer it to be clearly separated for each portion of the
// card... a discreet horizontal line" rather than a textual "//"). Reuses
// renderManaCostIcons/renderTextWithManaSymbols as is, once per face rather
// than once on the merged string — each face has its own mana cost/text
// already separated at the source (card_faces), so no more need to invent
// splitting logic.
// Called by the 3 detail modals in place of their own usual
// header+textEl+stats as soon as CardTextInfo.faces is present — see
// CardDetailModal.renderCardDescriptionBox for the call site.
export function renderCardDescriptionFaces(
	container: HTMLElement,
	faces: CardTextFace[],
	getSymbolSvg: (letter: string) => Promise<string | null>
) {
	faces.forEach((face, i) => {
		if (i > 0) container.createDiv({ cls: "mtg-card-description-face-divider" });
		const faceEl = container.createDiv({ cls: "mtg-card-description-face" });
		faceEl.createDiv({ cls: "mtg-card-description-face-name", text: face.name });
		const header = faceEl.createDiv({ cls: "mtg-card-description-header" });
		if (face.typeLine) header.createDiv({ cls: "mtg-card-description-type", text: face.typeLine });
		if (face.manaCost) {
			const manaCostEl = header.createDiv({ cls: "mtg-card-description-mana-cost" });
			renderManaCostIcons(manaCostEl, face.manaCost, getSymbolSvg);
		}
		const textEl = faceEl.createDiv({ cls: "mtg-card-description-text" });
		renderTextWithManaSymbols(textEl, face.oracleText || "No rules text.", getSymbolSvg);
		if (face.loyalty !== undefined) {
			faceEl.createDiv({ cls: "mtg-card-description-stats", text: `Loyalty: ${face.loyalty}` });
		} else if (face.power !== undefined || face.toughness !== undefined) {
			faceEl.createDiv({
				cls: "mtg-card-description-stats",
				text: `${face.power ?? "?"}/${face.toughness ?? "?"}`,
			});
		}
	});
}

// 3D "flip" button under the card, for true double-faced cards
// (transform/modal_dfc — see getDoubleFacedImages, scryfall.ts): shared by
// the 3 detail modals, same DOM/CSS/interaction everywhere. The staleness
// guard (this.card.scryfallId === the id requested when the fetch was
// launched, against a prev/next navigation during the Scryfall round trip)
// stays on the caller's side, same convention as
// renderPriceHistoryChart/renderDayChangeBadge higher up in this file — this
// function only builds the DOM once we already know there is a back face to
// show.
// `tilt` must already contain all its usual "front" content (the image + any
// foil/holo layers, built by the caller exactly as before for a
// non-double-faced card) — this function moves these existing children into
// a new rotation container rather than rebuilding them, so call this AFTER
// the caller has finished populating `tilt`, never before. setupCardTilt
// (already called on this same `tilt` before this, in the 3 modals) only
// reads/writes properties on `tilt` itself (style.transform, --holo-*, a
// ResizeObserver on its width) — no assumption about its children, so
// rearranging them afterwards doesn't disturb it.
// No dependency on setIcon/"obsidian" here (see the header of this file —
// none of the other shared rendering functions has one, same reasoning as
// renderDayChangeBadge for its ▲/▼ glyph): the button's icon is a simple
// Unicode character rather than a Lucide icon.
export function setupDoubleFacedFlip(
	imageColumn: HTMLElement,
	tilt: HTMLElement,
	backImageUrl: string,
	initiallyFlipped: boolean,
	onToggle: (flipped: boolean) => void
): void {
	const flipStage = tilt.createDiv({ cls: "mtg-card-detail-flip-stage" });
	const frontFace = flipStage.createDiv({
		cls: "mtg-card-detail-flip-face mtg-card-detail-flip-face-front",
	});
	// Array.from copies the NodeList BEFORE emptying it by moving —
	// appendChild removes each child from its original parent (tilt) as it
	// goes, so iterating the live NodeList of `tilt` directly would skip every
	// other child as the move progresses.
	Array.from(tilt.children)
		.filter((child) => child !== flipStage)
		.forEach((child) => frontFace.appendChild(child));

	const backFace = flipStage.createDiv({
		cls: "mtg-card-detail-flip-face mtg-card-detail-flip-face-back",
	});
	backFace.createEl("img", { cls: "mtg-card-detail-image", attr: { src: backImageUrl } });

	if (initiallyFlipped) flipStage.addClass("is-flipped");

	const btn = imageColumn.createDiv({ cls: "mtg-card-detail-flip-btn" });
	const updateLabel = () => {
		btn.empty();
		btn.createSpan({ cls: "mtg-card-detail-flip-btn-icon", text: "⇄" });
		btn.createSpan({ text: flipStage.hasClass("is-flipped") ? "Show front" : "Show back" });
	};
	updateLabel();
	btn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		const flipped = !flipStage.hasClass("is-flipped");
		flipStage.toggleClass("is-flipped", flipped);
		updateLabel();
		onToggle(flipped);
	});
}

// Real ratio of a Scryfall "normal" image (488×680 — see "Card view" in
// CLAUDE.md for this reference): height = width × this ratio, in natural
// portrait orientation. Used here to compute, for a given `stage` width,
// the natural landscape height of a rotated card (width × 1/this ratio) —
// `stage` itself always keeps the inverse aspect-ratio 488/680
// (styles.css), so this number only needs to be defined once here rather
// than duplicated on both sides.
const SCRYFALL_CARD_PORTRAIT_RATIO = 680 / 488;

// "Rotation" button for split cards (Fire // Ice, Never // Return... — see
// getSplitCardInfo, scryfall.ts): unlike setupDoubleFacedFlip above, there
// is only ONE printed visual here — it is its DISPLAY that must be rotated
// by 90°, not a second visual to reveal.
// Same calling conventions as setupDoubleFacedFlip: `tilt` must already
// contain all its usual content (image + any foil/holo layers), this
// function moves these existing children into a rotation layer rather than
// rebuilding them — call AFTER the caller has finished populating `tilt`,
// and after setupCardTilt (which only reads/writes properties on `tilt`
// itself, no assumption about its children — same reasoning already
// established for setupDoubleFacedFlip). The staleness guard
// (this.card.scryfallId === the requested id) stays on the caller's side,
// same convention as the other async boxes of this panel.
//
// **Redesign (2026-08-17)** following two pieces of feedback: the "Rotate to
// read"/"Reset rotation" button moved vertically depending on the state (the
// very first version only reserved the landscape height, which is shorter,
// while rotated), and the rotation felt "abrupt" (not animated at all, out
// of caution — see the old version of this comment in the git history). See
// styles.css for the full detail of the new calculation: `stage` now ALWAYS
// keeps the portrait aspect-ratio (488/680), so its reserved height never
// moves again — which pins the button once and for all — and `rotateLayer`
// is now ALWAYS position:absolute + centered in both states (never a
// `position` that toggles, a non-interpolable property), which makes the
// animation possible: resize() now sets an explicit width/height on it, in
// JS, in BOTH states (not only when rotated) — at rest, the natural portrait
// size of `stage` at its current width; rotated, these two values swapped,
// so that the rectangle painted after rotate(90deg) spans the full width of
// `stage` at its natural landscape height (shorter than `stage` itself, now
// always portrait — hence the empty space centered above/below the rotated
// card, the deliberate compromise that buys the button's stability).
// ResizeObserver on `stage`, same technique as
// setupCardTileRadiusObserver/computeCardTileRadius (view.ts, see "Card
// view" in CLAUDE.md) — no explicit disconnect(), same reasoning already
// established for the setupCardTilt observer on this same `tilt`: `stage` is
// rebuilt from scratch on every draw(), never reused, so once the old
// element is detached with no other reference, its observer becomes eligible
// for GC by itself.
// Animated transition this time (unlike the previous version, cautiously not
// animated by analogy with the desynchronization bug of
// .mtg-card-detail-grading-wrapper, see "v13" in CLAUDE.md): that risk
// concerned two distinct rendering ELEMENTS/mechanisms that had to stay in
// phase (grid-template-rows on one side, the margin of a neighboring element
// on the other) — here everything changes on the SAME element
// (`rotateLayer`), in the SAME synchronous batch (class + style.width/height
// set in the same tick, see applyState below), so the browser has only one
// "before"/"after" state to interpolate, without that class of risk.
export function setupSplitCardRotation(
	imageColumn: HTMLElement,
	tilt: HTMLElement,
	initiallyRotated: boolean,
	onToggle: (rotated: boolean) => void
): void {
	const stage = tilt.createDiv({ cls: "mtg-card-detail-split-stage" });
	const rotateLayer = stage.createDiv({ cls: "mtg-card-detail-split-rotate" });
	Array.from(tilt.children)
		.filter((child) => child !== stage)
		.forEach((child) => rotateLayer.appendChild(child));

	let rotated = initiallyRotated;

	// offsetWidth, NOT getBoundingClientRect().width (reported bug: the next
	// card displayed "smaller" when navigating from a rotated card to another
	// split card) — getBoundingClientRect() reflects the VISUAL geometry,
	// hence ANY CSS transform carried by an ANCESTOR, including a transient
	// one. `stage` lives under `.mtg-card-detail-image-wrap`, which carries
	// for ~1-2 frames the entry transform of the Cover Flow carousel
	// (animateCardNav, translateX + rotateY, see styles.css) — if the
	// getSplitCardInfo promise of the next card resolves very quickly (cache
	// already warm, e.g. a card already visited this session: the .then()
	// callback runs in a microtask, BEFORE the first requestAnimationFrame
	// that removes this transform), resize() then measured the card still
	// shrunk by the carousel's 3D perspective (rotateY distorts the perceived
	// width), freezing this too-small size for good since nothing triggers
	// resize() again once the transform is removed (a transform never changes
	// the LAYOUT size, only the visual rendering — ResizeObserver, which
	// observes the layout box, therefore doesn't fire again when this
	// transform disappears). offsetWidth returns the real layout width,
	// insensitive to any transform (its own or an ancestor's) — the right
	// measure here, whenever it takes place.
	const resize = () => {
		const width = stage.offsetWidth;
		if (width === 0) return;
		if (rotated) {
			// Pre-rotation: width/height swapped so that after rotate(90deg) the
			// painted rectangle spans the full width of `stage`, at its natural
			// landscape height.
			rotateLayer.style.width = `${width / SCRYFALL_CARD_PORTRAIT_RATIO}px`;
			rotateLayer.style.height = `${width}px`;
		} else {
			rotateLayer.style.width = `${width}px`;
			rotateLayer.style.height = `${width * SCRYFALL_CARD_PORTRAIT_RATIO}px`;
		}
	};

	const applyState = () => {
		stage.toggleClass("is-rotated", rotated);
		resize();
	};
	applyState();

	const observer = new ResizeObserver(() => resize());
	observer.observe(stage);

	// Reuses .mtg-card-detail-flip-btn/-btn-icon as is (same accent-outline
	// pill under the image as the 3D "flip" button) rather than a dedicated
	// class — the two buttons never coexist (a card is either a true
	// double-faced card or split, never both at once, see
	// getDoubleFacedImages/getSplitCardInfo), and the visual style is generic
	// — same reuse reasoning as .mtg-card-detail-backdrop/-close-btn elsewhere
	// in this plugin (the name doesn't fit each use exactly, but the CSS rule
	// itself is generic).
	const btn = imageColumn.createDiv({ cls: "mtg-card-detail-flip-btn" });
	const updateLabel = () => {
		btn.empty();
		btn.createSpan({ cls: "mtg-card-detail-flip-btn-icon", text: "↻" });
		btn.createSpan({ text: rotated ? "Reset rotation" : "Rotate to read" });
	};
	updateLabel();
	btn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		rotated = !rotated;
		// The animated geometry (transform + width/height, all three in
		// transition, see styles.css) makes the painted rectangle transiently
		// overflow beyond its resting size — the natural "bulge" of a rectangle
		// that rotates AND changes size at the same time, maximal around 45°
		// (measured ~1.45× the resting width in an isolated test) — which the clip
		// of `tilt` (sized for the TWO resting states, not for this transient
		// peak) visibly cropped during the rotation (reported bug). Disabled for
		// the duration of the transition (same duration as the CSS, 450ms): once
		// it stops, the clip is cleanly reapplied on the exact final shape —
		// `.mtg-card-detail-nav-viewport`, wider than the card and never touched
		// here, keeps containing any overflow within the bounds of the column
		// during this window.
		tilt.addClass("mtg-card-detail-tilt-rotating");
		window.setTimeout(() => tilt.removeClass("mtg-card-detail-tilt-rotating"), 450);
		applyState();
		updateLabel();
		onToggle(rotated);
	});
}

export function renderLegalityColorLegend(box: HTMLElement) {
	const legend = box.createDiv({ cls: "mtg-legal-formats-legend" });
	const items: { cls: string; label: string }[] = [
		{ cls: "is-legal", label: "Legal" },
		{ cls: "is-restricted", label: "Restricted" },
		{ cls: "is-banned", label: "Banned" },
		{ cls: "is-not-legal", label: "Not legal" },
	];
	items.forEach(({ cls, label }) => {
		const item = legend.createDiv({ cls: "mtg-legal-formats-legend-item" });
		item.createDiv({ cls: `mtg-legal-formats-legend-swatch ${cls}` });
		item.createSpan({ text: label });
	});
}
