import { setIcon, Notice } from "obsidian";
import type { MTGCollectionView } from "../view";
import { cardValue, formatCardPrice, formatMoney, formatSignedMoney, toDeckPricedCard } from "../core/price";
import { finishHasFoilLook } from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import type { CollectionCard, WantlistCard } from "../core/card-model";
import type { CardbaseMover, CardbaseMoverPeriod, CardbaseVendor } from "../api/cardbase";
import { CARDBASE_VENDOR_LABELS, CARDBASE_FINISH_LABELS } from "../api/cardbase";
import { convertUsdEur } from "../api/frankfurter";
import type { ScryfallImmutableSnapshot } from "../api/scryfall";
import {
	selectDisplayMovers,
	getMoversAgeDays,
	isMoversDataStale,
	moverFinishOf,
	moverOwnershipKey,
	moverNativeCurrency,
	getMoverPriceDisplay,
} from "../core/market-movers";
import type { MoverConvert } from "../core/market-movers";
import { computeColorBreakdown, computeRarityBreakdown, getDeckSizeStatus } from "../core/deck-stats";
import { renderColorPieChart } from "../ui/deck-stats-fx";
import { NewDeckModal, NewWantlistModal } from "../modals/new-entity-modals";
import { CardPreviewModal } from "../modals/card-preview-modal";


const HOME_RECENT_CARDS_LIMIT = 10;
// Market Trends: visible rows per column, collapsed then expanded ("Show
// more", 2026-09-23). The expanded cap is also the number of rows per side
// for which the Scryfall snapshots are fetched right away (see loadAndDraw).
const HOME_MOVERS_COLLAPSED_LIMIT = 5;
const HOME_MOVERS_EXPANDED_LIMIT = 20;

const HOME_MOVER_PERIOD_LABELS: Record<CardbaseMoverPeriod, string> = {
	"1d": "24h",
	"7d": "7 days",
	"30d": "30 days",
};

// Scaffold shared by every dashboard block (icon + uppercase title, then a
// body the caller fills) — a pure DOM helper with no view/plugin state of
// its own, so unlike the functions below it stays a plain local function
// rather than a `this`-parameter one wired into MTGCollectionView.
function makeHomeBlock(container: HTMLElement, icon: string, title: string): HTMLElement {
	const block = container.createDiv({ cls: "mtg-home-block" });
	const header = block.createDiv({ cls: "mtg-home-block-header" });
	setIcon(header.createDiv({ cls: "mtg-home-block-header-icon" }), icon);
	header.createSpan({ text: title });
	return block.createDiv({ cls: "mtg-home-block-body" });
}

// A section heading (Overview / Recently Added / Market Trend) above its
// own mini-grid of blocks — same grid mechanism as before (`mtg-home-grid`,
// reused rather than a separate variant: a section with a single block,
// like Market Trend, just stretches that one child full-width, no special
// case needed). Same reasoning as makeHomeBlock: no view/plugin state,
// stays a plain local function.
function makeHomeSection(container: HTMLElement, title: string): HTMLElement {
	const section = container.createDiv({ cls: "mtg-home-section" });
	section.createEl("h4", { cls: "mtg-home-section-title", text: title });
	return section.createDiv({ cls: "mtg-home-grid" });
}

