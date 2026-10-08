import { App, Modal, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import {
	ScryfallCard,
	ScryfallError,
	searchScryfall,
	fetchLatestPaperPrintings,
	applySvgColor,
	getRarityColor,
} from "../api/scryfall";
import {
	AddCardOptions,
	AddCardsModalOptions,
	setupResultsCarousel,
	renderScryfallResultTile,
	renderResultSkeletons,
	animateResultTilesOut,
	applyResultTileStaggerEntrance,
} from "./shared-search-ui";
import { getFinishLabel } from "../core/card-model";
import { createFlagImg } from "../ui/option-icons";
import {
	isNegatedToken,
	stripNegation,
	isExactToken,
	stripExact,
	SEARCH_SET_CODE_RE,
	SEARCH_COLLECTOR_NUM_RE,
	recognizeKeywordToken,
	SUGGESTABLE_KEYWORDS,
	SEARCH_EXCLUDED_CATEGORIES,
	CATEGORY_LABELS,
	buildScryfallQueryFromChips,
	extractExactLookupHints,
	hasUnclosedQuote,
	stripQuotesFromCommittedToken,
	describeSearchFilters,
} from "../core/card-search";
import { ListGroup, WantlistGroup } from "../core/price";
import type { SavedSearchFilter, DeckCard } from "../core/data-model";
import { getDeckCardCategory } from "../core/data-model";
import type { CollectionCard, WantlistCard } from "../core/card-model";
import { AddCardSearchSyntaxModal } from "./search-syntax-modals";
import { NewListModal, NewWantlistModal } from "./new-entity-modals";
import { ChangePrintingModal } from "./change-printing-modal";
import { CopyCardModal } from "./copy-card-modal";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import { renderLoadingDots } from "../ui/card-detail-fx";
import { setupChipRowScroll } from "../ui/chip-row-scroll";
import { holdAtOffset, releaseOffset } from "../ui/flip";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  Suggested filters (below the search bar)                                  */
/* -------------------------------------------------------------------------- */

// A click directly applies the filter/sort, without having to type it by hand
// — "chip" adds (or removes, on re-click) a token in the existing chip bar
// (same engine as manual entry, see card-search.ts); "sort" toggles
// Scryfall's sort order itself (see sortOverride further down), since a chip
// token cannot express an ORDER of results, only a filter constraint.
type SuggestedFilter =
	| { kind: "chip"; label: string; token: string }
	| { kind: "sort"; label: string; order: string; dir: "asc" | "desc" };

// Fixed for now — planned (not done yet, explicitly requested as "in a
// second phase") for a list of custom filters saved by the user to be added
// to this one later, without revisiting the display/click mechanism itself
// (renderSuggestedFilters further down makes no assumption about where the
// list comes from).
const DEFAULT_SUGGESTED_FILTERS: SuggestedFilter[] = [
	{ kind: "chip", label: "Lands", token: "land" },
	{ kind: "sort", label: "Price up", order: "usd", dir: "asc" },
	{ kind: "sort", label: "Price down", order: "usd", dir: "desc" },
];

/* -------------------------------------------------------------------------- */
/*  "Add all" — seuils (voir performAddAll/runAddAll plus bas)                */
/* -------------------------------------------------------------------------- */

// Above this total, AddAllConfirmModal displays a warning paragraph in
// addition to the usual simple confirmation (real waiting time, Obsidian
// possibly appearing frozen during the operation) — explicitly requested
// rather than an identical confirmation whatever the batch size.
const ADD_ALL_WARNING_THRESHOLD = 500;
// Above this total added in one go, a history tile PER CARD
// (renderHistoryTile — a new DOM node + a FLIP resynchronization of the
// neighboring tiles for every card) would freeze the UI on a batch of
// several hundred/thousand cards — explicitly requested. Above it, a single
// aggregated summary tile replaces individual tracking (see
// addAllBatch/renderAddAllBatchTile): undoing/re-enabling the whole batch
// remains a pure data operation (one onUndoAdd/onAdd call per card, no DOM
// work), not at all the same cost scale.
const HISTORY_AGGREGATE_THRESHOLD = 50;
// Hard cap: above it, "Add all" refuses rather than attempt the operation.
// addCardToCollection/undoAddToCollection (plugin.ts) find their row
// through a .find()/.filter() that scans the WHOLE collection for every
// card added/undone — O(N) per card, so O(N²) over the whole batch, and
// none of it is split into asynchronous tasks (a single synchronous loop
// per fetched page). Without a cap, adding the entire Magic catalog
// (~96,000 printings, "unique=prints") to a real collection of a few
// thousand cards would mean several BILLION .find() comparisons — on the
// order of a minute (or more) in one go, JavaScript being single-threaded:
// Obsidian would stay entirely frozen (no frame, no click possible) the
// whole time, not merely "slow". 5000 remains a comfortably manageable
// batch (a few seconds at most, even on a large existing collection) while
// covering any realistic search filter — a user who literally wants the
// ENTIRE catalog must narrow their search (a set/color/rarity filter, etc.)
// rather than be able to freeze Obsidian in one click.
const ADD_ALL_HARD_CAP = 5000;

/* -------------------------------------------------------------------------- */
/*  Panneau "Add history" (voir onUndoAdd, shared-search-ui.ts)               */
/* -------------------------------------------------------------------------- */

// A batch of additions sharing the same options (finish/language/condition)
// — a HistoryEntry (see below) can in theory carry several contributions if
// the same printing was added to the same destination with DIFFERENT
// options, but computeAddOptions always returns the same constant value
// since the removal of every Finish/Language/Condition selector in this
// modal — a 2nd distinct group therefore no longer has a realistic path to
// occur today. `count` is the number of times onAdd was actually called with
// THESE precise options, never a signed delta (a disabled entry no longer
// has "negative" contributions, it starts again from zero at the next
// addition — see recordHistoryAdd).
interface HistoryContribution {
	options: AddCardOptions;
	count: number;
}

interface HistoryEntry {
	card: ScryfallCard;
	listId: string;
	destinationName: string;
	contributions: HistoryContribution[];
	enabled: boolean;
	// Built by renderHistoryTile, absent before its very first call for this
	// entry — recordHistoryAdd uses it precisely as a signal ("no tile yet" ->
	// build, otherwise -> update).
	tileEl?: HTMLElement;
	quantityEl?: HTMLElement;
	toggleBtn?: HTMLInputElement;
	// Line 2 (icon + set/number + destination) — kept so it can be rebuilt in
	// place after a successful printing change/move (see
	// openChangePrintingForEntry/openMoveCardForEntry), without having to find
	// tile.querySelector each time.
	line2El?: HTMLElement;
	// true once this card has been moved OUTSIDE the scope that
	// this.sourceKind (fixed for the whole lifetime of the modal) represents —
	// to a deck, or to the OTHER side of Collection/Wantlist (reported bug:
	// moving a card to a deck/a wantlist from "All Cards" silently broke the 2
	// links afterwards, exactly like the bug already fixed for a move that
	// STAYED within the same scope — see
	// openMoveCardForEntry/locateMovedCardAnywhere). Neither
	// ChangePrintingModal nor CopyCardModal can operate correctly on this row
	// from THIS modal any more once this case is reached (this.sourceKind
	// cannot follow the change per entry) — the 2 links then become
	// permanently non-interactive for this tile, same treatment as the Deck
	// flow, which never had these links at all.
	linksDisabled?: boolean;
	// Where the card actually landed once linksDisabled became true — drives
	// the non-clickable context badge ("In Collection"/"In Decks"/"In
	// Wantlists", see buildHistoryTileTrailing) that then replaces the trash
	// can. undefined as long as linksDisabled is false.
	frozenKind?: "collection" | "wantlist" | "deck";
	// Element currently displayed after the 2nd separator — either the trash
	// can or the context badge — kept so it can be replaced in place
	// (buildHistoryTileTrailing) instead of rebuilding the whole tile when
	// linksDisabled changes.
	trailingEl?: HTMLElement;
	// Resynchronizes the original carousel tile after a toggle — see
	// recordHistoryAdd/toggleHistoryEntry/deleteHistoryEntry. Absent as long
	// as no addition has succeeded yet for this entry (should not happen in
	// practice: a HistoryEntry only exists after a successful addition), or if
	// the original carousel tile has since been destroyed without a new
	// addition having replaced it (different search) — in both cases, the
	// absence is a silent no-op.
	syncCallback?: (row: { id: string; count: number } | undefined) => void;
}

function addOptionsEqual(a: AddCardOptions, b: AddCardOptions): boolean {
	return a.finish === b.finish && a.language === b.language && a.condition === b.condition;
}

function historyEntryTotalCount(entry: HistoryEntry): number {
	return entry.contributions.reduce((sum, c) => sum + c.count, 0);
}

export class AddCardsModal extends Modal {
	plugin: MTGCollectionPlugin;
	private resultsEl!: HTMLElement;
	private debounceTimer: number | null = null;
	private onAddCard: AddCardsModalOptions["onAdd"];
	private onChangeQuantity?: AddCardsModalOptions["onChangeQuantity"];
	private onOpenDetail?: AddCardsModalOptions["onOpenDetail"];
	private onUndoAdd?: AddCardsModalOptions["onUndoAdd"];
	private destinationName?: string;
	// See sourceKind, shared-search-ui.ts — only drives the 2 links "Change
	// printing"/"Move card" of the "Add history" panel (renderHistoryTile).
	private sourceKind?: AddCardsModalOptions["sourceKind"];
	// "Add history" panel (2nd column of bottomSection, see onOpen) —
	// historyListEl/historyEmptyEl are only built if onUndoAdd is supplied
	// (see their own construction, onOpen); historyEntries is a Map even
	// without the panel, never read/written in that case (this.onUndoAdd
	// guards all entry points). Key = historyKey(scryfallId, listId) — see
	// that method for the reasoning.
	private historyListEl!: HTMLElement;
	private historyEmptyEl!: HTMLElement;
	private historyEntries: Map<string, HistoryEntry> = new Map();
	// "Add history" drawer — hideable/showable, explicitly requested ("like a
	// drawer"). historyPanelEl carries the is-collapsed class toggled by
	// toggleHistoryDrawer, which drives everything else in pure CSS
	// (width/visible content — see styles.css). historyCollapsed lives on the
	// instance (not persisted) — always starts CLOSED (initial value `true`,
	// explicitly requested) on each new opening of the modal; the matching
	// is-collapsed class is set directly when the panel is built (onOpen), not
	// through toggleHistoryDrawer (which only runs on a click).
	private historyPanelEl?: HTMLElement;
	private historyCollapsed = true;
	private titleText: string;
	private listGallery?: AddCardsModalOptions["listGallery"];
	private chipTokens: string[] = [];
	private chipDraft = "";
	private chipSuggestionHighlightIndex = -1;
	private chipBarContainerEl!: HTMLElement;
	// One add function per card currently displayed in the carousel, exposed
	// by renderAddControl — lets "Add all" replay exactly the same code path
	// as each tile's individual "Add" button (same options, same conversion
	// into a stepper once added), rather than a second adding mechanism to
	// maintain in parallel. Reset every time resultsEl is emptied (new search)
	// — see resetResultControls.
	private currentResultControls: { card: ScryfallCard; addOne: (listId?: string, silent?: boolean) => void }[] = [];
	private addAllBtn!: HTMLButtonElement;
	// Scryfall pagination (see ScryfallPagedResult, scryfall.ts) — a single
	// Scryfall page caps at 175 results; beyond that, a "Load more" button at
	// the end of the track loads the rest. An explicit click rather than an
	// auto-triggered infinite scroll: one more network fetch stays deliberate,
	// consistent with the caution already established in this file around the
	// volume of Scryfall requests (see "Real rate-limit incident" in
	// CLAUDE.md). currentPage/hasMorePages/totalCardsFound are all reset by
	// resetResults() (new search); loadMoreQuery captures the parameters of
	// THE search for which hasMorePages became true (null = default search,
	// fetchLatestPaperPrintings) so that "Load more" reloads exactly the right
	// search.
	private currentPage = 1;
	private hasMorePages = false;
	private loadingMorePage = false;
	private totalCardsFound = 0;
	private loadMoreEl: HTMLElement | null = null;
	private loadMoreQuery: { setCode: string; collectorNumber: string; chipQuery: string } | null = null;
	// Incremented on every resetResults() (new search) — see runAddAll: an
	// auto-paginated "Add all" (hasMorePages) runs over several network round
	// trips, during which the user remains free to launch ANOTHER search
	// (currentPage/hasMorePages/totalCardsFound/loadMoreQuery would then be
	// reset under its feet). runAddAll captures this counter at start and
	// re-checks it after each fetched page — a mismatch means a more recent
	// search has taken over, in which case the loop stops cleanly without ever
	// touching these shared fields again (already reset for the new search).
	private addAllGeneration = 0;
	// non-null ONLY during an "Add all" whose total exceeds
	// HISTORY_AGGREGATE_THRESHOLD — recordHistoryAdd accumulates each addition
	// there instead of building/updating an individual history tile (see its
	// own comment). Only one active batch at a time.
	private addAllBatch: { card: ScryfallCard; options: AddCardOptions; listId: string }[] | null = null;
	// Disables the "Add all" button while a batch is in progress (mostly
	// useful for the auto-paginated variant, which can take several seconds) —
	// avoids a second click that would launch a 2nd batch in parallel with the
	// first.
	private addAllInProgress = false;
	// null = default sort (by release date, or by set if a "set:" filter is
	// active — see searchScryfall). Set by a click on a "sort" suggestion (see
	// DEFAULT_SUGGESTED_FILTERS/renderSuggestedFilters), clicking the same one
	// again resets it to null (toggle, not just "apply").
	private sortOverride: { order: string; dir: "asc" | "desc" } | null = null;
	private suggestedFiltersEl!: HTMLElement;
	// Inline "Save filter" prompt (name + Save/Cancel) — built once, hidden by
	// default (is-visible toggles the display), rather than a new Modal for a
	// simple name entry. Unlike the "Add all" confirmation (see
	// AddAllConfirmModal further down in this file, a real separate window
	// explicitly requested), this confirmation stays inline: a simple name
	// field was never concerned by that request.
	private saveFilterPromptEl!: HTMLElement;
	private saveFilterInputEl!: HTMLInputElement;
	// Square icon-only button, to the right of the chip bar itself (not in
	// suggestedFiltersEl) — rebuilt on every renderSearchChipBar (chip
	// added/removed…), but its enabled/disabled state must ALSO follow
	// chipDraft (the keyword being typed, not yet validated into a chip —
	// explicitly requested: enabled "from the first keyword"), which changes
	// on every keystroke WITHOUT rebuilding the whole bar (focus loss
	// otherwise, see the "input" handler further down) — hence
	// updateSaveFilterButtonState, called separately in both cases.
	private saveFilterBtn!: HTMLButtonElement;
	private resultsCountEl!: HTMLElement;
	// "Search oracle" block (renamed from "Filter oracle") — fixed title + an
	// English sentence describing the current chip bar (see
	// describeSearchFilters, card-search.ts, and updateFilterDescription).
	// filterDescriptionEl is the whole block (is-visible toggles its display);
	// filterDescriptionTextEl is just the sentence itself, the only part
	// rewritten on each updateFilterDescription call — the "Search oracle"
	// title is built once and never needs to be touched again.
	private filterDescriptionEl!: HTMLElement;
	private filterDescriptionTextEl!: HTMLElement;

	constructor(app: App, plugin: MTGCollectionPlugin, options: AddCardsModalOptions) {
		super(app);
		this.plugin = plugin;
		this.onAddCard = options.onAdd;
		this.onChangeQuantity = options.onChangeQuantity;
		this.onOpenDetail = options.onOpenDetail;
		this.onUndoAdd = options.onUndoAdd;
		this.destinationName = options.destinationName;
		this.sourceKind = options.sourceKind;
		this.titleText = options.titleText ?? "Search Magic: The Gathering cards";
		this.listGallery = options.listGallery;
	}

	// Autocompletion of the Set field: filters the complete list of sets by
	// name as you type, shows each one's official symbol. The actual code
	// (used for the query) is only filled in when a suggestion is clicked;
	// otherwise, the typed text is used as is as a fallback (for those who
	// still prefer typing a code directly).
	// Chip bar reusing the same system as the collection filter (color,
	// rarity, type, ability, cmc/price, foil, language…), translated to the
	// Scryfall query syntax — see buildScryfallQueryFromChips.
	private renderSearchChipBar() {
		const container = this.chipBarContainerEl;
		container.empty();
		const wrap = container.createDiv({ cls: "mtg-filter-chip-row" });
		const inner = wrap.createDiv({ cls: "mtg-filter-chip-row-inner" });

		this.chipTokens.forEach((token, index) => {
			const isNegated = isNegatedToken(token);
			const isExact = isExactToken(token);
			const baseToken = isNegated ? stripNegation(token) : isExact ? stripExact(token) : token;

			const chip = inner.createDiv({ cls: "mtg-filter-chip" });
			if (isNegated) chip.addClass("mtg-filter-chip-negated");
			if (isExact) chip.addClass("mtg-filter-chip-exact");

			const toggleNegateBtn = chip.createSpan({ cls: "mtg-filter-chip-negate-btn" });
			setIcon(toggleNegateBtn, "ban");
			toggleNegateBtn.setAttribute(
				"title",
				isNegated ? "Currently excluding — click to include instead" : "Click to exclude instead"
			);
			toggleNegateBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.chipTokens[index] = isNegated ? baseToken : `-${baseToken}`;
				this.renderSearchChipBar();
				this.triggerSearch();
			});

			// Same "exact color identity" toggle as renderChipFilter (view.ts) — see
			// its comment for the full reasoning.
			const recognizedForExact = recognizeKeywordToken(baseToken);
			if (recognizedForExact?.kind === "color") {
				const toggleExactBtn = chip.createSpan({ cls: "mtg-filter-chip-exact-btn" });
				setIcon(toggleExactBtn, "equal");
				toggleExactBtn.setAttribute(
					"title",
					isExact
						? "Currently matching only this color — click to match any card containing it"
						: "Click to match only cards that are exactly this color"
				);
				toggleExactBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.chipTokens[index] = isExact ? baseToken : `=${baseToken}`;
					this.renderSearchChipBar();
					this.triggerSearch();
				});
			}

			if (SEARCH_SET_CODE_RE.test(baseToken)) {
				chip.addClass("mtg-filter-chip-recognized");
				const code = baseToken.slice(4);
				const cached = this.plugin.getCachedSetSummary(code);
				const iconEl = chip.createSpan({ cls: "mtg-filter-chip-icon" });
				void this.plugin.getSetIconSvg(code).then((svg) => {
					if (!svg) return;
					setSvgMarkup(iconEl, svg);
					applySvgColor(iconEl, "#ffffff");
				});
				chip.createSpan({ text: cached?.name ?? code.toUpperCase() });
			} else if (SEARCH_COLLECTOR_NUM_RE.test(baseToken)) {
				chip.addClass("mtg-filter-chip-recognized");
				chip.createSpan({ text: `# ${baseToken.slice(1)}` });
			} else {
				const recognized = recognizeKeywordToken(baseToken);
				if (recognized?.kind === "color") {
					chip.addClass("mtg-filter-chip-recognized");
					const iconEl = chip.createSpan({ cls: "mtg-filter-chip-icon" });
					void this.plugin.getManaSymbolSvg(recognized.letter).then((svg) => {
						if (!svg) {
							iconEl.setText(baseToken);
							return;
						}
						setSvgMarkup(iconEl, svg);
						const svgEl = iconEl.querySelector("svg");
						if (svgEl) {
							svgEl.setAttribute("width", "16");
							svgEl.setAttribute("height", "16");
						}
					});
				} else if (recognized?.kind === "language") {
					chip.addClass("mtg-filter-chip-recognized");
					// recognized.flag is always a real country code here: "None" is no longer
					// an entry of LANGUAGES (see types.ts).
					createFlagImg(chip, recognized.flag, "mtg-flag-img mtg-flag-img-inline");
					chip.createSpan({ text: recognized.label });
				} else if (recognized && "label" in recognized) {
					chip.addClass("mtg-filter-chip-recognized");
					chip.createSpan({ text: recognized.label });
				} else {
					chip.createSpan({ text: baseToken });
				}
			}

			const removeBtn = chip.createSpan({ cls: "mtg-filter-chip-remove" });
			setIcon(removeBtn, "x");
			removeBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.chipTokens.splice(index, 1);
				this.renderSearchChipBar();
				this.triggerSearch();
			});
		});

		const input = inner.createEl("input", {
			cls: "mtg-filter-chip-input",
			attr: {
				placeholder:
					this.chipTokens.length === 0 ? "e.g. Ledger Shredder, blue, rare, cmc>3…" : "",
			},
		});
		input.value = this.chipDraft;

		const commitToken = (value: string) => {
			this.chipTokens.push(stripQuotesFromCommittedToken(value));
			this.chipDraft = "";
			this.renderSearchChipBar();
			this.triggerSearch();
		};

		input.addEventListener("keydown", (evt) => {
			const dropdown = this.chipBarContainerEl.querySelector(".mtg-filter-suggestions");
			const items = dropdown
				? Array.from(dropdown.querySelectorAll(".mtg-filter-suggestion-item"))
				: [];

			if (items.length > 0 && (evt.key === "ArrowDown" || evt.key === "ArrowUp" || evt.key === "Tab")) {
				evt.preventDefault();
				const dir = evt.key === "ArrowUp" || (evt.key === "Tab" && evt.shiftKey) ? -1 : 1;
				this.chipSuggestionHighlightIndex =
					(this.chipSuggestionHighlightIndex + dir + items.length) % items.length;
				items.forEach((el, i) =>
					el.toggleClass("is-keyboard-highlighted", i === this.chipSuggestionHighlightIndex)
				);
				return;
			}

			// Space = validates the suggestion currently highlighted via the keyboard
			// (↑/↓ arrows), like Enter — explicitly requested. Distinct from the Enter
			// branch just below: fires ONLY if there is really an active highlight
			// (chipSuggestionHighlightIndex ≥ 0), not as soon as the list is open —
			// without prior keyboard navigation, a space stays an ordinary space
			// (validates the word being typed as is, see the "input" handler further
			// down), exactly the expected behavior when one hasn't browsed the
			// suggestions.
			if (
				evt.key === " " &&
				items.length > 0 &&
				this.chipSuggestionHighlightIndex >= 0 &&
				this.chipSuggestionHighlightIndex < items.length
			) {
				evt.preventDefault();
				const chosenValue = items[this.chipSuggestionHighlightIndex].getAttribute("data-token-value");
				if (chosenValue) {
					commitToken(chosenValue);
					return;
				}
			}

			if (evt.key === "Backspace" && input.value === "" && this.chipTokens.length > 0) {
				evt.preventDefault();
				this.chipTokens.pop();
				this.renderSearchChipBar();
				this.triggerSearch();
				return;
			}
			if (evt.key === "Enter" && input.value.trim()) {
				evt.preventDefault();
				if (items.length > 0) {
					const chosenIndex =
						this.chipSuggestionHighlightIndex >= 0 &&
						this.chipSuggestionHighlightIndex < items.length
							? this.chipSuggestionHighlightIndex
							: 0;
					const chosenValue = items[chosenIndex].getAttribute("data-token-value");
					if (chosenValue) {
						commitToken(chosenValue);
						return;
					}
				}
				commitToken(input.value.trim());
			}
		});

		input.addEventListener("input", () => {
			const val = input.value;
			// !hasUnclosedQuote: see the same guard in renderChipFilter (view.ts) — a
			// quoted phrase still open (e.g. after "oracle:") must not be cut at the
			// first space.
			if (val.endsWith(" ") && !hasUnclosedQuote(val)) {
				const token = val.trim();
				this.chipDraft = "";
				if (token) {
					commitToken(token);
					return;
				}
			}
			this.chipDraft = val;
			// No triggerSearch() here — explicitly requested: the proposed cards must
			// not move as long as the keyword being typed isn't "validated"
			// (space/Enter, or a clicked suggestion — see commitToken, which calls
			// triggerSearch() itself). Before this change, buildScryfallQueryFromChips
			// already included the raw chipDraft in the search IN PROGRESS, so every
			// keystroke relaunched a Scryfall search with a still-partial keyword
			// ("r", "re", "red"…) — reported as a disturbing back-and-forth of the
			// carousel. The completion suggestion (renderChipSuggestions, just below)
			// stays instant on every keystroke: it's a local computation
			// (SUGGESTABLE_KEYWORDS/sets already cached), not a network round trip, so
			// nothing to gain by delaying it too.
			void this.renderChipSuggestions(commitToken);
			// No renderSearchChipBar() here (focus loss, see above) — just the
			// enabled/disabled state of the "Save filter" button, so that it becomes
			// clickable from the first typed keyword, not only once a chip has been
			// validated.
			this.updateSaveFilterButtonState();
			// Unlike triggerSearch() (results), the English description follows the
			// keyword being typed LIVE — a simple text change, no network
			// search/visual jump to avoid, so nothing to gain by delaying it until
			// validation.
			this.updateFilterDescription();
		});

		if (this.chipTokens.length > 0 || this.chipDraft.length > 0) {
			const clearBtn = inner.createDiv({ cls: "mtg-filter-clear-btn" });
			setIcon(clearBtn, "x-circle");
			clearBtn.setAttribute("title", "Clear filter");
			clearBtn.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				this.chipTokens = [];
				this.chipDraft = "";
				this.renderSearchChipBar();
				this.triggerSearch();
			});
		}

		const syntaxBtn = wrap.createDiv({ cls: "mtg-filter-syntax-btn" });
		setIcon(syntaxBtn, "help-circle");
		syntaxBtn.setAttribute("title", "Search syntax");
		syntaxBtn.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			new AddCardSearchSyntaxModal(this.app).open();
		});

		// Square icon-only button, to the right of the bar — explicitly requested
		// in place of the old "Save filter" pill under the bar. mousedown +
		// preventDefault (not a bare "click"): same reason as syntaxBtn/clearBtn
		// just above, avoids stealing the <input>'s focus at the moment of the
		// click.
		this.saveFilterBtn = wrap.createEl("button", { cls: "mtg-search-save-filter-square-btn" });
		setIcon(this.saveFilterBtn, "bookmark-plus");
		this.saveFilterBtn.setAttribute("title", "Save current filter");
		this.saveFilterBtn.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.showSaveFilterPrompt();
		});
		this.updateSaveFilterButtonState();
		this.updateFilterDescription();

		input.focus();
		input.setSelectionRange(this.chipDraft.length, this.chipDraft.length);
		setupChipRowScroll(inner);
		void this.renderChipSuggestions(commitToken);
	}

	private async renderChipSuggestions(commitToken: (value: string) => void) {
		this.chipBarContainerEl.querySelector(".mtg-filter-suggestions")?.remove();
		this.chipSuggestionHighlightIndex = -1;
		const q = this.chipDraft.trim().toLowerCase();
		if (!q) return;

		const allStaticMatches = SUGGESTABLE_KEYWORDS.filter(
			(k) =>
				!SEARCH_EXCLUDED_CATEGORIES.includes(k.category) &&
				!this.chipTokens.includes(k.value) &&
				k.matchTexts.some((m) => m.startsWith(q))
		);
		// Same fix as MTGCollectionView.getKeywordSuggestions (view.ts): "legal:"
		// alone matches the 10 curated formats at the head of
		// LEGALITY_SEARCH_FORMATS (card-search.ts) all at once — a cap of 5 would
		// have cut off "Legal: Commander" (6th of that list), reported bug.
		// "legal:" is a prefix that no other category can match (see
		// categorizeToken), so spotting "all matches are of category legality"
		// identifies this case unambiguously. Same for "border:" alone (9 entries,
		// see BORDER_SEARCH_OPTIONS).
		const staticCap =
			allStaticMatches.length > 0 &&
			(allStaticMatches.every((k) => k.category === "legality") ||
				allStaticMatches.every((k) => k.category === "border"))
				? 10
				: 5;
		const staticMatches = allStaticMatches.slice(0, staticCap);

		const allSets = await this.plugin.getAllScryfallSets();
		// Anti-race safeguard: if the user kept typing while the list of sets was
		// loading, this render is stale.
		if (this.chipDraft.trim().toLowerCase() !== q) return;

		// Derived sets (promos, tokens, art series, minigames) often share the
		// same base name as the main set — reported bug: searching "Battle for
		// Zendikar" (or just "Zendikar") did not suggest the set itself. Confirmed
		// with real Scryfall data: of the 17 non-digital sets containing
		// "zendikar", "Battle for Zendikar" (set_type "expansion") comes in
		// position 12 in the API's natural order (decreasing release date) — well
		// after the promo/token/minigame variants of the most recent "Zendikar
		// Rising" — so never in the first 3 results. Sorting to bring the "main"
		// sets ahead of their derived variants (stable sort — ES2019+ guarantees
		// Array.prototype.sort is stable — so the original release-date order is
		// preserved within each group) solves this without depending solely on a
		// higher cap.
		const AUXILIARY_SET_TYPES = new Set(["promo", "token", "memorabilia", "minigame"]);
		const setMatches = allSets
			.filter(
				(s) => s.name.toLowerCase().includes(q) && !this.chipTokens.includes(`set:${s.code}`)
			)
			.sort((a, b) => Number(AUXILIARY_SET_TYPES.has(a.set_type)) - Number(AUXILIARY_SET_TYPES.has(b.set_type)))
			.slice(0, 6);

		if (staticMatches.length === 0 && setMatches.length === 0) return;

		const dropdown = this.chipBarContainerEl.createDiv({ cls: "mtg-filter-suggestions" });
		const highlightOnHover = (item: HTMLElement) => {
			item.addEventListener("mouseenter", () => {
				const items = Array.from(dropdown.querySelectorAll(".mtg-filter-suggestion-item"));
				this.chipSuggestionHighlightIndex = items.indexOf(item);
				items.forEach((el) => el.removeClass("is-keyboard-highlighted"));
				item.addClass("is-keyboard-highlighted");
			});
		};

		staticMatches.forEach((s) => {
			const item = dropdown.createDiv({ cls: "mtg-filter-suggestion-item" });
			item.setAttribute("data-token-value", s.value);
			highlightOnHover(item);
			const mainArea = item.createDiv({ cls: "mtg-filter-suggestion-main" });
			if (CATEGORY_LABELS[s.category]) {
				mainArea.createSpan({
					cls: "mtg-filter-suggestion-category",
					text: CATEGORY_LABELS[s.category],
				});
			}
			if (s.flagCode) createFlagImg(mainArea, s.flagCode, "mtg-flag-img mtg-flag-img-inline");
			mainArea.createSpan({ text: s.display });
			mainArea.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				commitToken(s.value);
			});
		});

		// Sets: same "set:code" convention as the dedicated Set field, so that
		// buildScryfallQueryFromChips translates them the same way.
		setMatches.forEach((s) => {
			const item = dropdown.createDiv({ cls: "mtg-filter-suggestion-item" });
			item.setAttribute("data-token-value", `set:${s.code}`);
			highlightOnHover(item);
			const mainArea = item.createDiv({ cls: "mtg-filter-suggestion-main" });
			mainArea.createSpan({ cls: "mtg-filter-suggestion-category", text: "Set" });
			const iconEl = mainArea.createSpan({ cls: "mtg-search-set-suggestion-icon" });
			void this.plugin.getSetIconSvg(s.code).then((svg) => {
				if (!svg) return;
				setSvgMarkup(iconEl, svg);
				applySvgColor(iconEl, "#ffffff");
			});
			mainArea.createSpan({ text: s.name });
			mainArea.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				commitToken(`set:${s.code}`);
			});
		});
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-search-modal");
		this.modalEl.addClass("mtg-search-modal-wide");
		// Fixed height (not just capped): requested so that this window has the same
		// height as the card detail window — see .mtg-search-modal-fixed-height
		// (styles.css) for the reasoning and the accepted trade-off. Scoped to
		// AddCardsModal alone, not ChangePrintingModal (which shares
		// mtg-search-modal-wide for the width but not this class).
		this.modalEl.addClass("mtg-search-modal-fixed-height");

		// contentEl (mtg-search-modal) no longer has its own padding (see
		// styles.css, same technique as .mtg-card-detail-modal) — each of the two
		// direct sections below now provides its own explicitly. Necessary so that
		// mtg-search-bottom-section (further down) can reach the REAL
		// left/right/bottom edges of the window with its own darkened background —
		// reported bug: with Obsidian's native padding still active on contentEl,
		// this background stayed visibly inset from these 3 edges (only the area
		// under the carousel, where there was nothing to "reach", gave the
		// impression that it worked). mtg-search-top-section groups the title and
		// the carousel, which only needed to recover the same inset as before
		// (padding chosen by us, more reliable than an implicit and undocumented
		// native Obsidian padding that we could only try to guess in order to
		// cancel it elsewhere).
		const topSection = contentEl.createDiv({ cls: "mtg-search-top-section" });

		// titleText already existed as an option (used by all the callers in
		// view.ts, e.g. "Add cards to \"{listName}\"") but was never displayed —
		// an oversight, fixed here rather than by adding a title specific to the
		// requested "All Cards" flow alone, so that the 5 flows that build this
		// modal all benefit from it consistently.
		topSection.createEl("h2", { text: this.titleText, cls: "mtg-search-modal-title" });

		this.resultsEl = setupResultsCarousel(topSection);

		// 2-column row, each with its OWN distinct darkened background
		// (bottomMainEl/historyPanelEl further down, see styles.css — explicitly
		// requested, "the history should be in a dark block distinct from the dark
		// block of the search") — bottomSection itself therefore no longer carries
		// any padding nor background, just the row layout (flex: 1; min-height: 0
		// to absorb the remaining space at the bottom of the window, gap between
		// the 2 columns).
		const bottomSection = contentEl.createDiv({ cls: "mtg-search-bottom-section" });

		// bottomMainEl groups everything that bottomSection alone contained before
		// the addition of the "Add history" panel (results count/form/Search
		// oracle/filters), unchanged in itself — now carries its OWN
		// padding/darkened background/border-radius (see styles.css), so that its
		// background reaches edge to edge the left half of the window (same
		// principle as .mtg-card-detail-layout: inner padding, not on
		// contentEl/bottomSection themselves) while remaining visually separate
		// from the "Add history" panel to its right.
		const bottomMainEl = bottomSection.createDiv({ cls: "mtg-search-bottom-main" });

		// Number of cards found, discreet — explicitly requested. Stays displayed
		// as is while a new search is loading (see setResultsCount) rather than
		// emptying then filling again on each update — this intermediate blanking
		// was the small visual jump reported.
		this.resultsCountEl = bottomMainEl.createDiv({ cls: "mtg-search-results-count" });

		const form = bottomMainEl.createDiv({ cls: "mtg-search-form" });

		const nameField = form.createDiv({ cls: "mtg-search-field" });
		nameField.createEl("label", { text: "Search" });
		// Chips track + "Add all" side by side, UNDER the label — align-items:
		// stretch (styles.css) sets the button to the REAL height of the chip bar
		// rather than a guessed value, explicitly requested ("same height as the
		// search bar").
		const searchBarRow = nameField.createDiv({ cls: "mtg-search-bar-row" });
		this.chipBarContainerEl = searchBarRow.createDiv({ cls: "mtg-search-chip-bar-container" });
		this.renderSearchChipBar();

		// Adds all the cards currently displayed in the carousel in one go —
		// explicitly requested. Disabled as long as there is nothing to add
		// (updateAddAllButtonState), never removed: staying permanently visible
		// avoids a layout jump on each new search.
		this.addAllBtn = searchBarRow.createEl("button", {
			cls: "mtg-search-add-btn mtg-search-add-all-btn",
		});
		// "+" icon in a small circle before the text, explicitly requested — same
		// idiom as the Delete/Cancel buttons of the My Collection selection mode
		// (icon in a separate <span>, never the `text:` option of the button,
		// which would leave no room for a child next to it).
		setIcon(this.addAllBtn.createSpan({ cls: "mtg-search-add-all-icon" }), "plus");
		this.addAllBtn.createSpan({ text: "Add all" });
		this.addAllBtn.addEventListener("click", () => this.showAddAllConfirm());

		// "Save filter" prompt — name + Save/Cancel, revealed by the square "Save
		// filter" button of the chip bar (see higher up) instead of a new Modal
		// for a simple name entry, same reasoning as the "Add all" prompt further
		// down. Stays here, near the search bar (not in mtg-search-filters-panel
		// further down) — that is where the button that triggers it lives.
		this.saveFilterPromptEl = nameField.createDiv({ cls: "mtg-search-save-filter-prompt" });
		this.saveFilterInputEl = this.saveFilterPromptEl.createEl("input", {
			cls: "mtg-search-save-filter-input",
			type: "text",
			attr: { placeholder: "Filter name…" },
		});
		this.saveFilterInputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.confirmSaveFilter();
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.hideSaveFilterPrompt();
			}
		});
		const saveFilterActions = this.saveFilterPromptEl.createDiv({
			cls: "mtg-search-save-filter-actions",
		});
		const saveFilterConfirmBtn = saveFilterActions.createEl("button", {
			cls: "mtg-search-add-btn",
			text: "Save",
		});
		saveFilterConfirmBtn.addEventListener("click", () => this.confirmSaveFilter());
		const saveFilterCancelBtn = saveFilterActions.createEl("button", { text: "Cancel" });
		saveFilterCancelBtn.addEventListener("click", () => this.hideSaveFilterPrompt());

		// The Finish/Language/Condition trio of the Collection flow had already
		// been removed; the remaining Finish row, specific to the Wantlist flow,
		// was removed in turn (explicitly requested) — a card added from this
		// modal now always takes finish "regular"/language ""/condition "" by
		// default (see computeAddOptions), to be refined afterwards from the
		// card's detail panel like any other wantlist/collection card.

		// "Search oracle" block (renamed from "Filter oracle" — explicitly
		// requested; the CSS class/field names stay "filter-description", not
		// renamed for a simple change of displayed text) — fixed title + English
		// description, best-effort, of the current chip bar (see
		// describeSearchFilters, card-search.ts). Natural height (unlike
		// mtg-search-filters-panel just below); empty (whole block hidden, see
		// updateFilterDescription) when there is nothing to describe.
		this.filterDescriptionEl = bottomMainEl.createDiv({ cls: "mtg-search-filter-description" });
		this.filterDescriptionEl.createDiv({
			cls: "mtg-search-filter-description-title",
			text: "Search oracle",
		});
		this.filterDescriptionTextEl = this.filterDescriptionEl.createDiv({
			cls: "mtg-search-filter-description-text",
		});
		this.updateFilterDescription();

		// Small "Filters" title above the block (not inside it, unlike the "Search
		// oracle" title above) — explicitly requested.
		bottomMainEl.createDiv({ cls: "mtg-search-filters-title", text: "Filters" });

		// Filters block (fixed suggestions + saved filters) — last child of
		// bottomMainEl (nested flex column, see styles.css), to absorb all the
		// remaining space at the bottom of the window — explicitly requested,
		// replaces the old row at natural height under the form.
		this.suggestedFiltersEl = bottomMainEl.createDiv({ cls: "mtg-search-suggested-filters" });
		this.renderSuggestedFilters();

		// "Add history" panel — 2nd column of bottomSection, to the right of bottomMainEl —
		// explicitly requested, with a small diagram in support. Only for the flows that can really
		// undo an addition (onUndoAdd provided — Collection/Wantlist; never the Deck flow, which has
		// neither an id per card nor an equivalent changeCollectionCardCount/removeCollectionCard,
		// see the comment of historyEntries higher up): without it, this column would stay empty
		// with nothing to put in it, so not built at all rather than built-but-inert — bottomSection
		// keeps its single column from before in this case.
		if (this.onUndoAdd) {
			const historyPanelEl = bottomSection.createDiv({ cls: "mtg-search-history-panel" });
			this.historyPanelEl = historyPanelEl;
			// Closed by default — explicitly requested (this.historyCollapsed is
			// already `true` by default, see its own declaration; set here directly
			// rather than via toggleHistoryDrawer(), which only runs on a click).
			historyPanelEl.addClass("is-collapsed");

			// Clickable header (chevron + "Add history") — it is IT that
			// collapses/expands the drawer (explicitly requested, with a diagram
			// showing the chevron stuck to the title text): no separate button
			// floating over the 2 columns (a previous version had one, removed here).
			const header = historyPanelEl.createDiv({ cls: "mtg-search-history-header" });
			header.addEventListener("click", () => this.toggleHistoryDrawer());
			// chevron-right, as on the supplied diagram ("▶ Add history") — no icon
			// toggle here: the whole header disappears in the collapsed state
			// (replaced by the collapsed block below), so this chevron never needs to
			// represent the "collapsed" state itself.
			setIcon(header.createSpan({ cls: "mtg-search-history-toggle-icon" }), "chevron-right");
			header.createSpan({ cls: "mtg-search-history-title-text", text: "History" });

			// Content displayed ONLY in the collapsed state (see
			// .mtg-search-history-panel.is-collapsed, styles.css) — explicitly
			// requested: the collapsed drawer keeps its height and a minimum width
			// rather than disappearing entirely, with a pictogram in its upper part to
			// stay identifiable and clickable (same toggle as the header above),
			// followed by the text "History" displayed vertically (in capitals — see
			// text-transform on mtg-search-history-collapsed-label, styles.css — only
			// in this collapsed state, explicitly requested; the expanded header keeps
			// its normal case) — useless once expanded (the same text is already
			// legible horizontally in the header above), so this whole block
			// disappears as soon as it opens. flex: 1 in CSS (see styles.css) makes it
			// fill the whole height of the collapsed panel rather than keeping only
			// the size of its own content — explicitly requested, "when the History
			// block is closed, the whole block must be clickable to open it": this
			// same addEventListener now covers the whole visible area, not just the
			// icon+text.
			const collapsedContent = historyPanelEl.createDiv({ cls: "mtg-search-history-collapsed" });
			collapsedContent.setAttribute("title", "Show history");
			collapsedContent.addEventListener("click", () => this.toggleHistoryDrawer());
			setIcon(collapsedContent.createDiv({ cls: "mtg-search-history-collapsed-icon" }), "history");
			collapsedContent.createDiv({ cls: "mtg-search-history-collapsed-label", text: "History" });

			// No more box of its own (border/background) around the list — explicitly
			// requested, "keep only the dark block" (that of historyPanelEl itself) —
			// see styles.css.
			this.historyListEl = historyPanelEl.createDiv({ cls: "mtg-search-history-list" });
			this.historyEmptyEl = this.historyListEl.createDiv({
				cls: "mtg-search-history-empty",
				text: "Cards you add appear here.",
			});
		}

		this.updateAddAllButtonState();
		void this.loadDefaultResults();
	}

	// Empties resultsEl AND the state that depends on it (per-card "Add"
	// controls for "Add all") — the two call points of this.resultsEl.empty()
	// (loadDefaultResults, runSearch) systematically go through here rather
	// than calling a bare empty(), so as never to leave currentResultControls
	// referencing tiles that have just been destroyed (Add all would then add
	// cards that are no longer even displayed). The "Add all" confirmation
	// itself now lives in its own window (AddAllConfirmModal) — nothing to
	// hide/reset here concerning it. Also resets all the pagination state
	// (currentPage/hasMorePages/loadMoreQuery/totalCardsFound) — resultsEl has
	// just been emptied, so loadMoreEl (which potentially pointed to a child
	// of resultsEl) no longer references anything valid either.
	private resetResults() {
		this.resultsEl.empty();
		this.currentResultControls = [];
		this.updateAddAllButtonState();
		this.currentPage = 1;
		this.hasMorePages = false;
		this.loadMoreQuery = null;
		this.totalCardsFound = 0;
		this.loadMoreEl = null;
		// See addAllGeneration: signals to a possible runAddAll() still in flight
		// (auto-pagination of a previous "Add all") that a more recent search has
		// taken over currentPage/hasMorePages/etc.
		this.addAllGeneration++;
	}

	private updateAddAllButtonState() {
		this.addAllBtn.disabled = this.addAllInProgress || this.currentResultControls.length === 0;
	}

	// REAL total that "Add all" would add — beyond the page currently loaded
	// when hasMorePages is true (see totalCardsFound, the raw total_cards of
	// Scryfall for this search), not just what is already rendered in the
	// carousel. Used both for the confirmation label and for the hard cap (see
	// showAddAllConfirm).
	private addAllEffectiveTotal(): number {
		return this.hasMorePages ? this.totalCardsFound : this.currentResultControls.length;
	}

	// Separate window (see AddAllConfirmModal further down) rather than an
	// inline message under the search bar — explicitly requested. count now
	// reflects the REAL total of the search (see addAllEffectiveTotal), no
	// longer only what is already loaded in the carousel — "Add all" now
	// auto-paginates the rest itself (see runAddAll) rather than limiting
	// itself to the displayed page.
	private showAddAllConfirm() {
		if (this.addAllInProgress) return;
		const count = this.addAllEffectiveTotal();
		if (count === 0) return;
		// Hard cap — see ADD_ALL_HARD_CAP for the computation that justifies it. A
		// Notice rather than a separate modal: it is not a decision to make
		// ("Yes"/"Cancel"), just a limit that prevents the operation from
		// starting, with enough to understand why and what to do instead.
		if (count > ADD_ALL_HARD_CAP) {
			new Notice(
				`This search found ${count} cards — "Add all" is limited to ${ADD_ALL_HARD_CAP} at a time to avoid freezing Obsidian. Narrow your search (e.g. a set: or color filter) and try again.`,
				8000
			);
			return;
		}
		new AddAllConfirmModal(this.app, count, count > ADD_ALL_WARNING_THRESHOLD, () => this.performAddAll()).open();
	}

	private performAddAll() {
		if (this.addAllInProgress) return;
		// Copied rather than read through this.: purely defensive, so that this
		// precise batch stays consistent even if the user reopens a new search
		// between the moment AddAllConfirmModal opened and the one where its "Yes,
		// add all" button is actually clicked (see also addAllGeneration, which
		// protects the auto-paginated part of runAddAll against this same scenario
		// once the operation has started).
		const controls = this.currentResultControls;
		const paginating = this.hasMorePages;
		const total = paginating ? this.totalCardsFound : controls.length;
		if (total === 0) return;

		// defaultListId (Inbox): "Add all" adds directly, without opening a picker
		// — same reasoning as the individual "Add" click above, see
		// AddCardsModalOptions.listGallery.defaultListId.
		if (this.listGallery?.defaultListId) {
			void this.runAddAll(controls, paginating, this.listGallery.defaultListId);
			return;
		}

		if (this.listGallery) {
			// A single picker for the whole batch (not one per card, which would chain
			// dozens of modal windows) — the destination chosen once applies to each
			// card of the batch, including those not yet loaded (auto-paginated by
			// runAddAll).
			new SelectListModal(
				this.app,
				this.plugin,
				this.listGallery.summaries,
				`${total} card${total === 1 ? "" : "s"}`,
				this.listGallery.kind,
				(listId) => void this.runAddAll(controls, paginating, listId),
				true
			).open();
			return;
		}

		void this.runAddAll(controls, paginating, undefined);
	}

	// Core of "Add all" — first adds what is already loaded in the carousel
	// (same path as the individual "Add" click of each tile, via addOne: DOM
	// cost already paid, these tiles become steppers as usual), THEN, if
	// hasMorePages was true at the time of the click, fetches and adds the
	// rest page by page — without ever building a carousel tile for those
	// cards (a batch of several hundred/thousand off-screen results has no
	// reason to weigh down the carousel's DOM), just a direct call to
	// onAddCard per card. The pagination reuses the same mechanism as "Load
	// more" (searchScryfall/fetchLatestPaperPrintings with an increasing page)
	// — hence the same global pacing lock (requestScryfall, scryfall.ts) as
	// everything else in the plugin, no special handling needed here to stay
	// within the API's rules.
	private async runAddAll(
		controls: { card: ScryfallCard; addOne: (listId?: string, silent?: boolean) => void }[],
		paginating: boolean,
		listId: string | undefined
	) {
		this.addAllInProgress = true;
		this.addAllBtn.disabled = true;
		const generation = this.addAllGeneration;
		const options = this.computeAddOptions();
		const destinationName = this.resolveDestinationName(listId ?? "");

		// Snapshot of the search to paginate — never re-read from this. during the
		// loop below (this.loadMoreQuery could have changed in the meantime if a
		// new search starts; the generation check further down then stops before
		// using it again).
		const query = this.loadMoreQuery;

		// Beyond HISTORY_AGGREGATE_THRESHOLD, each addition (rendered or not)
		// accumulates in addAllBatch instead of building an individual history
		// tile — see recordHistoryAdd.
		const total = paginating ? this.totalCardsFound : controls.length;
		this.addAllBatch = this.onUndoAdd && total > HISTORY_AGGREGATE_THRESHOLD ? [] : null;

		controls.forEach(({ addOne }) => addOne(listId, true));

		let addedBeyondPage = 0;
		if (paginating) {
			// Same lock as "Load more" itself (loadingMorePage — see its own guard at
			// the head of loadMoreResults): blocks any manual click on the "Load more"
			// tile while this loop is already advancing on the same search, rather
			// than risking two concurrent fetches stepping on each other on
			// currentPage/hasMorePages. is-disabled (styles.css) gives visual feedback
			// of this blocking — without it, the tile would remain visually clickable
			// for a click that would no longer do anything.
			this.loadingMorePage = true;
			this.loadMoreEl?.addClass("is-disabled");
			let erroredOut = false;
			let page = this.currentPage;
			let hasMore = this.hasMorePages;
			while (hasMore) {
				page += 1;
				this.resultsCountEl.setText(
					`Adding cards… (${controls.length + addedBeyondPage} of ${this.totalCardsFound})`
				);
				let cards: ScryfallCard[];
				let totalCards: number;
				try {
					({ cards, hasMore, totalCards } = query
						? await searchScryfall(
								"",
								query.setCode,
								query.collectorNumber,
								query.chipQuery,
								this.sortOverride ?? undefined,
								page
						  )
						: await fetchLatestPaperPrintings(this.sortOverride ?? undefined, page));
				} catch {
					new Notice("Add all stopped early: failed to load more cards from Scryfall.");
					erroredOut = true;
					break;
				}
				// A new search has taken over during this network round trip (see
				// addAllGeneration) — currentPage/hasMorePages/totalCardsFound/loadMoreEl
				// already belong to THIS new search, no question of touching them anymore;
				// the cards already fetched in this iteration are nonetheless added (the
				// data operation remains valid even if its own progress display no longer
				// is), then we stop.
				const stillCurrent = this.addAllGeneration === generation;
				cards.forEach((card) => {
					const result = this.onAddCard(card, options, listId);
					if (result) this.recordHistoryAdd(card, options, result.listId, () => {});
				});
				addedBeyondPage += cards.length;
				if (!stillCurrent) {
					hasMore = false;
					break;
				}
				this.currentPage = page;
				this.hasMorePages = hasMore;
				this.totalCardsFound = totalCards;
			}
			this.loadingMorePage = false;
			if (this.addAllGeneration === generation) {
				if (erroredOut) {
					// Leaves "Load more" clickable for a new manual attempt on what remains —
					// same fallback as loadMoreResults() itself on a network failure.
					this.loadMoreEl?.removeClass("is-disabled");
					if (this.loadMoreEl) {
						this.loadMoreEl.empty();
						this.renderLoadMoreIdleContent(this.loadMoreEl);
					}
				} else {
					this.loadMoreEl?.remove();
					this.loadMoreEl = null;
				}
			}
		}

		this.addAllInProgress = false;
		if (this.addAllGeneration === generation) {
			this.updateAddAllButtonState();
			this.setResultsCount(this.currentResultControls.length, this.totalCardsFound);
		}

		if (this.addAllBatch && this.addAllBatch.length > 0) {
			this.renderAddAllBatchTile(this.addAllBatch, destinationName);
		}
		this.addAllBatch = null;

		const totalAdded = controls.length + addedBeyondPage;
		new Notice(`Added ${totalAdded} card${totalAdded === 1 ? "" : "s"}.`);
	}

	// Summary tile of an aggregated "Add all" batch (see
	// HISTORY_AGGREGATE_THRESHOLD) — same dressing as renderHistoryTile
	// (checkbox/separators/trash can, same CSS classes) to stay consistent
	// with the rest of the panel, but content and logic of its own: no single
	// card name to display, no "Change printing"/"Move card" link (the batch
	// potentially covers hundreds of different cards, no single link would
	// make sense), and a bulk undo/re-enable rather than per contribution —
	// one onUndoAdd/onAdd call per card of the batch, never DOM work per card,
	// so a batch of several thousand cards stays fast to undo.
	private renderAddAllBatchTile(
		batch: { card: ScryfallCard; options: AddCardOptions; listId: string }[],
		destinationName: string
	) {
		if (!this.onUndoAdd) return;
		this.historyEmptyEl?.toggleClass("is-hidden", true);

		let tile!: HTMLElement;
		this.flipHistoryListChange(() => {
			tile = this.historyListEl.createDiv({ cls: "mtg-search-history-tile" });
			this.historyListEl.prepend(tile);
			tile.addClass("mtg-search-history-tile-enter");
		});
		// Same double rAF technique as renderHistoryTile — see its own comment for
		// the full reasoning.
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => tile.addClass("mtg-search-history-tile-visible"));
		});

		let enabled = true;

		const toggleBtn = tile.createEl("input", { cls: "mtg-search-history-toggle-checkbox" });
		toggleBtn.type = "checkbox";
		toggleBtn.checked = true;
		toggleBtn.setAttribute("title", "Disable (undo this whole batch)");

		tile.createDiv({ cls: "mtg-search-history-divider" });

		const info = tile.createDiv({ cls: "mtg-search-history-info" });
		const line1 = info.createDiv({ cls: "mtg-search-history-line1" });
		line1.createSpan({ cls: "mtg-search-history-name", text: "Add all" });
		line1.createSpan({ cls: "mtg-search-history-qty", text: `×${batch.length}` });
		const line2 = info.createDiv({ cls: "mtg-search-history-line2" });
		// Reuses the destination class (flex:1 + ellipsis) rather than a new CSS
		// rule — this line has only a single text segment, potentially long
		// (destination name included), exactly what this class already handles.
		line2.createSpan({
			cls: "mtg-search-history-destination-link",
			text: `${batch.length} distinct card${batch.length === 1 ? "" : "s"} → ${destinationName}`,
		});

		tile.createDiv({ cls: "mtg-search-history-divider" });

		const deleteBtn = tile.createDiv({ cls: "mtg-search-history-delete-btn" });
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttribute("title", "Remove from history");

		const setEnabled = (value: boolean) => {
			if (value === enabled) return;
			if (!value) {
				batch.forEach(({ card, options, listId }) => this.onUndoAdd!(card, options, listId, 1));
			} else {
				batch.forEach(({ card, options, listId }) => this.onAddCard(card, options, listId));
			}
			enabled = value;
			tile.toggleClass("is-disabled", !enabled);
			toggleBtn.checked = enabled;
			toggleBtn.setAttribute(
				"title",
				enabled ? "Disable (undo this whole batch)" : "Re-enable (redo this whole batch)"
			);
		};

		toggleBtn.addEventListener("change", () => setEnabled(toggleBtn.checked));
		deleteBtn.addEventListener("click", () => {
			setEnabled(false);
			tile.remove();
			// This tile is never tracked in historyEntries (see higher up) —
			// deleteHistoryEntry therefore cannot see it to decide whether to display
			// historyEmptyEl again; re-checks the DOM of the panel directly rather
			// than duplicating a second counter.
			if (!this.historyListEl.querySelector(".mtg-search-history-tile")) {
				this.historyEmptyEl?.toggleClass("is-hidden", false);
			}
		});
	}

	// Rebuilt (not just hidden/shown) on each click, so that is-active
	// reflects the real state (chip added/removed, sort applied/canceled) —
	// same reasoning as renderSearchChipBar, called for the same reason right
	// after a mutation of chipTokens.
	private renderSuggestedFilters() {
		const container = this.suggestedFiltersEl;
		container.empty();
		DEFAULT_SUGGESTED_FILTERS.forEach((filter) => {
			const isActive =
				filter.kind === "chip"
					? this.chipTokens.includes(filter.token)
					: this.sortOverride?.order === filter.order && this.sortOverride?.dir === filter.dir;
			const btn = container.createEl("button", {
				cls: "mtg-search-suggested-filter-btn",
				text: filter.label,
			});
			btn.toggleClass("is-active", isActive);
			btn.addEventListener("click", () => {
				if (filter.kind === "chip") {
					// Toggle: a second click removes the chip rather than adding a second
					// identical one.
					const idx = this.chipTokens.indexOf(filter.token);
					if (idx >= 0) this.chipTokens.splice(idx, 1);
					else this.chipTokens.push(filter.token);
					this.renderSearchChipBar();
				} else {
					// Same toggle on the sort side: re-clicking the already active suggestion
					// goes back to the default sort rather than staying stuck on it.
					this.sortOverride = isActive ? null : { order: filter.order, dir: filter.dir };
				}
				this.renderSuggestedFilters();
				// triggerSearch (debounce 400ms), not runSearch directly: same path as any
				// other chip mutation in this file (removal, negation/exact toggle…) —
				// consistent with what exists, and it avoids a quick click on several
				// suggestions in a row triggering one Scryfall request per click instead
				// of a single one once it settles.
				this.triggerSearch();
			});
		});

		// Custom filters saved by the user (square "Save filter" button to the
		// right of the chip bar, see showSaveFilterPrompt/confirmSaveFilter) —
		// same visual language/toggle as the fixed suggestions above, but a saved
		// filter is a snapshot of SEVERAL tokens (+ a sort) at once, so applying
		// it REPLACES the whole current state of the bar rather than
		// adding/removing a single token. A small "x" inside the button deletes
		// the saved filter itself (settings, persisted), not just its current
		// application.
		this.plugin.settings.savedSearchFilters.forEach((filter) => {
			const isActive = this.savedFilterIsActive(filter);
			const btn = container.createEl("button", {
				cls: "mtg-search-suggested-filter-btn mtg-search-suggested-filter-btn-saved",
			});
			btn.toggleClass("is-active", isActive);
			btn.createSpan({ text: filter.label });
			const removeBtn = btn.createSpan({ cls: "mtg-search-suggested-filter-remove" });
			setIcon(removeBtn, "x");
			removeBtn.setAttribute("title", "Delete saved filter");
			removeBtn.addEventListener("click", (evt) => {
				// stopPropagation: this span lives inside the <button>, a click on it
				// would otherwise ALSO trigger the button's handler (bubbling up to it) —
				// it would apply/toggle the filter instead of deleting it.
				evt.stopPropagation();
				this.plugin.deleteSearchFilter(filter.id);
				this.renderSuggestedFilters();
			});
			btn.addEventListener("click", () => {
				if (isActive) {
					this.chipTokens = [];
					this.sortOverride = null;
				} else {
					this.chipTokens = [...filter.tokens];
					this.sortOverride = filter.sortOverride;
				}
				this.renderSearchChipBar();
				this.renderSuggestedFilters();
				this.triggerSearch();
			});
		});
	}

	// true as soon as there is ANYTHING to save — a chip already validated, an
	// active sort, OR a keyword still being typed (chipDraft, not yet a chip):
	// explicitly requested, "from the first keyword in the search bar", not
	// only once a suggestion has been clicked. buildScryfallQueryFromChips
	// (card-search.ts) already treats chipDraft as part of the search IN
	// PROGRESS — this button therefore follows exactly what the user already
	// sees being searched, not only what is formally validated as a chip.
	private hasSomethingToSaveFilter(): boolean {
		return this.chipTokens.length > 0 || this.chipDraft.trim().length > 0 || !!this.sortOverride;
	}

	// Separate from renderSearchChipBar: chipDraft changes on every keystroke
	// WITHOUT rebuilding the whole bar (loss of focus otherwise, see the
	// "input" handler higher up) — this method only touches a single attribute
	// on an already built button, callable on every keystroke without this
	// risk.
	private updateSaveFilterButtonState() {
		this.saveFilterBtn.disabled = !this.hasSomethingToSaveFilter();
	}

	// English sentence describing the chip bar (see describeSearchFilters,
	// card-search.ts) — includes the keyword being typed (chipDraft), not only
	// the already validated chips: unlike the search itself (which now waits for
	// an explicit validation, see triggerSearch), this sentence is a simple
	// textual preview of what is being built, no network round trip or visual
	// jump to avoid by delaying it. Defensive guard on filterDescriptionEl: the
	// very first call of renderSearchChipBar (onOpen, before this block is built
	// further down in the window) would otherwise hit a still-undefined element.
	// Always visible (explicitly requested — no more is-visible/conditional
	// hiding): when there is nothing to describe, it shows a neutral fallback
	// rather than an empty sentence or a block that disappears/reappears.
	private updateFilterDescription() {
		if (!this.filterDescriptionEl) return;
		const allTokens = this.chipDraft.trim()
			? [...this.chipTokens, this.chipDraft.trim()]
			: this.chipTokens;
		// Full set name rather than the short code (e.g. "Innistrad Remastered",
		// not "INR") — explicitly requested. getCachedSetSummary is a SYNCHRONOUS
		// read of an already warm cache (same source already used for the
		// icon/name of the "set:" chip itself a little higher in this file) —
		// describeSearchFilters itself falls back to the uppercase code if this
		// cache isn't warm yet.
		const description = describeSearchFilters(allTokens, (code) => this.plugin.getCachedSetSummary(code)?.name);
		this.filterDescriptionTextEl.setText(description || "No filter applied — showing every card.");
	}

	// A saved filter is "active" when the bar reflects EXACTLY its snapshot —
	// same tokens (order doesn't matter: a Set, not a position-by-position
	// comparison) and same sort, no more, no less.
	private savedFilterIsActive(filter: SavedSearchFilter): boolean {
		if (filter.tokens.length !== this.chipTokens.length) return false;
		const current = new Set(this.chipTokens);
		if (!filter.tokens.every((t) => current.has(t))) return false;
		if (!filter.sortOverride && !this.sortOverride) return true;
		if (!filter.sortOverride || !this.sortOverride) return false;
		return (
			filter.sortOverride.order === this.sortOverride.order &&
			filter.sortOverride.dir === this.sortOverride.dir
		);
	}

	private showSaveFilterPrompt() {
		if (!this.hasSomethingToSaveFilter()) return;
		this.saveFilterInputEl.value = "";
		this.saveFilterPromptEl.addClass("is-visible");
		this.saveFilterInputEl.focus();
	}

	private hideSaveFilterPrompt() {
		this.saveFilterPromptEl.removeClass("is-visible");
	}

	private confirmSaveFilter() {
		const label = this.saveFilterInputEl.value.trim();
		if (!label) {
			// No Notice for an empty field — re-focusing is enough, consistent with
			// the rest of this file which only alerts on a real network
			// failure/result, not on missing input.
			this.saveFilterInputEl.focus();
			return;
		}
		// A keyword still being typed (chipDraft) already counts in the displayed
		// search (see hasSomethingToSaveFilter) — we promote it to a real chip at
		// the moment of saving, exactly as Enter/space would, so that the saved
		// filter matches precisely what is visible/searched at the time of the
		// click rather than silently losing this keyword.
		if (this.chipDraft.trim()) {
			this.chipTokens.push(stripQuotesFromCommittedToken(this.chipDraft.trim()));
			this.chipDraft = "";
			this.renderSearchChipBar();
		}
		this.plugin.saveSearchFilter(label, this.chipTokens, this.sortOverride);
		this.hideSaveFilterPrompt();
		this.renderSuggestedFilters();
		new Notice(`Saved filter "${label}".`);
	}

	// Options applied to a card added from this modal — none of the 3 flows
	// (Collection/Wantlist/Deck) exposes a Finish/Language/Condition selector
	// here any more, always the default values; to be refined afterwards from
	// the card's detail panel.
	private computeAddOptions(): AddCardOptions {
		return { finish: "regular", language: "", condition: "" };
	}

	// Resolved by default (nothing to wait for on the very first call, before
	// any commit has ever triggered triggerSearch) — see
	// triggerSearch/loadDefaultResults/runSearch below.
	private resultsExitPromise: Promise<void> = Promise.resolve();

	private triggerSearch() {
		// Starts the animated exit of the currently displayed tiles right away
		// (see animateResultTilesOut, shared-search-ui.ts) — from the commit, not
		// only once the 400ms delay has elapsed, for immediate visual feedback
		// rather than a 400ms silence followed by a sudden fade.
		// runSearch()/loadDefaultResults() await this same Promise before emptying
		// resultsEl (resetResults) — necessary since the transition became slower
		// than the 400ms delay itself (see animateResultTilesOut): without this
		// wait, runSearch() would cut the animation off in the middle.
		this.resultsExitPromise = animateResultTilesOut(this.resultsEl);
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => void this.runSearch(), 400);
	}

	// "N cards found", discreet — explicitly requested.
	//
	// count === null is now a deliberate no-op (NOT a blanking to "") —
	// reported bug: the text disappeared then reappeared on every carousel
	// update, which read as a small visual jump. The previous count stays
	// displayed throughout loading (the carousel skeleton, see
	// renderResultSkeletons, is already the "loading in progress" signal —
	// this text needn't carry a second one) until setResultsCount(N) replaces
	// it directly with the real value, in a single text update instead of two.
	// clearResultsCount() below remains the only way to clear explicitly
	// (network error, results entirely invalidated) — distinct from "don't
	// touch" so as never to leave a stale count visible next to an error
	// message. `total` (Scryfall total_cards, see ScryfallPagedResult)
	// displays "X of Y cards found" as long as there are pages left to load (Y
	// > X) — otherwise the usual plain "N cards found", including when `total`
	// is supplied but equal to `count` (everything is already displayed,
	// nothing to distinguish).
	private setResultsCount(count: number | null, total?: number) {
		if (count === null) return;
		this.resultsCountEl.setText(
			total !== undefined && total > count
				? `${count} of ${total} cards found`
				: `${count} card${count === 1 ? "" : "s"} found`
		);
	}

	private clearResultsCount() {
		this.resultsCountEl.setText("");
	}

	// Content displayed before any keystroke: the most recently released paper
	// cards, to avoid an empty results window on first display (and hence a
	// window size jump at the first typed character).
	async loadDefaultResults() {
		// Waits for the animated exit of the currently displayed tiles to finish
		// (already started by triggerSearch, see resultsExitPromise) before
		// actually emptying them — an immediate no-op on the very first call
		// (resultsEl is already empty, no tile to make exit).
		await this.resultsExitPromise;
		this.resetResults();
		// No setResultsCount(null) here — see the comment of setResultsCount: the
		// previous count stays displayed as is during loading, the skeleton below
		// is already the visual loading signal.
		// Skeleton tiles (not a simple "Loading…" text): see renderResultSkeletons
		// for the full reasoning — eliminates the reported height jump between the
		// "loading" state and the arrival of the real tiles.
		renderResultSkeletons(this.resultsEl);
		try {
			const { cards, hasMore, totalCards } = await fetchLatestPaperPrintings(this.sortOverride ?? undefined);
			// If the user has already started typing during loading, we don't
			// overwrite what they are in the middle of searching for.
			if (this.chipTokens.length > 0 || this.chipDraft.trim()) {
				return;
			}
			this.resetResults();
			if (cards.length === 0) {
				this.clearResultsCount();
				return;
			}
			this.setResultsCount(cards.length, totalCards);
			// No arbitrary cap here: cards.length is already bounded to 175 by
			// Scryfall (a single page) — beyond that, hasMore/the "Load more" button
			// below take over rather than a local slice(0, 40), which artificially
			// shortened the carousel before even reaching that limit (reported: "the
			// carousel shows rather few cards").
			cards.forEach((card, i) => this.renderResult(card, i));
			this.updateAddAllButtonState();
			this.loadMoreQuery = null; // default search, no chips
			this.totalCardsFound = totalCards;
			this.hasMorePages = hasMore;
			if (hasMore) this.renderLoadMoreTile();
		} catch {
			this.resetResults();
			this.clearResultsCount();
		}
	}

	async runSearch() {
		const chipQuery = buildScryfallQueryFromChips(this.chipTokens, this.chipDraft);
		// If both the "set:xyz" and "#number" chips are present (not excluded), we
		// can still take advantage of searchScryfall's fast exact lookup rather
		// than going back through the general search.
		const { setCode, collectorNumber } = extractExactLookupHints(this.chipTokens, this.chipDraft);

		if (!chipQuery) {
			// loadDefaultResults() handles waiting for the animated exit +
			// resetResults() itself — no double emptying here.
			void this.loadDefaultResults();
			return;
		}

		await this.resultsExitPromise;
		this.resetResults();
		// No setResultsCount(null) here — same reasoning as loadDefaultResults
		// above, see the comment of setResultsCount.
		// Same reasoning as loadDefaultResults: skeleton rather than a bare
		// "Searching…" text, so as never to vary the track's height between the
		// start and the end of loading.
		renderResultSkeletons(this.resultsEl);

		let cards: ScryfallCard[] = [];
		let hasMore = false;
		let totalCards = 0;
		try {
			({ cards, hasMore, totalCards } = await searchScryfall(
				"",
				setCode,
				collectorNumber,
				chipQuery,
				this.sortOverride ?? undefined
			));
		} catch (e) {
			this.resetResults();
			this.clearResultsCount();
			const message =
				e instanceof ScryfallError
					? `Scryfall error (HTTP ${e.status}): ${e.message}`
					: `Error while querying Scryfall: ${(e as Error).message}`;
			this.resultsEl.createEl("p", {
				text: message,
				cls: "mtg-status mtg-error",
			});
			return;
		}

		this.resetResults();

		if (cards.length === 0) {
			this.setResultsCount(0);
			this.resultsEl.createEl("p", {
				text: "No card found.",
				cls: "mtg-status",
			});
			return;
		}

		this.setResultsCount(cards.length, totalCards);
		// Same reasoning as loadDefaultResults above: no local cap, hasMore/"Load
		// more" take over beyond the 1st page.
		cards.forEach((card, i) => this.renderResult(card, i));
		this.updateAddAllButtonState();
		this.loadMoreQuery = { setCode, collectorNumber, chipQuery };
		this.totalCardsFound = totalCards;
		this.hasMorePages = hasMore;
		if (hasMore) this.renderLoadMoreTile();
	}

	// "Idle" content (icon + label) of the "Load more" tile — factored out to
	// be called both at the initial construction and to put the tile back in
	// that state after a loading failure (see loadMoreResults), rather than
	// two copies of these 3 lines to maintain in parallel.
	private renderLoadMoreIdleContent(tile: HTMLElement) {
		const iconEl = tile.createDiv({ cls: "mtg-search-load-more-icon" });
		setIcon(iconEl, "chevron-right");
		tile.createSpan({ text: "Load more" });
	}

	// End-of-track tile (see .mtg-search-load-more-tile, styles.css, for its
	// own template) displayed when hasMorePages is true — explicit click
	// rather than an IntersectionObserver auto-triggered at the end of
	// scrolling, see the comment of hasMorePages/currentPage above for the
	// reasoning.
	private renderLoadMoreTile() {
		const tile = this.resultsEl.createDiv({ cls: "mtg-search-load-more-tile" });
		this.renderLoadMoreIdleContent(tile);
		tile.addEventListener("click", () => void this.loadMoreResults());
		this.loadMoreEl = tile;
	}

	// Loads the next page of THE SAME search (loadMoreQuery, captured when
	// hasMorePages became true — see runSearch/loadDefaultResults) and adds
	// the new tiles AFTER those already displayed, without touching them —
	// unlike runSearch/loadDefaultResults, which always start over from
	// resetResults(). The index passed to renderResult continues the existing
	// numbering (currentResultControls.length, before the addition): beyond
	// RESULT_TILE_STAGGER_MAX (4), applyResultTileStaggerEntrance is a no-op
	// anyway, so the tiles of a later page never get their own entrance wave —
	// consistent, they arrive outside the carousel's initial visible area.
	private async loadMoreResults() {
		if (this.loadingMorePage || !this.hasMorePages) return;
		this.loadingMorePage = true;
		const nextPage = this.currentPage + 1;
		if (this.loadMoreEl) {
			this.loadMoreEl.empty();
			renderLoadingDots(this.loadMoreEl.createDiv({ cls: "mtg-search-load-more-dots" }));
		}
		try {
			const { cards, hasMore, totalCards } = this.loadMoreQuery
				? await searchScryfall(
						"",
						this.loadMoreQuery.setCode,
						this.loadMoreQuery.collectorNumber,
						this.loadMoreQuery.chipQuery,
						this.sortOverride ?? undefined,
						nextPage
				  )
				: await fetchLatestPaperPrintings(this.sortOverride ?? undefined, nextPage);
			this.currentPage = nextPage;
			this.hasMorePages = hasMore;
			this.totalCardsFound = totalCards;
			// Removes the "Load more" tile before inserting the new cards — otherwise
			// they would be added after it (always at the very end of the track, via
			// createDiv), not before.
			this.loadMoreEl?.remove();
			this.loadMoreEl = null;
			const startIndex = this.currentResultControls.length;
			cards.forEach((card, i) => this.renderResult(card, startIndex + i));
			this.setResultsCount(this.currentResultControls.length, totalCards);
			this.updateAddAllButtonState();
			if (hasMore) this.renderLoadMoreTile();
		} catch {
			new Notice("Failed to load more cards from Scryfall.");
			// Puts the tile back in its initial clickable state (removes the loading
			// dots) — currentPage deliberately did not advance, a new click will retry
			// the same next page.
			if (this.loadMoreEl) {
				this.loadMoreEl.empty();
				this.renderLoadMoreIdleContent(this.loadMoreEl);
			}
		} finally {
			this.loadingMorePage = false;
		}
	}

	private historyKey(scryfallId: string, listId: string): string {
		return `${scryfallId}:${listId}`;
	}

	// listGallery: each tile can be added to a different destination, resolved by
	// id from the summaries already in hand (no extra fetch). Fixed destination
	// (the 2 fixed-target flows,
	// openAddCollectionCardsModal/openAddWantlistCardsModal): destinationName is
	// supplied directly by the call site (see AddCardsModalOptions).
	private resolveDestinationName(listId: string): string {
		if (this.listGallery) {
			const fromGallery = this.listGallery.summaries.find((s) => s.id === listId)?.name;
			if (fromGallery) return fromGallery;
			// Reported bug: adding a card to a just-created list/wantlist ("+ New
			// list"/"+ New wantlist" button INSIDE the per-card selector) displayed
			// "This destination" instead of its real name. Root cause:
			// listGallery.summaries is a SNAPSHOT taken when the modal opens (see
			// onOpen/openAddCollectionCardsModalWithListPicker), so a list created
			// DURING this same session never appears in it. resolveDestinationNameById
			// reads plugin.settings.lists/.wantlists directly (always up to date)
			// rather than falling back to "this destination" — the same method already
			// used to resolve the real destination after a move (see
			// openMoveCardForEntry, which has the same need "id known, name not
			// necessarily in the snapshot").
			return this.resolveDestinationNameById(listId);
		}
		return this.destinationName ?? "this destination";
	}

	// Records a contribution in the "Add history" panel — called once per
	// successful addOne() (individual "Add" click or "Add all"), NEVER for the
	// stepper's +/- adjustments of an already added tile (choice confirmed
	// before building this feature: the history only tracks explicit "Add"
	// clicks). Aggregated by (scryfallId, listId) — same card + same
	// destination reuse the same tile, its quantity increases instead of
	// creating a new one (confirmed choice, "aggregated by card").
	// `syncCallback` is stored as is (not in a separate Map): it is directly
	// tied to the lifecycle of THIS HistoryEntry, not to that of resultsEl — a
	// history entry must survive a new search (resetResults()) even if its
	// sync callback becomes inert once its original carousel tile is destroyed
	// (see syncFromHistory in renderAddControl: calling this callback on a
	// tile detached from the DOM does nothing visible, nor crashes).
	private recordHistoryAdd(
		card: ScryfallCard,
		options: AddCardOptions,
		listId: string,
		syncCallback: (row: { id: string; count: number } | undefined) => void
	) {
		// During an aggregated "Add all" (see
		// addAllBatch/HISTORY_AGGREGATE_THRESHOLD), every addition — rendered or
		// not, individual or auto-paginated — accumulates here instead of
		// building/updating a tile of history per card; renderAddAllBatchTile
		// builds ONE summary tile once the whole batch has been added (see
		// runAddAll).
		if (this.addAllBatch) {
			this.addAllBatch.push({ card, options, listId });
			return;
		}
		if (!this.onUndoAdd) return;
		const key = this.historyKey(card.id, listId);
		let hEntry = this.historyEntries.get(key);
		// A disabled entry (already undone) starts again from zero rather than
		// merging with contributions that have become obsolete — simpler and
		// unambiguous compared with "implicitly re-enabling" an entry that the
		// user explicitly chose to undo.
		if (!hEntry || !hEntry.enabled) {
			hEntry?.tileEl?.remove();
			hEntry = {
				card,
				listId,
				destinationName: this.resolveDestinationName(listId),
				contributions: [],
				enabled: true,
			};
			this.historyEntries.set(key, hEntry);
		}
		const existing = hEntry.contributions.find((c) => addOptionsEqual(c.options, options));
		if (existing) existing.count += 1;
		else hEntry.contributions.push({ options: { ...options }, count: 1 });
		// The most recent callback wins — it is always the CURRENTLY displayed
		// carousel tile that must be resynchronized if this entry is toggled
		// afterwards, not a tile from a previous search that has already been
		// replaced.
		hEntry.syncCallback = syncCallback;
		if (!hEntry.tileEl) {
			this.renderHistoryTile(hEntry);
		} else {
			this.updateHistoryTileQuantity(hEntry);
			// The latest action always displays first — explicitly requested.
			// flipHistoryListChange animates the move (see its own comment) —
			// prepend() on an already attached node MOVES it (doesn't duplicate it): a
			// card already present lower down in the list, re-clicked "Add"/"+",
			// therefore moves up to the top rather than staying at its original
			// position. renderHistoryTile above already handles the "new entry" case
			// (see its own comment).
			const tileEl = hEntry.tileEl;
			this.flipHistoryListChange(() => {
				this.historyListEl.prepend(tileEl);
			});
		}
	}

	// FLIP technique (First-Last-Invert-Play) identical to flipListChange
	// (view.ts, which already animates neighboring groups when
	// folding/unfolding in the same way): measures the position of each tile
	// ALREADY present BEFORE the mutation, applies the real mutation
	// instantly, then visually compensates for the gap with a transform
	// (immediate, invisible), before releasing it smoothly — explicitly
	// requested, "a small animation when a new tile appears, that it pushes
	// the tiles below". Since only "transform" animates, no layout
	// recalculation takes place during the animation itself. One and the same
	// helper serves both use cases above/below (renderHistoryTile,
	// recordHistoryAdd): a tile not yet created at the moment of measurement
	// is never in `movables` (it doesn't exist yet in the DOM) — this is
	// exactly what makes ONLY the tiles already present get pushed/animated,
	// never the new tile itself (which has its own separate entrance
	// animation, see mtg-search-history-tile-enter/-visible in
	// renderHistoryTile); an already present tile that is moved to the top
	// (2nd use case) is itself part of `movables` and therefore slides
	// normally to its new position.
	private flipHistoryListChange(mutate: () => void) {
		const movables = Array.from(
			this.historyListEl.querySelectorAll<HTMLElement>(".mtg-search-history-tile")
		);
		const firstTops = movables.map((el) => el.getBoundingClientRect().top);

		mutate();

		const toAnimate: HTMLElement[] = [];
		movables.forEach((el, i) => {
			if (!el.isConnected) return;
			const deltaY = firstTops[i] - el.getBoundingClientRect().top;
			if (Math.abs(deltaY) < 1) return;
			holdAtOffset(el, deltaY);
			toAnimate.push(el);
		});

		if (toAnimate.length === 0) return;
		// Forces the browser to "see" the offset position before releasing,
		// otherwise the two changes risk being merged and the animation skipped —
		// same precaution as flipListChange (view.ts).
		this.historyListEl.getBoundingClientRect();
		window.requestAnimationFrame(() => {
			toAnimate.forEach((el) => releaseOffset(el));
		});
	}

	// Symmetric to recordHistoryAdd, for the "-" of the stepper on an already
	// added tile (see applyDelta) — never called for a history
	// "disable"/"delete" (which go through onUndoAdd, a real data undo; this
	// ONLY tracks a quantity adjustment already applied elsewhere by
	// onChangeQuantity). Never recreates a missing entry — decrementing
	// something that doesn't/no longer exist makes no sense, unlike an
	// addition.
	private decrementHistoryQuantity(card: ScryfallCard, options: AddCardOptions, listId: string) {
		const key = this.historyKey(card.id, listId);
		const hEntry = this.historyEntries.get(key);
		if (!hEntry || !hEntry.enabled) return;
		const contribution = hEntry.contributions.find((c) => addOptionsEqual(c.options, options));
		if (!contribution) return;
		contribution.count -= 1;
		if (contribution.count <= 0) {
			hEntry.contributions = hEntry.contributions.filter((c) => c !== contribution);
		}
		// No contribution left: nothing to display/undo for this session, the tile
		// disappears (same path as deleteHistoryEntry, but without calling
		// onUndoAdd again — the data has already been decremented via
		// onChangeQuantity just before, in applyDelta).
		if (hEntry.contributions.length === 0) {
			hEntry.tileEl?.remove();
			this.historyEntries.delete(key);
			if (this.historyEntries.size === 0) this.historyEmptyEl?.toggleClass("is-hidden", false);
			return;
		}
		this.updateHistoryTileQuantity(hEntry);
	}

	private renderHistoryTile(hEntry: HistoryEntry) {
		this.historyEmptyEl?.toggleClass("is-hidden", true);
		let tile!: HTMLElement;
		this.flipHistoryListChange(() => {
			tile = this.historyListEl.createDiv({ cls: "mtg-search-history-tile" });
			this.historyListEl.prepend(tile);
			tile.addClass("mtg-search-history-tile-enter");
		});
		hEntry.tileEl = tile;
		// Nested double requestAnimationFrame for -visible (unchanged — still the
		// most robust technique to guarantee a real intermediate paint of -enter
		// before replacing it, independent of any macrotask/frame arbitration
		// unlike setTimeout(0)): the OUTER rAF runs at frame N (only schedules the
		// inner rAF, changes no class) — frame N is therefore painted with -enter
		// already set (now the first state EVER observed, see above) and nothing
		// else to recompute; the INNER rAF only runs at frame N+1, then adds
		// -visible.
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => tile.addClass("mtg-search-history-tile-visible"));
		});

		// Native checkbox (not an eye icon) — explicitly requested. accent-color
		// rather than a fully custom widget: recolors a native checkbox in the
		// plugin's accent without having to reproduce its shape/states
		// (checked/hovered/focus) by hand.
		hEntry.toggleBtn = tile.createEl("input", { cls: "mtg-search-history-toggle-checkbox" });
		hEntry.toggleBtn.type = "checkbox";
		hEntry.toggleBtn.addEventListener("change", () => this.toggleHistoryEntry(hEntry));

		// Vertical separator — align-self: stretch (styles.css) stretches it over
		// the tile's whole height to clearly split the checkbox from the text,
		// explicitly requested.
		tile.createDiv({ cls: "mtg-search-history-divider" });

		const info = tile.createDiv({ cls: "mtg-search-history-info" });
		const line1 = info.createDiv({ cls: "mtg-search-history-line1" });
		line1.createSpan({ cls: "mtg-search-history-name", text: hEntry.card.name });
		hEntry.quantityEl = line1.createSpan({ cls: "mtg-search-history-qty" });
		const line2 = info.createDiv({ cls: "mtg-search-history-line2" });
		hEntry.line2El = line2;
		this.buildHistoryLine2(
			hEntry,
			hEntry.card.set,
			hEntry.card.collector_number,
			hEntry.card.rarity,
			hEntry.destinationName
		);

		// Vertical separator before the delete button/the context badge —
		// explicitly requested, same class/same recipe as the one already placed
		// between the checkbox and the text above (align-self: stretch,
		// styles.css).
		tile.createDiv({ cls: "mtg-search-history-divider" });

		this.buildHistoryTileTrailing(hEntry, tile);

		this.updateHistoryTileQuantity(hEntry);
		this.updateHistoryTileState(hEntry);
	}

	// Builds (or fully rebuilds — see
	// openChangePrintingForEntry/openMoveCardForEntry, which call it again
	// after a success) the content of line 2: icon + set code/number ("Change
	// printing" link), then destination ("Move card" link) — two SEPARATE
	// CLICKABLE areas, requested explicitly one after the other in the same
	// message. The "Change printing" link is now also clickable for the Deck
	// flow (ChangePrintingModal accepts "deck" as a source since its
	// extension, see changeDeckCardPrinting/plugin.ts) — explicitly requested
	// after the fact, once the same feature was already enabled elsewhere in
	// My Decks (detail panel, row/tile). The "Move card" link REMAINS
	// Collection/Wantlist only: CopyCardModal still doesn't accept "deck" as a
	// source (DeckCard has no concept of moving — a card can legitimately
	// belong to several decks at once, unlike a single list/wantlist — see
	// "Data model notes" in CLAUDE.md), so the two links no longer have
	// exactly the same activation condition, handled separately below.
	private buildHistoryLine2(
		hEntry: HistoryEntry,
		setCode: string,
		collectorNumber: string,
		rarity: string,
		destinationName: string
	) {
		const line2 = hEntry.line2El;
		if (!line2) return;
		line2.empty();
		// !hEntry.linksDisabled — see its own declaration: once this card has been
		// moved outside the scope of this.sourceKind (to a deck, or to the other
		// side of Collection/Wantlist), neither link can operate correctly from
		// this modal any more — both become permanently non-interactive for this
		// tile, regardless of this.sourceKind itself. Deck never has a "Move" link
		// (see canMove below), so linksDisabled is in practice never set for a
		// Deck tile — kept anyway for this link, for consistency/future-proofing.
		const linksActive = !hEntry.linksDisabled;
		const canChangePrinting =
			linksActive &&
			(this.sourceKind === "collection" || this.sourceKind === "wantlist" || this.sourceKind === "deck");
		const canMove = linksActive && (this.sourceKind === "collection" || this.sourceKind === "wantlist");

		// Set symbol + code/number — explicitly requested. Same recipe as
		// .mtg-card-tile-set-icon (view.ts, "Card view"): icon tinted by rarity
		// via getSetIconSvg + applySvgColor, no IntersectionObserver guard here
		// unlike the results carousel (renderScryfallResultTile) — this panel only
		// ever holds a handful of tiles per session, no reason to delay their
		// loading; getSetIconSvg already serializes its own requests anyway
		// (setIconFetchQueue, plugin.ts), which protects this call like all the
		// others.
		const printingLink = line2.createSpan({ cls: "mtg-search-history-printing-link" });
		const setIconEl = printingLink.createSpan({ cls: "mtg-search-history-set-icon" });
		void this.plugin.getSetIconSvg(setCode).then((svg) => {
			if (!svg) return;
			setSvgMarkup(setIconEl, svg);
			const svgEl = setIconEl.querySelector("svg");
			if (svgEl) {
				svgEl.setAttribute("width", "12");
				svgEl.setAttribute("height", "12");
			}
			applySvgColor(setIconEl, getRarityColor(rarity));
		});
		printingLink.createSpan({
			cls: "mtg-search-history-printing-text",
			text: `${setCode.toUpperCase()} #${collectorNumber}`,
		});
		// Clickable in Collection/Wantlist/Deck, whatever the mode (fixed or
		// listGallery) — "Change printing" never concerns the destination, only
		// the printing itself, so not affected by the listGallery restriction
		// below (specific to the "Move" link).
		if (canChangePrinting) {
			printingLink.addClass("is-clickable");
			printingLink.setAttribute("title", "Change printing of this card");
			printingLink.addEventListener("click", () => this.openChangePrintingForEntry(hEntry));
		}

		// "→" separator — plain text, never clickable itself, between the two
		// links.
		line2.createSpan({ cls: "mtg-search-history-line2-arrow", text: " → " });

		const destLink = line2.createSpan({
			cls: "mtg-search-history-destination-link",
			text: destinationName,
		});
		// Clickable ONLY in listGallery mode (this.listGallery defined — "All
		// Cards"/the Wantlist equivalent, where the destination of an addition
		// varies tile by tile and is therefore worth revising afterwards) —
		// explicitly requested, reverted from the previous version that always
		// showed it for Collection/Wantlist: inside a specific list that is
		// already open (openAddCollectionCardsModal/openAddWantlistCardsModal,
		// fixed destination), the card has only one possible, already obvious
		// destination — a "move" link there adds nothing and was confusing. No new
		// option added for this: this.listGallery already exists, set on exactly
		// this same distinction (see its own field in AddCardsModalOptions).
		if (canMove && this.listGallery) {
			destLink.addClass("is-clickable");
			destLink.setAttribute("title", "Move card to another destination");
			destLink.addEventListener("click", () => this.openMoveCardForEntry(hEntry));
		}
	}

	// Finds the Collection/Wantlist row actually represented by this tile —
	// used by the 2 links above (Move stays Collection/Wantlist only, see
	// canMove/buildHistoryLine2; Change printing, for its part, also needs to
	// resolve a Deck row — see resolveDeckHistoryRow just below, a different
	// return type hence a separate function rather than a 3rd case added
	// here). undefined for the Deck flow, or if the row has since disappeared
	// by another path (card deleted in the meantime). Uses the entry's LAST
	// contribution — the same approximation, already established elsewhere in
	// this panel (see toggleHistoryEntry/deleteHistoryEntry), for a tile that
	// would aggregate several distinct option groups (see HistoryContribution
	// above — no realistic path to produce this case today, but a single link
	// could only designate ONE row at a time anyway).
	private resolveHistoryRow(hEntry: HistoryEntry): CollectionCard | WantlistCard | undefined {
		const lastContribution = hEntry.contributions[hEntry.contributions.length - 1];
		if (!lastContribution) return undefined;
		const { finish, language, condition } = lastContribution.options;
		if (this.sourceKind === "collection") {
			return this.plugin.settings.collection.find(
				(c) =>
					c.scryfallId === hEntry.card.id &&
					c.listId === hEntry.listId &&
					c.finish === finish &&
					c.language === language &&
					c.condition === condition
			);
		}
		if (this.sourceKind === "wantlist") {
			return this.plugin.settings.wantlist.find(
				(c) => c.scryfallId === hEntry.card.id && c.listId === hEntry.listId && c.finish === finish
			);
		}
		return undefined;
	}

	// Equivalent of resolveHistoryRow above, for the Deck flow — used only by
	// openChangePrintingForEntry (the "Move" link doesn't exist for Deck, see
	// canMove/buildHistoryLine2). For this flow, hEntry.listId is the DECK's
	// id (see onAdd, view.ts: the added card is reshaped there into { id:
	// row.scryfallId, count, listId: deck.id } for lack of an id field of its
	// own on DeckCard) and hEntry.card.id its scryfallId. A card added via
	// "Add cards" never has a category other than mainboard (only
	// importDecklistToDeck produces others, see "Data model notes" in
	// CLAUDE.md) — the row is therefore resolved by scryfallId + mainboard
	// category, consistent with what changeDeckCardPrinting (plugin.ts)
	// expects as a key.
	private resolveDeckHistoryRow(hEntry: HistoryEntry): DeckCard | undefined {
		const deck = this.plugin.settings.decks.find((d) => d.id === hEntry.listId);
		return deck?.cards.find(
			(c) => c.scryfallId === hEntry.card.id && getDeckCardCategory(c) === "mainboard"
		);
	}

	// Finds the real row AFTER a successful move — reported bug, root-caused:
	// `copyToList`/`moveCollectionCardToList` etc. (copy-card-modal.ts/plugin.ts)
	// ALWAYS implement "move" as "copy to the destination, THEN remove the original"
	// (this.plugin.removeCard(cardId) afterwards) — never an in-place mutation of
	// `row.listId`. The `row` reference captured BEFORE opening CopyCardModal (see
	// openMoveCardForEntry) therefore becomes a DANGLING reference once the move is
	// done: it was never removed from settings.collection/.wantlist, its .listId
	// never changed — reading row.listId afterwards still returns the OLD
	// destination, always, never the new one. CopyCardModal.onDone moreover has no
	// way to return the chosen destination (`() => void`, no argument), so there is
	// nothing to read on the modal side anyway. This method finds the row at its REAL
	// current position by searching by card identity (scryfallId +
	// finish/language/condition) WITHOUT a listId constraint — unlike
	// resolveHistoryRow above, which precisely needs that constraint to designate a
	// specific row in normal use. Accepted approximation if 2 identical copies (same
	// printing/finish/language/condition) ever existed in 2 different lists before
	// the move: the first one found wins — same spirit as "last contribution wins"
	// elsewhere in this panel.
	private resolveMovedRow(hEntry: HistoryEntry): CollectionCard | WantlistCard | undefined {
		const lastContribution = hEntry.contributions[hEntry.contributions.length - 1];
		if (!lastContribution) return undefined;
		const { finish, language, condition } = lastContribution.options;
		if (this.sourceKind === "collection") {
			return this.plugin.settings.collection.find(
				(c) =>
					c.scryfallId === hEntry.card.id &&
					c.finish === finish &&
					c.language === language &&
					c.condition === condition
			);
		}
		if (this.sourceKind === "wantlist") {
			return this.plugin.settings.wantlist.find((c) => c.scryfallId === hEntry.card.id && c.finish === finish);
		}
		return undefined;
	}

	// Reported bug: moving a card to a DECK, or to the OTHER side of
	// Collection/Wantlist (e.g. sourceKind === "collection" but the card moved
	// to a wantlist), reproduced EXACTLY the same bug already fixed for a move
	// that STAYED within the scope of this.sourceKind — because
	// resolveMovedRow (above) ONLY searches the array matching
	// this.sourceKind, it finds nothing at all in that case and the success
	// callback then updated nothing, leaving the tile showing the OLD
	// destination with links that silently never did anything again — same
	// symptom, different cause. this.sourceKind is fixed for the whole
	// lifetime of the modal (it isn't a per-entry property): neither
	// ChangePrintingModal nor CopyCardModal can operate on this row from THIS
	// modal any more once it has left that scope (DeckCard has neither an
	// alternative printing nor a concept of moving — see "Data model notes" —
	// and switching sourceKind on the fly for a single entry would break the
	// rest of the modal). This method therefore searches for the card
	// EVERYWHERE (collection, wantlist, every deck), only for DISPLAY — real
	// set/number/rarity/destination name, wherever it landed — never to
	// re-enable the links, which stay disabled in this case (see
	// hEntry.linksDisabled). Same "first found wins" approximation as
	// resolveMovedRow if an identical card already existed elsewhere.
	private locateMovedCardAnywhere(hEntry: HistoryEntry): {
		setCode: string;
		collectorNumber: string;
		rarity: string;
		destinationName: string;
		// Section where the card actually landed — serves to compose the "Edit in
		// My X" tooltip (see openMoveCardForEntry) once linksDisabled is set,
		// explicitly requested.
		kind: "collection" | "wantlist" | "deck";
	} | undefined {
		const lastContribution = hEntry.contributions[hEntry.contributions.length - 1];
		if (!lastContribution) return undefined;
		const { finish, language, condition } = lastContribution.options;

		const collectionRow = this.plugin.settings.collection.find(
			(c) =>
				c.scryfallId === hEntry.card.id &&
				c.finish === finish &&
				c.language === language &&
				c.condition === condition
		);
		if (collectionRow) {
			return {
				setCode: collectionRow.setCode,
				collectorNumber: collectionRow.collectorNumber,
				rarity: collectionRow.rarity,
				destinationName: this.plugin.settings.lists.find((l) => l.id === collectionRow.listId)?.name ?? "this destination",
				kind: "collection",
			};
		}

		const wantlistRow = this.plugin.settings.wantlist.find(
			(c) => c.scryfallId === hEntry.card.id && c.finish === finish
		);
		if (wantlistRow) {
			return {
				setCode: wantlistRow.setCode,
				collectorNumber: wantlistRow.collectorNumber,
				rarity: wantlistRow.rarity,
				destinationName: this.plugin.settings.wantlists.find((l) => l.id === wantlistRow.listId)?.name ?? "this destination",
				kind: "wantlist",
			};
		}

		for (const deck of this.plugin.settings.decks) {
			const deckCard = deck.cards.find((c) => c.scryfallId === hEntry.card.id);
			if (deckCard) {
				return {
					setCode: deckCard.setCode,
					collectorNumber: deckCard.collectorNumber,
					rarity: deckCard.rarity,
					destinationName: deck.name,
					kind: "deck",
				};
			}
		}

		return undefined;
	}

	// "Edit in My X" — explicitly requested, the tooltip placed on a frozen
	// tile (linksDisabled) to explain where to find the card now that its 2
	// links no longer do anything here — same spirit as the other "nuance
	// rather than silence" tooltips already established in this file (Mana
	// Pool/TCGplayer/Cardmarket in the Store Prices panel).
	private editElsewhereTitle(kind: "collection" | "wantlist" | "deck"): string {
		const section = kind === "collection" ? "Collection" : kind === "wantlist" ? "Wantlists" : "Decks";
		return `This card has moved to ${section} — open it there to make further changes.`;
	}

	// Fixes hEntry.card/hEntry.listId (the deduplication key — see
	// historyKey/resolveHistoryRow) AFTER a successful printing change or
	// move, and moves the entry in historyEntries to its new key — reported
	// bug, fixed: without this, a 2nd printing change (or a click on the
	// destination, or a disable/delete) on the SAME tile looked for the row
	// under its OLD scryfallId/listId, no longer found it (resolveHistoryRow
	// returned undefined), and silently no longer opened/did anything at all —
	// which read as "nothing is clickable any more" on that particular tile.
	// `oldKey` must be captured by the caller BEFORE mutating
	// hEntry.card/hEntry.listId (otherwise it would no longer represent the
	// old key at the time of computing it here).
	private reKeyHistoryEntry(hEntry: HistoryEntry, oldKey: string) {
		const newKey = this.historyKey(hEntry.card.id, hEntry.listId);
		if (newKey === oldKey) return;
		this.historyEntries.delete(oldKey);
		this.historyEntries.set(newKey, hEntry);
	}

	// "icon + set + number" link of line 2 — explicitly requested, opens
	// ChangePrintingModal on the row actually added (see
	// resolveHistoryRow/resolveDeckHistoryRow).
	private openChangePrintingForEntry(hEntry: HistoryEntry) {
		if (this.sourceKind === "deck") {
			this.openChangePrintingForDeckEntry(hEntry);
			return;
		}
		const row = this.resolveHistoryRow(hEntry);
		if (!row || (this.sourceKind !== "collection" && this.sourceKind !== "wantlist")) return;
		const oldKey = this.historyKey(hEntry.card.id, hEntry.listId);
		new ChangePrintingModal(
			this.app,
			this.plugin,
			{ id: row.id, name: row.name, scryfallId: row.scryfallId },
			() => {
				// changeCollectionCardPrinting/changeWantlistCardPrinting mutate `row` in
				// place (same reference) — its
				// setCode/collectorNumber/rarity/scryfallId/name fields are therefore
				// already up to date here, no need to look the row up again. hEntry.card
				// is rebuilt (spread + changed fields) rather than mutated in place — it
				// stays typed ScryfallCard, only the fields that
				// resolveHistoryRow/buildHistoryLine2 actually read change, see
				// reKeyHistoryEntry above for why this is necessary.
				hEntry.card = {
					...hEntry.card,
					id: row.scryfallId,
					set: row.setCode,
					collector_number: row.collectorNumber,
					rarity: row.rarity,
					name: row.name,
				};
				this.reKeyHistoryEntry(hEntry, oldKey);
				this.buildHistoryLine2(hEntry, row.setCode, row.collectorNumber, row.rarity, hEntry.destinationName);
			},
			this.sourceKind
		).open();
	}

	// Deck variant of the method above — separate rather than a 3rd branch in
	// the same function, because it has a real structural difference: unlike
	// changeCollectionCardPrinting/changeWantlistCardPrinting (never merge, the
	// `row` reference captured before opening stays valid afterwards),
	// changeDeckCardPrinting (plugin.ts) can MERGE with a row already present
	// for the same printing in this deck — the original row (deckRow below) may
	// therefore have been removed from deck.cards in the meantime. The
	// onChanged callback now receives the ScryfallCard actually chosen (see its
	// own comment, ChangePrintingModal) precisely so as to find the real row
	// afterwards BY THIS NEW scryfallId, rather than risk reading a phantom
	// row.
	private openChangePrintingForDeckEntry(hEntry: HistoryEntry) {
		const deckRow = this.resolveDeckHistoryRow(hEntry);
		if (!deckRow) return;
		const deckId = hEntry.listId;
		const category = getDeckCardCategory(deckRow);
		const oldKey = this.historyKey(hEntry.card.id, hEntry.listId);
		new ChangePrintingModal(
			this.app,
			this.plugin,
			{ name: deckRow.name, scryfallId: deckRow.scryfallId },
			(scry) => {
				if (!scry) return;
				const deck = this.plugin.settings.decks.find((d) => d.id === deckId);
				const updatedRow = deck?.cards.find(
					(c) => c.scryfallId === scry.id && getDeckCardCategory(c) === category
				);
				if (!updatedRow) return;
				hEntry.card = {
					...hEntry.card,
					id: updatedRow.scryfallId,
					set: updatedRow.setCode,
					collector_number: updatedRow.collectorNumber,
					rarity: updatedRow.rarity,
					name: updatedRow.name,
				};
				this.reKeyHistoryEntry(hEntry, oldKey);
				this.buildHistoryLine2(
					hEntry,
					updatedRow.setCode,
					updatedRow.collectorNumber,
					updatedRow.rarity,
					hEntry.destinationName
				);
			},
			"deck",
			{ deckId, category }
		).open();
	}

	// "destination" link of line 2 — explicitly requested, opens CopyCardModal
	// in "move" mode on the row actually added.
	private openMoveCardForEntry(hEntry: HistoryEntry) {
		const row = this.resolveHistoryRow(hEntry);
		if (!row || (this.sourceKind !== "collection" && this.sourceKind !== "wantlist")) return;
		const oldKey = this.historyKey(hEntry.card.id, hEntry.listId);
		new CopyCardModal(
			this.app,
			this.plugin,
			[row],
			this.sourceKind,
			() => {
				hEntry.syncCallback?.(undefined);
				// `row` is now a DANGLING reference (see resolveMovedRow above for why) —
				// never used here to find the real destination. resolveMovedRow finds the
				// row at its real current position IF it stayed in the array matching
				// this.sourceKind (searches by card identity, with no listId constraint).
				const movedRow = this.resolveMovedRow(hEntry);
				if (movedRow) {
					// resolveDestinationNameById (not resolveDestinationName): the latter
					// ignores its listId parameter outside listGallery mode, it always returns
					// the modal's FIXED destination name (this.destinationName) — which would
					// have silently displayed the OLD destination after a move to a totally
					// different list/wantlist.
					const newName = this.resolveDestinationNameById(movedRow.listId);
					hEntry.listId = movedRow.listId;
					hEntry.destinationName = newName;
					this.reKeyHistoryEntry(hEntry, oldKey);
					this.buildHistoryLine2(
						hEntry,
						movedRow.setCode,
						movedRow.collectorNumber,
						movedRow.rarity,
						newName
					);
					return;
				}
				// resolveMovedRow found nothing: the card left the scope of
				// this.sourceKind (moved to a deck, or to the OTHER side of
				// Collection/Wantlist) — reported bug, root-caused: without this case, the
				// tile stayed stuck on its old destination with links that silently never
				// did anything again. locateMovedCardAnywhere searches for the card
				// EVERYWHERE just for display; hEntry.linksDisabled makes the 2 links
				// permanently non-interactive for this tile — neither ChangePrintingModal
				// nor CopyCardModal can operate on it from this modal any more once it has
				// left that scope.
				const located = this.locateMovedCardAnywhere(hEntry);
				hEntry.linksDisabled = true;
				// Greys out the tile + "Edit in My X" tooltip — explicitly requested, "to
				// understand visually that this tile is frozen": same visual treatment as
				// is-disabled (unchecked checkbox), under a distinct class (is-frozen) —
				// the two states are semantically different (a frozen card is still
				// "enabled", it has just left the scope of this modal) but share the same
				// visual language. See updateHistoryTileState for the class itself.
				this.updateHistoryTileState(hEntry);
				if (located) {
					hEntry.destinationName = located.destinationName;
					hEntry.frozenKind = located.kind;
					hEntry.tileEl?.setAttribute("title", this.editElsewhereTitle(located.kind));
					this.buildHistoryLine2(
						hEntry,
						located.setCode,
						located.collectorNumber,
						located.rarity,
						located.destinationName
					);
				} else {
					// Should not happen (the card was indeed moved somewhere) — safety net
					// only, breaks nothing if one day it isn't.
					this.buildHistoryLine2(hEntry, hEntry.card.set, hEntry.card.collector_number, hEntry.card.rarity, hEntry.destinationName);
				}
				// Replaces the trash can with the non-clickable context badge ("In
				// Collection"/"In Decks"/"In Wantlists") — see buildHistoryTileTrailing
				// for why. After buildHistoryLine2 above (the order between the two
				// doesn't matter in itself, they are two distinct areas of the tile), to
				// stay grouped with the tile update rather than scattered.
				if (hEntry.tileEl) this.buildHistoryTileTrailing(hEntry, hEntry.tileEl);
			},
			"move"
		).open();
	}

	// Resolves the real name of a list/wantlist by id, regardless of this
	// modal's mode (fixed or listGallery) — unlike resolveDestinationName
	// above (designed for "which destination did THIS addition carry", not
	// "what is the current name of ANY listId"), needed here since a move can
	// send the card to a destination unrelated to this modal's original one.
	private resolveDestinationNameById(listId: string): string {
		if (this.sourceKind === "collection") {
			return this.plugin.settings.lists.find((l) => l.id === listId)?.name ?? "this destination";
		}
		if (this.sourceKind === "wantlist") {
			return this.plugin.settings.wantlists.find((l) => l.id === listId)?.name ?? "this destination";
		}
		return "this destination";
	}

	private buildHistoryTileTrailing(hEntry: HistoryEntry, tile: HTMLElement) {
		hEntry.trailingEl?.remove();
		if (hEntry.linksDisabled && hEntry.frozenKind) {
			const badge = tile.createDiv({ cls: "mtg-search-history-context-badge" });
			const iconName =
				hEntry.frozenKind === "collection" ? "layers" : hEntry.frozenKind === "deck" ? "swords" : "heart";
			const label =
				hEntry.frozenKind === "collection"
					? "In collection"
					: hEntry.frozenKind === "deck"
					? "In decks"
					: "In wantlists";
			setIcon(badge.createSpan({ cls: "mtg-search-history-context-badge-icon" }), iconName);
			badge.createSpan({ cls: "mtg-search-history-context-badge-label", text: label });
			hEntry.trailingEl = badge;
			return;
		}
		const deleteBtn = tile.createDiv({ cls: "mtg-search-history-delete-btn" });
		// "trash-2" (not "x") — explicitly requested, same icon as the plugin's
		// other delete actions (the "Delete" button of the bulk-actions bar,
		// "Remove from list" of the detail panel).
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttribute("title", "Remove from history");
		deleteBtn.addEventListener("click", () => this.deleteHistoryEntry(hEntry));
		hEntry.trailingEl = deleteBtn;
	}

	private updateHistoryTileQuantity(hEntry: HistoryEntry) {
		hEntry.quantityEl?.setText(`×${historyEntryTotalCount(hEntry)}`);
	}

	private updateHistoryTileState(hEntry: HistoryEntry) {
		hEntry.tileEl?.toggleClass("is-disabled", !hEntry.enabled);
		// is-frozen — explicitly requested, distinct from is-disabled (see the
		// comment of HistoryEntry.linksDisabled): set once and for all by
		// openMoveCardForEntry as soon as the card leaves the scope of this modal,
		// never removed afterwards (nothing can bring it back into that scope from
		// this same tile).
		hEntry.tileEl?.toggleClass("is-frozen", !!hEntry.linksDisabled);
		if (!hEntry.toggleBtn) return;
		hEntry.toggleBtn.checked = hEntry.enabled;
		// disabled once frozen — explicitly requested, same reasoning as the
		// replacement of the trash can by the context badge
		// (buildHistoryTileTrailing): toggleHistoryEntry would call
		// onUndoAdd/onAdd with hEntry.listId, deliberately left stale once
		// linksDisabled is set (see its comment) — the checkbox would therefore
		// stay clickable with nothing real behind it any more, exactly the same
		// trap as the trash can before its own fix. `disabled` (the native
		// attribute, not just removing a listener) blocks every click AND all
		// keyboard navigation at once, and the title is removed rather than set to
		// "" — an explicit title="" would mask the "Edit in My X" tooltip already
		// set on the tile itself (see openMoveCardForEntry) when hovering the
		// checkbox precisely, whereas removing the attribute lets that ancestor
		// tooltip bubble up normally.
		hEntry.toggleBtn.disabled = !!hEntry.linksDisabled;
		if (hEntry.linksDisabled) {
			hEntry.toggleBtn.removeAttribute("title");
		} else {
			hEntry.toggleBtn.setAttribute(
				"title",
				hEntry.enabled ? "Disable (undo this add)" : "Re-enable (redo this add)"
			);
		}
	}

	// Toggles enabled ↔ disabled — in both directions, the real card is
	// actually mutated (never a mere visual state), see onUndoAdd (undo) below
	// and onAdd (re-enabling, which replays each contribution exactly `count`
	// times with its own options). The last result (the resulting real row, or
	// undefined if deleted) resynchronizes the original carousel tile via
	// syncCallback — a reasonable approximation, not guaranteed exact, when a
	// single entry carries SEVERAL groups of contributions with different
	// options (see the comment of HistoryContribution): the current carousel
	// tile can only represent ONE row at a time anyway.
	private toggleHistoryEntry(hEntry: HistoryEntry) {
		if (!this.onUndoAdd) return;
		if (hEntry.enabled) {
			let lastRow: { id: string; count: number } | undefined;
			hEntry.contributions.forEach((c) => {
				lastRow = this.onUndoAdd!(hEntry.card, c.options, hEntry.listId, c.count);
			});
			hEntry.enabled = false;
			hEntry.syncCallback?.(lastRow);
		} else {
			let lastRow: { id: string; count: number; listId: string } | undefined;
			hEntry.contributions.forEach((c) => {
				for (let i = 0; i < c.count; i++) {
					const result = this.onAddCard(hEntry.card, c.options, hEntry.listId);
					if (result) lastRow = result;
				}
			});
			hEntry.enabled = true;
			hEntry.syncCallback?.(lastRow);
		}
		this.updateHistoryTileState(hEntry);
	}

	// Permanently deletes the tile — if the entry was still active, undoes it
	// first (same calls as a "disable", see toggleHistoryEntry); if it was
	// already disabled, the real data was already undone at the time of the
	// disable, nothing to redo here.
	private deleteHistoryEntry(hEntry: HistoryEntry) {
		if (this.onUndoAdd && hEntry.enabled) {
			let lastRow: { id: string; count: number } | undefined;
			hEntry.contributions.forEach((c) => {
				lastRow = this.onUndoAdd!(hEntry.card, c.options, hEntry.listId, c.count);
			});
			hEntry.syncCallback?.(lastRow);
		}
		hEntry.tileEl?.remove();
		this.historyEntries.delete(this.historyKey(hEntry.card.id, hEntry.listId));
		if (this.historyEntries.size === 0) this.historyEmptyEl?.toggleClass("is-hidden", false);
	}

	// "Add history" drawer — hides/shows the whole panel with a CSS slide
	// (width/padding/opacity animated, see
	// .mtg-search-history-panel.is-collapsed in styles.css) rather than a
	// simple display:none, so that bottomMainEl (flex: 1) visibly regains the
	// freed space instead of jumping instantly to its new size — explicitly
	// requested ("appears by sliding and pushes the content... like a
	// drawer"). is-history-collapsed on bottomSection also closes the gap
	// between the 2 columns, otherwise a residual void would remain visible on
	// the right once the panel is at width 0.
	private toggleHistoryDrawer() {
		this.historyCollapsed = !this.historyCollapsed;
		this.historyPanelEl?.toggleClass("is-collapsed", this.historyCollapsed);
	}

	// `index` (position in the displayed batch of results, not the card's id)
	// drives the entrance wave — see applyResultTileStaggerEntrance, which
	// caps itself at the first tiles actually visible in the carousel.
	// Optional: a call without index (none today, kept for future use outside
	// a "fresh batch of results") renders the tile directly visible, without a
	// wave.
	renderResult(card: ScryfallCard, index?: number) {
		const tile = renderScryfallResultTile(this.plugin, this.resultsEl, card, (tile) => {
			this.renderAddControl(tile, card);
		});
		if (index !== undefined) applyResultTileStaggerEntrance(tile, index);
	}

	// "Add" area of a result tile — a simple button at the start, which turns
	// into a +/quantity/- stepper once the card has actually been added
	// somewhere (onAddCard returned an entry AND onChangeQuantity is supplied
	// — see AddCardsModalOptions). The container is rebuilt in place (empty()
	// + rebuild) rather than replaced by a new element, so as not to disturb
	// the layout of the tile around it.
	private renderAddControl(tile: HTMLElement, card: ScryfallCard) {
		const container = tile.createDiv({ cls: "mtg-result-card-add-control" });
		// Entry already added this session, if any — the object returned by
		// addCardToCollection/addCardToWantlist is the same reference as the one mutated in
		// place by changeCollectionCardCount/changeWantlistCardCount, so its .count stays up
		// to date by itself after every +/- click.
		let entry: { id: string; count: number } | undefined;
		// Options/destination of the very first successful addition of this tile —
		// frozen once and for all (reported bug: the history stayed stuck at "×1"
		// even after several +/- clicks, because only THAT very first addition
		// went through recordHistoryAdd; the +/- stepper calls onChangeQuantity
		// directly, never onAdd). Do NOT re-read computeAddOptions() at the time
		// of a +/- click: its options are constant today, but freezing those of
		// the very first addition remains the right defense if a future selector
		// shared by the whole modal (like the former Finish select of the Wantlist
		// flow) reappeared — such a selector might have changed in the meantime
		// for ANOTHER card, which would then no longer be the options actually
		// used for THIS tile.
		let historyOptions: AddCardOptions | undefined;
		let historyListId: string | undefined;

		// The whole tile becomes clickable once the card is added — explicitly
		// requested — and opens its detail window (onOpenDetail, supplied by the
		// call site that knows which one to build — see its own comment in
		// shared-search-ui.ts). The handler itself is set only once here (not in
		// buildStepper, called every time the card is added from this tile); it
		// reads `entry`/`this.onOpenDetail` at click time, so it has nothing to do
		// as long as either is missing. The +/- and "Add" buttons themselves
		// (children of tile) stop the propagation of their own click (see below)
		// so as never to trigger this handler too.
		// syncFromHistory (defined further down, referenced here by closure like
		// buildAddButton/applyDelta elsewhere in this same function) is passed as
		// is as the "the detail window has just closed" callback — fixed bug:
		// changing the quantity or deleting the card from this detail window, then
		// coming back here, never resynchronized this tile. The call site
		// (view.ts) must call it back with the up-to-date real row once the window
		// has closed; syncFromHistory already knows how to do exactly that
		// (rebuild the stepper, or go back to "Add" if the row has disappeared) —
		// same mechanism as the "Add history" panel, just triggered by another
		// event.
		tile.addEventListener("click", () => {
			if (!entry || !this.onOpenDetail) return;
			this.onOpenDetail(entry.id, syncFromHistory);
		});

		const buildStepper = () => {
			if (!entry) return;
			container.empty();
			// mtg-result-card-tile-clickable: cursor + highlight on hover (see
			// styles.css) — only if onOpenDetail is actually supplied, otherwise the
			// tile would stay visually "clickable" for a click that does nothing.
			tile.toggleClass("mtg-result-card-tile-clickable", !!this.onOpenDetail);
			const stepper = container.createDiv({
				cls: "mtg-stepper mtg-stepper-horizontal mtg-result-card-stepper",
			});
			const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
			const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
			setIcon(downBtn, "minus");
			downBtn.toggleClass("is-disabled", entry.count <= 1);
			const valueEl = controls.createDiv({ cls: "mtg-stepper-value", text: String(entry.count) });
			const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
			setIcon(upBtn, "plus");

			const applyDelta = (delta: number) => {
				if (!entry || !this.onChangeQuantity) return;
				this.onChangeQuantity(entry.id, delta, () => {
					valueEl.setText(String(entry!.count));
					downBtn.toggleClass("is-disabled", entry!.count <= 1);
				});
				// The +/- stepper also changes the quantity actually added this session —
				// the history must follow (see the comment of historyOptions/historyListId
				// above for the bug this fixes). "+1" reuses recordHistoryAdd as is (same
				// logic as a new addition — creates the entry if needed, increments
				// otherwise); "-1" has its own symmetric logic, see
				// decrementHistoryQuantity.
				if (this.onUndoAdd && historyOptions && historyListId) {
					if (delta > 0) {
						this.recordHistoryAdd(card, historyOptions, historyListId, syncFromHistory);
					} else {
						this.decrementHistoryQuantity(card, historyOptions, historyListId);
					}
				}
			};
			// stopPropagation: these two buttons live inside tile, which now listens
			// to its own click (see above) — without it, adjusting the quantity would
			// also open the detail window on every +/- click.
			downBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				applyDelta(-1);
			});
			upBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				applyDelta(1);
			});
		};

		// Receives the resulting row of a history toggle (see
		// toggleHistoryEntry/deleteHistoryEntry) to resynchronize THIS carousel
		// tile on the real state — undefined means "the row no longer exists", in
		// which case the tile goes back to a simple "Add" button rather than
		// keeping a stepper showing a stale quantity. Only has an effect if THIS
		// tile is indeed the one concerned (see its call, further down, filtered
		// by card.id + listId).
		const syncFromHistory = (row: { id: string; count: number } | undefined) => {
			if (row) {
				entry = row;
				buildStepper();
			} else {
				entry = undefined;
				container.empty();
				tile.removeClass("mtg-result-card-tile-clickable");
				buildAddButton();
			}
		};

		const handleAdded = (result: { id: string; count: number; listId: string } | void, options: AddCardOptions) => {
			// No usable entry (a possible future caller without onChangeQuantity — the
			// 3 current flows, Collection/Wantlist/Deck, all supply it since the Deck
			// flow was made uniform): the "Add" button stays as is, clickable again to
			// add one more copy, as before.
			if (!result || !this.onChangeQuantity) return;
			entry = result;
			buildStepper();
			if (this.onUndoAdd) {
				historyOptions = options;
				historyListId = result.listId;
				this.recordHistoryAdd(card, options, result.listId, syncFromHistory);
			}
		};

		// Core of the addition, shared by the individual click on "Add" AND by
		// "Add all" (performAddAll, via currentResultControls) — a single code
		// path for both, not two adding logics to keep in sync. `listId` comes
		// either from the per-card picker (individual click, listGallery flow), or
		// from the single picker opened once for the whole batch (Add all,
		// listGallery flow). `silent` turns off the individual Notice during Add
		// all, which shows a single summary at the end rather than stacking one
		// notification per card.
		const addOne = (listId?: string, silent = false) => {
			const options = this.computeAddOptions();
			const result = this.onAddCard(card, options, listId);
			if (!silent) {
				new Notice(
					options.finish === "regular"
						? `Added: ${card.name}`
						: `Added (${getFinishLabel(options.finish)}): ${card.name}`
				);
			}
			handleAdded(result, options);
		};

		// Factored out (called at the initial construction AND by syncFromHistory,
		// see above, when a history "undo" brings this tile back to zero) rather
		// than two copies of the same button to maintain in parallel.
		const buildAddButton = () => {
			const addBtn = container.createEl("button", {
				cls: "mtg-result-card-add-btn",
				text: "Add",
			});
			// stopPropagation: see the comment of the click on tile above — by the
			// time this event bubbles up to tile, handleAdded may already have set
			// `entry` and rebuilt the stepper (it all happens synchronously in this
			// same handler before the bubbling resumes), so without stopPropagation,
			// clicking "Add" would immediately open the detail window instead of
			// simply adding the card.
			addBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				// defaultListId (Inbox): direct addition, without opening the picker — see
				// AddCardsModalOptions.listGallery.defaultListId. The picker remains the
				// behavior when no default is supplied (Wantlist flow, or defensively if
				// Inbox doesn't exist).
				if (this.listGallery?.defaultListId) {
					addOne(this.listGallery.defaultListId);
					return;
				}
				if (this.listGallery) {
					new SelectListModal(
						this.app,
						this.plugin,
						this.listGallery.summaries,
						card.name,
						this.listGallery.kind,
						(listId) => addOne(listId)
					).open();
					return;
				}
				addOne();
			});
		};
		buildAddButton();

		this.currentResultControls.push({ card, addOne });
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/* Add all confirmation (separate window, explicitly requested — see */
/* showAddAllConfirm above, replaces the former inline message) */
/* -------------------------------------------------------------------------- */

