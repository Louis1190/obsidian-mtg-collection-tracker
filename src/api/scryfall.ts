import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

/* -------------------------------------------------------------------------- */
/*  Scryfall API helpers                                                      */
/* -------------------------------------------------------------------------- */

// Summary of a set as returned by /sets (full list), used for
// autocompleting the "Set" field in the add-card search.
export interface ScryfallSetSummary {
	code: string;
	name: string;
	set_type: string;
	released_at?: string;
	icon_svg_uri?: string;
	digital: boolean;
}

export interface ScryfallCard {
	id: string;
	name: string;
	set: string;
	set_name: string;
	collector_number: string;
	rarity: string;
	mana_cost?: string;
	cmc?: number;
	type_line: string;
	oracle_text?: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
	artist?: string;
	colors?: string[];
	keywords?: string[];
	released_at?: string;
	// "split" covers Fire // Ice as well as Never // Return (the Aftermath
	// mechanic, merged by Scryfall under this same layout — see
	// getSplitCardInfo further down); "transform"/"modal_dfc"/etc. for real
	// double-faced cards — see getDoubleFacedImages, which does not depend on
	// this field (falls back to the presence/absence of image_uris at the
	// root, more reliable, see its own comment).
	layout?: string;
	image_uris?: { normal?: string; small?: string; art_crop?: string };
	card_faces?: {
		name?: string;
		mana_cost?: string;
		type_line?: string;
		oracle_text?: string;
		power?: string;
		toughness?: string;
		loyalty?: string;
		image_uris?: { normal?: string; small?: string; art_crop?: string };
	}[];
	prices?: {
		usd?: string;
		usd_foil?: string;
		usd_etched?: string;
		eur?: string;
		eur_foil?: string;
		eur_etched?: string;
	};
	legalities?: Record<string, string>;
	purchase_uris?: { tcgplayer?: string };
	// Border/frame ("border:" filter, card-search.ts) — always present at the
	// root level, including for a double-faced card (unlike
	// oracle_text/power/toughness, see buildCardTextInfo further down), so no
	// face-combining logic is needed here. Confirmed live on /cards/search on
	// 2026-08-16: border_color ∈ {black, white, silver, gold, yellow,
	// borderless} (gold exists on the API side but there is no known card
	// today); frame_effects can carry several values at once (e.g.
	// ["legendary", "showcase"]) — only "extendedart"/"showcase" interest us,
	// see BORDER_SEARCH_OPTIONS (card-search.ts); the "retro" frame is neither
	// of those, it is frame === "1997".
	border_color?: string;
	frame?: string;
	frame_effects?: string[];
}

// Subset of ScryfallCard consumed by
// MTGCollectionPlugin.getScryfallImmutableSnapshot (plugin.ts): originally
// (2026-08-18) the fields shared by
// buildCardTextInfo/getDoubleFacedImages/getSplitCardInfo +
// purchase_uris.tcgplayer — exactly what opening a card detail needs to
// derive for "Card Text"/the Flip button/the Rotate button/the TCGplayer
// link, in a single Scryfall round trip per card instead of the 4 independent
// requests that these 4 features were still making, until then, for the same
// id. Widened twice since (2026-09-23, see the fields themselves below) for
// CardPreviewModal (Home's Market Trends, card-preview-modal.ts):
// set/set_name/collector_number/rarity/mana_cost/type_line, just as immutable
// per scryfallId as oracle_text/image_uris (a given printing never changes
// set/number/rarity/cost/type). Still deliberately WITHOUT
// `prices`/`legalities`/`name`/etc. — an object cached indefinitely (see
// SCRYFALL_IMMUTABLE_CACHE_FILENAME, never a TTL) must structurally not be
// re-readable as a fresh price/legality source by mistake; those two go stale
// (daily price, legality re-checked within 7 days) whereas nothing in this
// Pick ever changes once the printing is out (textual errata aside). A full
// ScryfallCard object still structurally satisfies this narrower (Pick) type,
// so buildCardTextInfo/getDoubleFacedImages/getSplitCardInfo remain callable
// unchanged everywhere else (CSV import, add search...) where a full
// ScryfallCard is already available.
export type ScryfallImmutableSnapshot = Pick<
	ScryfallCard,
	| "oracle_text"
	| "power"
	| "toughness"
	| "loyalty"
	| "card_faces"
	| "purchase_uris"
	| "image_uris"
	| "layout"
	| "keywords"
	| "set"
	| "set_name"
	| "collector_number"
	| "rarity"
	// mana_cost/type_line : root-level only (a multi-face card's own
	// per-face values already come through card_faces[] above, which
	// CardTextInfo.faces/CardTextFace already carry — see buildCardTextInfo
	// below) — needed by CardPreviewModal's single-face path, the first
	// consumer of this type with no CollectionCard/DeckCard/WantlistCard of
	// its own already caching these (see CardTextInfo's own comment for why
	// every earlier consumer never needed them here).
	| "mana_cost"
	| "type_line"
