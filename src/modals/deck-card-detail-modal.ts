import { App, Modal, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import type { MTGCollectionView } from "../view";
import {
	Deck,
	DeckCard,
	isDeckCardOwned,
	getDeckCardCategory,
	getDeckCardFinish,
	getDeckCardCondition,
	getDeckCardLanguage,
	getDeckCardFunction,
	DECK_BOARD_TABS,
} from "../core/data-model";
import { detectDeckCardFunction, DECK_FUNCTION_CATEGORIES } from "../core/deck-function";

// Options of the "Category" picker — DECK_BOARD_TABS (data-model.ts, "board
// tabs" above a deck's card list) rather than a list duplicated here: the
// two represent exactly the same concept (the 3 real values of
// DeckCardCategory), Commander is no longer part of it since 2026-09-07
// (see DeckCardCategory, data-model.ts — it is now a Function, chosen via
// the "Function" box right next to it).
import { ChangePrintingModal } from "./change-printing-modal";
import { CopyCardModal } from "./copy-card-modal";
import { GradingModal } from "./grading-modal";
import {
	BackgroundCrossfader,
	setupCardTilt,
	setupPanelScrollFade,
	toCardbaseFinish,
	setupDoubleFacedFlip,
	setupSplitCardRotation,
} from "../ui/card-detail-fx";
import {
	isAlphaSet,
	CONDITIONS,
	getCondition,
	getLanguage,
	languagePickerOptions,
	FINISH_OPTIONS,
	getFinishLabel,
	finishHasFoilLook,
} from "../core/card-model";
import { openPickerMenu } from "../ui/picker-menu";
import { createConditionIcon, createLanguageIcon, createFlagImg } from "../ui/option-icons";
import { applySvgColor, getRarityColor } from "../api/scryfall";
import { formatCardPrice, toDeckPricedCard } from "../core/price";
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
/* Deck card detail modal — same Finish/Language/Condition trio + */
/* Graded/Custom Price as CardDetailModal (My Decks/My Collection */
/* harmonization, 2026-08-25, explicitly requested). The "Deck" box opens */
/* CopyCardModal in "move" mode, and a dedicated "Copy card to…" box opens it */
/* in "copy" mode (same day, same harmonization) — CopyCardModal now accepts */
/* "deck" as a 3rd sourceKind, in addition to "collection"/"wantlist". Now */
/* also has its own "Copies in Lists" (2026-09-08, cross-section — see */
/* renderCopiesInListsBox further down; the carousel rendering is common to */
/* the three windows, shared-detail-boxes.ts) */
/* -------------------------------------------------------------------------- */

export class DeckCardDetailModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private deck: Deck;
	private card: DeckCard;
	private confirmingDelete = false;
	private navCards: DeckCard[];
	private navAnimating = false;
	private bg = new BackgroundCrossfader();
	// See CardDetailModal.copiesActiveTileMetaEl — same fix, same reason
	// (2026-09-08: this window now also has a "Copies in Lists" block, see
	// renderCopiesInListsBox further down).
	private copiesActiveTileMetaEl: HTMLElement | null = null;
	// See CardDetailModal.prefetchTimeout — same debounce, same reason.
	private prefetchTimeout: number | null = null;
	// See CardDetailModal.flipped — same reasoning (3D "flip" button), reset
	// at the 2 places where this.card is reassigned further down.
	private flipped = false;
	// See CardDetailModal.splitRotated — same reasoning ("rotation" button of
	// split cards, async default), reset at the same 2 places.
	private splitRotated: boolean | null = null;
	// See CardDetailModal.legalFormatsShownFor — same mechanism (avoids
	// replaying the reveal fade on a redraw of the same already-resolved card)
	// and, as there, never reset on prev/next navigation: seeing an
	// already-resolved card again replays the fade once more, an accepted
	// trade-off rather than tracking every visited card.
	private legalFormatsState: LegalFormatsState = { shownFor: null };
	// See CardDetailModal.gradingExpanded/gradingJustOpened — same reasoning
	// identically (My Decks/My Collection harmonization, 2026-08-25),
	// recomputed at the same 2 places where this.card changes reference
	// further down (constructor + the 2 prev/next arrows). Still no 3rd point
	// as on the Collection/Wantlist side: "Copies in Lists" now exists here
	// too (2026-09-08), but systematically closes this window on click rather
	// than reassigning this.card in place (see renderCopiesInListsBox —
	// DeckCardDetailModal doesn't have the equivalent of navAnchorId to keep
	// "Card X of Y" consistent if this.card diverged from navCards), so there
	// is never an in-place reassignment to cover here.
	private gradingExpanded: boolean;
	private gradingJustOpened = false;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		view: MTGCollectionView,
		deck: Deck,
		card: DeckCard,
		navCards: DeckCard[] = []
	) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.deck = deck;
		this.card = card;
		this.navCards = navCards;
		this.gradingExpanded = !!(card.gradingGrade != null || card.gradingLabel || card.customPrice);
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
			currentIndex: this.navCards.findIndex((c) => c.scryfallId === this.card.scryfallId),
			name: this.card.name,
			isAnimating: () => this.navAnimating,
			setAnimating: (animating) => {
				this.navAnimating = animating;
			},
			goTo: (card) => {
				this.card = card;
				this.gradingExpanded = !!(
					this.card.gradingGrade != null ||
					this.card.gradingLabel ||
					this.card.customPrice
				);
				this.flipped = false;
				this.splitRotated = null;
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

		// Blurred background: the artwork alone (art crop), not the whole card.
		if (this.card.artCropUrl) {
			this.bg.update(contentEl, this.card.artCropUrl);
		} else {
			this.bg.clear();
		}

		if (this.confirmingDelete) {
			const confirmWrap = contentEl.createDiv({ cls: "mtg-card-detail-confirm-wrap" });
			confirmWrap.createEl("h2", { text: "Remove this card?" });
			confirmWrap.createEl("p", {
				text: `Remove ${this.card.count}x "${this.card.name}" from "${this.deck.name}"? This cannot be undone.`,
				cls: "mtg-status",
			});
			const row = confirmWrap.createDiv({ cls: "mtg-svg-btn-row" });
			const yesBtn = row.createEl("button", {
				text: "Yes, remove",
				cls: "mtg-remove-btn",
			});
			yesBtn.addEventListener("click", () => {
				this.plugin.removeDeckCard(this.deck.id, this.card.scryfallId);
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

		// Condition/language displayed in two places (icons above the image +
		// panel boxes in the collapsible section) — see CardDetailModal.draw for
		// the full reasoning, identical here. My Decks/My Collection
		// harmonization, 2026-08-25: DeckCard now carries condition/language (see
		// data-model.ts), found here via deck.id + scryfallId
		// (setDeckCardCondition/setDeckCardLanguage) rather than an id of its own,
		// like changeDeckCardCount further down.
		let condGlyphImageEl: HTMLElement | null = null;
		let condBtnImageEl: HTMLElement | null = null;
		let langFlagImageEl: HTMLElement | null = null;
		let langBtnImageEl: HTMLElement | null = null;
		let condValuePanelEl: HTMLElement | null = null;
		let langValuePanelEl: HTMLElement | null = null;

		const conditionPickerItems = () =>
			CONDITIONS.map((c) => ({
				render: (el: HTMLElement) => {
					createConditionIcon(el, c.value, "mtg-picker-condition-glyph");
					el.createSpan({ text: c.label });
				},
				onSelect: () => applyCondition(c.value),
			}));

		const applyCondition = (value: string) => {
			this.plugin.setDeckCardCondition(this.deck.id, this.card.scryfallId, value);
			this.card.condition = value;
			if (condBtnImageEl && condGlyphImageEl) {
				condGlyphImageEl.remove();
				condGlyphImageEl = createConditionIcon(
					condBtnImageEl,
					value,
					"mtg-card-detail-image-icon-glyph"
				);
				condBtnImageEl.setAttribute("title", getCondition(value).label);
			}
			if (condValuePanelEl) {
				condValuePanelEl.setText(getCondition(value).label);
			}
			this.view.render();
		};

		const openLanguagePickerFrom = (
			anchor: HTMLElement,
			menuOptions?: { matchAnchorWidth?: boolean; menuClass?: string }
		) => {
			void this.plugin
				.getAvailableLanguages(this.card.setCode, this.card.collectorNumber)
				.then((availableCodes) => {
					const options = languagePickerOptions(availableCodes);
					openPickerMenu(
						anchor,
						options.map((l) => ({
							render: (el: HTMLElement) => {
								createFlagImg(el, l.flag, "mtg-flag-img mtg-flag-img-inline");
								el.createSpan({ text: l.label });
							},
							onSelect: () => applyLanguage(l.code),
						})),
						menuOptions
					);
				});
		};

		const applyLanguage = (code: string) => {
			this.plugin.setDeckCardLanguage(this.deck.id, this.card.scryfallId, code);
			this.card.language = code;
			const lang = getLanguage(code);
			if (langBtnImageEl && langFlagImageEl) {
				langFlagImageEl.remove();
				langFlagImageEl = createLanguageIcon(
					langBtnImageEl,
					code,
					"mtg-card-detail-image-icon-flag",
					"mtg-card-detail-image-icon-glyph"
				);
				langBtnImageEl.setAttribute("title", lang.label);
			}
			if (langValuePanelEl) {
				langValuePanelEl.setText(lang.label);
			}
			this.view.render();
		};

		if (this.card.imageUrl) {
			const imageIcons = imageColumn.createDiv({ cls: "mtg-card-detail-image-icons" });

			const condBtn = imageIcons.createDiv({ cls: "mtg-card-detail-image-icon-btn" });
			condGlyphImageEl = createConditionIcon(
				condBtn,
				getDeckCardCondition(this.card),
				"mtg-card-detail-image-icon-glyph"
			);
			condBtn.setAttribute("title", getCondition(getDeckCardCondition(this.card)).label);
			condBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openPickerMenu(condBtn, conditionPickerItems());
			});
			condBtnImageEl = condBtn;

			const langBtn = imageIcons.createDiv({ cls: "mtg-card-detail-image-icon-btn" });
			langFlagImageEl = createLanguageIcon(
				langBtn,
				getDeckCardLanguage(this.card),
				"mtg-card-detail-image-icon-flag",
				"mtg-card-detail-image-icon-glyph"
			);
			langBtn.setAttribute("title", getLanguage(getDeckCardLanguage(this.card)).label);
			langBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openLanguagePickerFrom(langBtn);
			});
			langBtnImageEl = langBtn;
		}

		const viewport = imageColumn.createDiv({ cls: "mtg-card-detail-nav-viewport" });
		const imageWrap = viewport.createDiv({
			cls: isAlpha ? "mtg-card-detail-image-wrap mtg-card-detail-image-wrap-alpha" : "mtg-card-detail-image-wrap",
		});
		if (this.card.imageUrl) {
			const finish = getDeckCardFinish(this.card);
			const tilt = imageWrap.createDiv({ cls: "mtg-card-detail-tilt" });
			tilt.createEl("img", {
				cls: "mtg-card-detail-image",
				attr: { src: this.card.imageUrl },
			});
			// Foil/holo color layers — see CardDetailModal for the full reasoning,
			// identical here since DeckCard carries a finish (harmonization
			// 2026-08-25).
			if (finishHasFoilLook(finish)) {
				tilt.createDiv({
					cls: finish === "etched" ? "mtg-foil-overlay-etched" : "mtg-foil-overlay mtg-foil-overlay-large",
				});
				tilt.createDiv({
					cls:
						finish === "surged"
							? "mtg-card-detail-holo-shine-surge"
							: finish === "etched"
								? "mtg-card-detail-holo-shine-etched"
								: "mtg-card-detail-holo-shine",
				});
				tilt.createDiv({ cls: "mtg-card-detail-holo-sweep" });
			}
			setupCardTilt(imageWrap, tilt);

			// 3D "flip" button — see CardDetailModal for the full reasoning (same
			// shared function, same staleness guard). Only needs scryfallId, hence
			// available here like for Price History/Card Text (and, since 2026-09-02,
			// the TCGplayer Store Prices column — DeckCard now carries its own cached
			// Scryfall price, see renderStorePricesBox further down).
			const flipRequestedId = this.card.scryfallId;
			void this.plugin.getCardFaceImages(flipRequestedId).then((images) => {
				if (!images || this.card.scryfallId !== flipRequestedId) return;
				setupDoubleFacedFlip(imageColumn, tilt, images.back, this.flipped, (flipped) => {
					this.flipped = flipped;
				});
			});

			// "Rotation" button — see CardDetailModal for the full reasoning. Only
			// needs scryfallId, available here like for Price History/Card Text/the
			// flip above.
			const splitRequestedId = this.card.scryfallId;
			void this.plugin.getSplitCardInfo(splitRequestedId).then((info) => {
				if (!info || this.card.scryfallId !== splitRequestedId) return;
				// Always portrait by default — see CardDetailModal.
				if (this.splitRotated === null) this.splitRotated = false;
				setupSplitCardRotation(imageColumn, tilt, this.splitRotated, (rotated) => {
					this.splitRotated = rotated;
				});
			});
			// Ribbon outside `tilt` (not a child): stays flat, pinned to the corner of
			// the wrap, rather than pivoting with the card in 3D.
			if (!isDeckCardOwned(this.card)) {
				imageWrap.createDiv({ cls: "mtg-thumb-wanted-ribbon", text: "Wanted" });
			}
		}

		const panel = layout.createDiv({ cls: "mtg-card-detail-panel" });

		const headerRow = panel.createDiv({ cls: "mtg-card-detail-header-row" });
		// Same clickable box → ChangePrintingModal as
		// CardDetailModal/WantlistCardDetailModal (mtg-card-detail-set-box-clickable, "View
		// all versions") — only existed here in its non-clickable form until now (DeckCard
		// has no id field of its own, see "Data model notes" in CLAUDE.md, which blocked
		// direct reuse of changeCollectionCardPrinting/changeWantlistCardPrinting);
		// changeDeckCardPrinting (plugin.ts) finds the row by scryfallId + category
		// instead, see its own comment.
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
				{ name: this.card.name, scryfallId: this.card.scryfallId },
				() => {
					this.view.render();
					this.draw();
				},
				"deck",
				{ deckId: this.deck.id, category: getDeckCardCategory(this.card) }
			).open();
		});

		const deleteBtn = headerRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-icon-box mtg-delete-icon-btn",
		});
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttribute("title", "Remove from deck");
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
		// See CardDetailModal.copiesActiveTileMetaEl — same targeted fix, since
		// this window also has "Copies in Lists" (2026-09-08): without it,
		// changing the quantity would leave the active tile of this carousel
		// displayed with the old number.
		const refreshCopiesActiveTile = () => {
			if (this.copiesActiveTileMetaEl) {
				this.copiesActiveTileMetaEl.setText(
					`${this.card.count}x · ${formatCardPrice(
						toDeckPricedCard(this.card),
						this.plugin.settings.priceCurrency
					)}`
				);
			}
		};
		upBtn.addEventListener("click", () => {
			this.plugin.changeDeckCardCount(this.deck.id, this.card.scryfallId, 1, () => {
				valueEl.setText(String(this.card.count));
				refreshCopiesActiveTile();
				this.view.render();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});
		downBtn.addEventListener("click", () => {
			this.plugin.changeDeckCardCount(this.deck.id, this.card.scryfallId, -1, () => {
				valueEl.setText(String(this.card.count));
				refreshCopiesActiveTile();
				this.view.render();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});

		// Finish — same box/picker as CardDetailModal, harmonization 2026-08-25.
		// No "Copy card to…" box here (unlike Collection): see the comment on
		// "Deck" further down, a deck has no notion of copying/moving a card.
		const finishBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-finish-box" });
		finishBox.setAttribute("title", "Change finish");
		finishBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Finish" });
		const finishValueRow = finishBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
		finishValueRow.createSpan();
		finishValueRow.createSpan({
			cls: "mtg-card-detail-finish-value",
			text: getFinishLabel(getDeckCardFinish(this.card)),
		});
		setIcon(finishValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
		finishBox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			openPickerMenu(
				finishBox,
				FINISH_OPTIONS.map((f) => ({
					render: (el: HTMLElement) => el.createSpan({ text: f.label }),
					onSelect: () => {
						this.plugin.setDeckCardFinish(this.deck.id, this.card.scryfallId, f.value);
						this.card.finish = f.value;
						this.view.render();
						this.draw();
					},
				})),
				{ matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" }
			);
		});

		// "Copy card to…" — same box/icon as CardDetailModal, requested explicitly
		// the same day as "Deck" opening "Move card" below (harmonization
		// 2026-08-25). "copy" mode (CopyCardModal's default, not specified here as
		// in CardDetailModal): unlike the click on "Deck" further down, the card
		// stays in this deck after the copy — this.draw() behind
		// this.view.render() has nothing specific to this block to refresh (no
		// "Copies in Lists" on the Deck side), but follows the same convention as
		// CardDetailModal for consistency.
		const copyBox = attrRow.createDiv({ cls: "mtg-card-detail-box mtg-card-detail-icon-box" });
		setIcon(copyBox, "copy");
		copyBox.setAttribute("title", "Copy card to…");
		copyBox.addEventListener("click", () => {
			new CopyCardModal(
				this.app,
				this.plugin,
				[this.card],
				"deck",
				() => {
					this.view.render();
					this.draw();
				},
				"copy",
				{ deckId: this.deck.id }
			).open();
		});

		// Graded/Custom Price toggle (+ Condition/Language in the collapsible
		// section below) — see CardDetailModal.draw for the full reasoning,
		// identical here.
		const gradingToggleBox = attrRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-icon-box",
		});
		setIcon(gradingToggleBox, this.gradingExpanded ? "chevron-up" : "chevron-down");
		gradingToggleBox.setAttribute("title", "Grading & custom price");
		let gradingWrapperEl: HTMLElement | null = null;
		gradingToggleBox.addEventListener("click", () => {
			if (this.gradingExpanded) {
				this.gradingExpanded = false;
				setIcon(gradingToggleBox, "chevron-down");
				if (gradingWrapperEl) {
					const currentHeight = gradingWrapperEl.getBoundingClientRect().height;
					gradingWrapperEl.style.height = `${currentHeight}px`;
					void gradingWrapperEl.offsetHeight;
					gradingWrapperEl.removeClass("is-expanded");
					// No more inline height: the base class has height:0 (styles.css), the transition starts from
					// the pixel value set just above.
					gradingWrapperEl.style.removeProperty("height");
					window.setTimeout(() => {
						if (!this.gradingExpanded) this.draw();
					}, 300);
				} else {
					this.draw();
				}
			} else {
				this.gradingExpanded = true;
				this.gradingJustOpened = true;
				setIcon(gradingToggleBox, "chevron-up");
				this.draw();
			}
		});

		if (this.gradingExpanded) {
			const gradingWrapper = panel.createDiv({ cls: "mtg-card-detail-grading-wrapper" });
			gradingWrapperEl = gradingWrapper;
			const gradingContent = gradingWrapper.createDiv({ cls: "mtg-card-detail-grading-content" });

			const conditionLanguageRow = gradingContent.createDiv({ cls: "mtg-card-detail-box-row" });

			const condBox = conditionLanguageRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box",
			});
			condBox.setAttribute("title", "Change condition");
			condBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Condition" });
			const condValueRow = condBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
			condValueRow.createSpan();
			condValuePanelEl = condValueRow.createSpan({
				cls: "mtg-card-detail-finish-value",
				text: getCondition(getDeckCardCondition(this.card)).label,
			});
			setIcon(condValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
			condBox.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openPickerMenu(condBox, conditionPickerItems(), {
					matchAnchorWidth: true,
					menuClass: "mtg-finish-picker-menu",
				});
			});

			const langBox = conditionLanguageRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box",
			});
			langBox.setAttribute("title", "Change language");
			langBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Language" });
			const langValueRow = langBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
			langValueRow.createSpan();
			langValuePanelEl = langValueRow.createSpan({
				cls: "mtg-card-detail-finish-value",
				text: getLanguage(getDeckCardLanguage(this.card)).label,
			});
			setIcon(langValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
			langBox.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openLanguagePickerFrom(langBox, { matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" });
			});

			const gradingRow = gradingContent.createDiv({ cls: "mtg-card-detail-box-row" });

			const gradedBox = gradingRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box",
			});
			gradedBox.setAttribute("title", "Set grading");
			gradedBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Graded" });
			const gradedValueRow = gradedBox.createDiv({
				cls: "mtg-card-detail-finish-value-row mtg-card-detail-finish-value-row-no-caret",
			});
			gradedValueRow.createSpan({
				cls: "mtg-card-detail-finish-value",
				text:
					this.card.gradingGrade != null || this.card.gradingLabel
						? `${this.card.gradingCompany ?? ""} ${this.card.gradingGrade ?? ""} ${
								this.card.gradingLabel ?? ""
						  }`
								.replace(/\s+/g, " ")
								.trim()
						: "Not graded",
			});
			gradedBox.addEventListener("click", () => {
				new GradingModal(
					this.app,
					this.plugin,
					this.card,
					() => {
						this.view.render();
						this.draw();
					},
					"deck",
					{ deckId: this.deck.id, scryfallId: this.card.scryfallId }
				).open();
			});

			const customPriceBox = gradingRow.createDiv({
				cls: "mtg-card-detail-box mtg-card-detail-finish-box mtg-card-detail-customprice-box",
			});
			customPriceBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Custom price" });
			const priceInput = customPriceBox.createEl("input", {
				cls: "mtg-card-detail-customprice-input",
				type: "text",
			});
			priceInput.value = this.card.customPrice ?? "";
			priceInput.setAttribute("placeholder", "For example, $45");
			const commitCustomPrice = () => {
				this.plugin.setDeckCardCustomPrice(this.deck.id, this.card.scryfallId, priceInput.value);
			};
			priceInput.addEventListener("blur", commitCustomPrice);
			priceInput.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") priceInput.blur();
			});

			if (this.gradingJustOpened) {
				this.gradingJustOpened = false;
				const targetHeight = gradingWrapper.scrollHeight;
				window.requestAnimationFrame(() => {
					gradingWrapper.addClass("is-expanded");
					gradingWrapper.style.height = `${targetHeight}px`;
				});
				window.setTimeout(() => {
					// "auto" is that of .is-expanded (see card-detail-modal.ts).
					gradingWrapper.style.removeProperty("height");
				}, 300);
			} else {
				gradingWrapper.addClass("is-expanded");
			}
		}

		// Same clickable "List"/"Wantlist" box → CopyCardModal ("move" mode) as
		// CardDetailModal/WantlistCardDetailModal — only existed here in its
		// non-clickable form until now ("a deck has no notion of moving this
		// card", CopyCardModal only took CollectionCard/WantlistCard as a source);
		// explicitly requested on 2026-08-25, immediately after the
		// Finish/Condition/Language/Grading harmonization —
		// copyDeckCardToList/copyDeckCardToDeck/copyDeckCardToWantlist (plugin.ts)
		// find the row by scryfallId + category rather than by an id of their own,
		// see their comment.
		const deckBoxRow = panel.createDiv({ cls: "mtg-card-detail-box-row" });
		const deckBox = deckBoxRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-list-box mtg-card-detail-set-box-clickable",
		});
		deckBox.setAttribute("title", "Move card to another deck…");
		deckBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Deck" });
		deckBox.createDiv({ cls: "mtg-card-detail-list-box-value", text: this.deck.name });
		deckBox.addEventListener("click", () => {
			new CopyCardModal(
				this.app,
				this.plugin,
				[this.card],
				"deck",
				() => {
					this.close();
					this.view.render();
				},
				"move",
				{ deckId: this.deck.id }
			).open();
		});

		// "Board"/"Function" — right after "Deck", not in the collapsible
		// Condition/Language/Graded drawer (2026-09-02, explicitly requested with
		// a screenshot in support, after a first version where "Function" lived in
		// the Condition/Language row). This picker (DeckCardCategory —
		// Mainboard/Sideboard/Maybeboard, see DECK_BOARD_TABS/"board tabs"/Stacks
		// view) is a structural attribute of the card's place IN this deck, not a
		// secondary physical-condition detail like Condition/Language/Graded — so
		// it deserves its own row, at the same level as "Deck" rather than buried
		// in the drawer. Function moved here for the same reason (grouped with
		// this picker rather than with Condition/Language).
		// Commander is NO LONGER one of this picker's options since 2026-09-07
		// (explicitly requested: "Commander is a Function") — it is now designated
		// from the "Function" box right next to it.
		// Displayed label "Board" rather than "Category" since 2026-09-08
		// (explicitly requested, "it will be clearer") — internal variables/CSS
		// kept as is (categoryBox/categoryFunctionRow, DeckCardCategory), only the
		// visible text changes.
		const categoryFunctionRow = panel.createDiv({ cls: "mtg-card-detail-box-row" });

		const categoryBox = categoryFunctionRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-finish-box",
		});
		categoryBox.setAttribute("title", "Change board");
		categoryBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Board" });
		const categoryValueRow = categoryBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
		categoryValueRow.createSpan();
		categoryValueRow.createSpan({
			cls: "mtg-card-detail-finish-value",
			text: DECK_BOARD_TABS.find((t) => t.value === getDeckCardCategory(this.card))?.label ?? "Mainboard",
		});
		setIcon(categoryValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
		categoryBox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const items = DECK_BOARD_TABS.map((tab) => ({
				render: (el: HTMLElement) => el.createSpan({ text: tab.label }),
				onSelect: () => {
					this.plugin.setDeckCardCategory(this.deck.id, this.card.scryfallId, tab.value);
					this.card.category = tab.value;
					this.view.render();
					this.draw();
				},
			}));
			openPickerMenu(categoryBox, items, { matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" });
		});

		// "Function" (2026-09-02, see "Group by Function"/Stacks view) — same
		// box/picker as Category above. The picker always offers "Auto (…)" at the
		// top to go back to automatic detection — never a separate "no function"
		// state.
		const funcBox = categoryFunctionRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-finish-box",
		});
		funcBox.setAttribute("title", "Change function");
		funcBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "Function" });
		const funcValueRow = funcBox.createDiv({ cls: "mtg-card-detail-finish-value-row" });
		funcValueRow.createSpan();
		funcValueRow.createSpan({
			cls: "mtg-card-detail-finish-value",
			text: getDeckCardFunction(this.card),
		});
		setIcon(funcValueRow.createSpan({ cls: "mtg-card-detail-finish-caret" }), "chevron-down");
		funcBox.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const detected = detectDeckCardFunction(this.card) ?? getDeckCardFunction(this.card);
			const items = [
				{
					render: (el: HTMLElement) => el.createSpan({ text: `Auto (${detected})` }),
					onSelect: () => {
						this.plugin.setDeckCardFunction(this.deck.id, this.card.scryfallId, undefined);
						this.card.deckFunctionOverride = undefined;
						this.view.render();
						this.draw();
					},
				},
				...DECK_FUNCTION_CATEGORIES.map((label) => ({
					render: (el: HTMLElement) => el.createSpan({ text: label }),
					onSelect: () => {
						this.plugin.setDeckCardFunction(this.deck.id, this.card.scryfallId, label);
						this.card.deckFunctionOverride = label;
						this.view.render();
						this.draw();
					},
				})),
			];
			openPickerMenu(funcBox, items, { matchAnchorWidth: true, menuClass: "mtg-finish-picker-menu" });
		});

		this.renderCopiesInListsBox(panel);
		this.renderLegalFormatsBox(panel);
		this.renderStorePricesBox(panel);
		this.renderPriceHistoryBox(panel);
		this.renderCardDescriptionBox(panel);

		setupPanelScrollFade(panel);
	}

	// Same principle as CardDetailModal.renderCopiesInListsBox — cross-section
	// (2026-09-08, explicitly requested): My Collection, My Decks (including
	// THIS deck, excluding the active card by reference since DeckCard has no
	// id of its own) and My Wantlists. Unlike
	// CardDetailModal/WantlistCardDetailModal, NO tile reassigns this.card in
	// place here, not even another deck card with the same name (even in THIS
	// deck): this window has no equivalent of navAnchorId to keep "Card X of
	// Y" consistent if this.card diverged from navCards (see the comment on
	// gradingExpanded further up) — simpler and safer to always close this
	// window and open the right one instead, including for another DeckCard.
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
				.filter((c) => c.name === this.card.name && c !== this.card)
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
			.filter((c) => c.name === this.card.name)
			.forEach((c) => {
				others.push({
					kind: "wantlist",
					sourceName: this.plugin.settings.wantlists.find((w) => w.id === c.listId)?.name ?? "",
					imageUrl: c.imageUrl,
					finish: c.finish,
					count: c.count,
					priceText: formatCardPrice(c, this.plugin.settings.priceCurrency),
					onClick: () => {
						this.close();
						this.view.openWantlistCardDetailById(c.id);
					},
				});
			});

		renderCopiesInListsBox(
			panel,
			{
				kind: "deck",
				sourceName: this.deck.name,
				imageUrl: this.card.imageUrl,
				finish: getDeckCardFinish(this.card),
				count: this.card.count,
				priceText: formatCardPrice(toDeckPricedCard(this.card), this.plugin.settings.priceCurrency),
				wanted: !isDeckCardOwned(this.card),
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
		renderLegalFormatsBox(this.detailHost(), panel, this.card, this.legalFormatsState, this.deck.format);
	}

	private renderStorePricesBox(panel: HTMLElement) {
		renderStorePricesBox(this.detailHost(), panel, {
			scryfallId: this.card.scryfallId,
			name: this.card.name,
			finish: getDeckCardFinish(this.card),
			pricedCard: toDeckPricedCard(this.card),
		});
	}

	private renderPriceHistoryBox(panel: HTMLElement) {
		renderPriceHistoryBox(
			this.detailHost(),
			panel,
			{ scryfallId: this.card.scryfallId, finish: getDeckCardFinish(this.card) },
			() => this.schedulePrefetchNeighbors()
		);
	}

	private renderCardDescriptionBox(panel: HTMLElement) {
		renderCardDescriptionBox(this.detailHost(), panel, this.card);
	}

	// See CardDetailModal.schedulePrefetchNeighbors — same logic, but
	// centerIndex is computed by scryfallId (like renderNavHeader above,
	// DeckCard has neither an id of its own nor a navAnchorId) — same Proxy
	// (null) exclusion as CardDetailModal since the 2026-08-25 harmonization.
	private schedulePrefetchNeighbors() {
		if (this.prefetchTimeout != null) window.clearTimeout(this.prefetchTimeout);
		const centerIndex = this.navCards.findIndex((c) => c.scryfallId === this.card.scryfallId);
		if (centerIndex === -1 || this.navCards.length < 2) return;
		this.prefetchTimeout = window.setTimeout(() => {
			const items = this.navCards.map((c) => {
				const finish = getDeckCardFinish(c);
				return finish === "proxy" ? null : { scryfallId: c.scryfallId, finish: toCardbaseFinish(finish) };
			});
			void this.plugin.prefetchCardbaseNeighbors(items, centerIndex);
		}, 500);
	}

	onClose() {
		this.contentEl.empty();
	}
}