export function renderHomeSection(this: MTGCollectionView) {
	const container = this.bodyEl.createDiv({ cls: "mtg-home" });
	container.createEl("h3", { text: "Home", cls: "mtg-detail-title mtg-home-title" });

	this.renderHomeOverview(container);

	// One shared "Recently Added" section for both carousels — each block
	// still built by the same renderHomeRecentCarousel (see its own
	// comment below), just handed this section's grid instead of a
	// top-level one now that Home has 3 named sections, not one flat grid.
	const recentGrid = makeHomeSection(container, "Recently added");
	this.renderHomeRecentCarousel(recentGrid, {
		icon: "layers",
		title: "Collection",
		cards: [...this.plugin.settings.collection]
			.sort((a, b) => b.dateAdded - a.dateAdded)
			.slice(0, HOME_RECENT_CARDS_LIMIT),
		onOpenCard: (id) => this.openCollectionCardDetailById(id),
		emptyText: "No cards in your collection yet.",
		actionIcon: "plus",
		actionLabel: "Add cards",
		onAction: () => this.openAddCollectionCardsModalWithListPicker(),
	});
	this.renderHomeRecentCarousel(recentGrid, {
		icon: "heart",
		title: "Wantlists",
		cards: [...this.plugin.settings.wantlist]
			.sort((a, b) => b.dateAdded - a.dateAdded)
			.slice(0, HOME_RECENT_CARDS_LIMIT),
		onOpenCard: (id) => this.openWantlistCardDetailById(id),
		emptyText: "No cards in your wantlists yet.",
		actionIcon: "plus",
		actionLabel: "Add to wantlist",
		onAction: () => this.openAddWantlistCardsModalWithListPicker(),
	});

	const insightsGrid = makeHomeSection(container, "Insights");
	const currency = this.plugin.settings.priceCurrency;
	this.renderHomeRecentCarousel(insightsGrid, {
		icon: "trophy",
		title: "Top value",
		cards: [...this.plugin.settings.collection]
			.sort((a, b) => cardValue(b, currency) - cardValue(a, currency))
			.slice(0, HOME_RECENT_CARDS_LIMIT),
		onOpenCard: (id) => this.openCollectionCardDetailById(id),
		emptyText: "No priced cards in your collection yet.",
		actionIcon: "plus",
		actionLabel: "Add cards",
		onAction: () => this.openAddCollectionCardsModalWithListPicker(),
	});
	this.renderHomeColorBreakdown(insightsGrid);
	this.renderHomeRarityBreakdown(insightsGrid);
	this.renderHomeDecksToFinish(insightsGrid);

	this.renderHomeMarketTrends(container);
}

export function renderHomeOverview(this: MTGCollectionView, container: HTMLElement) {
	const grid = makeHomeSection(container, "Overview");
	const currency = this.plugin.settings.priceCurrency;
	const { lists, collection, decks, wantlists, wantlist } = this.plugin.settings;

	const totalCollectionCards = collection.reduce((sum, c) => sum + c.count, 0);
	const totalCollectionValue = collection.reduce((sum, c) => sum + cardValue(c, currency), 0);

	const totalDeckCards = decks.reduce((sum, d) => sum + d.cards.reduce((s, c) => s + c.count, 0), 0);
	const totalDeckValue = decks.reduce(
		(sum, d) => sum + d.cards.reduce((s, c) => s + cardValue(toDeckPricedCard(c), currency), 0),
		0
	);

	const totalWantlistCards = wantlist.reduce((sum, c) => sum + c.count, 0);
	const totalWantlistValue = wantlist.reduce((sum, c) => sum + cardValue(c, currency), 0);

	const buildStatBlock = (
		icon: string,
		title: string,
		stats: string,
		onOpenSection: () => void,
		actionLabel: string,
		onAction: () => void
	) => {
		const body = makeHomeBlock(grid, icon, title);
		const row = body.createDiv({ cls: "mtg-home-overview-row", text: stats });
		row.addEventListener("click", onOpenSection);
		const btn = body.createEl("button", { cls: "mtg-search-add-btn", text: actionLabel });
		btn.addEventListener("click", onAction);
	};

	buildStatBlock(
		"layers",
		"Collection",
		// Same figure as the My Collection header: Inbox is not counted as a list
		// (see renderCollectionSection).
		`${lists.filter((l) => !l.isInbox).length} lists · ${totalCollectionCards} cards · ${formatMoney(totalCollectionValue, currency)}`,
		() => {
			this.activeSection = "collection";
			this.render();
		},
		"+ Add cards",
		() => this.openAddCollectionCardsModalWithListPicker()
	);
	buildStatBlock(
		"swords",
		"Decks",
		`${decks.length} decks · ${totalDeckCards} cards · ${formatMoney(totalDeckValue, currency)}`,
		() => {
			this.activeSection = "decks";
			this.render();
		},
		"+ New deck",
		() => {
			new NewDeckModal(this.app, this.plugin, (deck) => this.openDeck(deck.id)).open();
		}
	);
	buildStatBlock(
		"heart",
		"Wantlists",
		`${wantlists.length} wantlists · ${totalWantlistCards} cards · ${formatMoney(totalWantlistValue, currency)}`,
		() => {
			this.activeSection = "wantlists";
			this.render();
		},
		"+ New wantlist",
		() => {
			new NewWantlistModal(this.app, this.plugin, (wantlist) => this.openWantlist(wantlist.id)).open();
		}
	);

	const backupBody = makeHomeBlock(grid, "save", "Backup");
	const backupStatusText = () =>
		this.plugin.settings.lastAutoBackup
			? `Last backup: ${new Date(this.plugin.settings.lastAutoBackup).toLocaleString()}`
			: "No automatic backup yet.";
	const backupStatus = backupBody.createDiv({ cls: "mtg-home-overview-row", text: backupStatusText() });
	backupStatus.addEventListener("click", () => this.openPluginSettings());

	// GitHub sync status (2026-10-05): only if it is enabled on THIS device. Repainted on every change of the
	// engine's state, without redoing Home's render (render() would also rebuild the carousels for a line of
	// text). The next render() creates a new line: we replace the subscription of the previous one; the old,
	// detached line is ignored in the meantime (isConnected).
	const syncRow = backupBody.createDiv({ cls: "mtg-home-overview-row mtg-home-sync-row" });
	syncRow.addEventListener("click", () => this.openPluginSettings());
	const paintSync = () => {
		const status = this.plugin.githubHomeStatus();
		syncRow.style.display = status ? "" : "none";
		syncRow.removeClass("is-ok", "is-warn", "is-error");
		if (!status) return;
		syncRow.addClass(`is-${status.tone}`);
		syncRow.setText(status.text);
	};
	paintSync();
	this.homeSyncUnsub?.();
	this.homeSyncUnsub = this.plugin.subscribeGithubStatus(() => {
		if (syncRow.isConnected) paintSync();
	});
	const backupBtn = backupBody.createEl("button", { cls: "mtg-search-add-btn", text: "Back up now" });
	const backUpNow = async () => {
		const result = await this.plugin.runAutoBackup();
		if ("error" in result) {
			new Notice(`Backup failed: ${result.error}`);
			return;
		}
		new Notice(`Backup saved to ${result.path}.`);
		backupStatus.setText(backupStatusText());
	};
	backupBtn.addEventListener("click", () => void backUpNow());
}

