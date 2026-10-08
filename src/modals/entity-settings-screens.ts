import { Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { ListIcon } from "../core/data-model";
import {
	applySvgColor,
	dedupeSetsByIcon,
	getSetGroupLabel,
	SET_GROUP_ORDER,
	ScryfallSetSummary,
} from "../api/scryfall";
import { MANA_ICON_LETTERS, OTHER_ICON_SYMBOLS } from "./entity-icon-options";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/* Sub-screens common to the settings modals (list / wantlist / deck) — */
/* List/Wantlist/DeckSettingsModal, and InboxSettingsModal for the */
/* confirmation */
/* -------------------------------------------------------------------------- */
// Each settings modal replaces all of its content with a "sub-screen" (confirmation, choice of a merge's
// target, of the cover, of the icon) then goes back to the main screen. These sub-screens were copied three
// times, identical apart from the names; what really changes from one section to another is a parameter: the
// entity's name ("list"/"wantlist"/"deck"), its cards and the key that identifies them (CollectionCard.id,
// DeckCard.scryfallId), the merge candidates (Inbox excluded on the list side), and which plugin method saves
// the result.
//
// The modal keeps its flags (confirmingDelete, pickingIcon…) and its draw(): it calls the screen function,
// which builds the content and calls back `onCancel` / `onDone` — it is the modal that flips the flag and
// redraws.

// Full-format confirmation screen (Delete / Clear): title, message, red "Yes, …", "No, cancel". Not the
// in-place Delete/Cancel swap of the bulk-actions bar — consistent among the destructive actions of these
// windows.
export function renderConfirmScreen(
	contentEl: HTMLElement,
	c: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }
) {
	contentEl.createEl("h2", { text: c.title });
	contentEl.createEl("p", { text: c.message, cls: "mtg-status" });
	const row = contentEl.createDiv({ cls: "mtg-svg-btn-row" });
	const yesBtn = row.createEl("button", {
		text: c.confirmLabel,
		cls: "mtg-remove-btn",
	});
	yesBtn.addEventListener("click", c.onConfirm);
	const noBtn = row.createEl("button", { text: "No, cancel" });
	noBtn.addEventListener("click", c.onCancel);
}

// Choice of the 2nd entity of a merge ("Merge with another …"). Only chooses: the rest (editable name,
// confirmation, mutation) is delegated to MergeListsModal/MergeWantlistsModal/MergeDecksModal (merge-modals.ts)
// through `onChoose`. Same mechanism as a gallery's grouped Merge, explicitly requested: a NEW entity is created
// with the two, and BOTH originals (this one included) are deleted — not a simple absorption. The candidates are
// supplied by the modal, already filtered (on the list side, Inbox is excluded: mergeLists silently ignores it,
// offering it would lead to a "merge" that does nothing visible) and in the wanted order.
// Presented like "Move to"/"Copy to" (CopyCardModal) — explicitly requested, in place of the former text
// <select>: same gallery of tiles (cover/name/"N cards"), same search bar, same staggered appearance of the
// first tiles (revealTile). Clicking a tile directly chooses the 2nd entity, just as clicking a CopyCardModal
// tile directly triggers the copy/move — no separate "Merge" button. No tabs (a single possible destination) nor
// "+ New X" tile (a merge assumes an existing entity); same .mtg-copy-card-gallery-* classes as CopyCardModal,
// none scoped under .mtg-copy-card-modal.
export interface MergeCandidate {
	id: string;
	name: string;
	coverImage?: string;
	totalQty: number;
}

