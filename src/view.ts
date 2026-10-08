import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type MTGCollectionPlugin from "./plugin";
import {
	CollectionCard,
	WantlistCard,
} from "./core/card-model";
import {
	CardViewMode,
	GroupByOption,
	SortByOption,
	CardGroup,
	RENDER_BATCH_SIZE,
} from "./core/card-sorting";
import {
	DeckCard,
	DeckBoardTab,
	VIEW_TYPE_MTG_COLLECTION,
} from "./core/data-model";
import { NewDeckModal, NewListModal, NewWantlistModal } from "./modals/new-entity-modals";
import * as sharedRenderHelpers from "./view/shared-render-helpers";
import * as filterChips from "./view/filter-chips";
import * as groupSortBar from "./view/group-sort-bar";
import * as groupCollapse from "./view/group-collapse";
import * as cardThumbnails from "./view/card-thumbnails";
import * as downloads from "./view/downloads";
import * as homeRender from "./view/home-render";
import * as collectionRender from "./view/collection-render";
import * as deckRender from "./view/deck-render";
import * as wantlistRender from "./view/wantlist-render";
import * as mobileBars from "./view/mobile-bars";

export class MTGCollectionView extends ItemView {
	plugin: MTGCollectionPlugin;
	mainEl!: HTMLElement;
	backToTopBtn!: HTMLElement;
	bodyEl!: HTMLElement;
	collectionHeaderEl!: HTMLElement;
	headerTitleEl!: HTMLElement;
	headerStatsEl!: HTMLElement;
	// Pinned "Inbox"/"All Cards" row of the My Collection grid — see its
	// comment at creation (onOpen) and renderListGrid.
	collectionPinnedEl!: HTMLElement;
	collectionToolbarEl!: HTMLElement;
	decksToolbarEl!: HTMLElement;
	wantlistsToolbarEl!: HTMLElement;
	newListBtn!: HTMLElement;
	newDeckBtn!: HTMLElement;
	newWantlistBtn!: HTMLElement;
	listGallerySelectBtn!: HTMLElement;
	deckGallerySelectBtn!: HTMLElement;
	wantlistGallerySelectBtn!: HTMLElement;
	filterEl!: HTMLInputElement;
	deckFilterEl!: HTMLInputElement;
	wantlistFilterEl!: HTMLInputElement;
	navHomeBtn!: HTMLElement;
	navCollectionBtn!: HTMLElement;
	navDecksBtn!: HTMLElement;
	navWantlistsBtn!: HTMLElement;
	navEl!: HTMLElement;
	navIndicatorEl!: HTMLElement;
	private navIndicatorPlaced = false;

	// Places the capsule on the active item. Without a transition on the very first placement (and when
	// the nav is hidden, offsetWidth = 0) so that it doesn't arrive sliding in from the corner of the
	// pill.
	updateNavIndicator(animate = true) {
		const active = this.navEl?.querySelector<HTMLElement>(".mtg-nav-item.is-active");
		if (!active || !this.navIndicatorEl || active.offsetWidth === 0) {
			this.navIndicatorPlaced = false;
			return;
		}
		const el = this.navIndicatorEl;
		el.toggleClass("is-instant", !animate || !this.navIndicatorPlaced);
		// getBoundingClientRect (not offsetLeft/Width, rounded to the integer): the capsule stays aligned
		// to the sub-pixel with the item.
		const a = active.getBoundingClientRect();
		const n = this.navEl.getBoundingClientRect();
		el.style.width = `${a.width}px`;
		el.style.height = `${a.height}px`;
		el.style.transform = `translate(${a.left - n.left}px, ${a.top - n.top}px)`;
		this.navIndicatorPlaced = true;
	}
	// Floating preview on hovering a card's name in Table mode — see
	// showCardNamePreview/hideCardNamePreview and the comment on
	// .mtg-card-name-preview (styles.css) for the full reasoning.
	cardNamePreviewEl!: HTMLElement;
	cardNamePreviewImgEl!: HTMLImageElement;

	activeSection: "home" | "collection" | "decks" | "wantlists" = "home";
	// "Show more" of Home's Market Trends block (2026-09-23, top 5 → top 20,
	// see renderHomeMarketTrends): on the VIEW rather than in a local variable
	// of the closure as period/vendor were (those are now in the settings, see
	// MTGCollectionSettings.homeMoversPeriod) — Home is rebuilt in full on
	// every render() (view opened/closed, modal that modifies data...), and an
	// expanded list that collapses by itself because of an unrelated re-render
	// would be annoying. Not persisted to disk: expanding is a session choice,
	// not a preference.
	homeMoversExpanded = false;
	// Unsubscription of Home's GitHub status line (only one at a time: each render of Home replaces the previous one).
	homeSyncUnsub: (() => void) | null = null;
	openListId: string | null = null;
	openDeckId: string | null = null;
	openWantlistId: string | null = null;
	// Identifies "where" we are (section + open list/deck/wantlist) at the
	// last render(): used to NOT keep a view's scroll position when we change
	// view.
	lastRenderedViewKey: string | null = null;

	// Number of rows currently rendered in each list (see RENDER_BATCH_SIZE):
	// reset to the starting value on every change of context (opening another
	// list, filter, sort, grouping...) so as never to start again from a limit
	// already enlarged by a previous scrolling session.
	listRenderLimit = RENDER_BATCH_SIZE;
	deckRenderLimit = RENDER_BATCH_SIZE;
	wantlistRenderLimit = RENDER_BATCH_SIZE;
	// "Signature" of the context displayed last time (open list, filter, sort,
	// grouping, display mode): compared on every render to detect a change of
	// context and reset the render limit to zero, without having to instrument
	// each possible trigger individually (typing in the filter, click on
	// sort/group...).
	// "Load more" via scrolling changes none of these elements — the already
	// enlarged limit therefore correctly survives the re-render it triggers.
	lastListRenderSignature: string | null = null;
	lastDeckRenderSignature: string | null = null;
	lastWantlistRenderSignature: string | null = null;