>;

// A single face of a multi-faced card (split, adventure, flip, transform,
// modal_dfc, meld...), for the "Card Text" display of the detail panel
// (CardDetailModal.renderCardDescriptionBox, renderCardDescriptionFaces in
// card-detail-fx.ts) — see CardTextInfo.faces below for the full
// reasoning.
export interface CardTextFace {
	name: string;
	manaCost?: string;
	typeLine?: string;
	oracleText: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
}

// Rules text + stats ("Card Text" block of the detail panel, see
// CardDetailModal.renderCardDescriptionBox) — name/cost/type are already
// cached on CollectionCard/DeckCard/WantlistCard (see "Files" in CLAUDE.md),
// so no need to bring them up again here; only
// oracle_text/power/toughness/loyalty had never been stored anywhere in this
// plugin before this block.
export interface CardTextInfo {
	oracleText: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
	// Non-undefined ONLY for a multi-faced card (see buildCardTextInfo below)
	// — per-actual-face detail (each with its own name/cost/type/text/stats),
	// rather than the merged version above. Added following explicit feedback
	// (Fire // Ice displayed its two mana costs end to end and "Instant //
	// Instant" as the combined type, judged unreadable) —
	// renderCardDescriptionBox prefers this field whenever it is present, to
	// display each face in its own section separated by a discreet line rather
	// than a textual "//". oracleText/power/toughness/loyalty above remain the
	// merged version, unchanged, for any code that doesn't need this
	// separation.
	faces?: CardTextFace[];
}

// Double-faced cards (transform/modal/split...): Scryfall returns neither
// oracle_text nor power/toughness/loyalty at the root level for these cards
// (unlike type_line, always a combination of both faces even at the root
// level) — each face's text lives in card_faces[]. The merged version
// (oracleText/power/toughness/loyalty) deliberately stays simple rather than
// a full front/back layout (the original fallback, before `faces` existed):
// it concatenates each face's text (preceded by its own name to stay
// readable), and takes the stats of the first face that has any — a
// creature/planeswalker DFC almost never has both faces with different stats
// at the same time, so this choice already covers the vast majority of real
// cases. `faces` (added afterwards) also exposes the per-face detail as is,
// without merging — name/cost/type specific to EACH face, no "//" nor mana
// costs end to end, for a display that truly separates "Fire" from "Ice" (or
// the front from the back of a real double-faced card) rather than combining
// them in a single block.
export function buildCardTextInfo(card: ScryfallImmutableSnapshot): CardTextInfo {
	if (card.oracle_text !== undefined || !card.card_faces || card.card_faces.length === 0) {
		return {
			oracleText: card.oracle_text ?? "",
			power: card.power,
			toughness: card.toughness,
			loyalty: card.loyalty,
		};
	}
	const oracleText = card.card_faces
		.map((face) => {
			if (!face.oracle_text) return null;
			return face.name ? `${face.name}\n${face.oracle_text}` : face.oracle_text;
		})
		.filter((text): text is string => !!text)
		.join("\n\n// \n\n");
	const faceWithStats = card.card_faces.find(
		(face) => face.power !== undefined || face.toughness !== undefined || face.loyalty !== undefined
	);
	const faces: CardTextFace[] = card.card_faces.map((face) => ({
		name: face.name ?? "",
		manaCost: face.mana_cost,
		typeLine: face.type_line,
		oracleText: face.oracle_text ?? "",
		power: face.power,
		toughness: face.toughness,
		loyalty: face.loyalty,
	}));
	return {
		oracleText,
		power: faceWithStats?.power,
		toughness: faceWithStats?.toughness,
		loyalty: faceWithStats?.loyalty,
		faces,
	};
}