export function renderMergeTargetScreen(
	contentEl: HTMLElement,
	s: {
		// "list" | "wantlist" | "deck"
		noun: string;
		// Name of the entity whose settings are being opened (quoted in the help text).
		currentName: string;
		candidates: MergeCandidate[];
		onChoose: (targetId: string) => void;
		onCancel: () => void;
	}
) {
	contentEl.createEl("h2", { text: `Merge with another ${s.noun}` });
	if (s.candidates.length === 0) {
		contentEl.createEl("p", {
			text: `There's no other ${s.noun} to merge with.`,
			cls: "mtg-status",
		});
		const backBtn = contentEl.createEl("button", { text: "Back" });
		backBtn.addEventListener("click", s.onCancel);
		return;
	}
	contentEl.createEl("p", {
		text: `Choose another ${s.noun} to merge with "${s.currentName}". This creates one new ${s.noun} with every card from both, then deletes the two originals.`,
		cls: "mtg-status",
	});

	const searchWrap = contentEl.createDiv({ cls: "mtg-copy-card-search" });
	const searchInput = searchWrap.createEl("input", {
		cls: "mtg-copy-card-search-input",
		type: "text",
		attr: { placeholder: `Search ${s.noun}s…` },
	});
	const galleryEl = contentEl.createDiv({ cls: "mtg-copy-card-gallery" });

	let tileStaggerIndex = 0;
	const revealTile = (tile: HTMLElement, stagger: boolean) => {
		if (!stagger) {
			tile.addClass("is-visible");
			return;
		}
		const delay = Math.min(tileStaggerIndex, 8) * 40;
		tileStaggerIndex++;
		window.setTimeout(() => tile.addClass("is-visible"), delay);
	};

	const renderMergeGallery = (stagger: boolean) => {
		galleryEl.empty();
		tileStaggerIndex = 0;
		const query = searchInput.value.trim().toLowerCase();
		const matches = s.candidates.filter((g) => !query || g.name.toLowerCase().includes(query));
		matches.forEach((g) => {
			const tile = galleryEl.createDiv({ cls: "mtg-copy-card-gallery-tile" });
			const bg = tile.createDiv({ cls: "mtg-copy-card-gallery-tile-bg" });
			if (g.coverImage) bg.style.backgroundImage = `url("${g.coverImage}")`;
			const overlay = tile.createDiv({ cls: "mtg-copy-card-gallery-overlay" });
			overlay.createDiv({ cls: "mtg-copy-card-gallery-name", text: g.name });
			overlay.createDiv({ cls: "mtg-copy-card-gallery-meta", text: `${g.totalQty} cards` });
			tile.addEventListener("click", () => s.onChoose(g.id));
			revealTile(tile, stagger);
		});
		if (matches.length === 0) {
			galleryEl.createEl("p", { text: `No ${s.noun} found.`, cls: "mtg-status" });
		}
	};
	// Rebuilds ONLY the gallery on each keystroke, never the whole contentEl
	// via this.draw() — rebuilding this <input> itself would cut the focus in
	// the middle of typing (same risk already documented for
	// CopyCardModal.searchInputEl).
	searchInput.addEventListener("input", () => renderMergeGallery(false));
	renderMergeGallery(true);

	const cancelRow = contentEl.createDiv({ cls: "mtg-svg-btn-row" });
	const cancelBtn = cancelRow.createEl("button", { text: "Cancel" });
	cancelBtn.addEventListener("click", s.onCancel);
}

// "Choose cover image": a card of THIS entity, whose artwork replaces the automatic choice (the most expensive,
// see pickCoverImage/resolveCoverImage, core/price.ts) wherever this group is displayed (section grid,
// CopyCardModal gallery… — everything goes through groupByList/groupByWantlist/resolveDeckCoverImage, so nothing
// else to touch). Grid of 3 columns of artworks ONLY (artCropUrl — the Scryfall crop of the art alone, not the
// full card scan, explicitly requested) with just the name below, discreet. Selection by outline (same recipe as
// .mtg-set-tile-selected of the main grid: outline, not border, so as never to shift the box on click) rather
// than a "Use this" button per tile — a single choice at a time, validated by a single "Save" at the bottom;
// browsing the grid therefore doesn't touch the saved cover yet. No search bar (deliberately proportioned to
// what was asked for).
// "Automatic" is always the 1st tile (not only when a manual choice has already been made) — without it, nothing
// would indicate that it is the active state as long as no card has ever been chosen.
// `key` identifies a card for this section (CollectionCard.id / WantlistCard.id on the lists and wantlists side,
// DeckCard.scryfallId on the deck side, which has no id of its own); `currentKey` is the current cover.
export interface CoverCard {
	key: string;
	name: string;
	artCropUrl: string;
	imageUrl: string;
}