// Small dedicated window, rather than an inline message under the search
// bar (as before) — explicitly requested. Same styling as the plugin's
// other small confirmation modals (mtg-list-actions-modal, shared
// open/close animation) rather than a native window.confirm(), never used
// anywhere in this plugin.
class AddAllConfirmModal extends Modal {
	// showWarning: above ADD_ALL_WARNING_THRESHOLD (see showAddAllConfirm) —
	// an extra paragraph warns that the operation may take a while (Scryfall
	// auto-pagination, one paced network round trip per page) and that
	// Obsidian may seem frozen during that time, rather than the usual simple
	// confirmation.
	constructor(app: App, private count: number, private showWarning: boolean, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		applyModalOpenAnimation(this);
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-list-actions-modal");
		contentEl.createEl("h2", { text: "Add all cards?" });
		contentEl.createEl("p", {
			text: `Are you sure you want to add all ${this.count} card${
				this.count === 1 ? "" : "s"
			} from this search?`,
		});
		if (this.showWarning) {
			contentEl.createEl("p", {
				cls: "mtg-add-all-warning",
				text: "This is a large batch — Scryfall will be fetched page by page, which can take a while, and Obsidian may be unresponsive while it runs.",
			});
		}
		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const confirmBtn = actions.createEl("button", { cls: "mtg-search-add-btn", text: "Yes, add all" });
		confirmBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
		// Neutral button, with no particular class — same default style as the
		// "Cancel" of ChangePrintingModal (.mtg-card-detail-actions button).
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/*  Select list modal (step 2 of adding a card from "All Cards" : confirm    */
/*  which list to put it in, with nothing pre-selected)                      */
/* -------------------------------------------------------------------------- */

// Takes over the visual styling of CopyCardModal ("Move card") identically —
// same gallery/tile CSS classes (zoom on hover, overlay, wave entrance),
// same search bar, same "+ New X" tile, same click-directly-adds (no
// separate "Add" button to click after selecting) — explicitly requested so
// that the two modals look alike in every respect, only the title differs.
// No Collection/Decks/Wantlists tabs like CopyCardModal: this modal only
// intervenes once the destination is already fixed by the caller (adding to
// a list or to a wantlist, never both at once), so a single gallery is
// enough — `kind` only serves to choose the right label/the right creation
// modal, not a tab.
export class SelectListModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private summaries: (ListGroup | WantlistGroup)[];
	private cardName: string;
	private kind: "list" | "wantlist";
	private onConfirm: (listId: string) => void;
	private galleryEl!: HTMLElement;
	private searchQuery = "";
	private searchInputEl!: HTMLInputElement;
	// Same convention as CopyCardModal.tileStaggerIndex: staggers the
	// appearance of the first 8 tiles on opening, never while typing in the
	// search (see renderGallery/revealTile).
	private tileStaggerIndex = 0;
	// true for the grouped "Add all" call (performAddAll, add-cards-modal.ts):
	// cardName is already "N cards" there, so surrounding it with quotes as
	// for a single card name ("Add "N cards" to") would read badly — plain
	// just removes the quotes from the title, nothing else changes.
	private plain: boolean;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		summaries: (ListGroup | WantlistGroup)[],
		cardName: string,
		kind: "list" | "wantlist",
		onConfirm: (listId: string) => void,
		plain = false
	) {
		super(app);
		this.plugin = plugin;
		this.summaries = summaries;
		this.cardName = cardName;
		this.kind = kind;
		this.onConfirm = onConfirm;
		this.plain = plain;
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		// Same classes as CopyCardModal (no mtg-search-modal class here, which
		// carries the styling of the card search itself, not of this
		// destination-selection step).
		contentEl.addClass("mtg-copy-card-modal");
		contentEl.addClass("mtg-list-actions-modal");
		contentEl.createEl("h2", { text: this.plain ? `Add ${this.cardName} to` : `Add "${this.cardName}" to` });

		const searchWrap = contentEl.createDiv({ cls: "mtg-copy-card-search" });
		this.searchInputEl = searchWrap.createEl("input", {
			cls: "mtg-copy-card-search-input",
			type: "text",
		});
		this.searchInputEl.setAttribute(
			"placeholder",
			this.kind === "wantlist" ? "Search wantlists…" : "Search lists…"
		);
		// Only rebuilds the gallery on each keystroke, never this <input> itself —
		// same reasoning (focus loss while typing) as CopyCardModal.searchInputEl.
		this.searchInputEl.addEventListener("input", () => {
			this.searchQuery = this.searchInputEl.value;
			this.renderGallery();
		});

		this.galleryEl = contentEl.createDiv({ cls: "mtg-copy-card-gallery" });
		this.renderGallery(true);
	}