	// Cache of the result of groupAndSortCards (sort + grouping), expensive to
	// redo on a large collection: a "load more" on scroll changes neither the
	// filter, nor the sort, nor the grouping, nor the data itself
	// (this.plugin.dataVersion), so nothing justifies recomputing — only
	// sliceGroupsForRender must redo its work, with a new limit. The signature
	// here includes dataVersion (unlike lastXRenderSignature above, which only
	// serves to reset the display limit): a mutation elsewhere (changing a
	// quantity...) must invalidate this cache without reducing what is already
	// displayed.
	cachedListCardGroups: CardGroup<CollectionCard>[] | null = null;
	lastListDataSignature: string | null = null;
	cachedDeckCardGroups: CardGroup<DeckCard>[] | null = null;
	lastDeckDataSignature: string | null = null;
	cachedWantlistCardGroups: CardGroup<WantlistCard>[] | null = null;
	lastWantlistDataSignature: string | null = null;

	// Cache of the DOM elements of each card row (content of .mtg-card-row, not its
	// .mtg-card-row-outer — the latter is always rebuilt from scratch, see
	// renderListDetail, because it carries the group collapse state manipulated
	// directly by toggleGroupRows). render() rebuilds the whole body on every
	// interaction (typing in the filter, ticked checkbox...) even when the vast
	// majority of the rows already loaded have not changed — on a collection of
	// 10,000 cards after a deep scroll, redoing this work (async icons,
	// listeners...) for hundreds/thousands of identical rows on every keystroke
	// becomes noticeable. A row is reused as is if its "signature" (see
	// collectionCardRowSignature) has not changed since the last render; otherwise
	// rebuilt and the cache updated. Purged at the end of the render of entries that
	// no longer match the current filter, so as not to grow without bound over a
	// session with many different filters.
	cachedListRowElements: Map<string, { signature: string; el: HTMLElement }> = new Map();
	// Always up to date at click time (unlike a local variable captured by the
	// closure of the click handler of a row reused from a previous render,
	// which would then reference a stale navOrder — see
	// buildCollectionCardRow).
	navOrderForListClick: CollectionCard[] = [];
	// Same principle as cachedListRowElements/navOrderForListClick, for Decks and
	// Wantlists. Composite key deckId:scryfallId (not just scryfallId) for Decks:
	// the same card can appear in several distinct decks, with an owned/quantity
	// status of its own.
	cachedDeckRowElements: Map<string, { signature: string; el: HTMLElement }> = new Map();
	navOrderForDeckClick: DeckCard[] = [];
	cachedWantlistRowElements: Map<string, { signature: string; el: HTMLElement }> = new Map();
	navOrderForWantlistClick: WantlistCard[] = [];

	listGroupBy: GroupByOption = "none";
	listSortBy: SortByOption = "name";
	sortReverse = false;
	groupReverse = false;
	listViewMode: CardViewMode = "list";

	deckGroupBy: GroupByOption = "none";
	deckSortBy: SortByOption = "name";
	deckSortReverse = false;
	deckGroupReverse = false;
	deckViewMode: CardViewMode = "list";
	// Active "board" tab above a deck's card list (see renderDeckBoardTabs,
	// src/view/deck-render.ts) — global like the rest of My Decks' display state
	// above, not specific to a particular deck.
	deckActiveBoard: DeckBoardTab = "mainboard";
	// Id of the card being dragged in the Stacks view (renderDeckStacksView,
	// src/view/deck-render.ts, 2026-09-12) — read directly from this field
	// rather than via dataTransfer.getData() during "dragover": the HTML5
	// drag-and-drop standard only exposes the real transported value in the
	// "drop" handler itself (standard security restriction, not a bug), so an
	// instance field is the only reliable way to know, while hovering over a
	// pile, which card is being dropped.
	draggingDeckStackCardId: string | null = null;

	wantlistGroupBy: GroupByOption = "none";
	wantlistSortBy: SortByOption = "name";
	wantlistSortReverse = false;
	wantlistGroupReverse = false;
	wantlistViewMode: CardViewMode = "list";

	listCardFilterTokens: string[] = [];
	listCardFilterDraft = "";
	deckCardFilterTokens: string[] = [];
	deckCardFilterDraft = "";
	wantlistCardFilterTokens: string[] = [];
	wantlistCardFilterDraft = "";
	lastFocusedFilterKey: string | null = null;
	lastFocusedFilterCursor: number | null = null;
	// Set by renderChipFilter (built off-DOM, before render()'s atomic swap)
	// and executed by render() right after the swap, in the same synchronous
	// pass — restoring focus via setTimeout() left a brief window with no
	// element focused (the old one has just been detached, the new one is not
	// yet): a keystroke landing right in that window was lost, which gave the
	// impression of "sometimes" no longer being able to type at all.
	pendingFocusRestore: (() => void) | null = null;
	// Debounce of the render() triggered by typing in a text filter: the
	// filtering runs on the ENTIRE list/deck/wantlist (not only the portion
	// currently displayed), and render() rebuilds all the DOM loaded so far —
	// on a collection of 10,000 cards, calling that on every key pressed
	// becomes noticeable. Only delays render() itself: onDraftChange() stays
	// synchronous (immediate state update, cheap), so typing then validating
	// right away (Enter, space) always sees the last character typed. The
	// input itself is never unmounted during the delay (no DOM rebuilt until
	// the timer fires), so no risk of losing focus in the middle of a
	// keystroke — unlike a debounce that would have applied to the focus
	// restoration itself (see pendingFocusRestore above).
	filterRenderDebounceTimer: number | null = null;
	suggestionHighlightIndex = -1;
	listCollapsedGroups: Set<string> = new Set();
	lastRenderedListGroupLabels: string[] = [];
	deckCollapsedGroups: Set<string> = new Set();
	lastRenderedDeckGroupLabels: string[] = [];
	wantlistCollapsedGroups: Set<string> = new Set();
	lastRenderedWantlistGroupLabels: string[] = [];

