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

// Options du picker "Category" — DECK_BOARD_TABS (data-model.ts, "onglets
// de board" au-dessus de la liste des cartes d'un deck) plutôt qu'une
// liste dupliquée ici : les deux représentent exactement le même concept
// (les 3 vraies valeurs de DeckCardCategory), Commander n'en fait plus
// partie depuis le 2026-09-07 (voir DeckCardCategory, data-model.ts — c'est
// désormais une Function, choisie via la boîte "Function" juste à côté).
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
/*  Deck card detail modal — même trio Finish/Language/Condition + Graded/   */
/*  Custom Price que CardDetailModal (harmonisation My Decks/My Collection,  */
/*  2026-08-25, demandée explicitement). La boîte "Deck" ouvre CopyCardModal */
/*  en mode "move", et une boîte "Copy card to…" dédiée l'ouvre en mode      */
/*  "copy" (même jour, même harmonisation) — CopyCardModal accepte           */
/*  maintenant "deck" comme 3ᵉ sourceKind, en plus de "collection"/          */
/*  "wantlist". A maintenant aussi son propre "Copies in Lists"              */
/*  (2026-09-08, cross-section — voir renderCopiesInListsBox plus bas ; le   */
/*  rendu du carrousel est commun aux trois fenêtres, shared-detail-boxes.ts)*/
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
	// Voir CardDetailModal.copiesActiveTileMetaEl — même correctif, même
	// raison (2026-09-08 : cette fenêtre a maintenant elle aussi un bloc
	// "Copies in Lists", voir renderCopiesInListsBox plus bas).
	private copiesActiveTileMetaEl: HTMLElement | null = null;
	// Voir CardDetailModal.prefetchTimeout — même débounce, même raison.
	private prefetchTimeout: number | null = null;
	// Voir CardDetailModal.flipped — même raisonnement (bouton "flip" 3D),
	// réinitialisé aux 2 endroits où this.card est réassigné plus bas.
	private flipped = false;
	// Voir CardDetailModal.splitRotated — même raisonnement (bouton "rotation"
	// des cartes split, défaut async), réinitialisé aux 2 mêmes endroits.
	private splitRotated: boolean | null = null;
	// Voir CardDetailModal.legalFormatsShownFor — même mécanisme (évite de
	// rejouer le fondu de révélation sur un redessin de la même carte déjà
	// résolue) et, comme là-bas, jamais réinitialisé à la navigation prev/
	// next : revoir une carte déjà résolue rejoue le fondu une fois de
	// plus, un compromis accepté plutôt que de suivre chaque carte visitée.
	private legalFormatsState: LegalFormatsState = { shownFor: null };
	// Voir CardDetailModal.gradingExpanded/gradingJustOpened — même
	// raisonnement à l'identique (harmonisation My Decks/My Collection,
	// 2026-08-25), recalculé aux mêmes 2 endroits où this.card change de
	// référence plus bas (constructeur + les 2 flèches prev/next). Toujours
	// pas de 3ᵉ point comme côté Collection/Wantlist : "Copies in Lists"
	// existe maintenant ici aussi (2026-09-08), mais ferme systématiquement
	// cette fenêtre au clic plutôt que de réassigner this.card en place
	// (voir renderCopiesInListsBox — DeckCardDetailModal n'a pas
	// l'équivalent de navAnchorId pour garder "Card X of Y" cohérent si
	// this.card divergeait de navCards), donc jamais de réassignation en
	// place à couvrir ici.
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
		// Masque la croix native d'Obsidian (classe partagée par toutes les
		// modales du plugin qui ont leur propre croix perso — voir modal-
		// animation.ts) : ce bouton lui-même vit dans contentEl, rebâti à
		// chaque draw() (voir plus bas), donc PAS ajouté via addModalCloseButton
		// ici — seule cette classe de masquage est nécessaire dans onOpen().
		this.modalEl.addClass("mtg-modal-hides-native-close");
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
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
		// On préserve le calque de fond (voir BackgroundCrossfader) : seul un
		// vidage sélectif (pas contentEl.empty()) permet le fondu enchaîné
		// entre deux illustrations lors de la navigation précédent/suivant.
		this.bg.clearSiblingsIn(contentEl);
		contentEl.addClass("mtg-card-detail-modal");
		contentEl.addClass("mtg-card-detail-modal-fixed-height");

		const closeBtn = contentEl.createDiv({ cls: "mtg-card-detail-close-btn" });
		setIcon(closeBtn, "x");
		closeBtn.setAttribute("title", "Close");
		closeBtn.addEventListener("click", () => this.close());

		// Fond flouté : l'illustration seule (art crop), pas la carte entière.
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

		// Condition/langue affichées à deux endroits (icônes au-dessus de
		// l'image + boîtes du panneau dans la section repliable) — voir
		// CardDetailModal.draw pour le raisonnement complet, identique ici.
		// Harmonisation My Decks/My Collection, 2026-08-25 : DeckCard porte
		// maintenant condition/language (voir data-model.ts), retrouvées ici
		// via deck.id + scryfallId (setDeckCardCondition/setDeckCardLanguage)
		// plutôt qu'un id propre, comme changeDeckCardCount plus bas.
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
			// Calques de couleur foil/holo — voir CardDetailModal pour le
			// raisonnement complet, identique ici depuis que DeckCard porte
			// un finish (harmonisation 2026-08-25).
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

			// Bouton "flip" 3D — voir CardDetailModal pour le raisonnement complet
			// (même fonction partagée, même guard de péremption). Ne nécessite que
			// scryfallId, donc disponible ici comme pour Price History/Card Text
			// (et, depuis le 2026-09-02, la colonne Store Prices TCGplayer —
			// DeckCard porte désormais son propre prix Scryfall en cache, voir
			// renderStorePricesBox plus bas).
			const flipRequestedId = this.card.scryfallId;
			void this.plugin.getCardFaceImages(flipRequestedId).then((images) => {
				if (!images || this.card.scryfallId !== flipRequestedId) return;
				setupDoubleFacedFlip(imageColumn, tilt, images.back, this.flipped, (flipped) => {
					this.flipped = flipped;
				});
			});

			// Bouton "rotation" — voir CardDetailModal pour le raisonnement complet.
			// Ne nécessite que scryfallId, disponible ici comme pour Price History/
			// Card Text/le flip ci-dessus.
			const splitRequestedId = this.card.scryfallId;
			void this.plugin.getSplitCardInfo(splitRequestedId).then((info) => {
				if (!info || this.card.scryfallId !== splitRequestedId) return;
				// Toujours portrait par défaut — voir CardDetailModal.
				if (this.splitRotated === null) this.splitRotated = false;
				setupSplitCardRotation(imageColumn, tilt, this.splitRotated, (rotated) => {
					this.splitRotated = rotated;
				});
			});
			// Ruban en dehors de `tilt` (pas un enfant) : reste plat, épinglé au
			// coin du wrap, plutôt que de pivoter avec la carte en 3D.
			if (!isDeckCardOwned(this.card)) {
				imageWrap.createDiv({ cls: "mtg-thumb-wanted-ribbon", text: "Wanted" });
			}
		}

		const panel = layout.createDiv({ cls: "mtg-card-detail-panel" });

		const headerRow = panel.createDiv({ cls: "mtg-card-detail-header-row" });
		// Même boîte cliquable → ChangePrintingModal que CardDetailModal/
		// WantlistCardDetailModal (mtg-card-detail-set-box-clickable, "View all
		// versions") — n'existait ici que sous sa forme non cliquable jusqu'ici
		// (DeckCard n'a pas de champ id propre, voir "Data model notes" dans
		// CLAUDE.md, ce qui bloquait la réutilisation directe de
		// changeCollectionCardPrinting/changeWantlistCardPrinting) ; changeDeckCardPrinting
		// (plugin.ts) retrouve la ligne par scryfallId + catégorie à la place,
		// voir son propre commentaire.
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
		// Voir CardDetailModal.copiesActiveTileMetaEl — même correctif ciblé,
		// depuis que cette fenêtre a elle aussi "Copies in Lists" (2026-09-08) :
		// sans ça, changer la quantité laisserait la tuile active de ce
		// carrousel affichée avec l'ancien nombre.
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

		// Finish — même boîte/picker que CardDetailModal, harmonisation
		// 2026-08-25. Pas de boîte "Copy card to…" ici (contrairement à
		// Collection) : voir le commentaire sur "Deck" plus bas, un deck n'a
		// pas de notion de copie/déplacement de carte.
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

		// "Copy card to…" — même boîte/icône que CardDetailModal, demandée
		// explicitement le même jour que "Deck" ouvrant "Move card" ci-dessous
		// (harmonisation 2026-08-25). Mode "copy" (le défaut de CopyCardModal,
		// non précisé ici comme dans CardDetailModal) : contrairement au clic
		// sur "Deck" plus bas, la carte reste dans ce deck après la copie —
		// this.draw() derrière this.view.render() n'a rien à rafraîchir de
		// spécifique à ce bloc (pas de "Copies in Lists" côté Deck), mais suit
		// la même convention que CardDetailModal par cohérence.
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

		// Toggle Graded/Custom Price (+ Condition/Language dans la section
		// repliable ci-dessous) — voir CardDetailModal.draw pour le
		// raisonnement complet, identique ici.
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
					// Plus de hauteur en ligne : la classe de base fait height:0 (styles.css), la transition part de
					// la valeur en pixels posée juste au-dessus.
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
					// "auto" est celui de .is-expanded (voir card-detail-modal.ts).
					gradingWrapper.style.removeProperty("height");
				}, 300);
			} else {
				gradingWrapper.addClass("is-expanded");
			}
		}

		// Même boîte "List"/"Wantlist" cliquable → CopyCardModal (mode "move")
		// que CardDetailModal/WantlistCardDetailModal — n'existait ici que
		// sous sa forme non cliquable jusqu'ici ("un deck n'a pas de notion
		// de déplacer cette carte", CopyCardModal ne prenait que des
		// CollectionCard/WantlistCard en source) ; demandé explicitement le
		// 2026-08-25, immédiatement après l'harmonisation Finish/Condition/
		// Language/Grading — copyDeckCardToList/copyDeckCardToDeck/
		// copyDeckCardToWantlist (plugin.ts) retrouvent la ligne par
		// scryfallId + catégorie plutôt que par un id propre, voir leur
		// commentaire.
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

		// "Board"/"Function" — juste après "Deck", pas dans le tiroir
		// repliable Condition/Language/Graded (2026-09-02, demandé
		// explicitement avec capture à l'appui, après une première version où
		// "Function" vivait dans la rangée Condition/Language). Ce picker
		// (DeckCardCategory — Mainboard/Sideboard/Maybeboard, voir
		// DECK_BOARD_TABS/"onglets de board"/vue Stacks) est un attribut
		// structurel de la place de la carte DANS ce deck, pas un détail
		// secondaire de condition physique comme Condition/Language/Graded —
		// mérite donc sa propre rangée, au même niveau que "Deck" plutôt
		// qu'enfouie dans le tiroir. Function déplacée ici pour la même
		// raison (regroupée avec ce picker plutôt qu'avec Condition/Language).
		// Commander n'est PLUS l'une des options de ce picker depuis le
		// 2026-09-07 (demandé explicitement : "Commander est une Function") —
		// se désigne désormais depuis la boîte "Function" juste à côté.
		// Libellé affiché "Board" plutôt que "Category" depuis le 2026-09-08
		// (demandé explicitement, "cela sera plus clair") — variables/CSS
		// internes gardées telles quelles (categoryBox/categoryFunctionRow,
		// DeckCardCategory), seul le texte visible change.
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

		// "Function" (2026-09-02, voir "Group by Function"/vue Stacks) — même
		// boîte/picker que Category ci-dessus. Le picker propose toujours
		// "Auto (…)" en tête pour revenir à la détection automatique — jamais
		// un état "aucune fonction" séparé.
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

	// Même principe que CardDetailModal.renderCopiesInListsBox — cross-
	// section (2026-09-08, demandé explicitement) : My Collection, My Decks
	// (y compris CE deck-ci, en excluant la carte active par référence
	// puisque DeckCard n'a pas d'id propre) et My Wantlists. À la différence
	// de CardDetailModal/WantlistCardDetailModal, AUCUNE tuile ne réassigne
	// this.card en place ici, pas même une autre carte de deck du même
	// nom (même dans CE deck) : cette fenêtre n'a pas d'équivalent de
	// navAnchorId pour garder "Card X of Y" cohérent si this.card
	// divergeait de navCards (voir le commentaire sur gradingExpanded plus
	// haut) — plus simple et plus sûr de toujours fermer cette fenêtre et
	// ouvrir la bonne à la place, y compris pour une autre DeckCard.
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

	// Les boîtes ci-dessous sont communes aux trois fenêtres de détail (voir shared-detail-boxes.ts) :
	// ces méthodes ne font que leur donner ce qui est propre à CETTE section.
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

	// Voir CardDetailModal.schedulePrefetchNeighbors — même logique, mais
	// centerIndex se calcule par scryfallId (comme renderNavHeader ci-dessus,
	// DeckCard n'a pas d'id propre ni de navAnchorId) — même exclusion Proxy
	// (null) que CardDetailModal depuis l'harmonisation 2026-08-25.
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
