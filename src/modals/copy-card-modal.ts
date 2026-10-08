import { App, Modal, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { CollectionCard, WantlistCard } from "../core/card-model";
import { DeckCard, getDeckCardCategory, ListIcon } from "../core/data-model";
import { NewListModal, NewDeckModal, NewWantlistModal } from "./new-entity-modals";
import { groupByList, groupByWantlist, formatMoney, resolveDeckCoverImage } from "../core/price";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import { applySvgColor } from "../api/scryfall";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  Copy card modal (duplicate a card into another list/deck/wantlist,       */
/*  without removing it from where it already is)                           */
/* -------------------------------------------------------------------------- */

type TabKey = "collection" | "decks" | "wantlists";

const TAB_DEFS: { key: TabKey; label: string }[] = [
	{ key: "collection", label: "Collection" },
	{ key: "decks", label: "Decks" },
	{ key: "wantlists", label: "Wantlists" },
];

export class CopyCardModal extends Modal {
	private plugin: MTGCollectionPlugin;
	// Always an array, even for a single card (see the call sites in
	// card-detail-modal.ts/wantlist-card-detail-modal.ts, which pass a
	// 1-element array) — a single code path for the simple case (detail panel)
	// and the multiple case (My Collection's bulk-actions bar, "Move
	// to…"/"Copy to…") rather than two parallel implementations to maintain
	// separately.
	private cards: (CollectionCard | WantlistCard | DeckCard)[];
	// Where the copied/moved cards come from: determines which plugin method
	// to call (the collection/wantlist/deck arrays are distinct), regardless
	// of the destination tab chosen below. All the cards of a single call
	// share the same source — the bulk-actions bar never mixes collection and
	// wantlist in the same selection, and a deck's detail panel never opens
	// this modal with more than one DeckCard at a time (see "deck" below).
	private sourceKind: "collection" | "wantlist" | "deck";
	// Needed only when sourceKind === "deck": a DeckCard has no id field of
	// its own (see "Data model notes" in CLAUDE.md) nor a reference to its
	// parent deck —
	// copyDeckCardToList/copyDeckCardToDeck/copyDeckCardToWantlist (plugin.ts)
	// therefore need to be told explicitly where the card starts from.
	private deckContext?: { deckId: string };
	// "move" removes each card from its source once added to the destination —
	// same gallery of destinations as "copy", only the plugin method called
	// differs (see copyToList/copyToDeck/copyToWantlist).
	private mode: "copy" | "move";
	private onDone: () => void;
	private activeTab: TabKey = "collection";
	private galleryEl!: HTMLElement;
	// Reset to "" on every tab change (see selectTab) — a query typed in "My
	// Decks" makes no sense once switched to "My Wantlists".
	private searchQuery = "";
	private searchInputEl!: HTMLInputElement;
	// Tabs + indicator built ONLY ONCE (in buildChrome, called from onOpen)
	// rather than rebuilt on every click like the rest of this modal —
	// explicitly requested ("smoother transitions"). A CSS transition can only
	// animate an element from one state to another ON THE SAME element;
	// rebuilding the buttons on every click (the old behavior, inherited from
	// renderGallery elsewhere in this file) never leaves anything to animate
	// from. These references therefore persist for the whole lifetime of the
	// modal.
	private tabButtons: Partial<Record<TabKey, HTMLElement>> = {};
	private tabIndicatorEl!: HTMLElement;
	// Staggers the appearance of the first tiles of a freshly displayed
	// gallery (opening, tab change) — never while typing in the search, which
	// must stay instant so as not to slow down an active filtering. Reset to 0
	// at the start of each renderGallery(), incremented per tile to space out
	// their delay (see revealTile).
	private tileStaggerIndex = 0;
	private staggerNextGallery = false;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		cards: (CollectionCard | WantlistCard | DeckCard)[],
		sourceKind: "collection" | "wantlist" | "deck",
		onDone: () => void,
		mode: "copy" | "move" = "copy",
		deckContext?: { deckId: string }
	) {
		super(app);
		this.plugin = plugin;
		this.cards = cards;
		this.sourceKind = sourceKind;
		this.onDone = onDone;
		this.mode = mode;
		this.deckContext = deckContext;
	}

	onOpen() {
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts. Explicitly requested for this modal in particular
		// ("can the 'Move card' modal appear the same way as the card detail
		// window") after which the same animation was generalized to all the
		// plugin's other modals.
		applyModalOpenAnimation(this);
		// Round close cross + hiding of Obsidian's native cross, shared by all of
		// the plugin's modals — see modal-animation.ts.
		addModalCloseButton(this);
		this.buildChrome();
		this.renderGallery(true);
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	// Title + tabs + indicator + search bar + (empty) gallery container:
	// everything that must survive a tab change without being
	// destroyed/recreated. Called only once, from onOpen().
	private buildChrome() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mtg-copy-card-modal");
		contentEl.addClass("mtg-list-actions-modal");
		// Plural title beyond one card (same convention as MarkAsAcquiredModal:
		// "Mark as acquired" vs "Mark N cards as acquired") — My Collection's
		// bulk-actions bar can open this modal with several cards selected at
		// once.
		const count = this.cards.length;
		const title =
			this.mode === "move"
				? count === 1
					? "Move card"
					: `Move ${count} cards`
				: count === 1
					? "Copy card to"
					: `Copy ${count} cards to`;
		contentEl.createEl("h2", { text: title });

		const tabsEl = contentEl.createDiv({ cls: "mtg-copy-card-tabs" });
		TAB_DEFS.forEach((t) => {
			const btn = tabsEl.createDiv({
				cls: "mtg-copy-card-tab-btn" + (this.activeTab === t.key ? " is-active" : ""),
				text: t.label,
			});
			btn.addEventListener("click", () => this.selectTab(t.key));
			this.tabButtons[t.key] = btn;
		});
		// Single bar that slides from one tab to the other (see positionIndicator)
		// rather than a border per button toggled on click — this is precisely
		// what enables the requested sliding: a single instance, never rebuilt, of
		// which only transform/width is changed.
		this.tabIndicatorEl = tabsEl.createDiv({ cls: "mtg-copy-card-tab-indicator" });

		const searchWrap = contentEl.createDiv({ cls: "mtg-copy-card-search" });
		this.searchInputEl = searchWrap.createEl("input", {
			cls: "mtg-copy-card-search-input",
			type: "text",
		});
		this.searchInputEl.setAttribute("placeholder", this.searchPlaceholder());
		// Rebuilds ONLY the gallery (not the tabs/the search) on every keystroke —
		// rebuilding this <input> itself would cut the focus in the middle of
		// typing (same risk documented for pendingFocusRestore/renderChipFilter
		// elsewhere in this plugin). Never a staggered delay here
		// (staggerNextGallery stays false): a filtering must react immediately,
		// not ripple on every typed character.
		this.searchInputEl.addEventListener("input", () => {
			this.searchQuery = this.searchInputEl.value;
			this.renderGallery();
		});

		this.galleryEl = contentEl.createDiv({ cls: "mtg-copy-card-gallery" });

		// Initial position set synchronously, in the same pass as the construction
		// of the buttons: the indicator has never been painted anywhere else, so
		// there is nothing to animate FROM — unlike selectTab below, which runs
		// after a first render that is already visible.
		this.positionIndicator(this.activeTab);
	}

	private selectTab(key: TabKey) {
		if (this.activeTab === key) return;
		this.tabButtons[this.activeTab]?.removeClass("is-active");
		this.activeTab = key;
		this.tabButtons[key]?.addClass("is-active");
		this.positionIndicator(key);
		this.searchQuery = "";
		this.searchInputEl.value = "";
		this.searchInputEl.setAttribute("placeholder", this.searchPlaceholder());
		this.renderGallery(true);
	}

	private positionIndicator(key: TabKey) {
		const btn = this.tabButtons[key];
		if (!btn) return;
		this.tabIndicatorEl.style.transform = `translateX(${btn.offsetLeft}px)`;
		this.tabIndicatorEl.style.width = `${btn.offsetWidth}px`;
	}

	private searchPlaceholder(): string {
		if (this.activeTab === "collection") return "Search lists…";
		if (this.activeTab === "decks") return "Search decks…";
		return "Search wantlists…";
	}

	private renderGallery(stagger = false) {
		this.galleryEl.empty();
		this.tileStaggerIndex = 0;
		this.staggerNextGallery = stagger;
		if (this.activeTab === "collection") this.renderCollectionTab();
		else if (this.activeTab === "decks") this.renderDecksTab();
		else this.renderWantlistsTab();
	}

	private matchesSearch(name: string): boolean {
		const query = this.searchQuery.trim().toLowerCase();
		return !query || name.toLowerCase().includes(query);
	}

	// Makes a freshly built tile appear, one by one rather than all at once,
	// on the initial opening and on a tab change (staggerNextGallery) —
	// explicitly requested ("the first suggestions could appear one by one").
	// Capped at the first 8 tiles: beyond that, same delay as the 8th rather
	// than an endless stretching for a long list — the idea is to make the
	// first results visible on screen "arrive", not to animate an entire
	// gallery of 50 rows in a row. Outside the stagger (search in progress),
	// the class is set right away: nothing to animate from in the same
	// repaint, so no transition plays, exactly the "instant" effect wanted.
	private revealTile(tile: HTMLElement) {
		if (!this.staggerNextGallery) {
			tile.addClass("is-visible");
			return;
		}
		const delay = Math.min(this.tileStaggerIndex, 8) * 40;
		this.tileStaggerIndex++;
		window.setTimeout(() => tile.addClass("is-visible"), delay);
	}

	private renderNewTile(label: string, onClick: () => void) {
		const tile = this.galleryEl.createDiv({
			cls: "mtg-copy-card-gallery-tile mtg-copy-card-gallery-tile-new",
		});
		tile.createDiv({ cls: "mtg-copy-card-gallery-name", text: label });
		tile.addEventListener("click", onClick);
		this.revealTile(tile);
	}

	// `pictogram` (Lucide icon name): only for the "Inbox" tile (see
	// renderCollectionTab) — same treatment as its tile in the main "My
	// Collection" grid (.mtg-set-tile-inbox/renderListTile): solid accent
	// color, no background image/gradient, with its small pictogram,
	// explicitly requested after it came out here without this treatment
	// (plain gray background like any other list).
	// `pictogram`/`value`: only for the "Inbox" tile (see renderCollectionTab)
	// — 3rd line (total value) in addition, to faithfully reproduce its tile
	// of the main "My Collection" grid (renderListTile: name / "X unique · Y
	// cards" / value), explicitly requested after a first version that only
	// reproduced name + number of cards on 2 lines.
	private renderTile(
		coverImage: string,
		name: string,
		meta: string,
		onClick: () => void,
		pictogram?: string,
		value?: string,
		icon?: ListIcon
	) {
		const tile = this.galleryEl.createDiv({
			cls: "mtg-copy-card-gallery-tile" + (pictogram ? " mtg-copy-card-gallery-tile-inbox" : ""),
		});
		// The background lives on its own layer (like .mtg-set-tile-bg for the
		// tiles of the "My Collection" grid) rather than directly on the tile, so
		// that the hover zoom (see styles.css) only affects the image — the
		// overlay text, a separate child, stays stable. Never created for Inbox
		// (same principle as renderListTile for the main grid): nothing to
		// neutralize on the background side, the solid accent comes directly from
		// .mtg-copy-card-gallery-tile-inbox in CSS.
		if (!pictogram) {
			const bg = tile.createDiv({ cls: "mtg-copy-card-gallery-tile-bg" });
			if (coverImage) bg.style.backgroundImage = `url("${coverImage}")`;
		}
		const overlay = tile.createDiv({ cls: "mtg-copy-card-gallery-overlay" });
		if (pictogram) {
			setIcon(overlay.createDiv({ cls: "mtg-copy-card-gallery-pictogram" }), pictogram);
			const textWrap = overlay.createDiv({ cls: "mtg-copy-card-gallery-pinned-text" });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-name", text: name });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-meta", text: meta });
			if (value) {
				textWrap.createDiv({ cls: "mtg-copy-card-gallery-value", text: value });
			}
		} else if (icon) {
			// Manually chosen pictogram (ListSettingsModal, "Choose icon") — same
			// slightly-opaque circle as the Inbox tile above
			// (.mtg-copy-card-gallery-pictogram, reused as is), placed in a nested row
			// (mtg-copy-card-gallery-icon-row) rather than on
			// .mtg-copy-card-gallery-overlay itself: this tile keeps its background
			// image + darkened gradient toward the bottom (unlike Inbox, flat
			// background), so the text must stay anchored at the bottom of the overlay
			// as before — only this new block (circle + text) is a row, not the entire
			// overlay. Mana displayed as is (already colored by Scryfall), set
			// recolored in white to stay readable in this dark circle.
			const iconRow = overlay.createDiv({ cls: "mtg-copy-card-gallery-icon-row" });
			const iconCircle = iconRow.createDiv({ cls: "mtg-copy-card-gallery-pictogram" });
			const fetchIcon =
				icon.kind === "mana"
					? this.plugin.getManaSymbolSvg(icon.value)
					: this.plugin.getSetIconSvg(icon.value);
			void fetchIcon.then((svg) => {
				if (!svg) return;
				setSvgMarkup(iconCircle, svg);
				if (icon.kind === "set") applySvgColor(iconCircle, "#ffffff");
			});
			const textWrap = iconRow.createDiv({ cls: "mtg-copy-card-gallery-icon-text" });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-name", text: name });
			textWrap.createDiv({ cls: "mtg-copy-card-gallery-meta", text: meta });
		} else {
			overlay.createDiv({ cls: "mtg-copy-card-gallery-name", text: name });
			overlay.createDiv({ cls: "mtg-copy-card-gallery-meta", text: meta });
		}
		tile.addEventListener("click", onClick);
		this.revealTile(tile);
	}

	private finishAction(destinationName: string) {
		const verb = this.mode === "move" ? "Moved" : "Copied";
		const subject =
			this.cards.length === 1 ? `"${this.cards[0].name}"` : `${this.cards.length} card(s)`;
		new Notice(`${verb} ${subject} to "${destinationName}".`);
		this.close();
		this.onDone();
	}

	private renderCollectionTab() {
		this.renderNewTile("+ New list", () => {
			new NewListModal(this.app, this.plugin, (list) => {
				this.copyToList(list.id, list.name);
			}).open();
		});
		const groups = groupByList(
			this.plugin.settings.lists,
			this.plugin.settings.collection,
			this.plugin.settings.priceCurrency
		);
		// See renderTile — same identification of the "Inbox" system list as
		// renderListTile/renderListGrid for the main grid
		// (CollectionList.isInbox). Pinned as the first tile (right after "+ New
		// list") rather than left in the alphabetical order of groupByList —
		// reported bug: Inbox was only first by coincidence (when its name sorted
		// before all the other lists) and ended up elsewhere as soon as a list
		// preceded it alphabetically. Same treatment as renderListGrid (view.ts)
		// for the main grid: removed from the array, re-injected separately at the
		// head.
		const inboxListId = this.plugin.settings.lists.find((l) => l.isInbox)?.id;
		const inboxGroup = groups.find((g) => g.id === inboxListId);
		const otherGroups = groups.filter((g) => g.id !== inboxListId);
		const renderGroupTile = (g: (typeof groups)[number], isInbox: boolean) => {
			this.renderTile(
				g.coverImage,
				g.name,
				// "X unique · Y cards" for Inbox (same label as its tile in the main grid,
				// renderListTile) — the other tiles keep their single "N cards" line, not
				// concerned by this request.
				isInbox ? `${g.cards.length} unique · ${g.totalQty} cards` : `${g.totalQty} cards`,
				() => this.copyToList(g.id, g.name),
				isInbox ? "inbox" : undefined,
				isInbox ? formatMoney(g.totalValue, this.plugin.settings.priceCurrency) : undefined,
				isInbox ? undefined : g.icon
			);
		};
		if (inboxGroup && this.matchesSearch(inboxGroup.name)) {
			renderGroupTile(inboxGroup, true);
		}
		otherGroups
			.filter((g) => this.matchesSearch(g.name))
			.forEach((g) => renderGroupTile(g, false));
	}

	private copyToList(listId: string, name: string) {
		// Deck → list: separate, unlike the 2 branches below —
		// copyDeckCardToList/moveDeckCardToList (plugin.ts) are asynchronous
		// (Scryfall round trip needed — CollectionCard has fields that DeckCard
		// still doesn't, e.g. releasedAt, price aside since 2026-09-02) and find
		// their row by scryfallId + category rather than by id
		// (this.deckContext.deckId provides the starting deck).
		if (this.sourceKind === "deck") {
			const deckId = this.deckContext?.deckId;
			if (!deckId) return;
			void Promise.all(
				(this.cards as DeckCard[]).map((card) => {
					const category = getDeckCardCategory(card);
					return this.mode === "move"
						? this.plugin.moveDeckCardToList(deckId, card.scryfallId, category, listId)
						: this.plugin.copyDeckCardToList(deckId, card.scryfallId, category, listId);
				})
			).then(() => this.finishAction(name));
			return;
		}

		// Loop over this.cards rather than calling a dedicated "bulk" plugin method:
		// copyCollectionCardToList/moveCollectionCardToList (and their wantlist
		// equivalents) already do all the necessary work per card (merging with an
		// existing entry, saveSettings() — debounced, so N rapid calls don't cost N disk
		// writes); reusing them as is for 1 card as for N avoids maintaining a second
		// implementation of the same merge logic.
		(this.cards as (CollectionCard | WantlistCard)[]).forEach((card) => {
			if (this.sourceKind === "wantlist") {
				if (this.mode === "move") {
					this.plugin.moveWantlistCardsToCollection([card.id], listId, "", "en");
				} else {
					this.plugin.copyWantlistCardToList(card.id, listId);
				}
			} else {
				if (this.mode === "move") {
					this.plugin.moveCollectionCardToList(card.id, listId);
				} else {
					this.plugin.copyCollectionCardToList(card.id, listId);
				}
			}
		});
		this.finishAction(name);
	}

	private renderDecksTab() {
		this.renderNewTile("+ New deck", () => {
			new NewDeckModal(this.app, this.plugin, (deck) => {
				this.copyToDeck(deck.id, deck.name);
			}).open();
		});
		this.plugin.settings.decks
			// The source deck (sourceKind === "deck") has no place in its own gallery
			// of destinations — "move to the deck where the card already is" makes no
			// sense, and copyDeckCardToDeck/moveDeckCardToDeck (plugin.ts) treat this
			// case as an explicit no-op rather than risk losing a card.
			.filter((deck) => deck.id !== this.deckContext?.deckId)
			.filter((deck) => this.matchesSearch(deck.name))
			.forEach((deck) => {
				// Same manual/automatic choice (Deck.coverCardId, DeckSettingsModal's
				// "Choose cover image") as the "My Decks" grid (renderDeckGrid) — rather
				// than the plain 1st card with an image found in deck.cards.
				const cover = resolveDeckCoverImage(deck.cards, deck.coverCardId);
				const totalQty = deck.cards.reduce((s, c) => s + c.count, 0);
				this.renderTile(
					cover,
					deck.name,
					`${deck.cards.length} unique · ${totalQty} cards`,
					() => this.copyToDeck(deck.id, deck.name),
					undefined,
					undefined,
					deck.deckIcon
				);
			});
	}

	private copyToDeck(deckId: string, name: string) {
		if (this.sourceKind === "deck") {
			const fromDeckId = this.deckContext?.deckId;
			if (!fromDeckId) return;
			(this.cards as DeckCard[]).forEach((card) => {
				const category = getDeckCardCategory(card);
				if (this.mode === "move") {
					this.plugin.moveDeckCardToDeck(fromDeckId, card.scryfallId, category, deckId);
				} else {
					this.plugin.copyDeckCardToDeck(fromDeckId, card.scryfallId, category, deckId);
				}
			});
			this.finishAction(name);
			return;
		}

		(this.cards as (CollectionCard | WantlistCard)[]).forEach((card) => {
			if (this.sourceKind === "wantlist") {
				this.plugin.addWantlistCardToDeck(card, deckId);
				if (this.mode === "move") this.plugin.bulkRemoveWantlistCards([card.id]);
			} else {
				this.plugin.addCollectionCardToDeck(card, deckId);
				if (this.mode === "move") this.plugin.removeCollectionCard(card.id);
			}
		});
		this.finishAction(name);
	}

	private renderWantlistsTab() {
		this.renderNewTile("+ New wantlist", () => {
			new NewWantlistModal(this.app, this.plugin, (wantlist) => {
				this.copyToWantlist(wantlist.id, wantlist.name);
			}).open();
		});
		const groups = groupByWantlist(
			this.plugin.settings.wantlists,
			this.plugin.settings.wantlist,
			this.plugin.settings.priceCurrency
		);
		groups
			.filter((g) => this.matchesSearch(g.name))
			.forEach((g) => {
				this.renderTile(
					g.coverImage,
					g.name,
					`${g.totalQty} cards`,
					() => this.copyToWantlist(g.id, g.name),
					undefined,
					undefined,
					g.icon
				);
			});
	}

	private copyToWantlist(wantlistId: string, name: string) {
		// See copyToList — same reasoning (asynchronous, Scryfall round trip) for
		// copyDeckCardToWantlist/moveDeckCardToWantlist.
		if (this.sourceKind === "deck") {
			const deckId = this.deckContext?.deckId;
			if (!deckId) return;
			void Promise.all(
				(this.cards as DeckCard[]).map((card) => {
					const category = getDeckCardCategory(card);
					return this.mode === "move"
						? this.plugin.moveDeckCardToWantlist(deckId, card.scryfallId, category, wantlistId)
						: this.plugin.copyDeckCardToWantlist(deckId, card.scryfallId, category, wantlistId);
				})
			).then(() => this.finishAction(name));
			return;
		}

		(this.cards as (CollectionCard | WantlistCard)[]).forEach((card) => {
			if (this.sourceKind === "wantlist") {
				if (this.mode === "move") {
					this.plugin.moveWantlistCardToWantlist(card.id, wantlistId);
				} else {
					this.plugin.copyWantlistCardToWantlist(card.id, wantlistId);
				}
			} else {
				if (this.mode === "move") {
					this.plugin.moveCollectionCardToWantlist(card.id, wantlistId);
				} else {
					this.plugin.copyCollectionCardToWantlist(card.id, wantlistId);
				}
			}
		});
		this.finishAction(name);
	}

	onClose() {
		this.contentEl.empty();
	}
}