	private matchesSearch(name: string): boolean {
		const query = this.searchQuery.trim().toLowerCase();
		return !query || name.toLowerCase().includes(query);
	}

	private revealTile(tile: HTMLElement, stagger: boolean) {
		if (!stagger) {
			tile.addClass("is-visible");
			return;
		}
		const delay = Math.min(this.tileStaggerIndex, 8) * 40;
		this.tileStaggerIndex++;
		window.setTimeout(() => tile.addClass("is-visible"), delay);
	}

	private renderGallery(stagger = false) {
		this.galleryEl.empty();
		this.tileStaggerIndex = 0;

		const newTile = this.galleryEl.createDiv({
			cls: "mtg-copy-card-gallery-tile mtg-copy-card-gallery-tile-new",
		});
		newTile.createDiv({
			cls: "mtg-copy-card-gallery-name",
			text: this.kind === "wantlist" ? "+ New wantlist" : "+ New list",
		});
		// The "+ New X" tile always stays displayed, never filtered by the search
		// — same convention as CopyCardModal.renderNewTile: the search serves to
		// find an existing destination faster, not to hide the creation option.
		newTile.addEventListener("click", () => {
			if (this.kind === "wantlist") {
				new NewWantlistModal(this.app, this.plugin, (wantlist) => this.confirm(wantlist.id)).open();
			} else {
				new NewListModal(this.app, this.plugin, (list) => this.confirm(list.id)).open();
			}
		});
		this.revealTile(newTile, stagger);

		this.summaries
			.filter((s) => this.matchesSearch(s.name))
			.forEach((summary) => {
				const tile = this.galleryEl.createDiv({ cls: "mtg-copy-card-gallery-tile" });
				const bg = tile.createDiv({ cls: "mtg-copy-card-gallery-tile-bg" });
				if (summary.coverImage) bg.style.backgroundImage = `url("${summary.coverImage}")`;
				const overlay = tile.createDiv({ cls: "mtg-copy-card-gallery-overlay" });
				overlay.createDiv({ cls: "mtg-copy-card-gallery-name", text: summary.name });
				overlay.createDiv({ cls: "mtg-copy-card-gallery-meta", text: `${summary.totalQty} cards` });
				tile.addEventListener("click", () => this.confirm(summary.id));
				this.revealTile(tile, stagger);
			});
	}

	// A click on a tile adds directly, like CopyCardModal — no intermediate
	// selection followed by a separate "Add" button.
	private confirm(id: string) {
		this.onConfirm(id);
		this.close();
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