export function renderCoverPickerScreen(
	contentEl: HTMLElement,
	s: {
		noun: string;
		cards: CoverCard[];
		currentKey: string | undefined;
		// Saves the choice (undefined = automatic) — the modal calls the right plugin method.
		save: (key: string | undefined) => void;
		// After the save (the modal leaves the sub-screen and redraws).
		onDone: () => void;
		onCancel: () => void;
	}
) {
	contentEl.createEl("h2", { text: "Choose cover image" });
	if (s.cards.length === 0) {
		contentEl.createEl("p", {
			text: `This ${s.noun} has no cards yet.`,
			cls: "mtg-status",
		});
		const backBtn = contentEl.createEl("button", { text: "Cancel" });
		backBtn.addEventListener("click", s.onCancel);
		return;
	}
	contentEl.createEl("p", {
		text: `Pick a card to use its illustration as this ${s.noun}'s cover in the grid.`,
		cls: "mtg-status",
	});

	// State local to this screen, validated only by "Save" further down —
	// browsing the grid doesn't touch list.coverCardId yet, unlike the old
	// version that applied each click immediately.
	let selectedKey: string | undefined = s.currentKey;

	const grid = contentEl.createDiv({ cls: "mtg-cover-picker-grid" });

	const selectTile = (tile: HTMLElement, key: string | undefined) => {
		grid
			.querySelectorAll(".mtg-cover-picker-tile.is-selected")
			.forEach((el) => el.removeClass("is-selected"));
		tile.addClass("is-selected");
		selectedKey = key;
	};

	// "Automatic" always as the 1st tile (not only when a manual choice has
	// already been made) — without it, nothing indicates that it is the active
	// state as long as no card has ever been chosen.
	const autoTile = grid.createDiv({
		cls: "mtg-cover-picker-tile mtg-cover-picker-tile-auto" + (!s.currentKey ? " is-selected" : ""),
	});
	const autoBox = autoTile.createDiv({ cls: "mtg-cover-picker-tile-img mtg-cover-picker-tile-auto-box" });
	setIcon(autoBox, "sparkles");
	autoTile.createDiv({ cls: "mtg-cover-picker-tile-title", text: "Automatic" });
	autoTile.addEventListener("click", () => selectTile(autoTile, undefined));

	s.cards.forEach((card) => {
		const tile = grid.createDiv({
			cls: "mtg-cover-picker-tile" + (card.key === s.currentKey ? " is-selected" : ""),
		});
		const art = card.artCropUrl || card.imageUrl;
		if (art) {
			tile.createEl("img", {
				cls: "mtg-cover-picker-tile-img",
				attr: { src: art, loading: "lazy" },
			});
		} else {
			tile.createDiv({ cls: "mtg-cover-picker-tile-img mtg-no-image" });
		}
		tile.createDiv({ cls: "mtg-cover-picker-tile-title", text: card.name });
		tile.addEventListener("click", () => selectTile(tile, card.key));
	});

	const row = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-list-actions-save-row" });
	const saveBtn = row.createEl("button", { text: "Save", cls: "mtg-search-add-btn" });
	saveBtn.addEventListener("click", () => {
		const label = selectedKey
			? `"${s.cards.find((c) => c.key === selectedKey)?.name ?? ""}"`
			: "automatic";
		s.save(selectedKey);
		new Notice(`Cover image set to ${label}.`);
		s.onDone();
	});
	const cancelBtn = row.createEl("button", { text: "Cancel" });
	cancelBtn.addEventListener("click", s.onCancel);
}

// State of the icon picker, carried by the modal (an INSTANCE FIELD rather than a local variable of draw()) to
// survive a tab change (Mana Symbol/Set Symbol/Other symbol): the screen body is rebuilt on every tab change, a
// local variable would be reset from the entity there, losing a choice not yet saved when simply switching tab
// to look at the other one.
// - pendingIcon: current choice, not yet saved (validated only by "Save");
// - tab: displayed tab;
// - dedupedSets: list of sets deduplicated by symbol, memoized once computed (dedupeSetsByIcon over ~1000
//   entries, not free) rather than recomputed at every opening — getAllScryfallSets() itself is already cached
//   on the plugin side, but the deduplication wasn't.
export interface IconPickerState {
	pendingIcon: ListIcon | undefined;
	tab: "mana" | "set" | "other";
	dedupedSets: ScryfallSetSummary[] | null;
}

export function newIconPickerState(): IconPickerState {
	return { pendingIcon: undefined, tab: "mana", dedupedSets: null };
}