	selectedListCardIds: Set<string> = new Set();
	listSelectMode = false;
	selectedDeckCardIds: Set<string> = new Set();
	deckSelectMode = false;
	selectedWantlistCardIds: Set<string> = new Set();
	wantlistSelectMode = false;
	listBulkBarWasVisible = false;
	deckBulkBarWasVisible = false;
	wantlistBulkBarWasVisible = false;
	// Scroll position of the Select mode actions bar, PER bar type (key = `kind` of
	// createBulkActionsBar: "list-cards", "deck-gallery"…). The bar is rebuilt on every
	// render(); without this, every selection tap or applied action would bring it back to the
	// left. One key per bar and not a single field: a section's Select mode can stay active
	// while we visit another, and its bar (which therefore does not start from 0, `animate`
	// being false) would then inherit the position of an unrelated bar.
	bulkBarScrollLeft: Map<string, number> = new Map();

	// "Gallery" selection mode — one notch above
	// selectMode/deckSelectMode/wantlistSelectMode above: those select CARDS
	// inside an already open list/deck/wantlist, this one selects whole
	// LISTS/DECKS/WANTLISTS from the overview grid (before opening). Totally
	// independent states — the two can coexist without conflict since they are
	// never active in the same place on the screen (the grid never displays
	// the "+ Add cards"/card-select buttons of an open list, and vice versa).
	listGallerySelectMode = false;
	selectedListIds: Set<string> = new Set();
	deckGallerySelectMode = false;
	selectedDeckIds: Set<string> = new Set();
	wantlistGallerySelectMode = false;
	selectedWantlistIds: Set<string> = new Set();
	listGalleryBulkBarWasVisible = false;
	deckGalleryBulkBarWasVisible = false;
	wantlistGalleryBulkBarWasVisible = false;
	// Fields moved from the methods area during the Phase 5b split (2026-09-10) -- they remain real
	// instance fields, just relocated here to stay grouped with the others.
	tableFadeTimeouts = new WeakMap<HTMLElement, number>();
	groupCollapseTimeouts = new WeakMap<HTMLElement, number>();

	constructor(leaf: WorkspaceLeaf, plugin: MTGCollectionPlugin) {
		super(leaf);
		this.plugin = plugin;
	}


	getViewType() {
		return VIEW_TYPE_MTG_COLLECTION;
	}


	getDisplayText() {
		return "MTG Collection";
	}


	getIcon() {
		return "library";
	}


	applyAccentColor() {
		if (this.plugin.settings.accentColor) {
			this.containerEl.style.setProperty("--mtg-accent", this.plugin.settings.accentColor);
		} else {
			this.containerEl.style.removeProperty("--mtg-accent");
		}
	}


	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("mtg-collection-view");
		this.applyAccentColor();

		this.listGroupBy = this.plugin.settings.collectionGroupBy;
		this.listSortBy = this.plugin.settings.collectionSortBy;
		this.sortReverse = this.plugin.settings.collectionSortReverse;
		this.groupReverse = this.plugin.settings.collectionGroupReverse;
		this.listViewMode = this.plugin.settings.collectionViewMode;
		// "category" (never written out literally anywhere, `as GroupByOption` to
		// compare it anyway): old value persisted by a session prior to that same
		// 2026-09-07 (removed from GroupByOption, see card-sorting.ts) — folded
		// back to "none" at load rather than left as is, which would display a
		// "Group by " with no label and group everything under an empty label
		// (default: return "" in groupSortValue/groupLabelFor). A normal user
		// choice can no longer ever produce this value, so this fallback
		// concretely only runs once per vault.
		const loadedDeckGroupBy = this.plugin.settings.deckGroupBy;
		this.deckGroupBy = (loadedDeckGroupBy as GroupByOption | "category") === "category" ? "none" : loadedDeckGroupBy;
		this.deckSortBy = this.plugin.settings.deckSortBy;
		this.deckSortReverse = this.plugin.settings.deckSortReverse;
		this.deckGroupReverse = this.plugin.settings.deckGroupReverse;
		this.deckViewMode = this.plugin.settings.deckViewMode;
		this.deckActiveBoard = this.plugin.settings.deckActiveBoard;
		this.wantlistGroupBy = this.plugin.settings.wantlistGroupBy;
		this.wantlistSortBy = this.plugin.settings.wantlistSortBy;
		this.wantlistSortReverse = this.plugin.settings.wantlistSortReverse;
		this.wantlistGroupReverse = this.plugin.settings.wantlistGroupReverse;
		this.wantlistViewMode = this.plugin.settings.wantlistViewMode;

		const layout = container.createDiv({ cls: "mtg-layout" });

		/* ---- Side nav ---- */
		const nav = layout.createDiv({ cls: "mtg-nav" });
		this.navEl = nav;
		if (this.plugin.settings.navCollapsed) nav.addClass("is-collapsed");

		const toggleRow = nav.createDiv({ cls: "mtg-nav-toggle-row" });
		const toggleBtn = toggleRow.createDiv({ cls: "mtg-nav-toggle" });
		const renderToggleIcon = () =>
			setIcon(
				toggleBtn,
				this.plugin.settings.navCollapsed ? "panel-left-open" : "panel-left-close"
			);
		renderToggleIcon();
		toggleBtn.setAttribute("title", "Collapse/expand menu");
		const toggleNav = async () => {
			this.plugin.settings.navCollapsed = !this.plugin.settings.navCollapsed;
			nav.toggleClass("is-collapsed", this.plugin.settings.navCollapsed);
			renderToggleIcon();
			await this.plugin.saveSettings();
		};
		toggleBtn.addEventListener("click", () => void toggleNav());

		// Capsule that slides behind the active item (phone only, hidden elsewhere in CSS): a single
		// element moved via left/width rather than a background per item, otherwise nothing to animate
		// between two items.
		this.navIndicatorEl = nav.createDiv({ cls: "mtg-nav-indicator" });
		new ResizeObserver(() => this.updateNavIndicator(false)).observe(nav);

		const makeNavItem = (icon: string, label: string) => {
			const item = nav.createDiv({ cls: "mtg-nav-item" });
			item.setAttribute("title", label);
			const iconEl = item.createSpan({ cls: "mtg-nav-icon" });
			setIcon(iconEl, icon);
			item.createSpan({ cls: "mtg-nav-label", text: label });
			return item;
		};