// Front/back images of a REAL physical double-faced card (transform,
// modal_dfc, reversible_card, double_faced_token — two illustrations
// printed on the two sides of a single card), for the 3D "flip" button
// under the image in the 3 detail modals. NOT to be confused with the
// split/adventure/flip/meld layouts, which also have a non-empty
// card_faces[] but only one actually printed visual (the "faces" there
// describe textual components of a single physical card, e.g. Fire // Ice
// or Brazen Borrower/Petty Theft) — checked live on /cards/named on
// 2026-08-16 for the 6 layouts concerned: a real double-faced card NEVER
// has image_uris at the root level (only on each of its 2 card_faces),
// whereas split/adventure/flip/meld ALWAYS have image_uris at the root
// (and, for split/adventure/flip, card_faces WITHOUT their own image_uris).
// It is this signal — root without an image, the first two faces with one —
// that reliably distinguishes "there is a real back to reveal" from the
// rest, without needing the `layout` field itself.
export interface DoubleFacedImages {
	front: string;
	back: string;
}

export function getDoubleFacedImages(card: ScryfallImmutableSnapshot): DoubleFacedImages | null {
	if (card.image_uris?.normal) return null;
	const faces = card.card_faces;
	if (!faces || faces.length < 2) return null;
	const front = faces[0].image_uris?.normal;
	const back = faces[1].image_uris?.normal;
	if (!front || !back) return null;
	return { front, back };
}

// "Split" cards (Fire // Ice, Dusk // Dawn...), including the Aftermath
// mechanic (Never // Return) — merged by Scryfall under this same "split"
// layout, there is no longer a separate "aftermath" layout (checked live on
// /cards/named on 2026-08-17, for both sub-cases). Unlike the real
// double-faced cards above, there is only ONE printed visual here whose text
// is rotated 90° in the frame — so it is the DISPLAY that must be rotated,
// not a second visual to reveal (see setupSplitCardRotation,
// card-detail-fx.ts).
// The two sub-cases behave differently once rotated, hence the need to tell
// them apart rather than treat every "split" layout the same: on a classic
// split, both halves are printed rotated in the SAME direction (confirmed by
// comparing the real images of Fire // Ice) — a single 90° rotation therefore
// makes BOTH of them readable at the same time. On an Aftermath split, ONLY
// the second half is rotated (the first stays readable in portrait — it is
// the one normally cast from hand, before the second becomes castable from
// the graveyard): no single rotation makes both readable at once, so there is
// no universally correct default orientation for this sub-case —
// setupSplitCardRotation therefore starts from portrait for this one (first
// half already readable without manipulation), manual rotation only.
// Detected via keywords ∋ "Aftermath" rather than a card name or a text
// heuristic — confirmed live: present at the card's root level (keywords:
// ["Aftermath"]), absent from the faces themselves.
export interface SplitCardInfo {
	isAftermath: boolean;
}

export function getSplitCardInfo(card: ScryfallImmutableSnapshot): SplitCardInfo | null {
	if (card.layout !== "split") return null;
	return { isAftermath: !!card.keywords?.includes("Aftermath") };
}