interface HomeCarouselOptions {
	icon: string;
	title: string;
	cards: (CollectionCard | WantlistCard)[];
	onOpenCard: (id: string) => void;
	emptyText: string;
	actionIcon: string;
	actionLabel: string;
	onAction: () => void;
}

// Same mechanism as "Copies in Lists" (card-detail-modal.ts and its 2
// variants: scrolling scroll-snap track + arrows that do
// scrollBy(±track.clientWidth)) — its own family of classes
// (mtg-home-carousel-*) rather than reusing mtg-copies-in-lists-* as is:
// the tiles there are a fraction (1/3) of the modal panel's width (~1100px
// known in advance), whereas here a block's width depends on mtg-home-grid
// — fixed-width tiles (px) adapt to any block width without recalculation.
// Shared between Collection and Wantlists (called twice with different
// options) rather than tripled: unlike the rendering of a whole section,
// this is a pure presentation block, in the same spirit as
// renderThumbWithBadge (already shared between the 3 sections for the same
// reason).
export function renderHomeRecentCarousel(
	this: MTGCollectionView,
	container: HTMLElement,
	opts: HomeCarouselOptions
) {
	const body = makeHomeBlock(container, opts.icon, opts.title);

	if (opts.cards.length === 0) {
		body.createDiv({ cls: "mtg-status", text: opts.emptyText });
		const btn = body.createEl("button", { cls: "mtg-search-add-btn", text: opts.actionLabel });
		btn.addEventListener("click", opts.onAction);
		return;
	}

	const row = body.createDiv({ cls: "mtg-home-carousel-row" });
	const leftArrow = row.createDiv({ cls: "mtg-home-carousel-arrow" });
	setIcon(leftArrow, "chevron-left");
	const track = row.createDiv({ cls: "mtg-home-carousel-track" });
	const rightArrow = row.createDiv({ cls: "mtg-home-carousel-arrow" });
	setIcon(rightArrow, "chevron-right");
	// No layout measurement here (unlike "Copies in Lists", which knows its
	// track width in advance) — a single card is enough to know there is
	// nothing to scroll; beyond that, scrollBy() on a track that doesn't
	// overflow yet simply does nothing visible.
	leftArrow.toggleClass("is-disabled", opts.cards.length <= 1);
	rightArrow.toggleClass("is-disabled", opts.cards.length <= 1);
	leftArrow.addEventListener("click", () => track.scrollBy({ left: -track.clientWidth, behavior: "smooth" }));
	rightArrow.addEventListener("click", () => track.scrollBy({ left: track.clientWidth, behavior: "smooth" }));

	for (const card of opts.cards) {
		const tile = track.createDiv({ cls: "mtg-home-carousel-tile" });
		const imgWrap = tile.createDiv({ cls: "mtg-home-carousel-tile-image-wrap" });
		this.renderThumbWithBadge(
			imgWrap,
			card.imageUrl,
			card.setCode,
			card.rarity,
			finishHasFoilLook(card.finish),
			false,
			"tile"
		);
		const info = tile.createDiv({ cls: "mtg-home-carousel-tile-info" });
		info.createDiv({ cls: "mtg-home-carousel-tile-name", text: card.name });
		info.createDiv({
			cls: "mtg-home-carousel-tile-meta",
			text: `${card.count}x · ${formatCardPrice(card, this.plugin.settings.priceCurrency)}`,
		});
		tile.addEventListener("click", () => opts.onOpenCard(card.id));
	}

	const actionTile = row.createDiv({ cls: "mtg-home-carousel-action-tile" });
	setIcon(actionTile.createDiv({ cls: "mtg-home-carousel-action-icon" }), opts.actionIcon);
	actionTile.createDiv({ cls: "mtg-home-carousel-action-label", text: opts.actionLabel });
	actionTile.addEventListener("click", opts.onAction);
}