		this.navHomeBtn = makeNavItem("home", "Home");
		this.navHomeBtn.addEventListener("click", () => {
			this.activeSection = "home";
			this.render();
		});

		this.navCollectionBtn = makeNavItem("layers", "Collection");
		this.navCollectionBtn.addEventListener("click", () => {
			this.activeSection = "collection";
			this.render();
		});

		this.navDecksBtn = makeNavItem("swords", "Decks");
		this.navDecksBtn.addEventListener("click", () => {
			this.activeSection = "decks";
			this.render();
		});

		this.navWantlistsBtn = makeNavItem("heart", "Wantlists");
		this.navWantlistsBtn.addEventListener("click", () => {
			this.activeSection = "wantlists";
			this.render();
		});

		nav.createDiv({ cls: "mtg-nav-divider" });

		// mtg-nav-item-settings: dedicated class (in addition to mtg-nav-item) so that .is-phone
		// .mtg-nav can hide THIS particular button without touching the other 4 — see styles.css.
		const navSettings = makeNavItem("settings", "Settings");
		navSettings.addClass("mtg-nav-item-settings");
		navSettings.addEventListener("click", () => this.openPluginSettings());

		// Obsidian's bars on phone (the floating bar at the bottom and the .view-header at the top): hidden
		// as long as this view is active AND settings.hideObsidianMobileBars is true — see
		// src/view/mobile-bars.ts and the "Hide Obsidian's mobile bars" setting (Interface, setting-tab.ts).
		// No dedicated button in the rail since 2026-09-27 (see mobile-bars.ts): the menu's floating pill on
		// phone only has room for the 5 items above.
		this.setupMobileBars();

		/* ---- Main area ---- */
		const main = layout.createDiv({ cls: "mtg-main" });
		this.mainEl = main;

		// Child of layout (not of main): main scrolls internally
		// (overflow-y:auto), so a position:absolute placed INSIDE it would be
		// positioned relative to the whole scrollable height of the content, not
		// relative to the visible area — the button would end up out of view
		// depending on the scroll position instead of staying fixed in the corner.
		// layout, for its part, never scrolls (only main scrolls within it, see
		// .mtg-layout/.mtg-main in styles.css), so a child positioned absolutely
		// relative to layout (position:relative) stays visually fixed in the
		// corner whatever the scroll position of main.
		this.backToTopBtn = layout.createDiv({ cls: "mtg-back-to-top-btn" });
		setIcon(this.backToTopBtn, "arrow-up");
		this.backToTopBtn.setAttribute("title", "Back to top");
		// getActiveScrollEl() rather than main directly: since the addition of .mtg-detail-scroll-area
		// (see its own comment in styles.css and handleScrollAreaScroll,
		// src/view/shared-render-helpers.ts), it is THIS area that actually scrolls once a
		// list/deck/wantlist is open, not main itself — resolved at click time, not at registration
		// time (fixed, the latter would never see the right area once the mode has changed).
		this.backToTopBtn.addEventListener("click", () => {
			this.getActiveScrollEl().scrollTo({ top: 0, behavior: "smooth" });
		});
		// A single listener for the whole lifetime of the view — main is a
		// persistent element (never destroyed/rebuilt, unlike this.bodyEl further
		// down), so no need to attach it on every render(). Generic (any
		// section/view), not only a list's detail — a grid with many rows can just
		// as well justify this shortcut. The card name preview (Table mode) takes
		// advantage of the same listener rather than adding a second one: its
		// position is computed once on opening (see showCardNamePreview) and does
		// not follow scrolling, so hiding it here avoids it staying frozen above a
		// row that has moved under it. Never does anything while a detail view is
		// open: main itself then never overflows (see .mtg-collection-body-detail)
		// — handleScrollAreaScroll covers this case separately, attached to
		// .mtg-detail-scroll-area on every render().
		main.addEventListener("scroll", () => this.handleScrollAreaScroll(main));
		// Same reasoning for the Card view's responsive radius — see
		// setupCardTileRadiusObserver.
		this.setupCardTileRadiusObserver();
		// Same reasoning again, for the split into tracks of the Stacks view (My
		// Decks) — see setupDeckStacksLayoutObserver, src/view/deck-render.ts.
		this.setupDeckStacksLayoutObserver();

		// Single persistent element (never recreated) — see the comment on
		// .mtg-card-name-preview (styles.css) for the full reasoning
		// (position:fixed, added to document.body rather than to an ancestor
		// within the plugin, same precedent as .mtg-picker-menu/openPickerMenu).
		this.cardNamePreviewEl = document.body.createDiv({ cls: "mtg-card-name-preview" });
		this.cardNamePreviewImgEl = this.cardNamePreviewEl.createEl("img");