export const SCRYFALL_HEADERS = {
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json;q=0.9,*/*;q=0.8",
};

export class ScryfallError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

let scryfallGateChain: Promise<void> = Promise.resolve();
// <10 requests/second with a real margin (≈9 req/s max), not just right at
// the limit documented by Scryfall.
const SCRYFALL_MIN_GAP_MS = 110;

function reserveScryfallSlot(): Promise<void> {
	const slot = scryfallGateChain.then(() => sleep(SCRYFALL_MIN_GAP_MS));
	scryfallGateChain = slot;
	return slot;
}

export async function requestScryfall(params: RequestUrlParam): Promise<RequestUrlResponse> {
	await reserveScryfallSlot();
	const res = await requestUrl({ ...params, throw: false });
	if (res.status === 429) {
		const header = res.headers?.["retry-after"] ?? res.headers?.["Retry-After"];
		const seconds = header ? Number(header) : NaN;
		// Valid Retry-After (seconds, capped at 5s so as never to freeze the UI
		// for too long), otherwise a reasonable fallback — Scryfall does not
		// always send this header despite its own documentation.
		const waitMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : 2000;
		await sleep(waitMs);
	}
	return res;
}

// Result of a paginated search — `hasMore` reflects the raw `has_more` of
// the Scryfall response (a page holds up to 175 cards; beyond that, a broad
// search has more to offer), `totalCards` its `total_cards` (total number of
// search results, all pages combined — not just `cards.length`, which only
// counts THIS page). Used by searchScryfall and fetchLatestPaperPrintings
// below, both paginated the same way through an optional `page` parameter —
// a single shared result type rather than one per function, since the call
// site (AddCardsModal, "Load more") treats both interchangeably.
export interface ScryfallPagedResult {
	cards: ScryfallCard[];
	hasMore: boolean;
	totalCards: number;
}

// JSON body of Scryfall's search and error responses (`res.json` is `any`: we type it here, once).
interface ScryfallListBody {
	data?: ScryfallCard[];
	has_more?: boolean;
	total_cards?: number;
}
interface ScryfallErrorBody {
	details?: string;
}

// order/dir: same values as the `order` parameter of the Scryfall API (e.g.
// "usd" to sort by price). Used by the "Price up"/"Price down" suggestions
// of AddCardsModal (add-cards-modal.ts) — when provided, takes precedence
// over the automatic choice (sort by set if a "set:" filter is active,
// otherwise by release date) rather than adding to it: a sort explicitly
// chosen by the user must win over the default heuristic.
// `page` (1-indexed, like the Scryfall API itself) serves the "Load more"
// of AddCardsModal — a broad search can exceed the 175 results that a
// single Scryfall page returns; never passed by the 2 CSV import call sites
// in plugin.ts, which only ever want the first result of a name lookup, so
// it implicitly stays at 1 (default) for them.
export async function searchScryfall(
	name: string,
	setCode: string,
	collectorNumber: string,
	chipQuery = "",
	sortOverride?: { order: string; dir: "asc" | "desc" },
	page = 1
): Promise<ScryfallPagedResult> {
	// If a collector number AND a set are provided, we can query the
	// "cards/{set}/{number}" endpoint directly, exact and fast — a set+number
	// already identifies a single printing, so any other active chips are
	// redundant in that case anyway.
	// No pagination possible here (at most one card) — page is ignored on this
	// branch.
	if (setCode && collectorNumber) {
		const res = await requestScryfall({
			url: `https://api.scryfall.com/cards/${encodeURIComponent(
				setCode.toLowerCase()
			)}/${encodeURIComponent(collectorNumber)}`,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (res.status === 200) {
			return { cards: [res.json as ScryfallCard], hasMore: false, totalCards: 1 };
		}
		if (res.status !== 404) {
			throw new ScryfallError(
				res.status,
				(res.json as ScryfallErrorBody | undefined)?.details ?? `Scryfall returned HTTP ${res.status}`
			);
		}
		// 404 on this exact endpoint -> we fall back to the classic search
	}

	const parts: string[] = [];
	if (name) parts.push(name);
	if (setCode) parts.push(`set:${setCode}`);
	if (collectorNumber) parts.push(`cn:${collectorNumber}`);
	if (chipQuery) parts.push(chipQuery);

	if (parts.length === 0) return { cards: [], hasMore: false, totalCards: 0 };

	const fullQuery = parts.join(" ");
	// When a set filter is active, sorting by set+number ascending (the set's
	// first card first) is more useful than the default release-date sort —
	// all cards of the same set share the same date anyway.
	const hasSetFilter = /\b(set|s):\S+/i.test(fullQuery);
	const orderParams = sortOverride
		? `order=${sortOverride.order}&dir=${sortOverride.dir}`
		: hasSetFilter
		? "order=set&dir=asc"
		: "order=released";

	const query = encodeURIComponent(fullQuery);
	const pageParam = page > 1 ? `&page=${page}` : "";
	const res = await requestScryfall({
		url: `https://api.scryfall.com/cards/search?q=${query}&${orderParams}&unique=prints${pageParam}`,
		headers: SCRYFALL_HEADERS,
		throw: false,
	});

	if (res.status === 404) return { cards: [], hasMore: false, totalCards: 0 }; // no card found, normal Scryfall response
	if (res.status !== 200) {
		throw new ScryfallError(
			res.status,
			(res.json as ScryfallErrorBody | undefined)?.details ?? `Scryfall returned HTTP ${res.status}`
		);
	}
	const data = res.json as ScryfallListBody;
	const cards = data.data ?? [];
	return {
		cards,
		hasMore: !!data.has_more,
		totalCards: typeof data.total_cards === "number" ? data.total_cards : cards.length,
	};
}

// The most recently released cards, paper version only (the plugin only
// handles physical cards). Serves as the default content when the search
// opens, before the user types anything — avoids an empty results area that
// would suddenly grow once the first search is launched. `page` — see
// searchScryfall above, same reasoning/mechanism.
export async function fetchLatestPaperPrintings(
	sortOverride?: { order: string; dir: "asc" | "desc" },
	page = 1
): Promise<ScryfallPagedResult> {
	const order = sortOverride?.order ?? "released";
	const dir = sortOverride?.dir ?? "desc";
	const query = encodeURIComponent("game:paper");
	const pageParam = page > 1 ? `&page=${page}` : "";
	const res = await requestScryfall({
		url: `https://api.scryfall.com/cards/search?q=${query}&order=${order}&dir=${dir}&unique=prints${pageParam}`,
		headers: SCRYFALL_HEADERS,
		throw: false,
	});
	if (res.status !== 200) return { cards: [], hasMore: false, totalCards: 0 };
	const body = res.json as ScryfallListBody;
	const cards = body.data ?? [];
	return {
		cards,
		hasMore: !!body.has_more,
		totalCards: typeof body.total_cards === "number" ? body.total_cards : cards.length,
	};
}

export function getImageUrl(card: ScryfallCard): string {
	if (card.image_uris?.normal) return card.image_uris.normal;
	if (card.card_faces?.[0]?.image_uris?.normal)
		return card.card_faces[0].image_uris.normal;
	if (card.image_uris?.small) return card.image_uris.small;
	return "";
}

// Just the card's artwork, without the frame or text: much better suited
// to a background image (list tile) than a scan of the whole card.
export function getArtCropUrl(card: ScryfallCard): string {
	if (card.image_uris?.art_crop) return card.image_uris.art_crop;
	if (card.card_faces?.[0]?.image_uris?.art_crop)
		return card.card_faces[0].image_uris.art_crop;
	return getImageUrl(card);
}

// Color of the set symbol according to rarity, as on real cards / in Delver:
// gold for rare, silver for uncommon, white for common.
export const RARITY_COLORS: Record<string, string> = {
	mythic: "#d9662b",
	rare: "#d4af37",
	uncommon: "#9fb4c7",
	common: "#ffffff",
	special: "#9fb4c7",
	bonus: "#d4af37",
};

export function getRarityColor(rarity: string): string {
	return RARITY_COLORS[rarity?.toLowerCase()] ?? "#ffffff";
}

// All existing printings of a card, by exact name (`!"Name"`), used to
// offer a set change on a card already in the collection (the physical
// card may belong to a different set than the one recorded by mistake, or
// we simply want to change it).
export async function searchAllPrintings(name: string): Promise<ScryfallCard[]> {
	const query = encodeURIComponent(`!"${name}" unique:prints`);
	const res = await requestScryfall({
		url: `https://api.scryfall.com/cards/search?q=${query}&order=released&dir=desc`,
		headers: SCRYFALL_HEADERS,
		throw: false,
	});
	if (res.status !== 200) return [];
	return (res.json as ScryfallListBody).data ?? [];
}

// Applies a color to an SVG already inserted in the DOM, directly on each
// shape (path/circle/rect/polygon/g) rather than relying on `currentColor`,
// which can fail depending on the source SVG's internal structure (e.g.
// fill defined on a parent <g> rather than on each <path>).
export function applySvgColor(container: HTMLElement, color: string) {
	container.style.color = color;
	container
		.querySelectorAll("path, circle, rect, polygon, ellipse, g")
		.forEach((el) => {
			(el as HTMLElement).style.fill = color;
		});
}

export function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

// Kinds of set judged "accessory" rather than the main product — a
// Scryfall set symbol is very often shared between the expansion itself
// and its own tokens/promos/art series (checked live on /sets: 987
// non-digital sets, only 337 distinct symbols). Used by dedupeSetsByIcon
// below to keep only the most "main" entry per symbol, rather than listing
// every variant separately for a visually identical icon
// (ListSettingsModal, "Choose icon", "Set Symbol" grid).
const SET_TYPE_DEPRIORITIZED = new Set(["token", "memorabilia", "promo", "minigame"]);

// sets.icon_svg_uri serves as the grouping key; a set with no known icon
// (no real case found at the time of writing, but the API doesn't
// explicitly guarantee it) falls back to its own code, never merged with
// another. Input order preserved within each group: the winning entry is
// the first "non-accessory" one encountered, or otherwise the very first
// one.
export function dedupeSetsByIcon(sets: ScryfallSetSummary[]): ScryfallSetSummary[] {
	const byIcon = new Map<string, ScryfallSetSummary>();
	sets.forEach((s) => {
		const key = s.icon_svg_uri ?? `code:${s.code}`;
		const existing = byIcon.get(key);
		if (!existing) {
			byIcon.set(key, s);
			return;
		}
		if (SET_TYPE_DEPRIORITIZED.has(existing.set_type) && !SET_TYPE_DEPRIORITIZED.has(s.set_type)) {
			byIcon.set(key, s);
		}
	});
	return Array.from(byIcon.values());
}

// High-level grouping of the "Set Symbol" grid (ListSettingsModal, "Choose
// icon") — requested on the model of the Keyrune reference page
// (https://keyrune.andrewgioia.com/icons.html, 16 categories), but derived
// from Scryfall's set_type field rather than copied as is: Keyrune maintains
// its own list by hand, set by set, which would break the 100% automatic
// update already in place here (a new set lands in the right group by itself
// through its set_type, without any code needing to change). 9 groups rather
// than Keyrune's 16 — several of its categories (e.g. "Global Series",
// "Guild Kits") don't exist as a distinct set_type and could therefore only
// be derived by hand. The 22 set_type values actually observed on /sets
// (checked live) are all covered below.
const SET_TYPE_GROUPS: { label: string; types: string[] }[] = [
	{ label: "Core sets", types: ["core"] },
	{ label: "Expansion sets", types: ["expansion"] },
	{ label: "Commander & multiplayer", types: ["commander", "planechase", "archenemy", "vanguard", "arsenal"] },
	{
		label: "Draft innovations & masters",
		types: ["masters", "draft_innovation", "duel_deck", "from_the_vault", "premium_deck", "spellbook"],
	},
	{ label: "Starter & box sets", types: ["starter", "box"] },
	{ label: "Masterpiece series", types: ["masterpiece"] },
	{ label: "Promos & tokens", types: ["promo", "token", "memorabilia"] },
	{ label: "Minigames & other", types: ["minigame", "eternal"] },
	{ label: "Un-Sets", types: ["funny"] },
];

// Explicit fallback for a set_type not covered above (a new category
// Scryfall might introduce after this file was written) — displayed in its
// own "Other" group rather than silently excluded from the grid.
export function getSetGroupLabel(setType: string): string {
	const found = SET_TYPE_GROUPS.find((g) => g.types.includes(setType));
	return found ? found.label : "Other";
}

// Display order of the groups in the grid — "Other" always last, for the
// same fallback as above.
export const SET_GROUP_ORDER: string[] = [...SET_TYPE_GROUPS.map((g) => g.label), "Other"];

// Minimal SVG cleanup before it is cached / inserted into the DOM — used both for the
// ribbon's customizable icon (customIconSvg, free input) and for the set/symbol SVGs
// fetched from Scryfall (fetchSetIconSvg/fetchManaSymbolSvg, plugin.ts). Removes:
// - <script> tags;
// - event-handler attributes (onclick, onload…);
// - javascript:/data: URIs in href/xlink:href (e.g. <a href="javascript:...">, <use
//   href="data:image/svg+xml;base64,...">) — a <script>-less SVG can still execute code
//   through these attributes;
// - <foreignObject> (can embed arbitrary HTML/JS in an SVG context) and the SMIL
//   animation tags (<animate>/<set>/<animateTransform>/<animateMotion>), a historical
//   SVG XSS vector through their values/to/from attributes.
// It remains a regex cleanup, not a guarantee: the real barrier is setSvgMarkup
// (ui/svg-markup.ts), which rebuilds the DOM from an allow-list and therefore lets
// through no <script>, no on* attribute, no href, whatever this cleanup left behind. It
// remains useful upstream: what is cached on disk is already clean.
export function sanitizeSvg(svg: string): string {
	let clean = svg.replace(/<script[\s\S]*?<\/script>/gi, "");
	clean = clean.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
	clean = clean.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
	clean = clean.replace(/\s(?:xlink:)?href\s*=\s*"\s*(?:javascript|data):[^"]*"/gi, "");
	clean = clean.replace(/\s(?:xlink:)?href\s*=\s*'\s*(?:javascript|data):[^']*'/gi, "");
	clean = clean.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
	clean = clean.replace(/<(animate|animatetransform|animatemotion|set)\b[^>]*\/?>(?:[\s\S]*?<\/\1>)?/gi, "");
	return clean;
}

// Minimal "RFC 4180" CSV parser: handles quoted fields containing commas, line
// breaks and escaped quotes (""). Needed because Delver exports contain
// multi-line rules text.
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;
	const len = text.length;

	while (i < len) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
				} else {
					inQuotes = false;
					i++;
				}
			} else {
				field += ch;
				i++;
			}
		} else if (ch === '"') {
			inQuotes = true;
			i++;
		} else if (ch === ",") {
			row.push(field);
			field = "";
			i++;
		} else if (ch === "\r") {
			i++;
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
		} else {
			field += ch;
			i++;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

// Escapes a field for CSV export (downloadListCsv/downloadWantlistCsv,
// view.ts): doubles internal quotes (RFC 4180, symmetric with parseCsv above)
// AND protects against CSV formula injection (CWE-1236) — a field whose FIRST
// character is =, +, -, @, tab or CR is interpreted as a formula by
// Excel/LibreOffice/Google Sheets on opening, not as text. Most of the
// columns exported here come from Scryfall (never a risk), but "Custom
// Price"/"Grading Label" are freely typed text — an apostrophe prefix (the
// standard OWASP/GitHub convention for this problem) neutralizes the formula
// while staying invisible when displayed in a spreadsheet.
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;
export function toCsvField(value: string): string {
	const escaped = value.replace(/"/g, '""');
	const defanged = CSV_FORMULA_TRIGGER.test(escaped) ? `'${escaped}` : escaped;
	return `"${defanged}"`;
}

// Fetches up-to-date data (image, price) for a batch of Scryfall identifiers
// in a minimum number of requests, via the /cards/collection endpoint (75 max
// per call).
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function fetchScryfallCollection(
	ids: string[],
	onProgress?: (msg: string) => void,
	// Called after EACH batch of 75 with only the cards of that batch — added
	// for MTGCollectionPlugin.bulkFetchLegalities (see that file), whose
	// reported bug ("legality only shows once the whole fetch is done") came
	// exactly from here: without this callback, a caller that derives one
	// Promise per id from the single Promise returned by this function sees
	// ALL its ids resolved only at the very last batch, even those whose data
	// arrived in the first — on a collection of ~10k cards (134 batches,
	// ~120ms pause between each), that can mean several tens of seconds of
	// waiting for nothing. Optional and with no effect on the other existing
	// callers (refreshAllPrices, getCardLegalities…), which don't pass it.
	onChunkResolved?: (chunkResults: Map<string, ScryfallCard>) => void
): Promise<Map<string, ScryfallCard>> {
	const map = new Map<string, ScryfallCard>();
	const chunks = chunk(ids, 75);
	for (let i = 0; i < chunks.length; i++) {
		onProgress?.(`Fetching card data… batch ${i + 1}/${chunks.length}`);
		const res = await requestScryfall({
			url: "https://api.scryfall.com/cards/collection",
			method: "POST",
			headers: { ...SCRYFALL_HEADERS, "Content-Type": "application/json" },
			body: JSON.stringify({
				identifiers: chunks[i].map((id) => ({ id })),
			}),
			throw: false,
		});
		const chunkMap = new Map<string, ScryfallCard>();
		if (res.status === 200) {
			const data = res.json as { data: ScryfallCard[] };
			data.data.forEach((c) => {
				map.set(c.id, c);
				chunkMap.set(c.id, c);
			});
		}
		onChunkResolved?.(chunkMap);
		// Small pause between batches: good practice requested by Scryfall
		// (50-100ms minimum between requests), with no noticeable effect since all
		// of this runs in the background.
		if (i < chunks.length - 1) await sleep(120);
	}
	return map;
}
