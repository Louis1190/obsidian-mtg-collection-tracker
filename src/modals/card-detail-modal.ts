import { App, Modal, setIcon } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import type { MTGCollectionView } from "../view";
import {
	CollectionCard,
	isAlphaSet,
	CONDITIONS,
	getCondition,
	getLanguage,
	languagePickerOptions,
	FINISH_OPTIONS,
	getFinishLabel,
	finishHasFoilLook,
} from "../core/card-model";
import { getDeckCardFinish, isDeckCardOwned } from "../core/data-model";
import {
	BackgroundCrossfader,
	setupCardTilt,
	setupPanelScrollFade,
	toCardbaseFinish,
	setupDoubleFacedFlip,
	setupSplitCardRotation,
} from "../ui/card-detail-fx";
import { openPickerMenu } from "../ui/picker-menu";
import { createConditionIcon, createLanguageIcon, createFlagImg } from "../ui/option-icons";
import { applySvgColor, getRarityColor } from "../api/scryfall";
import { formatCardPrice, toDeckPricedCard } from "../core/price";
import { ChangePrintingModal } from "./change-printing-modal";
import { CopyCardModal } from "./copy-card-modal";
import { GradingModal } from "./grading-modal";
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
/*  Card detail modal (big image + info/actions panel)                       */
/* -------------------------------------------------------------------------- */