		const header = main.createDiv({ cls: "mtg-collection-header mtg-deck-title-row" });
		this.collectionHeaderEl = header;
		const headerTitleInfo = header.createDiv({ cls: "mtg-title-info" });
		this.headerTitleEl = headerTitleInfo.createEl("h3", { cls: "mtg-detail-title" });
		this.headerStatsEl = headerTitleInfo.createDiv({
			cls: "mtg-collection-stats mtg-detail-title-stats",
		});
		// "+ New X" buttons of the grid (My Collection/My Decks/My Wantlists), each
		// followed by its own "Select" button — explicitly requested to the right of "+
		// New X" (the reverse order from here was tried first, corrected on feedback).
		// The two already share the same height (34px, mtg-search-add-btn /
		// mtg-tile-menu-btn-large) and the same flex parent with align-items:center
		// (mtg-deck-title-row), so no additional CSS was needed to center them vertically
		// relative to each other — already guaranteed by this existing layout. Same
		// icon/toggle (square-mouse-pointer ↔ x) as selectModeBtn (a variable local to
		// renderListDetail/etc., src/view/collection-render.ts — selection of CARDS
		// inside an already open list), just one notch higher in the hierarchy.
		// Persistent elements (like newListBtn etc.): their icon/active state is
		// resynchronized on every render() rather than rebuilt, see syncGallerySelectBtn.
		this.newListBtn = header.createEl("button", {
			text: "+ New list",
			cls: "mtg-search-add-btn",
		});
		this.newListBtn.addEventListener("click", () => {
			new NewListModal(this.app, this.plugin, (list) => {
				this.openListId = list.id;
				this.render();
			}).open();
		});
		this.listGallerySelectBtn = header.createDiv({
			cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
		});
		this.listGallerySelectBtn.addEventListener("click", () => {
			this.listGallerySelectMode = !this.listGallerySelectMode;
			if (!this.listGallerySelectMode) {
				this.selectedListIds.clear();
				this.listGalleryBulkBarWasVisible = false;
			}
			this.render();
		});
		this.newDeckBtn = header.createEl("button", {
			text: "+ New deck",
			cls: "mtg-search-add-btn",
		});
		this.newDeckBtn.addEventListener("click", () => {
			new NewDeckModal(this.app, this.plugin, (deck) => {
				this.openDeckId = deck.id;
				this.render();
			}).open();
		});
		this.deckGallerySelectBtn = header.createDiv({
			cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
		});
		this.deckGallerySelectBtn.addEventListener("click", () => {
			this.deckGallerySelectMode = !this.deckGallerySelectMode;
			if (!this.deckGallerySelectMode) {
				this.selectedDeckIds.clear();
				this.deckGalleryBulkBarWasVisible = false;
			}
			this.render();
		});
		this.newWantlistBtn = header.createEl("button", {
			text: "+ New wantlist",
			cls: "mtg-search-add-btn",
		});
		this.newWantlistBtn.addEventListener("click", () => {
			new NewWantlistModal(this.app, this.plugin, (wantlist) => {
				this.openWantlistId = wantlist.id;
				this.render();
			}).open();
		});
		this.wantlistGallerySelectBtn = header.createDiv({
			cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large",
		});
		this.wantlistGallerySelectBtn.addEventListener("click", () => {
			this.wantlistGallerySelectMode = !this.wantlistGallerySelectMode;
			if (!this.wantlistGallerySelectMode) {
				this.selectedWantlistIds.clear();
				this.wantlistGalleryBulkBarWasVisible = false;
			}
			this.render();
		});

		// Pinned "Inbox"/"All Cards" row of My Collection (filled by
		// renderListGrid) — placed BEFORE the filter bar below, explicitly
		// requested (search and sort come after these two tiles). It is this row
		// that goes up above the bar, not the other way round: the filter bar is a
		// persistent element that render() never rebuilds (its input would lose
		// focus, and an IME/dead-key composition would be canceled, on every
		// keystroke), whereas this one is rebuilt on every render(), by the same
		// detached swap as this.bodyEl — see render().
		this.collectionPinnedEl = main.createDiv({ cls: "mtg-collection-pinned" });

		// Toolbar "My Collection" : filtre
		this.collectionToolbarEl = main.createDiv({ cls: "mtg-collection-toolbar" });
		const filterWrap = this.collectionToolbarEl.createDiv({ cls: "mtg-filter-chip-row" });
		const filterInner = filterWrap.createDiv({ cls: "mtg-filter-chip-row-inner" });
		this.filterEl = filterInner.createEl("input", {
			cls: "mtg-filter-chip-input",
			type: "text",
			placeholder: "Filter by name or list…",
		});
		this.filterEl.addEventListener("input", () => this.render());

		// Toolbar "My Decks" : filtre
		this.decksToolbarEl = main.createDiv({ cls: "mtg-collection-toolbar" });
		const deckFilterWrap = this.decksToolbarEl.createDiv({ cls: "mtg-filter-chip-row" });
		const deckFilterInner = deckFilterWrap.createDiv({ cls: "mtg-filter-chip-row-inner" });
		this.deckFilterEl = deckFilterInner.createEl("input", {
			cls: "mtg-filter-chip-input",
			type: "text",
			placeholder: "Filter decks…",
		});
		this.deckFilterEl.addEventListener("input", () => this.render());

		// Toolbar "My Wantlists" : filtre
		this.wantlistsToolbarEl = main.createDiv({ cls: "mtg-collection-toolbar" });
		const wantlistFilterWrap = this.wantlistsToolbarEl.createDiv({ cls: "mtg-filter-chip-row" });
		const wantlistFilterInner = wantlistFilterWrap.createDiv({ cls: "mtg-filter-chip-row-inner" });
		this.wantlistFilterEl = wantlistFilterInner.createEl("input", {
			cls: "mtg-filter-chip-input",
			type: "text",
			placeholder: "Filter wantlists…",
		});
		this.wantlistFilterEl.addEventListener("input", () => this.render());

		this.bodyEl = main.createDiv({ cls: "mtg-collection-body" });

