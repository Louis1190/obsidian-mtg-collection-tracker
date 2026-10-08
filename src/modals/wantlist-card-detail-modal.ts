import { App, Modal, Notice, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import type { MTGCollectionView } from "../view";
import {
	WantlistCard,
	isAlphaSet,
	finishHasFoilLook,
	getFinishLabel,
	FINISH_OPTIONS,
} from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { getDeckCardFinish, isDeckCardOwned } from "../core/data-model";
import {
	BackgroundCrossfader,
	setupCardTilt,
	setupPanelScrollFade,
	toCardbaseFinish,
	setupDoubleFacedFlip,
	setupSplitCardRotation,
} from "../ui/card-detail-fx";
import { applySvgColor, getRarityColor } from "../api/scryfall";
import { formatCardPrice, toDeckPricedCard } from "../core/price";
import { ChangePrintingModal } from "./change-printing-modal";
import { CopyCardModal } from "./copy-card-modal";
import { MarkAsAcquiredModal } from "./mark-as-acquired-modal";
import { applyModalOpenAnimation, closeModalAnimated } from "../ui/modal-animation";
import { setSvgMarkup } from "../ui/svg-markup";
import {
	DetailBoxHost,
	LegalFormatsState,
	renderCardDescriptionBox,
	renderPriceHistoryBox,
	renderLegalFormatsBox,
	renderStorePricesBox,
	renderCopiesInListsBox,
	renderCardNavHeader,
	CopyTile,
} from "./shared-detail-boxes";

/* -------------------------------------------------------------------------- */
/*  Wantlist card detail modal (same pattern as CardDetailModal, minus        */
/*  condition/language — a wanted card isn't owned yet — plus a "Mark as     */
/*  acquired" action)                                                        */
/* -------------------------------------------------------------------------- */

export class WantlistCardDetailModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private card: WantlistCard;
	private confirmingDelete = false;
	private navCards: WantlistCard[];
	// See CardDetailModal.navAnchorId: keeps the "Card X of Y"/arrows bar
	// active on the original position even when this.card shows a copy clicked
	// from "Copies in Lists" (absent from navCards).
	private navAnchorId: string;
	// Prevents a second prev/next click from cutting short the animation in
	// progress (see animateCardNav) — lifted as soon as the entrance
	// transition starts, not necessarily once it is visually finished.
	private navAnimating = false;
	private bg = new BackgroundCrossfader();
	// See CardDetailModal.copiesActiveTileMetaEl — same fix, same reason.
	private copiesActiveTileMetaEl: HTMLElement | null = null;
	// See CardDetailModal.legalFormatsShownFor — same fix, same reason.
	private legalFormatsState: LegalFormatsState = { shownFor: null };
	// See CardDetailModal.prefetchTimeout — same debounce, same reason.
	private prefetchTimeout: number | null = null;
	// See CardDetailModal.flipped — same reasoning (3D "flip" button), reset
	// at the 3 places where this.card is reassigned further down.
	private flipped = false;
	// See CardDetailModal.splitRotated — same reasoning ("rotation" button of
	// split cards, async default), reset at the same 3 places.
	private splitRotated: boolean | null = null;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		view: MTGCollectionView,
		card: WantlistCard,
		navCards: WantlistCard[] = []
	) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.card = card;
		this.navCards = navCards;
		this.navAnchorId = card.id;
	}

	onOpen() {
		this.modalEl.addClass("mtg-card-detail-modal-frame");
		// Hides Obsidian's native cross (class shared by all of the plugin's
		// modals that have their own custom cross — see modal-animation.ts): this
		// button itself lives in contentEl, rebuilt on every draw() (see below),
		// so NOT added via addModalCloseButton here — only this hiding class is
		// needed in onOpen().
		this.modalEl.addClass("mtg-modal-hides-native-close");
		// Opening fade + zoom, shared by all of the plugin's modals — see
		// modal-animation.ts.
		applyModalOpenAnimation(this);
		this.draw();
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	private renderNavHeader(contentEl: HTMLElement) {
		renderCardNavHeader(contentEl, {
			cards: this.navCards,
			currentIndex: this.navCards.findIndex((c) => c.id === this.navAnchorId),
			name: this.card.name,
			isAnimating: () => this.navAnimating,
			setAnimating: (animating) => {
				this.navAnimating = animating;
			},
			goTo: (card) => {
				this.card = card;
				this.flipped = false;
				this.splitRotated = null;
				this.navAnchorId = this.card.id;
				this.draw();
			},
		});
	}

	draw() {
		const { contentEl } = this;
		// We preserve the background layer (see BackgroundCrossfader): only a
		// selective clearing (not contentEl.empty()) allows the cross-fade between
		// two illustrations during previous/next navigation.
		this.bg.clearSiblingsIn(contentEl);
		contentEl.addClass("mtg-card-detail-modal");
		contentEl.addClass("mtg-card-detail-modal-fixed-height");

		const closeBtn = contentEl.createDiv({ cls: "mtg-card-detail-close-btn" });
		setIcon(closeBtn, "x");
		closeBtn.setAttribute("title", "Close");
		closeBtn.addEventListener("click", () => this.close());

		if (this.card.artCropUrl) {
			this.bg.update(contentEl, this.card.artCropUrl);
		} else {
			this.bg.clear();
		}

		if (this.confirmingDelete) {
			const confirmWrap = contentEl.createDiv({ cls: "mtg-card-detail-confirm-wrap" });
			confirmWrap.createEl("h2", { text: "Remove this card?" });
			confirmWrap.createEl("p", {
				text: `Remove ${this.card.count}x "${this.card.name}" from this wantlist? This cannot be undone.`,
				cls: "mtg-status",
			});
			const row = confirmWrap.createDiv({ cls: "mtg-svg-btn-row" });
			const yesBtn = row.createEl("button", {
				text: "Yes, remove",
				cls: "mtg-remove-btn",
			});
			yesBtn.addEventListener("click", () => {
				this.plugin.removeWantlistCard(this.card.id);
				this.close();
				this.view.render();
			});
			const noBtn = row.createEl("button", { text: "No, cancel" });
			noBtn.addEventListener("click", () => {
				this.confirmingDelete = false;
				this.draw();
			});
			return;
		}

		this.renderNavHeader(contentEl);

		const layout = contentEl.createDiv({ cls: "mtg-card-detail-layout" });

		const isAlpha = isAlphaSet(this.card.setCode);
		const imageColumn = layout.createDiv({ cls: "mtg-card-detail-image-column" });
		const viewport = imageColumn.createDiv({ cls: "mtg-card-detail-nav-viewport" });
		const imageWrap = viewport.createDiv({
			cls: isAlpha ? "mtg-card-detail-image-wrap mtg-card-detail-image-wrap-alpha" : "mtg-card-detail-image-wrap",
		});
		if (this.card.imageUrl) {
			// The holographic tilt/shimmer (setupCardTilt) is set on this nested
			// level, not directly on imageWrap: imageWrap already carries the
			// transform of the Cover Flow carousel (animateCardNav) for previous/next
			// navigation, and the two would fight over the same transform property if
			// they targeted the same element. The 3D tilt itself applies to all
			// finishes — only the color layers (foil-overlay/holo-shine/holo-sweep)
			// remain reserved for foil/etched, since a regular card doesn't physically
			// shimmer but can still be tilted.
			const tilt = imageWrap.createDiv({ cls: "mtg-card-detail-tilt" });
			tilt.createEl("img", {
				cls: "mtg-card-detail-image",
				attr: { src: this.card.imageUrl },
			});
			if (finishHasFoilLook(this.card.finish)) {
				// Etched doesn't scatter light like foiled/surged — its ambient halo stays
				// neutral/silvery (mtg-foil-overlay-etched) rather than the rainbow
				// gradient shared by the other two finishes.
				tilt.createDiv({
					cls:
						this.card.finish === "etched"
							? "mtg-foil-overlay-etched"
							: "mtg-foil-overlay mtg-foil-overlay-large",
				});
				// Surge Foil gets the multi-layer shine in the style of the Pokémon "V"
				// card (see styles.css); Etched gets a glitter effect (see styles.css)
				// rather than the simple rainbow shine used for foiled — explicitly
				// requested, etched "doesn't scatter light" like a real holo.
				tilt.createDiv({
					cls:
						this.card.finish === "surged"
							? "mtg-card-detail-holo-shine-surge"
							: this.card.finish === "etched"
								? "mtg-card-detail-holo-shine-etched"
								: "mtg-card-detail-holo-shine",
				});
				tilt.createDiv({ cls: "mtg-card-detail-holo-sweep" });
			}
			setupCardTilt(imageWrap, tilt);

			// "Wanted" marker (top-left corner, white heart on accent-color
			// background) — explicitly requested, screenshot in support, same badge as
			// buildWantlistCardTile (view.ts). Child of `tilt` (not of imageWrap) —
			// explicitly requested as a follow-up: unlike the "Wanted" ribbon of
			// DeckCardDetailModal (which deliberately stays flat/pinned), this badge
			// must follow the 3D tilt toward the cursor like the
			// foil-overlay/holo-shine layers just above, set on this same element for
			// the same reason. `tilt` already carries the rounded-corner clip
			// (overflow:hidden + border-radius, see its own comment above) — the
			// badge's 0.6em inset (styles.css) always keeps it inside this area, never
			// cropped.
			const wantBadge = tilt.createDiv({ cls: "mtg-wantlist-heart-badge mtg-wantlist-heart-badge-large" });
			setIcon(wantBadge, "heart");

			// 3D "flip" button — see CardDetailModal for the full reasoning (same
			// shared function, same staleness guard).
			const flipRequestedId = this.card.scryfallId;
			void this.plugin.getCardFaceImages(flipRequestedId).then((images) => {
				if (!images || this.card.scryfallId !== flipRequestedId) return;
				setupDoubleFacedFlip(imageColumn, tilt, images.back, this.flipped, (flipped) => {
					this.flipped = flipped;
				});
			});

			// "Rotation" button — see CardDetailModal for the full reasoning.
			const splitRequestedId = this.card.scryfallId;
			void this.plugin.getSplitCardInfo(splitRequestedId).then((info) => {
				if (!info || this.card.scryfallId !== splitRequestedId) return;
				// Always portrait by default — see CardDetailModal.
				if (this.splitRotated === null) this.splitRotated = false;
				setupSplitCardRotation(imageColumn, tilt, this.splitRotated, (rotated) => {
					this.splitRotated = rotated;
				});
			});
		}

		const panel = layout.createDiv({ cls: "mtg-card-detail-panel" });

		const headerRow = panel.createDiv({ cls: "mtg-card-detail-header-row" });
		const setBox = headerRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-set-box mtg-card-detail-set-box-clickable",
		});
		setBox.setAttribute("title", "View all versions");
		const setBadge = setBox.createDiv({ cls: "mtg-card-detail-set-badge" });
		void this.plugin.getSetIconSvg(this.card.setCode).then((svg) => {
			if (!svg) return;
			setSvgMarkup(setBadge, svg);
			const svgEl = setBadge.querySelector("svg");
			if (svgEl) {
				svgEl.setAttribute("width", "20");
				svgEl.setAttribute("height", "20");
			}
			applySvgColor(setBadge, getRarityColor(this.card.rarity));
		});
		setBox.createDiv({ cls: "mtg-card-detail-set-box-name", text: this.card.setName });
		setBox.createDiv({ cls: "mtg-card-detail-set-box-versions", text: "View all versions" });
		setBox.createDiv({
			cls: "mtg-card-detail-set-box-code",
			text: `${this.card.setCode.toUpperCase()} #${this.card.collectorNumber}`,
		});
		setBox.addEventListener("click", () => {
			new ChangePrintingModal(
				this.app,
				this.plugin,
				this.card,
				() => {
					this.view.render();
					this.draw();
				},
				"wantlist"
			).open();
		});

		const deleteBtn = headerRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-icon-box mtg-delete-icon-btn",
		});
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttribute("title", "Remove from wantlist");
		deleteBtn.addEventListener("click", () => {
			this.confirmingDelete = true;
			this.draw();
		});

		const attrRow = panel.createDiv({ cls: "mtg-card-detail-box-row" });

		const qtyBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-qty-box" });
		qtyBox.createDiv({ cls: "mtg-card-detail-qty-label", text: "Quantity" });
		const stepper = qtyBox.createDiv({ cls: "mtg-stepper mtg-stepper-horizontal" });
		const controls = stepper.createDiv({ cls: "mtg-stepper-controls" });
		const downBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
		setIcon(downBtn, "minus");
		downBtn.toggleClass("is-disabled", this.card.count <= 1);
		const valueEl = controls.createDiv({
			cls: "mtg-stepper-value",
			text: String(this.card.count),
		});
		const upBtn = controls.createDiv({ cls: "mtg-stepper-btn" });
		setIcon(upBtn, "plus");

		const finishBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-finish-box" });
		finishBox.setAttribute("title", "Change finish");
		finishBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Finish" });
		const finishValueRow = finishBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
		finishValueRow.createSpan();
		finishValueRow.createSpan({
			cls: "mtg-card-detail-finish-value",
			text: getFinishLabel(this.card.finish),
		});
		setIcon(finishValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
		finishBox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			openPickerMenu(
				finishBox,
				FINISH_OPTIONS.map((f) => ({
					render: (el: HTMLElement) => el.createSpan({ text: f.label }),
					onSelect: () => {
						this.plugin.setWantlistCardFinish(this.card.id, f.value);
						this.card.finish = f.value;
						this.view.render();
						this.draw();
					},
				})),
				{ matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" }
			);
		});

		const copyBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-icon-box" });
		setIcon(copyBox, "copy");
		copyBox.setAttribute("title", "Copy card to…");
		copyBox.addEventListener("click", () => {
			// See CardDetailModal.copyBox: this.draw() in addition to
			// this.view.render(), otherwise "Copies in Lists" stays on the snapshot
			// captured when this modal opened.
			new CopyCardModal(this.app, this.plugin, [this.card], "wantlist", () => {
				this.view.render();
				this.draw();
			}).open();
		});

		const wantlist = this.plugin.settings.wantlists.find((w) => w.id === this.card.listId);
		const wantlistBoxRow = panel.createDiv({ cls: "mtg-card-detail-box-row" });
		const wantlistBox = wantlistBoxRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-list-box mtg-card-detail-set-box-clickable",
		});
		wantlistBox.setAttribute("title", "Move card to another wantlist…");
		wantlistBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Wantlist" });
		wantlistBox.createDiv({ cls: "mtg-card-detail-list-box-value", text: wantlist?.name ?? "" });
		wantlistBox.addEventListener("click", () => {
			new CopyCardModal(
				this.app,
				this.plugin,
				[this.card],
				"wantlist",
				() => {
					this.close();
					this.view.render();
				},
				"move"
			).open();
		});

		this.renderCopiesInListsBox(panel);
		this.renderLegalFormatsBox(panel);
		this.renderStorePricesBox(panel);
		this.renderPriceHistoryBox(panel);
		this.renderCardDescriptionBox(panel);

		const refreshQuantityAndPrice = () => {
			valueEl.setText(String(this.card.count));
			if (this.copiesActiveTileMetaEl) {
				this.copiesActiveTileMetaEl.setText(
					`${this.card.count}x · ${formatCardPrice(this.card, this.plugin.settings.priceCurrency)}`
				);
			}
			this.view.render();
		};

		upBtn.addEventListener("click", () => {
			this.plugin.changeWantlistCardCount(this.card.id, 1, () => {
				refreshQuantityAndPrice();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});
		downBtn.addEventListener("click", () => {
			this.plugin.changeWantlistCardCount(this.card.id, -1, () => {
				refreshQuantityAndPrice();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});

		const actions = panel.createDiv({ cls: "mtg-card-detail-actions" });
		const acquiredBtn = actions.createEl("button", {
			text: "✓ Mark as acquired",
			cls: "mtg-search-add-btn",
		});
		acquiredBtn.addEventListener("click", () => {
			if (this.plugin.settings.lists.length === 0) {
				new Notice("Create a collection list first (Collection → + New list).");
				return;
			}
			new MarkAsAcquiredModal(this.app, this.plugin, this.view, [this.card.id]).open();
			this.close();
		});

		setupPanelScrollFade(panel);
	}

	// Same principle as CardDetailModal.renderCopiesInListsBox — cross-section
	// since 2026-09-08 (My Collection + My Decks, in addition to My Wantlists
	// itself). Click on a wantlist tile (same section): changes this.card in
	// place (original behavior, unchanged). Click on a collection/deck tile
	// (different section): closes this window and opens the right one instead
	// — see the full comment in CardDetailModal.renderCopiesInListsBox,
	// identical here.
	private renderCopiesInListsBox(panel: HTMLElement) {
		const others: CopyTile[] = [];

		this.plugin.settings.collection
			.filter((c) => c.name === this.card.name)
			.forEach((c) => {
				others.push({
					kind: "collection",
					sourceName: this.plugin.settings.lists.find((l) => l.id === c.listId)?.name ?? "",
					imageUrl: c.imageUrl,
					finish: c.finish,
					count: c.count,
					priceText: formatCardPrice(c, this.plugin.settings.priceCurrency),
					onClick: () => {
						this.close();
						this.view.openCollectionCardDetailById(c.id);
					},
				});
			});

		this.plugin.settings.decks.forEach((deck) => {
			deck.cards
				.filter((c) => c.name === this.card.name)
				.forEach((c) => {
					others.push({
						kind: "deck",
						sourceName: deck.name,
						imageUrl: c.imageUrl,
						finish: getDeckCardFinish(c),
						count: c.count,
						priceText: formatCardPrice(toDeckPricedCard(c), this.plugin.settings.priceCurrency),
						wanted: !isDeckCardOwned(c),
						onClick: () => {
							this.close();
							this.view.openDeckCardDetailById(deck.id, c.scryfallId);
						},
					});
				});
		});

		this.plugin.settings.wantlist
			.filter((c) => c.name === this.card.name && c.id !== this.card.id)
			.forEach((c) => {
				others.push({
					kind: "wantlist",
					sourceName: this.plugin.settings.wantlists.find((w) => w.id === c.listId)?.name ?? "",
					imageUrl: c.imageUrl,
					finish: c.finish,
					count: c.count,
					priceText: formatCardPrice(c, this.plugin.settings.priceCurrency),
					onClick: () => {
						this.card = c;
						this.flipped = false;
						this.splitRotated = null;
						this.draw();
					},
				});
			});

		renderCopiesInListsBox(
			panel,
			{
				kind: "wantlist",
				sourceName: this.plugin.settings.wantlists.find((w) => w.id === this.card.listId)?.name ?? "",
				imageUrl: this.card.imageUrl,
				finish: this.card.finish,
				count: this.card.count,
				priceText: formatCardPrice(this.card, this.plugin.settings.priceCurrency),
			},
			others,
			(meta) => {
				this.copiesActiveTileMetaEl = meta;
			}
		);
	}

	// The boxes below are common to the three detail windows (see shared-detail-boxes.ts): these
	// methods only give them what is specific to THIS section.
	private detailHost(): DetailBoxHost {
		return { plugin: this.plugin, currentScryfallId: () => this.card.scryfallId };
	}

	private renderLegalFormatsBox(panel: HTMLElement) {
		renderLegalFormatsBox(this.detailHost(), panel, this.card, this.legalFormatsState);
	}

	private renderStorePricesBox(panel: HTMLElement) {
		renderStorePricesBox(this.detailHost(), panel, {
			scryfallId: this.card.scryfallId,
			name: this.card.name,
			finish: this.card.finish,
			pricedCard: this.card,
		});
	}

	private renderPriceHistoryBox(panel: HTMLElement) {
		renderPriceHistoryBox(
			this.detailHost(),
			panel,
			{ scryfallId: this.card.scryfallId, finish: this.card.finish },
			() => this.schedulePrefetchNeighbors()
		);
	}

	private renderCardDescriptionBox(panel: HTMLElement) {
		renderCardDescriptionBox(this.detailHost(), panel, this.card);
	}

	// See CardDetailModal.schedulePrefetchNeighbors — same logic.
	private schedulePrefetchNeighbors() {
		if (this.prefetchTimeout != null) window.clearTimeout(this.prefetchTimeout);
		const centerIndex = this.navCards.findIndex((c) => c.id === this.navAnchorId);
		if (centerIndex === -1 || this.navCards.length < 2) return;
		this.prefetchTimeout = window.setTimeout(() => {
			const items = this.navCards.map((c) =>
				c.finish === "proxy" ? null : { scryfallId: c.scryfallId, finish: toCardbaseFinish(c.finish) }
			);
			void this.plugin.prefetchCardbaseNeighbors(items, centerIndex);
		}, 500);
	}

	onClose() {
		this.contentEl.empty();
	}
}