export class CardDetailModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private view: MTGCollectionView;
	private card: CollectionCard;
	private confirmingDelete = false;
	// Ordered list (current filter/sort/grouping) in which this card was
	// opened — only serves for previous/next navigation and the "Card X of Y",
	// captured as is at opening (not updated live if the list changes while
	// the window is open).
	private navCards: CollectionCard[];
	// Id used to compute the "Card X of Y" position/the activation of the
	// arrows — distinct from this.card.id: clicking an "Other in Lists"
	// thumbnail changes this.card (the display) without touching this anchor,
	// so that the navigation bar keeps the continuity of the original list
	// rather than disappearing (the other copy doesn't belong to navCards).
	// Updated only by the previous/next arrows themselves.
	private navAnchorId: string;
	// Prevents a second prev/next click from cutting short the animation in
	// progress (see animateCardNav) — lifted as soon as the entrance
	// transition starts, not necessarily once it is visually finished.
	private navAnimating = false;
	private bg = new BackgroundCrossfader();
	// Active tile of the "Copies in Lists" carousel (see
	// renderCopiesInListsBox) — captured so that refreshQuantityAndPrice can
	// touch up its "Nx · price" directly, in addition to the stepper and the
	// main price line. Without it, changing the quantity left this carousel
	// displaying the old number: it is a targeted DOM update (not a complete
	// this.draw(), so as not to lose focus/make the panel flicker), so any
	// value displayed elsewhere must be touched up explicitly rather than
	// counting on a new render.
	private copiesActiveTileMetaEl: HTMLElement | null = null;
	// Shows/hides the Graded/Custom Price row — recomputed from the card's
	// data every time this.card changes (constructor + the 3 places where
	// this.card is reassigned further down), so that the block opens already
	// expanded on a card that already has this information, but navigating to
	// another card starts again from ITS own data — not a simple static
	// default like confirmingDelete, which makes no sense per card.
	private gradingExpanded: boolean;
	// Distinguishes "gradingExpanded has just turned true following a click on
	// the toggle" from a draw() triggered for any other reason while the block
	// is already open (changing the finish, saving the grading, etc.) —
	// without it, EVERY redraw would replay the block's opening animation
	// instead of rendering it directly in its final state. Consumed (reset to
	// false) as soon as it has served once, in draw() itself.
	private gradingJustOpened = false;
	// Distinguishes "first display of the legalities for this card" from a
	// draw() triggered for any other reason while the same card is displayed
	// (changing the finish, saving the grading, etc.) — without it, EVERY
	// redraw rebuilt the 8 tiles in their neutral state and replayed the whole
	// wave, even though the underlying data (already cached, see
	// MTGCollectionPlugin.legalitiesCache) hadn't changed (reported bug: the
	// "Legal Formats" box seemed to "update" on every finish change, while the
	// information displayed stayed identical).
	private legalFormatsState: LegalFormatsState = { shownFor: null };
	// State of the 3D "flip" button (see setupDoubleFacedFlip) — like
	// gradingExpanded above, reset every time this.card changes reference
	// (constructor + the 3 places where this.card is reassigned further down):
	// navigating to another card must always start from the front face, never
	// keep the back displayed for a different card. `false` already covers the
	// constructor (initial value of the field), no need to reassign it
	// explicitly there.
	private flipped = false;
	// State of the "rotation" button of split cards (see
	// setupSplitCardRotation/getSplitCardInfo) — same reset as flipped above
	// at the same 3 places, BUT `null` (not `false`): unlike flip, whose
	// default state is a plain constant false, the default orientation of a
	// split card depends on async data (classic → rotated, Aftermath →
	// portrait, see getSplitCardInfo) — `null` distinguishes "not yet
	// determined for this card" from an explicit choice (default applied or
	// manual click on the button), so that a redraw of the SAME card (changing
	// the finish, saving the grading...) doesn't reapply the default over a
	// choice already made.
	private splitRotated: boolean | null = null;
	// Debounce of the background preloading of neighboring cards (see
	// schedulePrefetchNeighbors) — a fast Cover Flow navigation cancels the
	// previous scheduling instead of stacking batches of cardbase requests for
	// cards already left.
	private prefetchTimeout: number | null = null;

	constructor(
		app: App,
		plugin: MTGCollectionPlugin,
		view: MTGCollectionView,
		card: CollectionCard,
		navCards: CollectionCard[] = []
	) {
		super(app);
		this.plugin = plugin;
		this.view = view;
		this.card = card;
		this.navCards = navCards;
		this.navAnchorId = card.id;
		// gradingCompany no longer indicates "graded" on its own: GradingModal
		// preselects PSA by default and saves it even with no grade/condition
		// entered, so its mere presence no longer distinguishes a truly graded
		// card from a card never touched — only grade and condition count.
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

	// Card name centered above the two columns, flanked by previous/next
	// arrows that walk through this.navCards (the filtered/sorted list as it
	// was displayed when the window opened), with the "Card X of Y" marker
	// below. this.card changes reference on navigation then redraws the whole
	// window via draw() — the quantity stepper, the foil, etc. then reflect
	// the newly displayed card.
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
				this.gradingExpanded = !!(
					this.card.gradingGrade != null ||
					this.card.gradingLabel ||
					this.card.customPrice
				);
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
		// Fixed height (not just capped) — see styles.css for the full reasoning;
		// DeckCardDetailModal/WantlistCardDetailModal now add the same class
		// (harmonization 2026-08-17), so the 3 detail modals behave identically
		// from this point of view despite their different content.
		contentEl.addClass("mtg-card-detail-modal-fixed-height");

		const closeBtn = contentEl.createDiv({ cls: "mtg-card-detail-close-btn" });
		setIcon(closeBtn, "x");
		closeBtn.setAttribute("title", "Close");
		closeBtn.addEventListener("click", () => this.close());

		// Blurred background: the artwork alone (art crop), not the whole card
		// with its frame/text — more immersive and readable once blurred.
		if (this.card.artCropUrl) {
			this.bg.update(contentEl, this.card.artCropUrl);
		} else {
			this.bg.clear();
		}

		if (this.confirmingDelete) {
			const confirmWrap = contentEl.createDiv({ cls: "mtg-card-detail-confirm-wrap" });
			confirmWrap.createEl("h2", { text: "Remove this card?" });
			confirmWrap.createEl("p", {
				text: `Remove ${this.card.count}x "${this.card.name}" from this list? This cannot be undone.`,
				cls: "mtg-status",
			});
			const row = confirmWrap.createDiv({ cls: "mtg-svg-btn-row" });
			const yesBtn = row.createEl("button", {
				text: "Yes, remove",
				cls: "mtg-remove-btn",
			});
			yesBtn.addEventListener("click", () => {
				this.plugin.removeCollectionCard(this.card.id);
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

		// Condition/language are displayed in two places — the icons above the
		// image, and the panel's boxes (in the collapsible section, see
		// gradingExpanded further down) — choosing a value in one of the two must
		// update the other. applyCondition/applyLanguage centralize the mutation +
		// the refresh of both locations; the references below are only filled in
		// if the corresponding element was actually created (the image only if
		// this.card.imageUrl is defined; the panel boxes only if gradingExpanded
		// is true). HTMLElement, nothing more precise:
		// condGlyphImageEl/langFlagImageEl hold either a badge/flag (real value),
		// or the fallback Lucide icon "no value chosen"
		// (createConditionIcon/createLanguageIcon, types.ts) — two different DOM
		// shapes (text span vs span+injected svg), never interchangeable by a
		// simple in-place .setText()/.style.color. applyCondition/applyLanguage
		// below therefore systematically rebuild the element (remove + recreate)
		// instead of mutating it, unlike the old code from before this fallback
		// was added.
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
			this.plugin.setCollectionCardCondition(this.card.id, value);
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
			this.plugin.setCollectionCardLanguage(this.card.id, code);
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
			// Condition/language above the image (not overlaid): they are attributes
			// of the physical copy, just like the foil already overlaid on the image,
			// but placed alongside rather than on top so as never to hide the artwork.
			const imageIcons = imageColumn.createDiv({ cls: "mtg-card-detail-image-icons" });

			const condBtn = imageIcons.createDiv({ cls: "mtg-card-detail-image-icon-btn" });
			condGlyphImageEl = createConditionIcon(
				condBtn,
				this.card.condition,
				"mtg-card-detail-image-icon-glyph"
			);
			condBtn.setAttribute("title", getCondition(this.card.condition).label);
			condBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				openPickerMenu(condBtn, conditionPickerItems());
			});
			condBtnImageEl = condBtn;

			const langBtn = imageIcons.createDiv({ cls: "mtg-card-detail-image-icon-btn" });
			langFlagImageEl = createLanguageIcon(
				langBtn,
				this.card.language,
				"mtg-card-detail-image-icon-flag",
				"mtg-card-detail-image-icon-glyph"
			);
			langBtn.setAttribute("title", getLanguage(this.card.language).label);
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

			// 3D "flip" button — only for a real physical double-faced card
			// (transform/modal_dfc), see getDoubleFacedImages (scryfall.ts). The
			// staleness guard follows the same convention as the other boxes of this
			// panel that depend on a Scryfall round trip (Legal Formats, Store Prices,
			// Price History further down): requestedId captured at launch, compared to
			// this.card.scryfallId once the promise has resolved, to ignore a response
			// that arrived after a prev/next navigation to another card.
			const flipRequestedId = this.card.scryfallId;
			void this.plugin.getCardFaceImages(flipRequestedId).then((images) => {
				if (!images || this.card.scryfallId !== flipRequestedId) return;
				setupDoubleFacedFlip(imageColumn, tilt, images.back, this.flipped, (flipped) => {
					this.flipped = flipped;
				});
			});

			// "Rotation" button — only for a split layout (Fire // Ice, Never //
			// Return...), see getSplitCardInfo (scryfall.ts). Mutually exclusive with
			// the flip above (a card is either a real double-faced card or split,
			// never both — see getDoubleFacedImages/getSplitCardInfo), same staleness
			// guard as it.
			const splitRequestedId = this.card.scryfallId;
			void this.plugin.getSplitCardInfo(splitRequestedId).then((info) => {
				if (!info || this.card.scryfallId !== splitRequestedId) return;
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
			new ChangePrintingModal(this.app, this.plugin, this.card, () => {
				this.view.render();
				this.draw();
			}).open();
		});

		const deleteBtn = headerRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-icon-box mtg-delete-icon-btn",
		});
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttribute("title", "Remove from list");
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
						this.plugin.setCollectionCardFinish(this.card.id, f.value);
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
			// this.draw() (not only this.view.render()): the modal stays open after a
			// copy (unlike the move further down, which closes since the card leaves
			// this list) — without redrawing its own content, the "Copies in Lists"
			// block stayed on the snapshot captured when the modal opened, without the
			// copy that was just created (reported bug).
			new CopyCardModal(this.app, this.plugin, [this.card], "collection", () => {
				this.view.render();
				this.draw();
			}).open();
		});

		const gradingToggleBox = attrRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-icon-box",
		});
		setIcon(gradingToggleBox, this.gradingExpanded ? "chevron-up" : "chevron-down");
		gradingToggleBox.setAttribute("title", "Grading & custom price");
		// The wrapper is filled in further down (only if gradingExpanded is
		// already true at this point of draw()) — closing relies on it directly
		// (removing is-expanded triggers the CSS transition) without going back
		// through draw(), so this closure must see the up-to-date value at click
		// time, not only at creation. It works: gradingWrapperEl is assigned
		// further down in this same synchronous call to draw(), so by the time a
		// click can actually arrive, it already points to the right element (or
		// stays null if the block wasn't open).
		let gradingWrapperEl: HTMLElement | null = null;
		gradingToggleBox.addEventListener("click", () => {
			if (this.gradingExpanded) {
				this.gradingExpanded = false;
				setIcon(gradingToggleBox, "chevron-down");
				if (gradingWrapperEl) {
					// Animates the closing on the existing element (already painted), without
					// waiting for a complete draw() — then, once the transition has finished,
					// a delayed draw() removes the block from the DOM for good (same 300ms
					// timer as toggleGroupRows for groups). Freezes the current height
					// (measured, "auto" doesn't animate) as explicit pixels before removing
					// is-expanded, otherwise the "height" transition has nothing concrete to
					// interpolate from. The offsetHeight read that follows forces the browser
					// to apply this value BEFORE the next change (without which the two merge
					// into a single operation and the transition never sees the starting
					// state).
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
			// Visually groups everything the toggle reveals (Condition/Language +
			// Graded/Custom Price) in a single dotted outline, so that it's understood
			// at a glance that these boxes form a separate block rather than simply
			// continuing the list of always-visible boxes above. Purely cosmetic —
			// since the switch to a measured pixel height (see below and styles.css),
			// gradingWrapper no longer needs a single child to animate, unlike the old
			// grid-template-rows technique.
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
				text: getCondition(this.card.condition).label,
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
				text: getLanguage(this.card.language).label,
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
			// No arrow here (unlike Condition/Language/Finish): explicitly requested —
			// "Graded" opens GradingModal as a shortcut, it's not an inline picker, so
			// no 1em/auto gutter to balance (see
			// mtg-card-detail-finish-value-row-no-caret in CSS for the single-column
			// re-centering this implies).
			const gradedValueRow = gradedBox.createDiv({
				cls: "mtg-card-detail-finish-value-row mtg-card-detail-finish-value-row-no-caret",
			});
			gradedValueRow.createSpan({
				cls: "mtg-card-detail-finish-value",
				// gradingCompany alone is no longer enough to say "graded" (see
				// gradingExpanded above) — GradingModal preselects PSA by default and
				// saves it even with no grade/condition entered.
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
				new GradingModal(this.app, this.plugin, this.card, () => {
					this.view.render();
					this.draw();
				}).open();
			});

			// No modal here (unlike gradedBox): the user types their price directly in the
			// box, saved via setCollectionCardCustomPrice on blur/Enter. Never call
			// this.draw()/this.view.render() from these handlers — a redraw in the middle of
			// typing would cut the focus (same risk as the pendingFocusRestore documented
			// elsewhere in this file), and nothing else in the panel displays customPrice
			// that would need updating in return.
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
				this.plugin.setCollectionCardCustomPrice(this.card.id, priceInput.value);
			};
			priceInput.addEventListener("blur", commitCustomPrice);
			priceInput.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") priceInput.blur();
			});

			// The very first opening starts from the collapsed state (see the base
			// class in styles.css) then switches to is-expanded one frame later, so
			// that the CSS transition has a real state change to animate — without the
			// rAF, the element would appear already in its final state from its first
			// paint, with no visible transition. A draw() that falls through here for
			// a completely different reason (block already open) jumps straight to the
			// final state, without replaying the entrance animation.
			if (this.gradingJustOpened) {
				this.gradingJustOpened = false;
				// scrollHeight measures the natural height of the content already built
				// above DESPITE the current height:0/overflow:hidden (set by the base
				// class in CSS) — which is precisely what scrollHeight is made to report.
				// Set at the same time as is-expanded, in the same rAF callback, so that
				// height/margin-bottom/opacity all three start their transition from the
				// same painted state, at the same instant (see styles.css for why this
				// replaces the old grid-template-rows technique, which didn't keep these
				// properties perfectly in phase despite an identical declared
				// duration/curve).
				const targetHeight = gradingWrapper.scrollHeight;
				window.requestAnimationFrame(() => {
					gradingWrapper.addClass("is-expanded");
					gradingWrapper.style.height = `${targetHeight}px`;
				});
				window.setTimeout(() => {
					// Goes back to "auto" once the transition is over: a value frozen in
					// pixels would stay wrong if the content later changes height (e.g.
					// selecting a longer grade label in Graded) without going back through
					// this opening path. "auto" is that of .is-expanded (styles.css): we
					// remove the pixel value. On a block closed in the meantime (it no longer
					// has is-expanded) the height therefore stays 0 — the old code would
					// reopen it abruptly by setting an inline "auto".
					gradingWrapper.style.removeProperty("height");
				}, 300);
			} else {
				// Redraw while the block is already open (changing the finish, saving the
				// grading…): no animation to replay, the height directly follows the
				// content (height:auto of .is-expanded).
				gradingWrapper.addClass("is-expanded");
			}
		}

		const list = this.plugin.settings.lists.find((l) => l.id === this.card.listId);
		const listBoxRow = panel.createDiv({ cls: "mtg-card-detail-box-row" });
		const listBox = listBoxRow.createDiv({
			cls: "mtg-card-detail-box mtg-card-detail-list-box mtg-card-detail-set-box-clickable",
		});
		listBox.setAttribute("title", "Move card to another list…");
		listBox.createDiv({ cls: "mtg-card-detail-finish-label", text: "List" });
		listBox.createDiv({ cls: "mtg-card-detail-list-box-value", text: list?.name ?? "" });
		listBox.addEventListener("click", () => {
			new CopyCardModal(
				this.app,
				this.plugin,
				[this.card],
				"collection",
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
			this.plugin.changeCollectionCardCount(this.card.id, 1, () => {
				refreshQuantityAndPrice();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});
		downBtn.addEventListener("click", () => {
			this.plugin.changeCollectionCardCount(this.card.id, -1, () => {
				refreshQuantityAndPrice();
				downBtn.toggleClass("is-disabled", this.card.count <= 1);
			});
		});

		setupPanelScrollFade(panel);
	}

	private renderCopiesInListsBox(panel: HTMLElement) {
		const others: CopyTile[] = [];

		this.plugin.settings.collection
			.filter((c) => c.name === this.card.name && c.id !== this.card.id)
			.forEach((c) => {
				others.push({
					kind: "collection",
					sourceName: this.plugin.settings.lists.find((l) => l.id === c.listId)?.name ?? "",
					imageUrl: c.imageUrl,
					finish: c.finish,
					count: c.count,
					priceText: formatCardPrice(c, this.plugin.settings.priceCurrency),
					onClick: () => {
						this.card = c;
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
				kind: "collection",
				sourceName: this.plugin.settings.lists.find((l) => l.id === this.card.listId)?.name ?? "",
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

	// See MTGCollectionPlugin.prefetchCardbaseNeighbors for the full reasoning
	// (window depending on API key, sequential, deduplicated by cache). The
	// debounce here (500ms) prevents a fast Cover Flow navigation from
	// stacking one preload scheduling per card traversed — only the last card
	// that actually stayed displayed for a moment triggers a real batch of
	// requests.
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