// To be called on click of "Choose icon" on the main screen: takes the choice from the entity's current
// icon and opens the tab that contains it (set → "Set Symbol", OTHER_ICON_SYMBOLS symbol → "Other symbol",
// otherwise "Mana Symbol").
export function openIconPicker(state: IconPickerState, icon: ListIcon | undefined) {
	state.pendingIcon = icon;
	state.tab =
		icon?.kind === "set"
			? "set"
			: icon && OTHER_ICON_SYMBOLS.some((s) => s.letter === icon.value)
				? "other"
				: "mana";
}

// "Choose icon": a pictogram displayed in front of the entity's 3 lines of text (section grid AND CopyCardModal
// gallery — everything starts from group.icon, set once via setListIcon/setWantlistIcon/setDeckIcon). 3 tabs,
// same visual language AND same mechanism as "My Collection"/"My Decks"/"My Wantlists" in CopyCardModal: the tab
// buttons + the sliding bar (.mtg-copy-card-tab-indicator) are built ONLY ONCE below (never recreated by a tab
// change), exactly like CopyCardModal.buildChrome — a tab change calls switchIconTab (just repositions the bar +
// rebuilds the body), never a complete redraw, which would destroy these buttons and make the bar reappear
// already in place without sliding. state.pendingIcon keeps the current choice from one tab to another.
export function renderIconPickerScreen(
	contentEl: HTMLElement,
	ctx: {
		plugin: MTGCollectionPlugin;
		noun: string;
		state: IconPickerState;
		// Saves the choice (undefined = no icon) — the modal calls the right plugin method.
		save: (icon: ListIcon | undefined) => void;
		onDone: () => void;
		onCancel: () => void;
	}
) {
	const { state } = ctx;
	const noun = ctx.noun.charAt(0).toUpperCase() + ctx.noun.slice(1);
	contentEl.createEl("h2", { text: "Choose icon" });
	contentEl.createEl("p", {
		text: `Shown to the left of the ${ctx.noun}'s name, wherever it appears.`,
		cls: "mtg-status",
	});

	const tabsEl = contentEl.createDiv({ cls: "mtg-copy-card-tabs" });
	const tabDefs: { key: "mana" | "set" | "other"; label: string }[] = [
		{ key: "mana", label: "Mana symbol" },
		{ key: "set", label: "Set symbol" },
		{ key: "other", label: "Other symbol" },
	];
	const tabButtons: Partial<Record<"mana" | "set" | "other", HTMLElement>> = {};
	tabDefs.forEach((t) => {
		const btn = tabsEl.createDiv({
			cls: "mtg-copy-card-tab-btn" + (state.tab === t.key ? " is-active" : ""),
			text: t.label,
		});
		btn.addEventListener("click", () => switchIconTab(t.key));
		tabButtons[t.key] = btn;
	});
	const tabIndicatorEl = tabsEl.createDiv({ cls: "mtg-copy-card-tab-indicator" });
	const positionIndicator = (btn: HTMLElement) => {
		tabIndicatorEl.style.transform = `translateX(${btn.offsetLeft}px)`;
		tabIndicatorEl.style.width = `${btn.offsetWidth}px`;
	};
	// SYNCHRONOUS initial positioning, in the same tick as the creation of the
	// bar — nothing has been painted at another position yet from which to
	// slide, so it appears already at the right place with no unwanted sliding
	// on opening (same reasoning as CopyCardModal.buildChrome).
	positionIndicator(tabButtons[state.tab]!);

	// Fixed minimum height so the window doesn't change size depending on the
	// active tab (explicitly requested) — bounded to the same value as the cap
	// of the "Set Symbol" grid (.mtg-icon-picker-grid, max-height:45vh) since
	// it is the tallest tab of the 3; the shorter tabs (Mana/Other) just leave
	// empty space below rather than vary the window's total height.
	const body = contentEl.createDiv({ cls: "mtg-icon-picker-body" });

	// Mana Symbol/Other symbol: same 5-column grid as Set Symbol (explicitly
	// requested) — .mtg-icon-picker-grid, shared by the 3 tabs (see
	// styles.css), is what guarantees both the identical presentation AND the
	// identical height from one tab to another (same container, same
	// max-height/overflow-y, just fewer tiles to scroll).
	const renderSymbolGrid = (symbols: { letter: string; label: string; recolor?: boolean }[]) => {
		const grid = body.createDiv({ cls: "mtg-icon-picker-grid" });
		const selectTile = (tile: HTMLElement, icon: ListIcon | undefined) => {
			grid.querySelectorAll(".mtg-icon-picker-tile.is-selected").forEach((el) =>
				el.removeClass("is-selected")
			);
			tile.addClass("is-selected");
			state.pendingIcon = icon;
		};
		// The "None" tile (clear the pictogram) was removed from the 1st tab
		// (explicitly requested) — the "Choose icon" button of the main window
		// already carries its own small cross for that once an icon is chosen (see
		// below, removeIconBtn), so an empty cell at the head of the grid was
		// redundant.
		symbols.forEach(({ letter, label, recolor }) => {
			const tile = grid.createDiv({
				cls:
					"mtg-icon-picker-tile" +
					(state.pendingIcon?.kind === "mana" && state.pendingIcon.value === letter
						? " is-selected"
						: ""),
			});
			tile.setAttribute("title", label);
			void ctx.plugin.getManaSymbolSvg(letter).then((svg) => {
				if (!svg) return;
				setSvgMarkup(tile, svg);
				// Only the single-color "Other symbol" symbols (pure #000, no background)
				// need this recoloring — see the comment of OTHER_ICON_SYMBOLS for the
				// detail checked symbol by symbol. Never applied to a mana symbol (recolor
				// always absent on MANA_ICON_LETTERS), which must keep its true color.
				if (recolor) applySvgColor(tile, "var(--text-muted)");
			});
			tile.addEventListener("click", () => selectTile(tile, { kind: "mana", value: letter }));
		});
	};

	// "Set Symbol" tab: search + 5-column grid, the symbol alone — the set
	// name in a tooltip rather than as text under each tile (explicitly
	// requested). dedupeSetsByIcon (api/scryfall.ts) avoids listing separately
	// several sets that share the same symbol (tokens/promos/art series of the
	// same set, very frequent — 987 non-digital sets but only 337 distinct
	// symbols, checked live on the API — see that function's comment). All the
	// tiles are built ONLY ONCE (as soon as the list of sets arrives); the
	// search now only hides/shows the tiles already in place rather than
	// destroying/recreating them on each keystroke — a tile rebuilt exactly
	// under a cursor that stayed still doesn't re-trigger the browser's native
	// tooltip as long as no new mouseover event arrives on it (reported bug:
	// "the tooltip doesn't always appear"), whereas a tile that stays the same
	// DOM node throughout keeps its continuous hover.
	//
	// Grouped by category (Core Sets/Expansion Sets/Commander &
	// Multiplayer/etc. — explicitly requested, modeled on the Keyrune
	// reference page) via getSetGroupLabel/SET_GROUP_ORDER (api/scryfall.ts),
	// derived from Scryfall's set_type field rather than from a hand-written
	// list of sets — see the comment of these two exports for the full
	// reasoning. The search remains global, across all groups at once
	// (explicitly chosen rather than a fold/unfold per group): a group header
	// (grid-column:1/-1, like .mtg-status just below) simply hides if none of
	// its tiles is visible any more, exactly the same mechanism as
	// noResultsEl.
	const renderSetTab = () => {
		const searchInput = body.createEl("input", {
			type: "text",
			cls: "mtg-icon-picker-search",
			attr: { placeholder: "Search sets…" },
		});
		const setGridEl = body.createDiv({ cls: "mtg-icon-picker-grid" });
		const loadingEl = setGridEl.createEl("p", { text: "Loading sets…", cls: "mtg-status" });
		const noResultsEl = setGridEl.createEl("p", { text: "No set found.", cls: "mtg-status" });
		noResultsEl.addClass("mtg-hidden");
		let tiles: { el: HTMLElement; name: string }[] = [];
		let groupSections: { headerEl: HTMLElement; tileEls: HTMLElement[] }[] = [];

		const applyFilter = () => {
			const q = searchInput.value.trim().toLowerCase();
			let anyVisible = false;
			tiles.forEach(({ el, name }) => {
				const match = !q || name.includes(q);
				el.style.display = match ? "" : "none";
				if (match) anyVisible = true;
			});
			groupSections.forEach(({ headerEl, tileEls }) => {
				headerEl.style.display = tileEls.some((t) => t.style.display !== "none") ? "" : "none";
			});
			noResultsEl.toggleClass("mtg-hidden", !(tiles.length > 0 && !anyVisible));
		};
		searchInput.addEventListener("input", applyFilter);

		const buildTiles = (sets: ScryfallSetSummary[]) => {
			loadingEl.remove();
			tiles = [];
			groupSections = [];
			SET_GROUP_ORDER.forEach((groupLabel) => {
				// sets is already sorted alphabetically as a whole (see state.dedupedSets
				// below) — a simple filter() preserves this relative order within the
				// group, no second sort is needed here.
				const groupSets = sets.filter((s) => getSetGroupLabel(s.set_type) === groupLabel);
				if (groupSets.length === 0) return;
				const headerEl = setGridEl.createDiv({
					cls: "mtg-icon-picker-group-header",
					text: groupLabel,
				});
				const tileEls: HTMLElement[] = [];
				groupSets.forEach((s) => {
					const tile = setGridEl.createDiv({
						cls:
							"mtg-icon-picker-tile" +
							(state.pendingIcon?.kind === "set" && state.pendingIcon.value === s.code
								? " is-selected"
								: ""),
					});
					tile.setAttribute("title", s.name);
					void ctx.plugin.getSetIconSvg(s.code).then((svg) => {
						if (!svg) return;
						setSvgMarkup(tile, svg);
						applySvgColor(tile, "var(--text-muted)");
					});
					tile.addEventListener("click", () => {
						setGridEl
							.querySelectorAll(".mtg-icon-picker-tile.is-selected")
							.forEach((el) => el.removeClass("is-selected"));
						tile.addClass("is-selected");
						state.pendingIcon = { kind: "set", value: s.code };
					});
					tileEls.push(tile);
					tiles.push({ el: tile, name: s.name.toLowerCase() });
				});
				groupSections.push({ headerEl, tileEls });
			});
			applyFilter();
		};

		if (state.dedupedSets) {
			buildTiles(state.dedupedSets);
		} else {
			void ctx.plugin.getAllScryfallSets().then((sets) => {
				// Most recent first (explicitly requested) — released_at is an ISO string
				// (YYYY-MM-DD), hence comparable lexically without parsing; checked live
				// that all 987 non-digital sets have it filled in (the fallback to ""
				// below is therefore only there out of caution, never actually reached
				// today). Sorted only once here, globally — buildTiles now only filters by
				// group (see above), so the "most recent first" order is found by itself
				// within each group with no second sort.
				state.dedupedSets = dedupeSetsByIcon(sets).sort((a, b) =>
					(b.released_at ?? "").localeCompare(a.released_at ?? "")
				);
				buildTiles(state.dedupedSets);
			});
		}
	};

	const renderBody = () => {
		body.empty();
		if (state.tab === "mana") renderSymbolGrid(MANA_ICON_LETTERS);
		else if (state.tab === "other") renderSymbolGrid(OTHER_ICON_SYMBOLS);
		else renderSetTab();
	};

	// Referenced by the tab clicks above (closure, resolved only at click time
	// — never before this point in the code, so no ordering concern despite
	// the const declaration further down, same convention as
	// noneTile/setSelect elsewhere in this file).
	const switchIconTab = (tab: "mana" | "set" | "other") => {
		if (state.tab === tab) return;
		state.tab = tab;
		Object.values(tabButtons).forEach((btn) => btn.removeClass("is-active"));
		tabButtons[tab]!.addClass("is-active");
		positionIndicator(tabButtons[tab]!);
		renderBody();
	};
	renderBody();

	const saveCancelRow = contentEl.createDiv({ cls: "mtg-svg-btn-row mtg-icon-picker-save-row" });
	const cancelIconBtn = saveCancelRow.createEl("button", {
		text: "Cancel",
		cls: "mtg-icon-picker-cancel-btn",
	});
	cancelIconBtn.addEventListener("click", ctx.onCancel);
	const saveBtn = saveCancelRow.createEl("button", { text: "Save", cls: "mtg-search-add-btn" });
	saveBtn.addEventListener("click", () => {
		ctx.save(state.pendingIcon);
		new Notice(state.pendingIcon ? `${noun} icon updated.` : `${noun} icon removed.`);
		ctx.onDone();
	});
}