		this.render();
	}


	render() {
		// A render() arriving via another path (Enter, chip removed…) makes a
		// keystroke debounce still pending obsolete (see scheduleFilterRender):
		// without this, that stale timer would trigger a second, redundant
		// render() right after this one.
		if (this.filterRenderDebounceTimer !== null) {
			window.clearTimeout(this.filterRenderDebounceTimer);
			this.filterRenderDebounceTimer = null;
		}
		// Hidden on every render(): a hovered row can be destroyed/rebuilt by this
		// same render() (change of sort/filter/view mode) without a mouseleave
		// having the chance to fire on an already removed DOM node — leaving the
		// preview displayed would freeze its position above a row that no longer
		// exists (or is no longer) there.
		this.hideCardNamePreview();
		this.navHomeBtn.toggleClass("is-active", this.activeSection === "home");
		this.navCollectionBtn.toggleClass(
			"is-active",
			this.activeSection === "collection"
		);
		this.navDecksBtn.toggleClass("is-active", this.activeSection === "decks");
		this.navWantlistsBtn.toggleClass("is-active", this.activeSection === "wantlists");
		this.updateNavIndicator();

		// this.collectionHeaderEl ("My Collection"/"My Decks"/"My Wantlists" +
		// stats + "+ New X") was never hidden as a container — only its text
		// (headerTitleEl/headerStatsEl, emptied via setText("") further down) and
		// its 3 "+ New X" buttons were, individually. Reported bug: a small
		// visible gap above the "Back to X" button once a list/deck/wantlist is
		// open — even entirely empty, this container (display:flex, with no height
		// of its own once its content is emptied) keeps its margin-bottom: 0.75em,
		// which still pushes .mtg-back-row further down. Hidden here with the same
		// logic already used by the 3 "+ New X" buttons (one per section, combined
		// into a single OR since this container is shared between the 3 sections)
		// rather than depending solely on the emptied text. "Back to X" now lives
		// in .mtg-detail-sticky-header itself (see
		// renderListDetail/renderDeckDetail/renderWantlistDetail, plus
		// .mtg-detail-header-banner in styles.css) rather than in a separate
		// element — this comment originally referenced that second element,
		// updated since it no longer exists.
		this.collectionHeaderEl.style.display =
			this.activeSection !== "home" && !this.isDetailViewOpen() ? "flex" : "none";
		// .mtg-main no longer ever scrolls by itself once a detail view is open —
		// see .mtg-collection-body-detail/.mtg-detail-scroll-area (styles.css),
		// which take over the real scrolling inside this.bodyEl. Without this
		// class, the scrollbar gutter reserved by .mtg-main (scrollbar-gutter:
		// stable) would remain in addition to that of .mtg-detail-scroll-area —
		// two empty bands side by side, the real scrollbar pushed back by that
		// much from the real edge of the panel.
		this.mainEl.toggleClass("mtg-main-detail-open", this.isDetailViewOpen());

		this.collectionPinnedEl.style.display =
			this.activeSection === "collection" && !this.openListId ? "" : "none";
		this.collectionToolbarEl.style.display =
			this.activeSection === "collection" && !this.openListId ? "flex" : "none";
		this.newListBtn.style.display =
			this.activeSection === "collection" && !this.openListId ? "" : "none";
		this.listGallerySelectBtn.style.display =
			this.activeSection === "collection" && !this.openListId ? "" : "none";
		this.syncGallerySelectBtn(this.listGallerySelectBtn, this.listGallerySelectMode, "Select lists");
		this.decksToolbarEl.style.display =
			this.activeSection === "decks" && !this.openDeckId ? "flex" : "none";
		this.newDeckBtn.style.display =
			this.activeSection === "decks" && !this.openDeckId ? "" : "none";
		this.deckGallerySelectBtn.style.display =
			this.activeSection === "decks" && !this.openDeckId ? "" : "none";
		this.syncGallerySelectBtn(this.deckGallerySelectBtn, this.deckGallerySelectMode, "Select decks");
		this.wantlistsToolbarEl.style.display =
			this.activeSection === "wantlists" && !this.openWantlistId ? "flex" : "none";
		this.newWantlistBtn.style.display =
			this.activeSection === "wantlists" && !this.openWantlistId ? "" : "none";
		this.wantlistGallerySelectBtn.style.display =
			this.activeSection === "wantlists" && !this.openWantlistId ? "" : "none";
		this.syncGallerySelectBtn(
			this.wantlistGallerySelectBtn,
			this.wantlistGallerySelectMode,
			"Select wantlists"
		);

		// Builds the new content in an element detached from the DOM (the code of the render*Section methods
		// — now in src/view/*-render.ts — targets this.bodyEl without knowing it), then swaps it in one go
		// with the old one once fully ready — never an "empty" intermediate state. With the old approach
		// (empty then rebuild in place), the scrollable height of .mtg-main collapsed for an instant on
		// every render; a fast scroll in progress (inertia/momentum) was then cut short by the browser at
		// that precise instant — particularly visible with incremental loading (renderLoadMoreSentinel),
		// which triggers a render() again in the middle of a scrolling action.
		// .mtg-detail-scroll-area (see styles.css) is rebuilt on every render() like the rest of this.bodyEl
		// — UNLIKE this.mainEl, nothing therefore preserves its scroll position "for free" by the mere fact
		// of never destroying it. Captured here before the swap, reapplied right after on the new instance:
		// covers any render() trigger (change of sort/filter/selection mode, incremental loading via
		// renderLoadMoreSentinel, etc.), not just this last case.
		const oldScrollArea = this.bodyEl.querySelector<HTMLElement>(".mtg-detail-scroll-area");
		const viewKey = `${this.activeSection}:${this.openListId ?? ""}:${this.openDeckId ?? ""}:${this.openWantlistId ?? ""}`;
		const viewChanged = this.lastRenderedViewKey !== null && this.lastRenderedViewKey !== viewKey;
		this.lastRenderedViewKey = viewKey;
		const preservedScrollTop = oldScrollArea && !viewChanged ? oldScrollArea.scrollTop : null;

		const oldBodyEl = this.bodyEl;
		const newBodyEl = oldBodyEl.cloneNode(false) as HTMLElement;
		// this.bodyEl only hosts the flex-column scaffolding of the detail views
		// (.mtg-collection-body-detail, see styles.css) if the render*Detail
		// method called just below adds it itself — never inherited as is from the
		// previous render via cloneNode(false), which nevertheless copies the
		// class attribute of the old node: without this explicit reset, going back
		// from the detail to the grid would leave this class lingering on the new
		// bodyEl (auto-height/block expected for the grid).
		newBodyEl.removeClass("mtg-collection-body-detail");
		this.bodyEl = newBodyEl;
		// Same detached swap for My Collection's pinned row (collectionPinnedEl,
		// see onOpen): only renderListGrid fills it, every other render leaves it
		// empty — and hidden, its display having been set above BEFORE this clone,
		// which cloneNode(false) copies over.
		const oldPinnedEl = this.collectionPinnedEl;
		const newPinnedEl = oldPinnedEl.cloneNode(false) as HTMLElement;
		this.collectionPinnedEl = newPinnedEl;
		// Reset before rebuilding: only what THIS render pass has just scheduled
		// (see renderChipFilter) remains "pending" here — never a stale callback
		// from a previous render.
		this.pendingFocusRestore = null;

		if (this.activeSection === "home") {
			this.renderHomeSection();
		} else if (this.activeSection === "collection") {
			this.renderCollectionSection();
		} else if (this.activeSection === "decks") {
			this.renderDecksSection();
		} else {
			this.renderWantlistsSection();
		}

		oldBodyEl.replaceWith(newBodyEl);
		oldPinnedEl.replaceWith(newPinnedEl);
		if (viewChanged) this.mainEl.scrollTop = 0;
		if (preservedScrollTop !== null) {
			const newScrollArea = newBodyEl.querySelector<HTMLElement>(".mtg-detail-scroll-area");
			if (newScrollArea) newScrollArea.scrollTop = preservedScrollTop;
		}
		// Executed here, right after the swap, in the same synchronous pass as the
		// construction above: the new element to focus is already in the document
		// at this moment (replaceWith() is a synchronous DOM mutation), so no
		// window where nothing has focus comes in between the removal of the old
		// content and the focus restoration.
		this.runPendingFocusRestore();
		this.updateDeckStacksLayout();
		// Same purpose as the comment of updateDeckStacksLayout above: at this
		// precise moment, a freshly built Card view tile (if the render displays
		// one) is already in the document — see updateCardTileRadius, which
		// precisely needs this to measure a real width rather than that of a
		// detached node. Covers the case "we just opened/changed the Card view";
		// the ResizeObserver set up once in onOpen() (setupCardTileRadiusObserver)
		// covers the other case, a panel resize without render().
		this.updateCardTileRadius();
	}

	// True if a list/deck/wantlist is currently open (whatever the section) —
	// i.e. if .mtg-detail-scroll-area exists in the current render rather than
	// the overview grid. Centralized here: several mechanisms (visibility of
	// collectionHeaderEl, gutter of .mtg-main, active scroll area) ask exactly
	// the same question.

	async onClose() {
		// cardNamePreviewEl is added to document.body (see onOpen), not to a
		// descendant of this view — without this explicit removal, it would
		// outlive the closing of the view.
		this.cardNamePreviewEl?.remove();
		this.homeSyncUnsub?.();
		this.homeSyncUnsub = null;
	}

	// -------------------------------------------------------------------
	// Method implementations below live in src/view/*.ts (split out on
	// 2026-09-10, "Phase 5b" -- see CLAUDE.md's "Architecture notes") --
	// each field is still called exactly as before everywhere else in the
	// codebase, unchanged; only WHERE the implementation lives moved. This
	// block is a manifest/index of the whole class's surface.
	// -------------------------------------------------------------------

	// -- Shared view helpers: settings link, scroll area, table header, gallery select button, load-more sentinel (src/view/shared-render-helpers.ts) --
	openPluginSettings = sharedRenderHelpers.openPluginSettings;
	renderTableHeader = sharedRenderHelpers.renderTableHeader;
	isDetailViewOpen = sharedRenderHelpers.isDetailViewOpen;
	getActiveScrollEl = sharedRenderHelpers.getActiveScrollEl;
	handleScrollAreaScroll = sharedRenderHelpers.handleScrollAreaScroll;
	syncGallerySelectBtn = sharedRenderHelpers.syncGallerySelectBtn;
	renderLoadMoreSentinel = sharedRenderHelpers.renderLoadMoreSentinel;

	// -- Filter chip search bar: chips, numeric builder, keyword suggestions, focus restore (src/view/filter-chips.ts) --
	scheduleFilterRender = filterChips.scheduleFilterRender;
	renderChipFilter = filterChips.renderChipFilter;
	renderNumericFilterBuilder = filterChips.renderNumericFilterBuilder;
	getKeywordSuggestions = filterChips.getKeywordSuggestions;
	runPendingFocusRestore = filterChips.runPendingFocusRestore;

	// -- Group by / Sort by / view mode toolbar (src/view/group-sort-bar.ts) --
	persistSortSettings = groupSortBar.persistSortSettings;
	renderGroupSortBar = groupSortBar.renderGroupSortBar;

	// -- Collapsing and FLIP animation of card groups (src/view/group-collapse.ts) --
	setRowCollapsed = groupCollapse.setRowCollapsed;
	toggleGroupRows = groupCollapse.toggleGroupRows;
	flipListChange = groupCollapse.flipListChange;

	// -- Card thumbnails with badge, name preview, tile corner radius (src/view/card-thumbnails.ts) --
	showCardNamePreview = cardThumbnails.showCardNamePreview;
	hideCardNamePreview = cardThumbnails.hideCardNamePreview;
	setupCardTileRadiusObserver = cardThumbnails.setupCardTileRadiusObserver;
	updateCardTileRadius = cardThumbnails.updateCardTileRadius;
	renderThumbWithBadge = cardThumbnails.renderThumbWithBadge;

	// -- File downloads (src/view/downloads.ts) --
	downloadTextFile = downloads.downloadTextFile;
	downloadZip = downloads.downloadZip;

	// -- Home (src/view/home-render.ts) --
	renderHomeSection = homeRender.renderHomeSection;
	renderHomeOverview = homeRender.renderHomeOverview;
	renderHomeRecentCarousel = homeRender.renderHomeRecentCarousel;
	renderHomeColorBreakdown = homeRender.renderHomeColorBreakdown;
	renderHomeRarityBreakdown = homeRender.renderHomeRarityBreakdown;
	renderHomeDecksToFinish = homeRender.renderHomeDecksToFinish;
	renderHomeMarketTrends = homeRender.renderHomeMarketTrends;

	// -- My Collection (src/view/collection-render.ts) --
	triggerImportCollection = collectionRender.triggerImportCollection;
	openAddCollectionCardsModal = collectionRender.openAddCollectionCardsModal;
	openCollectionCardDetailById = collectionRender.openCollectionCardDetailById;
	openAddCollectionCardsModalWithListPicker = collectionRender.openAddCollectionCardsModalWithListPicker;
	renderCollectionSection = collectionRender.renderCollectionSection;
	renderListGrid = collectionRender.renderListGrid;
	renderListTile = collectionRender.renderListTile;
	renderListGalleryBulkActionsBar = collectionRender.renderListGalleryBulkActionsBar;
	renderListDetail = collectionRender.renderListDetail;
	collectionCardRowSignature = collectionRender.collectionCardRowSignature;
	buildCollectionCardRow = collectionRender.buildCollectionCardRow;
	buildCollectionCardTile = collectionRender.buildCollectionCardTile;
	renderCollectionBulkActionsBar = collectionRender.renderCollectionBulkActionsBar;
	exportListCsv = collectionRender.exportListCsv;
	listTxtLines = collectionRender.listTxtLines;
	exportListTxt = collectionRender.exportListTxt;
	copyListTxt = collectionRender.copyListTxt;
	exportListSelectionCsv = collectionRender.exportListSelectionCsv;
	listSelectionTxtLines = collectionRender.listSelectionTxtLines;
	exportListSelectionTxt = collectionRender.exportListSelectionTxt;
	copyListSelectionTxt = collectionRender.copyListSelectionTxt;
	buildListCsvString = collectionRender.buildListCsvString;
	downloadListCsv = collectionRender.downloadListCsv;
	listGroupsToTxtLines = collectionRender.listGroupsToTxtLines;
	triggerImportIntoList = collectionRender.triggerImportIntoList;
	triggerImportTxtIntoList = collectionRender.triggerImportTxtIntoList;
	openList = collectionRender.openList;
	closeListIfOpen = collectionRender.closeListIfOpen;

	// -- My Decks (src/view/deck-render.ts) --
	openDeckCardDetailById = deckRender.openDeckCardDetailById;
	renderDeckBoardTabs = deckRender.renderDeckBoardTabs;
	renderDeckBulkActionsBar = deckRender.renderDeckBulkActionsBar;
	deckSelectionTxtLines = deckRender.deckSelectionTxtLines;
	exportDeckSelectionTxt = deckRender.exportDeckSelectionTxt;
	copyDeckSelectionTxt = deckRender.copyDeckSelectionTxt;
	exportDeckSelectionCsv = deckRender.exportDeckSelectionCsv;
	decksToTxtLines = deckRender.decksToTxtLines;
	buildDeckCsvString = deckRender.buildDeckCsvString;
	downloadDeckCsv = deckRender.downloadDeckCsv;
	exportDeckCsv = deckRender.exportDeckCsv;
	deckTxtLines = deckRender.deckTxtLines;
	exportDeckTxt = deckRender.exportDeckTxt;
	copyDeckTxt = deckRender.copyDeckTxt;
	triggerImportIntoDeck = deckRender.triggerImportIntoDeck;
	triggerImportTxtIntoDeck = deckRender.triggerImportTxtIntoDeck;
	openDeck = deckRender.openDeck;
	closeDeckIfOpen = deckRender.closeDeckIfOpen;
	renderDecksSection = deckRender.renderDecksSection;
	renderDeckGrid = deckRender.renderDeckGrid;
	renderDeckGalleryBulkActionsBar = deckRender.renderDeckGalleryBulkActionsBar;
	renderDeckDetail = deckRender.renderDeckDetail;
	renderDeckStacksView = deckRender.renderDeckStacksView;
	updateDeckStacksLayout = deckRender.updateDeckStacksLayout;
	setupDeckStacksLayoutObserver = deckRender.setupDeckStacksLayoutObserver;
	deckCardRowSignature = deckRender.deckCardRowSignature;
	renderDeckLegalityBadge = deckRender.renderDeckLegalityBadge;
	buildDeckCardRow = deckRender.buildDeckCardRow;
	buildDeckCardTile = deckRender.buildDeckCardTile;

	// -- My Wantlists (src/view/wantlist-render.ts) --
	triggerImportWantlist = wantlistRender.triggerImportWantlist;
	openAddWantlistCardsModal = wantlistRender.openAddWantlistCardsModal;
	openWantlistCardDetailById = wantlistRender.openWantlistCardDetailById;
	openAddWantlistCardsModalWithListPicker = wantlistRender.openAddWantlistCardsModalWithListPicker;
	renderWantlistBulkActionsBar = wantlistRender.renderWantlistBulkActionsBar;
	wantlistSelectionTxtLines = wantlistRender.wantlistSelectionTxtLines;
	exportWantlistSelectionTxt = wantlistRender.exportWantlistSelectionTxt;
	copyWantlistSelectionTxt = wantlistRender.copyWantlistSelectionTxt;
	exportWantlistCsv = wantlistRender.exportWantlistCsv;
	wantlistTxtLines = wantlistRender.wantlistTxtLines;
	exportWantlistTxt = wantlistRender.exportWantlistTxt;
	copyWantlistTxt = wantlistRender.copyWantlistTxt;
	exportWantlistSelectionCsv = wantlistRender.exportWantlistSelectionCsv;
	buildWantlistCsvString = wantlistRender.buildWantlistCsvString;
	downloadWantlistCsv = wantlistRender.downloadWantlistCsv;
	wantlistGroupsToTxtLines = wantlistRender.wantlistGroupsToTxtLines;
	triggerImportIntoWantlist = wantlistRender.triggerImportIntoWantlist;
	triggerImportTxtIntoWantlist = wantlistRender.triggerImportTxtIntoWantlist;
	openWantlist = wantlistRender.openWantlist;
	closeWantlistIfOpen = wantlistRender.closeWantlistIfOpen;
	renderWantlistsSection = wantlistRender.renderWantlistsSection;
	renderWantlistGrid = wantlistRender.renderWantlistGrid;
	renderWantlistTile = wantlistRender.renderWantlistTile;
	renderWantlistGalleryBulkActionsBar = wantlistRender.renderWantlistGalleryBulkActionsBar;
	renderWantlistDetail = wantlistRender.renderWantlistDetail;
	wantlistCardRowSignature = wantlistRender.wantlistCardRowSignature;
	buildWantlistCardRow = wantlistRender.buildWantlistCardRow;
	buildWantlistCardTile = wantlistRender.buildWantlistCardTile;

	// -- Obsidian bars on phone, bottom and top (src/view/mobile-bars.ts) --
	setupMobileBars = mobileBars.setupMobileBars;
	syncMobileBars = mobileBars.syncMobileBars;

}