// Own key (not an `in`: "toString"/"constructor" are "in" any object) to
// validate a value read from data.json against a label table.
function isKnownKey(table: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(table, key);
}

// Everything drawResults() needs to (re)draw without a new request — this
// is what lets "Show more"/"Show less" toggle instantly. gainers/losers
// are ALREADY filtered (silently, see core/market-movers.ts) and sorted,
// truncated to HOME_MOVERS_EXPANDED_LIMIT.
interface MoversDrawData {
	gainers: CardbaseMover[];
	losers: CardbaseMover[];
	snapshots: Map<string, ScryfallImmutableSnapshot>;
	// undefined = exchange rate unavailable → vendor's native amounts (see
	// getMoverPriceDisplay).
	convert: MoverConvert | undefined;
	asOf: string | undefined;
}

export function renderHomeMarketTrends(this: MTGCollectionView, container: HTMLElement) {
	const grid = makeHomeSection(container, "Market trend");
	const body = makeHomeBlock(grid, "trending-up", "Market trends");
	// Captured here rather than read via `this`: setVendor below is a `function`
	// declaration (hoisted), whose `this` is NOT the view's.
	const plugin = this.plugin;
	const settings = plugin.settings;

	// Ownership and wantlist by printing AND finish (see moverFinishOf,
	// core/market-movers.ts: a foil's price moves independently of the
	// non-foil, an "owned" badge only makes sense for the same finish).
	// ownedEntryByPrinting is only used for the CLICK, to keep the old
	// behavior when no copy of the exact finish exists: a printing owned in
	// another finish still opens its sheet rather than the read-only preview.
	const ownedCountByKey = new Map<string, number>();
	const ownedEntryByKey = new Map<string, CollectionCard>();
	const ownedEntryByPrinting = new Map<string, CollectionCard>();
	for (const c of settings.collection) {
		if (!ownedEntryByPrinting.has(c.scryfallId)) ownedEntryByPrinting.set(c.scryfallId, c);
		const finish = moverFinishOf(c.finish);
		if (!finish) continue;
		const key = moverOwnershipKey(c.scryfallId, finish);
		ownedCountByKey.set(key, (ownedCountByKey.get(key) ?? 0) + c.count);
		if (!ownedEntryByKey.has(key)) ownedEntryByKey.set(key, c);
	}
	const wantedKeys = new Set<string>();
	for (const w of settings.wantlist) {
		const finish = moverFinishOf(w.finish);
		if (finish) wantedKeys.add(moverOwnershipKey(w.scryfallId, finish));
	}

	// Remembered choices (MTGCollectionSettings.homeMoversPeriod/Vendor); a
	// value that is no longer a known period/vendor (data.json edited by hand,
	// vendor removed later) falls back to the default rather than breaking the
	// whole block.
	const storedVendor = settings.homeMoversVendor;
	let period: CardbaseMoverPeriod = isKnownKey(HOME_MOVER_PERIOD_LABELS, settings.homeMoversPeriod)
		? settings.homeMoversPeriod
		: "1d";
	let vendor: CardbaseVendor | undefined =
		storedVendor !== "" && isKnownKey(CARDBASE_VENDOR_LABELS, storedVendor) ? storedVendor : undefined;
	let requestToken = 0;
	let lastData: MoversDrawData | undefined;

	const toolbar = body.createDiv({ cls: "mtg-home-trends-toolbar" });
	const periodTabs = toolbar.createDiv({ cls: "mtg-home-trends-period-tabs" });
	const periodButtons = new Map<CardbaseMoverPeriod, HTMLElement>();
	(Object.keys(HOME_MOVER_PERIOD_LABELS) as CardbaseMoverPeriod[]).forEach((p) => {
		const btn = periodTabs.createEl("button", {
			cls: "mtg-home-trends-period-btn",
			text: HOME_MOVER_PERIOD_LABELS[p],
		});
		btn.toggleClass("is-active", p === period);
		periodButtons.set(p, btn);
		btn.addEventListener("click", () => {
			if (period === p) return;
			period = p;
			settings.homeMoversPeriod = p;
			void plugin.saveSettings();
			periodButtons.forEach((el, key) => el.toggleClass("is-active", key === p));
			loadAndDraw();
		});
	});

	const vendorBtn = toolbar.createEl("button", { cls: "mtg-home-trends-vendor-btn" });
	const vendorLabelEl = vendorBtn.createSpan({ text: vendor ? CARDBASE_VENDOR_LABELS[vendor] : "All vendors" });
	setIcon(vendorBtn.createSpan({ cls: "mtg-home-trends-vendor-caret" }), "chevron-down");
	vendorBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		openPickerMenu(vendorBtn, [
			{
				render: (el: HTMLElement) => el.createSpan({ text: "All vendors" }),
				onSelect: () => setVendor(undefined),
			},
			...(Object.keys(CARDBASE_VENDOR_LABELS) as CardbaseVendor[]).map((v) => ({
				render: (el: HTMLElement) => el.createSpan({ text: CARDBASE_VENDOR_LABELS[v] }),
				onSelect: () => setVendor(v),
			})),
		]);
	});

	const resultsEl = body.createDiv({ cls: "mtg-home-trends-results" });

	function setVendor(v: CardbaseVendor | undefined) {
		if (vendor === v) return;
		vendor = v;
		settings.homeMoversVendor = v ?? "";
		void plugin.saveSettings();
		vendorLabelEl.setText(v ? CARDBASE_VENDOR_LABELS[v] : "All vendors");
		loadAndDraw();
	}

	const buildMoverRow = (
		parent: HTMLElement,
		mover: CardbaseMover,
		directionClass: "is-up" | "is-down",
		snapshot: ScryfallImmutableSnapshot | undefined,
		convert: MoverConvert | undefined
	) => {
		const key = moverOwnershipKey(mover.scryfallId, mover.finish);
		const ownedCount = ownedCountByKey.get(key) ?? 0;
		const isWanted = wantedKeys.has(key);
		const owned = ownedEntryByKey.get(key) ?? ownedEntryByPrinting.get(mover.scryfallId);
		const rowEl = parent.createDiv({ cls: "mtg-home-trends-row" });

		const imageUrl = snapshot?.image_uris?.normal ?? snapshot?.card_faces?.[0]?.image_uris?.normal ?? "";
		// cardbase's own finish enum ("normal"/"foil"/"etched"), not this
		// plugin's Finish type — finishHasFoilLook doesn't apply here, so a
		// plain boolean instead of misusing/adapting that helper for 2 values.
		const showFoilLook = mover.finish === "foil" || mover.finish === "etched";
		this.renderThumbWithBadge(rowEl, imageUrl, snapshot?.set ?? "", snapshot?.rarity ?? "", showFoilLook);

		const bodyEl = rowEl.createDiv({ cls: "mtg-home-trends-row-body" });
		const headEl = bodyEl.createDiv({ cls: "mtg-home-trends-row-head" });
		headEl.createDiv({ cls: "mtg-home-trends-row-name", text: mover.name });
		const changeEl = headEl.createDiv({ cls: `mtg-home-trends-row-change ${directionClass}` });
		setIcon(
			changeEl.createSpan({ cls: "mtg-home-trends-row-change-icon" }),
			directionClass === "is-up" ? "arrow-up" : "arrow-down"
		);
		const sign = mover.changePct > 0 ? "+" : "";
		changeEl.createSpan({ text: `${sign}${mover.changePct.toFixed(1)}%` });

		// Always created, even without a snapshot (empty text): it is what, with
		// flex: 1, keeps the price stuck to the right.
		const lineEl = bodyEl.createDiv({ cls: "mtg-home-trends-row-line" });
		lineEl.createDiv({
			cls: "mtg-home-trends-row-set",
			text: snapshot ? `${snapshot.set.toUpperCase()} #${snapshot.collector_number}` : "",
		});
		const price = getMoverPriceDisplay(mover, settings.priceCurrency, convert);
		const native = moverNativeCurrency(mover);
		const range = `${formatMoney(price.from, price.currency)} → ${formatMoney(price.to, price.currency)}`;
		const priceTitle = price.converted
			? `${range} (converted from ${formatMoney(mover.priceFrom, native)} → ${formatMoney(mover.priceTo, native)} at today's rate)`
			: price.currency !== settings.priceCurrency
			  ? `${range} (exchange rate unavailable — shown in the vendor's currency)`
			  : range;
		const priceEl = lineEl.createDiv({ cls: "mtg-home-trends-row-price", attr: { title: priceTitle } });
		priceEl.createSpan({ cls: "mtg-home-trends-row-price-now", text: formatMoney(price.to, price.currency) });
		priceEl.createSpan({
			cls: `mtg-home-trends-row-delta ${directionClass}`,
			text: formatSignedMoney(price.delta, price.currency),
		});

		bodyEl.createDiv({
			cls: "mtg-home-trends-row-meta",
			text: `${CARDBASE_VENDOR_LABELS[mover.vendor]} · ${CARDBASE_FINISH_LABELS[mover.finish] ?? mover.finish}`,
		});

		if (ownedCount > 0 || isWanted) {
			const tagsEl = bodyEl.createDiv({ cls: "mtg-home-trends-tags" });
			if (ownedCount > 0) {
				tagsEl.createSpan({ cls: "mtg-home-trends-tag", text: ownedCount > 1 ? `Owned ×${ownedCount}` : "Owned" });
			}
			if (isWanted) {
				const wantedTag = tagsEl.createSpan({ cls: "mtg-home-trends-tag" });
				setIcon(wantedTag.createSpan({ cls: "mtg-home-trends-tag-icon" }), "heart");
				wantedTag.createSpan({ text: "Wantlist" });
			}
		}

		rowEl.addEventListener("click", () => {
			if (owned) {
				this.openCollectionCardDetailById(owned.id);
			} else {
				new CardPreviewModal(this.app, this.plugin, mover, snapshot).open();
			}
		});
	};

	// Draws (or redraws) all of resultsEl from lastData, without a request:
	// called by loadAndDraw once the data is ready, and directly by "Show
	// more"/"Show less".
	const drawResults = () => {
		const data = lastData;
		if (!data) return;
		resultsEl.empty();

		// Age banner ABOVE everything else (columns as well as the "no movement"
		// message): it is the key to reading what follows — the "24h" movements of
		// data two weeks old are not those of the last 24h.
		const ageDays = getMoversAgeDays(data.asOf, Date.now());
		if (data.asOf && isMoversDataStale(ageDays)) {
			const stale = resultsEl.createDiv({ cls: "mtg-home-trends-stale" });
			setIcon(stale.createSpan({ cls: "mtg-home-trends-stale-icon" }), "triangle-alert");
			stale.createSpan({
				text: `Latest market data is from ${data.asOf} (${ageDays} days ago) — movers are as of that date.`,
			});
		}

		if (data.gainers.length === 0 && data.losers.length === 0) {
			resultsEl.createDiv({ cls: "mtg-status", text: "No significant price movers for this period/vendor." });
			return;
		}

		const limit = this.homeMoversExpanded ? HOME_MOVERS_EXPANDED_LIMIT : HOME_MOVERS_COLLAPSED_LIMIT;

		const columns = resultsEl.createDiv({ cls: "mtg-home-trends-columns" });
		if (data.gainers.length > 0) {
			const col = columns.createDiv({ cls: "mtg-home-trends-col" });
			col.createDiv({ cls: "mtg-home-trends-col-title is-up", text: "Gainers" });
			data.gainers
				.slice(0, limit)
				.forEach((m) => buildMoverRow(col, m, "is-up", data.snapshots.get(m.scryfallId), data.convert));
		}
		if (data.losers.length > 0) {
			const col = columns.createDiv({ cls: "mtg-home-trends-col" });
			col.createDiv({ cls: "mtg-home-trends-col-title is-down", text: "Losers" });
			data.losers
				.slice(0, limit)
				.forEach((m) => buildMoverRow(col, m, "is-down", data.snapshots.get(m.scryfallId), data.convert));
		}

		// Only if there is really more to show than the top of the list — never a
		// button that would do nothing.
		if (Math.max(data.gainers.length, data.losers.length) > HOME_MOVERS_COLLAPSED_LIMIT) {
			const more = resultsEl.createDiv({ cls: "mtg-home-trends-more" });
			const moreBtn = more.createEl("button", { cls: "mtg-home-trends-more-btn" });
			moreBtn.createSpan({ text: this.homeMoversExpanded ? "Show less" : "Show more" });
			setIcon(
				moreBtn.createSpan({ cls: "mtg-home-trends-more-icon" }),
				this.homeMoversExpanded ? "chevron-up" : "chevron-down"
			);
			moreBtn.addEventListener("click", () => {
				this.homeMoversExpanded = !this.homeMoversExpanded;
				drawResults();
			});
		}

		// meta.as_of, already present on this same response — see
		// CardbaseMoversResult.asOf (api/cardbase.ts) for why it requires no
		// separate GET /status call.
		if (data.asOf) {
			const footer = resultsEl.createDiv({
				cls: "mtg-price-history-source",
				text: `Source: cardbase.dev · Data as of ${data.asOf}`,
			});
			footer.addEventListener("click", () => window.open("https://cardbase.dev", "_blank"));
		}
	};

	const loadAndDraw = () => {
		resultsEl.empty();
		setIcon(resultsEl.createDiv({ cls: "mtg-price-history-loading" }), "loader-2");
		const token = ++requestToken;
		// The USD/EUR rate is requested AT THE SAME TIME as the movers
		// (session-cached after the first call) but must never hold them back:
		// rejection, failure or slowness (4 s max) simply give native amounts —
		// see getMoverPriceDisplay.
		const ratePromise = Promise.race([
			plugin.getUsdEurRate().catch(() => undefined),
			new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), 4000)),
		]);
		void Promise.all([plugin.getCardbaseMovers(period, vendor), ratePromise]).then(async ([result, rate]) => {
			// Home rebuilds the whole bodyEl on every render() (see render(),
			// view.ts): if the user has already left Home, resultsEl is a detached
			// node — isConnected avoids that. requestToken also covers the case where
			// period/vendor change twice in a row while staying on Home (the 1st
			// response, slower, could otherwise overwrite the 2nd once it arrived
			// after it) — same guard as the old MarketTrendsModal (its own
			// requestToken).
			if (token !== requestToken || !resultsEl.isConnected) return;

			if (!result) {
				resultsEl.empty();
				resultsEl.createDiv({ cls: "mtg-status", text: "Couldn't load market trends right now." });
				return;
			}

			// Silent anomaly filter + sort + cap at 20 per side (the maximum ever
			// displayed, "Show more"): see core/market-movers.ts.
			const gainers = selectDisplayMovers(result.gainers, "up", HOME_MOVERS_EXPANDED_LIMIT);
			const losers = selectDisplayMovers(result.losers, "down", HOME_MOVERS_EXPANDED_LIMIT);

			// Thumbnails need each mover's real Scryfall card data
			// (image/set/rarity/collector number), which CardbaseMover doesn't carry
			// (see its own comment, api/cardbase.ts) — one batched /cards/collection
			// request for all gainers+losers at once (never one request per row) via
			// the shared immutable-snapshot cache. Those of "Show more" are requested
			// right away (up to 40 ids, still ONE request, 75 max per batch):
			// expanding stays instantaneous and these snapshots are persisted anyway
			// for next time. Stays behind the same loading spinner as the movers fetch
			// itself, same "one spinner, then fully-formed content" shape as before,
			// rather than a per-row skeleton this block never had.
			const ids = [...gainers, ...losers].map((m) => m.scryfallId);
			const snapshots = ids.length > 0 ? await plugin.getScryfallImmutableSnapshots(ids) : new Map<string, ScryfallImmutableSnapshot>();
			if (token !== requestToken || !resultsEl.isConnected) return;

			lastData = {
				gainers,
				losers,
				snapshots,
				convert: rate ? (amount, from, to) => convertUsdEur(amount, from, to, rate) : undefined,
				asOf: result.asOf,
			};
			drawResults();
		});
	};

	loadAndDraw();
}

// "By Color"/"By Rarity" (2026-09-23) — both scoped to `settings.collection`
// only (not Decks/Wantlist too): matches how the rest of "Insights"/
// Overview already scope "your collection" numbers, and avoids double-
// counting or needing to decide how to treat a wanted-but-unowned deck
// card (see DeckCard.owned). renderColorPieChart already handles an empty
// input on its own ("No cards to break down yet."), so neither of these
// needs its own empty-state branch.
export function renderHomeColorBreakdown(this: MTGCollectionView, container: HTMLElement) {
	const body = makeHomeBlock(container, "palette", "By color");
	renderColorPieChart(body, computeColorBreakdown(this.plugin.settings.collection), false);
}

export function renderHomeRarityBreakdown(this: MTGCollectionView, container: HTMLElement) {
	const body = makeHomeBlock(container, "gem", "By rarity");
	renderColorPieChart(body, computeRarityBreakdown(this.plugin.settings.collection), false);
}

const HOME_DECKS_TO_FINISH_LIMIT = 5;

// "Decks to Finish" (2026-09-23) — getDeckSizeStatus (core/deck-stats.ts)
// is the simple 60/100-card heuristic, not a real per-format legality
// check (see its own comment there for why). Capped at
// HOME_DECKS_TO_FINISH_LIMIT like every other Home list, with a plain
// "+N more" line rather than its own scroll/carousel — this block is
// meant to be glanced at, not browsed.
export function renderHomeDecksToFinish(this: MTGCollectionView, container: HTMLElement) {
	const body = makeHomeBlock(container, "construction", "Decks to finish");
	const incomplete = this.plugin.settings.decks
		.map((deck) => ({ deck, status: getDeckSizeStatus(deck) }))
		.filter((d) => d.status.isBelowMinimum);

	if (incomplete.length === 0) {
		body.createDiv({ cls: "mtg-status", text: "All your decks meet their format's minimum size." });
		return;
	}

	const list = body.createDiv({ cls: "mtg-home-deck-alert-list" });
	incomplete.slice(0, HOME_DECKS_TO_FINISH_LIMIT).forEach(({ deck, status }) => {
		const row = list.createDiv({ cls: "mtg-home-deck-alert-row" });
		row.createDiv({ cls: "mtg-home-deck-alert-name", text: deck.name });
		row.createDiv({
			cls: "mtg-home-deck-alert-count",
			text: `${status.mainboardCount} / ${status.minimum} cards`,
		});
		row.addEventListener("click", () => this.openDeck(deck.id));
	});
	if (incomplete.length > HOME_DECKS_TO_FINISH_LIMIT) {
		body.createDiv({
			cls: "mtg-home-deck-alert-more",
			text: `+ ${incomplete.length - HOME_DECKS_TO_FINISH_LIMIT} more`,
		});
	}
}
