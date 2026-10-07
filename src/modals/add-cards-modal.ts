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

// Un clic applique directement le filtre/tri, sans avoir à le taper à la
// main — "chip" ajoute (ou retire, en re-cliquant) un jeton dans la barre de
// puces existante (même moteur que la saisie manuelle, voir card-search.ts) ;
// "sort" bascule l'ordre de tri Scryfall lui-même (voir sortOverride plus
// bas), un jeton de puce ne pouvant pas exprimer un ORDRE de résultats,
// seulement une contrainte de filtre.
type SuggestedFilter =
	| { kind: "chip"; label: string; token: string }
	| { kind: "sort"; label: string; order: string; dir: "asc" | "desc" };

// Fixe pour l'instant — prévu (pas encore fait, demandé explicitement comme
// "dans un second temps") pour qu'une liste de filtres personnalisés
// enregistrés par l'utilisateur vienne s'ajouter à celle-ci plus tard, sans
// revoir le mécanisme d'affichage/clic lui-même (renderSuggestedFilters plus
// bas ne fait aucune hypothèse sur l'origine de la liste).
const DEFAULT_SUGGESTED_FILTERS: SuggestedFilter[] = [
	{ kind: "chip", label: "Lands", token: "land" },
	{ kind: "sort", label: "Price up", order: "usd", dir: "asc" },
	{ kind: "sort", label: "Price down", order: "usd", dir: "desc" },
];

/* -------------------------------------------------------------------------- */
/*  "Add all" — seuils (voir performAddAll/runAddAll plus bas)                */
/* -------------------------------------------------------------------------- */

// Au-delà de ce total, AddAllConfirmModal affiche un paragraphe
// d'avertissement en plus de la simple confirmation habituelle (temps
// d'attente réel, Obsidian qui peut sembler figé pendant l'opération) —
// demandé explicitement plutôt qu'une confirmation identique quelle que
// soit la taille du lot.
const ADD_ALL_WARNING_THRESHOLD = 500;
// Au-delà de ce total ajouté en une seule fois, une tuile d'historique PAR
// CARTE (renderHistoryTile — un nouveau nœud DOM + une resynchronisation
// FLIP des tuiles voisines à chaque carte) figerait l'UI sur un lot de
// plusieurs centaines/milliers de cartes — demandé explicitement. Au-delà,
// une seule tuile résumée agrégée remplace le suivi individuel (voir
// addAllBatch/renderAddAllBatchTile) : annuler/réactiver le lot entier reste
// une opération de données pure (un appel onUndoAdd/onAdd par carte, aucun
// travail DOM), pas du tout la même échelle de coût.
const HISTORY_AGGREGATE_THRESHOLD = 50;
// Plafond dur : au-delà, "Add all" refuse plutôt que de tenter l'opération.
// addCardToCollection/undoAddToCollection (plugin.ts) retrouvent leur ligne
// par un .find()/.filter() qui parcourt TOUTE la collection à chaque carte
// ajoutée/annulée — O(N) par carte, donc O(N²) sur l'ensemble du lot, et
// rien de tout ça n'est découpé en tâches asynchrones (une seule boucle
// synchrone par page récupérée). Sans plafond, ajouter la totalité du
// catalogue Magic (~96 000 impressions, "unique=prints") sur une collection
// réelle de quelques milliers de cartes représenterait plusieurs MILLIARDS
// de comparutions .find() — de l'ordre de la minute (voire plus) d'un seul
// tenant, JavaScript étant mono-thread : Obsidian resterait entièrement
// figé (aucune frame, aucun clic possible) pendant tout ce temps, pas
// seulement "lent". 5000 reste un lot confortablement gérable (quelques
// secondes maximum, même sur une grosse collection existante) tout en
// couvrant tout filtre de recherche réaliste — un utilisateur qui veut
// littéralement TOUT le catalogue doit affiner sa recherche (un filtre de
// set/couleur/rareté, etc.) plutôt que de pouvoir geler Obsidian en un
// clic.
const ADD_ALL_HARD_CAP = 5000;

/* -------------------------------------------------------------------------- */
/*  Panneau "Add history" (voir onUndoAdd, shared-search-ui.ts)               */
/* -------------------------------------------------------------------------- */

// Un lot d'ajouts partageant les mêmes options (finish/language/condition) —
// une HistoryEntry (voir plus bas) peut en théorie porter plusieurs
// contributions si le même printing a été ajouté à la même destination avec
// des options DIFFÉRENTES, mais computeAddOptions renvoie toujours la même
// valeur constante depuis le retrait de tout sélecteur Finish/Language/
// Condition dans cette modale — un 2e groupe distinct n'a donc plus de
// chemin réaliste pour se produire aujourd'hui. `count` est le nombre de
// fois où onAdd a effectivement été appelé avec CES options précises,
// jamais un delta signé (une entrée désactivée n'a plus de contributions
// "négatives", elle repart de zéro au prochain ajout — voir
// recordHistoryAdd).
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
	// Construits par renderHistoryTile, absents avant son tout premier appel
	// pour cette entrée — recordHistoryAdd s'en sert justement comme
	// signal ("pas encore de tuile" -> construire, sinon -> mettre à jour).
	tileEl?: HTMLElement;
	quantityEl?: HTMLElement;
	toggleBtn?: HTMLInputElement;
	// Ligne 2 (icône + set/numéro + destination) — gardée pour pouvoir la
	// reconstruire en place après un changement d'impression/un déplacement
	// réussi (voir openChangePrintingForEntry/openMoveCardForEntry), sans
	// devoir retrouver tile.querySelector à chaque fois.
	line2El?: HTMLElement;
	// true une fois que cette carte a été déplacée HORS du périmètre que
	// this.sourceKind (fixe pour toute la durée de vie de la modale)
	// représente — vers un deck, ou vers l'AUTRE côté Collection/Wantlist
	// (bug rapporté : déplacer une carte vers un deck/une wantlist depuis
	// "All Cards" cassait silencieusement les 2 liens ensuite, exactement
	// comme le bug déjà corrigé pour un déplacement RESTANT dans le même
	// périmètre — voir openMoveCardForEntry/locateMovedCardAnywhere). Ni
	// ChangePrintingModal ni CopyCardModal ne peuvent plus opérer
	// correctement sur cette ligne depuis CETTE modale une fois ce cas
	// atteint (this.sourceKind ne peut pas suivre le changement par
	// entrée) — les 2 liens deviennent alors définitivement non
	// interactifs pour cette tuile, même traitement que le flux Deck, qui
	// n'a jamais eu ces liens du tout.
	linksDisabled?: boolean;
	// Où la carte a réellement atterri une fois linksDisabled devenu vrai —
	// pilote le badge de contexte non cliquable ("In Collection"/"In
	// Decks"/"In Wantlists", voir buildHistoryTileTrailing) qui remplace
	// alors la corbeille. undefined tant que linksDisabled est faux.
	frozenKind?: "collection" | "wantlist" | "deck";
	// Élément actuellement affiché après le 2ᵉ séparateur — soit la
	// corbeille, soit le badge de contexte — gardé pour pouvoir le
	// remplacer en place (buildHistoryTileTrailing) au lieu de devoir
	// reconstruire toute la tuile quand linksDisabled change.
	trailingEl?: HTMLElement;
	// Resynchronise la tuile carrousel d'origine après un toggle — voir
	// recordHistoryAdd/toggleHistoryEntry/deleteHistoryEntry. Absent tant
	// qu'aucun ajout n'a encore réussi pour cette entrée (ne devrait pas
	// arriver en pratique : une HistoryEntry n'existe qu'après un ajout
	// réussi), ou si la tuile carrousel d'origine a depuis été détruite
	// sans qu'un nouvel ajout ne l'ait remplacé (recherche différente) —
	// dans les deux cas, l'absence est un no-op silencieux.
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
	// Voir sourceKind, shared-search-ui.ts — pilote uniquement les 2 liens
	// "Change printing"/"Move card" du panneau "Add history" (renderHistoryTile).
	private sourceKind?: AddCardsModalOptions["sourceKind"];
	// Panneau "Add history" (2ᵉ colonne de bottomSection, voir onOpen) —
	// historyListEl/historyEmptyEl ne sont construits que si onUndoAdd est
	// fourni (voir leur propre construction, onOpen) ; historyEntries est un
	// Map même sans le panneau, jamais lu/écrit dans ce cas (this.onUndoAdd
	// garde tous les points d'entrée). Clé = historyKey(scryfallId, listId)
	// — voir cette méthode pour le raisonnement.
	private historyListEl!: HTMLElement;
	private historyEmptyEl!: HTMLElement;
	private historyEntries: Map<string, HistoryEntry> = new Map();
	// Tiroir "Add history" — masquable/affichable, demandé explicitement
	// ("comme un tiroir"). historyPanelEl porte la classe is-collapsed
	// togglée par toggleHistoryDrawer, qui pilote tout le reste en CSS pur
	// (largeur/contenu visible — voir styles.css). historyCollapsed vit sur
	// l'instance (pas persisté) — repart toujours FERMÉ (valeur initiale
	// `true`, demandé explicitement) à chaque nouvelle ouverture de la
	// modale ; la classe is-collapsed correspondante est posée directement
	// à la construction du panneau (onOpen), pas via toggleHistoryDrawer
	// (qui ne s'exécute que sur un clic).
	private historyPanelEl?: HTMLElement;
	private historyCollapsed = true;
	private titleText: string;
	private listGallery?: AddCardsModalOptions["listGallery"];
	private chipTokens: string[] = [];
	private chipDraft = "";
	private chipSuggestionHighlightIndex = -1;
	private chipBarContainerEl!: HTMLElement;
	// Un ajout par carte actuellement affichée dans le carrousel, exposé par
	// renderAddControl — permet à "Add all" de rejouer exactement le même
	// chemin de code que le bouton "Add" individuel de chaque tuile (mêmes
	// options, même conversion en stepper une fois ajoutée), plutôt qu'un
	// second mécanisme d'ajout à maintenir en parallèle. Réinitialisé à
	// chaque fois que resultsEl est vidé (nouvelle recherche) — voir
	// resetResultControls.
	private currentResultControls: { card: ScryfallCard; addOne: (listId?: string, silent?: boolean) => void }[] = [];
	private addAllBtn!: HTMLButtonElement;
	// Pagination Scryfall (voir ScryfallPagedResult, scryfall.ts) — une seule
	// page Scryfall plafonne à 175 résultats ; au-delà, un bouton "Load more"
	// en fin de piste charge la suite. Un clic explicite plutôt qu'un
	// défilement infini auto-déclenché : un fetch réseau de plus reste
	// volontaire, cohérent avec la prudence déjà établie dans ce fichier
	// autour du volume de requêtes Scryfall (voir "Real rate-limit incident"
	// dans CLAUDE.md). currentPage/hasMorePages/totalCardsFound sont tous
	// réinitialisés par resetResults() (nouvelle recherche) ; loadMoreQuery
	// capture les paramètres de LA recherche pour laquelle hasMorePages est
	// devenu vrai (null = recherche par défaut, fetchLatestPaperPrintings)
	// pour que "Load more" recharge exactement la bonne recherche.
	private currentPage = 1;
	private hasMorePages = false;
	private loadingMorePage = false;
	private totalCardsFound = 0;
	private loadMoreEl: HTMLElement | null = null;
	private loadMoreQuery: { setCode: string; collectorNumber: string; chipQuery: string } | null = null;
	// Incrémenté à chaque resetResults() (nouvelle recherche) — voir
	// runAddAll : un "Add all" auto-paginé (hasMorePages) tourne sur
	// plusieurs allers-retours réseau, pendant lesquels l'utilisateur reste
	// libre de lancer une AUTRE recherche (currentPage/hasMorePages/
	// totalCardsFound/loadMoreQuery seraient alors remis à zéro sous ses
	// pieds). runAddAll capture ce compteur au démarrage et le revérifie
	// après chaque page récupérée — un écart signifie qu'une recherche plus
	// récente a pris le relais, auquel cas la boucle s'arrête proprement
	// sans plus jamais toucher ces champs partagés (déjà repartis à zéro
	// pour la nouvelle recherche).
	private addAllGeneration = 0;
	// non-null UNIQUEMENT pendant un "Add all" dont le total dépasse
	// HISTORY_AGGREGATE_THRESHOLD — recordHistoryAdd y accumule chaque ajout
	// au lieu de construire/mettre à jour une tuile d'historique individuelle
	// (voir son propre commentaire). Un seul lot actif à la fois.
	private addAllBatch: { card: ScryfallCard; options: AddCardOptions; listId: string }[] | null = null;
	// Désactive le bouton "Add all" pendant qu'un lot est en cours (surtout
	// utile pour la variante auto-paginée, qui peut prendre plusieurs
	// secondes) — évite un second clic qui lancerait un 2ᵉ lot en parallèle
	// du premier.
	private addAllInProgress = false;
	// null = tri par défaut (par date de sortie, ou par édition si un filtre
	// "set:" est actif — voir searchScryfall). Fixé par un clic sur une
	// suggestion "sort" (voir DEFAULT_SUGGESTED_FILTERS/renderSuggestedFilters),
	// re-cliquer sur la même remet à null (bascule, pas seulement "applique").
	private sortOverride: { order: string; dir: "asc" | "desc" } | null = null;
	private suggestedFiltersEl!: HTMLElement;
	// Prompt inline "Save filter" (nom + Save/Cancel) — construit une fois,
	// masqué par défaut (is-visible bascule l'affichage), plutôt qu'une
	// nouvelle Modal pour une simple saisie de nom. Contrairement à la
	// confirmation "Add all" (voir AddAllConfirmModal plus bas dans ce
	// fichier, une vraie fenêtre séparée demandée explicitement), cette
	// confirmation-ci reste inline : un simple champ de nom n'a jamais été
	// concerné par cette demande.
	private saveFilterPromptEl!: HTMLElement;
	private saveFilterInputEl!: HTMLInputElement;
	// Bouton carré icône seule, à droite de la barre de puces elle-même (pas
	// dans suggestedFiltersEl) — reconstruit à chaque renderSearchChipBar
	// (chip ajoutée/retirée…), mais son état activé/désactivé doit AUSSI
	// suivre chipDraft (le mot-clé en cours de frappe, pas encore validé en
	// puce — demandé explicitement : activable "dès le premier mot-clé"),
	// qui change à chaque frappe SANS reconstruire toute la barre (perte de
	// focus sinon, voir le handler "input" plus bas) — d'où
	// updateSaveFilterButtonState, appelée séparément dans les deux cas.
	private saveFilterBtn!: HTMLButtonElement;
	private resultsCountEl!: HTMLElement;
	// Bloc "Search oracle" (renommé depuis "Filter oracle") — titre fixe +
	// phrase en anglais décrivant la barre de puces actuelle (voir
	// describeSearchFilters, card-search.ts, et updateFilterDescription).
	// filterDescriptionEl est le bloc entier (is-visible bascule son
	// affichage) ; filterDescriptionTextEl n'est que la phrase elle-même,
	// seule partie réécrite à chaque appel de updateFilterDescription — le
	// titre "Search oracle" est construit une fois et n'a jamais besoin
	// d'être retouché.
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

	// Autocomplétion du champ Set : filtre la liste complète des éditions par
	// nom au fur et à mesure de la frappe, affiche le symbole officiel de
	// chacune. Le code réel (utilisé pour la requête) n'est renseigné que
	// lorsqu'une suggestion est cliquée ; sinon, le texte tapé est utilisé tel
	// quel comme repli (pour qui préfère encore taper un code directement).
	// Barre à puces réutilisant le même système que le filtre de collection
	// (couleur, rareté, type, capacité, cmc/prix, foil, langue…), traduit vers
	// la syntaxe de requête Scryfall — voir buildScryfallQueryFromChips.
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

			// Même bascule "identité de couleur exacte" que renderChipFilter
			// (view.ts) — voir son commentaire pour le raisonnement complet.
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
					// recognized.flag est toujours un vrai code pays ici : "None"
					// n'est plus une entrée de LANGUAGES (voir types.ts).
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

			// Espace = valide la suggestion actuellement surlignée au clavier
			// (flèches ↑/↓), comme Entrée — demandé explicitement. Distinct de
			// la branche Entrée juste plus bas : ne se déclenche QUE s'il y a
			// vraiment un surlignage actif (chipSuggestionHighlightIndex ≥ 0),
			// pas dès que la liste est ouverte — sans navigation préalable au
			// clavier, un espace reste un espace ordinaire (valide le mot en
			// cours de frappe tel quel, voir le handler "input" plus bas),
			// exactement le comportement attendu quand on n'a pas parcouru les
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
			// !hasUnclosedQuote : voir la même garde dans renderChipFilter
			// (view.ts) — une phrase entre guillemets encore ouverte (ex.
			// après "oracle:") ne doit pas être coupée au premier espace.
			if (val.endsWith(" ") && !hasUnclosedQuote(val)) {
				const token = val.trim();
				this.chipDraft = "";
				if (token) {
					commitToken(token);
					return;
				}
			}
			this.chipDraft = val;
			// Pas de triggerSearch() ici — demandé explicitement : les cartes
			// proposées ne doivent pas bouger tant que le mot-clé en cours de
			// frappe n'est pas "validé" (espace/Entrée, ou une suggestion
			// cliquée — voir commitToken, qui appelle triggerSearch() lui-même).
			// Avant ce changement, buildScryfallQueryFromChips incluait déjà
			// chipDraft brut dans la recherche EN COURS, donc chaque frappe
			// relançait une recherche Scryfall avec un mot-clé encore partiel
			// ("r", "re", "red"…) — signalé comme un va-et-vient perturbant du
			// carrousel. La suggestion de complétion (renderChipSuggestions,
			// juste en dessous) reste instantanée à chaque frappe : c'est un
			// calcul local (SUGGESTABLE_KEYWORDS/éditions déjà en cache), pas un
			// aller-retour réseau, donc rien à gagner à la retarder elle aussi.
			void this.renderChipSuggestions(commitToken);
			// Pas de renderSearchChipBar() ici (perte de focus, voir plus haut) —
			// juste l'état activé/désactivé du bouton "Save filter", pour qu'il
			// devienne cliquable dès le premier mot-clé tapé, pas seulement une
			// fois une puce validée.
			this.updateSaveFilterButtonState();
			// Contrairement à triggerSearch() (résultats), la description en
			// anglais suit le mot-clé en cours de frappe EN DIRECT — un simple
			// changement de texte, pas de recherche réseau/saut visuel à éviter,
			// donc rien à gagner à la retarder jusqu'à validation.
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

		// Bouton carré icône seule, à droite de la barre — demandé
		// explicitement à la place de l'ancienne pilule "Save filter" sous la
		// barre. mousedown + preventDefault (pas "click" nu) : même raison que
		// syntaxBtn/clearBtn juste au-dessus, évite de voler le focus de
		// l'<input> au moment du clic.
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
		// Même correctif que MTGCollectionView.getKeywordSuggestions (view.ts) :
		// "legal:" seul matche d'un coup les 10 formats curatés en tête de
		// LEGALITY_SEARCH_FORMATS (card-search.ts) — un plafond de 5 aurait
		// coupé "Legal: Commander" (6ᵉ de cette liste), bug rapporté. "legal:"
		// est un préfixe qu'aucune autre catégorie ne peut matcher (voir
		// categorizeToken), donc repérer "toutes les correspondances sont de
		// catégorie legality" identifie ce cas sans ambiguïté. Même chose pour
		// "border:" seul (9 entrées, voir BORDER_SEARCH_OPTIONS).
		const staticCap =
			allStaticMatches.length > 0 &&
			(allStaticMatches.every((k) => k.category === "legality") ||
				allStaticMatches.every((k) => k.category === "border"))
				? 10
				: 5;
		const staticMatches = allStaticMatches.slice(0, staticCap);

		const allSets = await this.plugin.getAllScryfallSets();
		// Garde-fou anti-course : si l'utilisateur a continué à taper pendant
		// le chargement de la liste des éditions, ce rendu est périmé.
		if (this.chipDraft.trim().toLowerCase() !== q) return;

		// Les éditions dérivées (promos, tokens, art series, minijeux) partagent
		// souvent le même nom de base que l'édition principale — bug rapporté :
		// chercher "Battle for Zendikar" (ou juste "Zendikar") ne suggérait pas
		// l'édition elle-même. Confirmé avec les vraies données Scryfall : sur
		// les 17 éditions non-digitales contenant "zendikar", "Battle for
		// Zendikar" (set_type "expansion") arrive en position 12 dans l'ordre
		// naturel de l'API (date de sortie décroissante) — bien après les
		// variantes promo/token/minijeu de la plus récente "Zendikar Rising" —
		// donc jamais dans les 3 premiers résultats. Trier pour faire remonter
		// les éditions "principales" avant leurs variantes dérivées (tri stable
		// — ES2019+ garantit Array.prototype.sort stable — donc l'ordre
		// d'origine par date de sortie est préservé à l'intérieur de chaque
		// groupe) résout ça sans dépendre uniquement d'un plafond plus élevé.
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

		// Éditions : même convention "set:code" que le champ Set dédié, pour que
		// buildScryfallQueryFromChips les traduise de la même façon.
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
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-search-modal");
		this.modalEl.addClass("mtg-search-modal-wide");
		// Hauteur fixe (pas seulement plafonnée) : demandé pour que cette fenêtre
		// ait la même hauteur que la fenêtre de détail de carte — voir
		// .mtg-search-modal-fixed-height (styles.css) pour le raisonnement et le
		// compromis accepté. Scopée à AddCardsModal seule, pas ChangePrintingModal
		// (qui partage mtg-search-modal-wide pour la largeur mais pas cette classe).
		this.modalEl.addClass("mtg-search-modal-fixed-height");

		// contentEl (mtg-search-modal) n'a plus son propre padding (voir
		// styles.css, même technique que .mtg-card-detail-modal) — chacune
		// des deux sections directes ci-dessous fournit désormais le sien
		// explicitement. Nécessaire pour que mtg-search-bottom-section (plus
		// bas) puisse atteindre les bords gauche/droit/bas RÉELS de la
		// fenêtre avec son propre fond assombri — bug signalé : avec le
		// padding natif d'Obsidian encore actif sur contentEl, ce fond
		// restait visiblement en retrait de ces 3 bords (seul le dessous du
		// carrousel, où il n'y avait rien à "atteindre", donnait l'impression
		// que ça marchait). mtg-search-top-section regroupe le titre et le
		// carrousel, qui avaient seulement besoin de retrouver le même inset
		// qu'avant (padding choisi par nous, plus fiable qu'un padding natif
		// Obsidian implicite et non documenté qu'on ne pourrait qu'essayer de
		// deviner pour l'annuler ailleurs).
		const topSection = contentEl.createDiv({ cls: "mtg-search-top-section" });

		// titleText existait déjà comme option (utilisé par tous les appelants
		// dans view.ts, ex. "Add cards to \"{listName}\"") mais n'était jamais
		// affiché — un oubli, corrigé ici plutôt qu'en ajoutant un titre
		// spécifique au seul flux "All Cards" demandé, pour que les 5 flux qui
		// construisent cette modale en profitent tous de façon cohérente.
		topSection.createEl("h2", { text: this.titleText, cls: "mtg-search-modal-title" });

		this.resultsEl = setupResultsCarousel(topSection);

		// Rangée à 2 colonnes, chacune avec son PROPRE fond assombri distinct
		// (bottomMainEl/historyPanelEl plus bas, voir styles.css — demandé
		// explicitement, "l'historique devrait être dans un bloc foncé
		// distinct du bloc foncé de la recherche") — bottomSection lui-même
		// ne porte donc plus ni padding ni fond, juste la mise en page en
		// rangée (flex: 1; min-height: 0 pour absorber l'espace restant en
		// bas de la fenêtre, gap entre les 2 colonnes).
		const bottomSection = contentEl.createDiv({ cls: "mtg-search-bottom-section" });

		// bottomMainEl regroupe tout ce que bottomSection contenait seul avant
		// l'ajout du panneau "Add history" (compte de résultats/formulaire/
		// Search oracle/filtres), inchangé en soi — porte maintenant son
		// PROPRE padding/fond assombri/border-radius (voir styles.css), pour
		// que son fond atteigne bord à bord la moitié gauche de la fenêtre
		// (même principe que .mtg-card-detail-layout : padding interne, pas
		// sur contentEl/bottomSection eux-mêmes) tout en restant visuellement
		// séparé du panneau "Add history" à sa droite.
		const bottomMainEl = bottomSection.createDiv({ cls: "mtg-search-bottom-main" });

		// Nombre de cartes trouvées, discret — demandé explicitement. Reste
		// affiché tel quel pendant le chargement d'une nouvelle recherche (voir
		// setResultsCount) plutôt que de se vider puis se remplir à chaque
		// mise à jour — ce blanchiment intermédiaire était le petit saut
		// visuel signalé.
		this.resultsCountEl = bottomMainEl.createDiv({ cls: "mtg-search-results-count" });

		const form = bottomMainEl.createDiv({ cls: "mtg-search-form" });

		const nameField = form.createDiv({ cls: "mtg-search-field" });
		nameField.createEl("label", { text: "Search" });
		// Piste de puces + "Add all" côte à côte, SOUS le label — align-items:
		// stretch (styles.css) cale le bouton sur la hauteur RÉELLE de la barre
		// de puces plutôt qu'une valeur devinée, demandé explicitement ("même
		// hauteur que la barre de recherche").
		const searchBarRow = nameField.createDiv({ cls: "mtg-search-bar-row" });
		this.chipBarContainerEl = searchBarRow.createDiv({ cls: "mtg-search-chip-bar-container" });
		this.renderSearchChipBar();

		// Ajoute d'un coup toutes les cartes actuellement affichées dans le
		// carrousel — demandé explicitement. Désactivé tant qu'il n'y a rien à
		// ajouter (updateAddAllButtonState), jamais retiré : rester visible en
		// permanence évite un saut de layout à chaque nouvelle recherche.
		this.addAllBtn = searchBarRow.createEl("button", {
			cls: "mtg-search-add-btn mtg-search-add-all-btn",
		});
		// Icône "+" dans un petit cercle avant le texte, demandé explicitement
		// — même idiome que les boutons Delete/Cancel du mode sélection de My
		// Collection (icône en <span> séparé, jamais l'option `text:` du
		// bouton, qui ne laisserait pas de place pour un enfant à côté).
		setIcon(this.addAllBtn.createSpan({ cls: "mtg-search-add-all-icon" }), "plus");
		this.addAllBtn.createSpan({ text: "Add all" });
		this.addAllBtn.addEventListener("click", () => this.showAddAllConfirm());

		// Prompt "Save filter" — nom + Save/Cancel, révélé par le bouton carré
		// "Save filter" de la barre de puces (voir plus haut) au lieu d'une
		// nouvelle Modal pour une simple saisie de nom, même raisonnement que
		// le prompt "Add all" plus bas. Reste ici, près de la barre de
		// recherche (pas dans mtg-search-filters-panel plus bas) — c'est là
		// que vit le bouton qui le déclenche.
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

		// Le trio Finish/Language/Condition du flux Collection avait déjà été
		// retiré ; la ligne Finish restante, propre au flux Wantlist, a été
		// retirée à son tour (demandé explicitement) — une carte ajoutée
		// depuis cette modale prend maintenant toujours finish "regular"/
		// langue ""/condition "" par défaut (voir computeAddOptions), à
		// affiner ensuite depuis le panneau de détail de la carte comme
		// n'importe quelle autre carte de la wantlist/collection.

		// Bloc "Search oracle" (renommé depuis "Filter oracle" — demandé
		// explicitement ; les noms de classe CSS/champs restent
		// "filter-description", pas renommés pour un simple changement de
		// texte affiché) — titre fixe + description en anglais, best-effort,
		// de la barre de puces actuelle (voir describeSearchFilters,
		// card-search.ts). Hauteur naturelle (contrairement à
		// mtg-search-filters-panel juste en dessous) ; vide (bloc entier
		// masqué, voir updateFilterDescription) quand il n'y a rien à décrire.
		this.filterDescriptionEl = bottomMainEl.createDiv({ cls: "mtg-search-filter-description" });
		this.filterDescriptionEl.createDiv({
			cls: "mtg-search-filter-description-title",
			text: "Search oracle",
		});
		this.filterDescriptionTextEl = this.filterDescriptionEl.createDiv({
			cls: "mtg-search-filter-description-text",
		});
		this.updateFilterDescription();

		// Petit titre "Filters" au-dessus du bloc (pas dedans, contrairement
		// au titre "Search oracle" ci-dessus) — demandé explicitement.
		bottomMainEl.createDiv({ cls: "mtg-search-filters-title", text: "Filters" });

		// Bloc filtres (suggestions fixes + filtres enregistrés) — dernier
		// enfant de bottomMainEl (colonne flex imbriquée, voir styles.css),
		// pour absorber tout l'espace restant en bas de la fenêtre — demandé
		// explicitement, remplace l'ancienne rangée à hauteur naturelle sous
		// le formulaire.
		this.suggestedFiltersEl = bottomMainEl.createDiv({ cls: "mtg-search-suggested-filters" });
		this.renderSuggestedFilters();

		// Panneau "Add history" — 2ᵉ colonne de bottomSection, à droite de
		// bottomMainEl — demandé explicitement, avec un petit schéma à
		// l'appui. Uniquement pour les flux qui peuvent réellement annuler un
		// ajout (onUndoAdd fourni — Collection/Wantlist ; jamais le flux Deck,
		// qui n'a ni id par carte ni changeCollectionCardCount/removeCollectionCard équivalent, voir
		// le commentaire de historyEntries plus haut) : sans lui, cette
		// colonne resterait vide sans rien pouvoir y faire, donc pas construite
		// du tout plutôt que construite-mais-inerte — bottomSection garde sa
		// seule colonne d'avant dans ce cas.
		if (this.onUndoAdd) {
			const historyPanelEl = bottomSection.createDiv({ cls: "mtg-search-history-panel" });
			this.historyPanelEl = historyPanelEl;
			// Fermé par défaut — demandé explicitement (this.historyCollapsed
			// vaut déjà `true` par défaut, voir sa propre déclaration ; posé ici
			// directement plutôt que via toggleHistoryDrawer(), qui ne
			// s'exécute que sur un clic).
			historyPanelEl.addClass("is-collapsed");

			// En-tête cliquable (chevron + "Add history") — c'est LUI qui
			// replie/déploie le tiroir (demandé explicitement, avec un schéma
			// montrant le chevron collé au texte du titre) : pas de bouton
			// séparé flottant par-dessus les 2 colonnes (une version
			// précédente en avait un, retiré ici).
			const header = historyPanelEl.createDiv({ cls: "mtg-search-history-header" });
			header.addEventListener("click", () => this.toggleHistoryDrawer());
			// chevron-right, comme sur le schéma fourni ("▶ Add history") — pas
			// de bascule d'icône ici : l'en-tête entier disparaît à l'état
			// replié (remplacé par le bloc collapsed ci-dessous), donc ce
			// chevron n'a jamais besoin de représenter l'état "replié" lui-même.
			setIcon(header.createSpan({ cls: "mtg-search-history-toggle-icon" }), "chevron-right");
			header.createSpan({ cls: "mtg-search-history-title-text", text: "History" });

			// Contenu affiché UNIQUEMENT à l'état replié (voir
			// .mtg-search-history-panel.is-collapsed, styles.css) — demandé
			// explicitement : le tiroir replié garde sa hauteur et une largeur
			// minimale plutôt que de disparaître entièrement, avec un
			// pictogramme dans sa partie haute pour rester identifiable et
			// cliquable (même toggle que l'en-tête ci-dessus), suivi du texte
			// "History" affiché verticalement (en capitales — voir
			// text-transform sur mtg-search-history-collapsed-label,
			// styles.css — uniquement à cet état replié, demandé
			// explicitement ; l'en-tête déployé garde sa casse normale) —
			// inutile une fois déployé (le même texte est déjà lisible à
			// l'horizontale dans l'en-tête ci-dessus), donc ce bloc entier
			// disparaît dès l'ouverture. flex: 1 en CSS (voir styles.css) le
			// fait remplir toute la hauteur du panneau replié plutôt que de
			// ne garder que la taille de son propre contenu — demandé
			// explicitement, "quand le bloc est fermé, tout le bloc doit
			// être cliquable pour l'ouvrir" : ce même addEventListener
			// couvre désormais toute la zone visible, pas seulement
			// l'icône+le texte.
			const collapsedContent = historyPanelEl.createDiv({ cls: "mtg-search-history-collapsed" });
			collapsedContent.setAttribute("title", "Show history");
			collapsedContent.addEventListener("click", () => this.toggleHistoryDrawer());
			setIcon(collapsedContent.createDiv({ cls: "mtg-search-history-collapsed-icon" }), "history");
			collapsedContent.createDiv({ cls: "mtg-search-history-collapsed-label", text: "History" });

			// Plus de boîte propre (bordure/fond) autour de la liste — demandé
			// explicitement, "ne garder que le bloc sombre" (celui
			// d'historyPanelEl lui-même) — voir styles.css.
			this.historyListEl = historyPanelEl.createDiv({ cls: "mtg-search-history-list" });
			this.historyEmptyEl = this.historyListEl.createDiv({
				cls: "mtg-search-history-empty",
				text: "Cards you add appear here.",
			});
		}

		this.updateAddAllButtonState();
		void this.loadDefaultResults();
	}

	// Vide resultsEl ET l'état qui en dépend (contrôles "Add" par carte pour
	// "Add all") — les deux points d'appel de this.resultsEl.empty()
	// (loadDefaultResults, runSearch) passent systématiquement par ici
	// plutôt que d'appeler empty() nu, pour ne jamais laisser
	// currentResultControls référencer des tuiles qui viennent d'être
	// détruites (Add all ajouterait alors des cartes qui ne sont même plus
	// affichées). La confirmation "Add all" elle-même vit maintenant dans
	// sa propre fenêtre (AddAllConfirmModal) — rien à masquer/réinitialiser
	// ici la concernant. Réinitialise aussi tout l'état de pagination
	// (currentPage/hasMorePages/loadMoreQuery/totalCardsFound) — resultsEl
	// vient d'être vidé, donc loadMoreEl (qui pointait potentiellement vers
	// un enfant de resultsEl) ne référence plus rien de valide non plus.
	private resetResults() {
		this.resultsEl.empty();
		this.currentResultControls = [];
		this.updateAddAllButtonState();
		this.currentPage = 1;
		this.hasMorePages = false;
		this.loadMoreQuery = null;
		this.totalCardsFound = 0;
		this.loadMoreEl = null;
		// Voir addAllGeneration : signale à un éventuel runAddAll() encore en
		// vol (auto-pagination d'un "Add all" précédent) qu'une recherche plus
		// récente a repris la main sur currentPage/hasMorePages/etc.
		this.addAllGeneration++;
	}

	private updateAddAllButtonState() {
		this.addAllBtn.disabled = this.addAllInProgress || this.currentResultControls.length === 0;
	}

	// Total RÉEL que "Add all" ajouterait — au-delà de la page actuellement
	// chargée quand hasMorePages est vrai (voir totalCardsFound, le
	// total_cards brut de Scryfall pour cette recherche), pas seulement ce
	// qui est déjà rendu dans le carrousel. Utilisé à la fois pour le
	// libellé de confirmation et pour le plafond dur (voir showAddAllConfirm).
	private addAllEffectiveTotal(): number {
		return this.hasMorePages ? this.totalCardsFound : this.currentResultControls.length;
	}

	// Fenêtre séparée (voir AddAllConfirmModal plus bas) plutôt qu'un
	// message inline sous la barre de recherche — demandé explicitement.
	// count reflète maintenant le total RÉEL de la recherche (voir
	// addAllEffectiveTotal), plus seulement ce qui est déjà chargé dans le
	// carrousel — "Add all" auto-pagine désormais le reste lui-même (voir
	// runAddAll) plutôt que de se limiter à la page affichée.
	private showAddAllConfirm() {
		if (this.addAllInProgress) return;
		const count = this.addAllEffectiveTotal();
		if (count === 0) return;
		// Plafond dur — voir ADD_ALL_HARD_CAP pour le calcul qui le justifie.
		// Un Notice plutôt qu'une modale à part : ce n'est pas une décision à
		// prendre ("Yes"/"Cancel"), juste une limite qui empêche l'opération
		// de démarrer, avec de quoi comprendre pourquoi et quoi faire à la
		// place.
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
		// Copié plutôt que lu à travers this. : purement défensif, pour que ce
		// lot précis reste cohérent même si l'utilisateur rouvre une nouvelle
		// recherche entre le moment où AddAllConfirmModal s'est ouverte et
		// celui où son bouton "Yes, add all" est effectivement cliqué (voir
		// aussi addAllGeneration, qui protège la partie auto-paginée de
		// runAddAll contre ce même scénario une fois l'opération lancée).
		const controls = this.currentResultControls;
		const paginating = this.hasMorePages;
		const total = paginating ? this.totalCardsFound : controls.length;
		if (total === 0) return;

		// defaultListId (Inbox) : "Add all" ajoute directement, sans ouvrir de
		// picker — même raisonnement que le clic "Add" individuel ci-dessus,
		// voir AddCardsModalOptions.listGallery.defaultListId.
		if (this.listGallery?.defaultListId) {
			void this.runAddAll(controls, paginating, this.listGallery.defaultListId);
			return;
		}

		if (this.listGallery) {
			// Un seul picker pour tout le lot (pas un par carte, qui ferait
			// s'enchaîner des dizaines de fenêtres modales) — la destination
			// choisie une fois s'applique à chaque carte du lot, y compris
			// celles pas encore chargées (auto-paginées par runAddAll).
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

	// Cœur de "Add all" — ajoute d'abord ce qui est déjà chargé dans le
	// carrousel (même chemin que le clic "Add" individuel de chaque tuile,
	// via addOne : coût DOM déjà payé, ces tuiles deviennent des steppers
	// comme d'habitude), PUIS, si hasMorePages était vrai au moment du clic,
	// récupère et ajoute le reste page par page — sans jamais construire de
	// tuile carrousel pour ces cartes-là (un lot de plusieurs centaines/
	// milliers de résultats hors champ n'a aucune raison d'alourdir le DOM
	// du carrousel), juste un appel direct à onAddCard par carte. La
	// pagination réutilise le même mécanisme que "Load more"
	// (searchScryfall/fetchLatestPaperPrintings avec page croissant) — donc
	// le même verrou de cadence global (requestScryfall, scryfall.ts) que
	// tout le reste du plugin, aucun traitement spécial nécessaire ici pour
	// rester dans les règles de l'API.
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

		// Snapshot de la recherche à paginer — jamais relu depuis this.
		// pendant la boucle ci-dessous (this.loadMoreQuery pourrait avoir
		// changé entre-temps si une nouvelle recherche démarre ; le contrôle
		// de génération plus bas s'arrête alors avant de s'en resservir).
		const query = this.loadMoreQuery;

		// Au-delà de HISTORY_AGGREGATE_THRESHOLD, chaque ajout (rendu ou non)
		// s'accumule dans addAllBatch au lieu de construire une tuile
		// d'historique individuelle — voir recordHistoryAdd.
		const total = paginating ? this.totalCardsFound : controls.length;
		this.addAllBatch = this.onUndoAdd && total > HISTORY_AGGREGATE_THRESHOLD ? [] : null;

		controls.forEach(({ addOne }) => addOne(listId, true));

		let addedBeyondPage = 0;
		if (paginating) {
			// Même verrou que "Load more" lui-même (loadingMorePage — voir son
			// propre garde en tête de loadMoreResults) : bloque tout clic manuel
			// sur la tuile "Load more" pendant que cette boucle avance déjà sur
			// la même recherche, plutôt que de risquer deux fetchs concurrents
			// se marchant dessus sur currentPage/hasMorePages. is-disabled
			// (styles.css) donne un retour visuel à ce blocage — sans lui, la
			// tuile resterait visuellement cliquable pour un clic qui ne ferait
			// plus rien.
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
				// Une nouvelle recherche a repris la main pendant cet aller-
				// retour réseau (voir addAllGeneration) — currentPage/
				// hasMorePages/totalCardsFound/loadMoreEl appartiennent déjà à
				// CETTE nouvelle recherche, plus question d'y toucher ; les
				// cartes déjà récupérées dans cette itération sont quand même
				// ajoutées (l'opération de données reste valide même si son
				// propre affichage de progression ne l'est plus), puis on
				// s'arrête.
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
					// Laisse "Load more" cliquable pour un nouvel essai manuel sur
					// ce qui reste — même repli que loadMoreResults() lui-même sur
					// un échec réseau.
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

	// Tuile résumée d'un lot "Add all" agrégé (voir HISTORY_AGGREGATE_
	// THRESHOLD) — même habillage que renderHistoryTile (checkbox/
	// séparateurs/corbeille, mêmes classes CSS) pour rester cohérente avec
	// le reste du panneau, mais un contenu et une logique propres : pas de
	// nom de carte unique à afficher, pas de lien "Change printing"/"Move
	// card" (le lot couvre potentiellement des centaines de cartes
	// différentes, aucun lien unique n'aurait de sens), et une annulation/
	// réactivation en bloc plutôt que par contribution — un appel
	// onUndoAdd/onAdd par carte du lot, jamais de travail DOM par carte,
	// donc un lot de plusieurs milliers de cartes reste rapide à annuler.
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
		// Même technique double rAF que renderHistoryTile — voir son propre
		// commentaire pour le raisonnement complet.
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
		// Réutilise la classe destination (flex:1 + ellipsis) plutôt qu'une
		// nouvelle règle CSS — cette ligne n'a qu'un seul segment de texte,
		// potentiellement long (nom de destination inclus), exactement ce
		// que cette classe gère déjà.
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
			// Cette tuile n'est jamais suivie dans historyEntries (voir plus
			// haut) — deleteHistoryEntry ne peut donc pas la voir pour décider
			// de réafficher historyEmptyEl ; revérifie directement le DOM du
			// panneau plutôt que de dupliquer un second compteur.
			if (!this.historyListEl.querySelector(".mtg-search-history-tile")) {
				this.historyEmptyEl?.toggleClass("is-hidden", false);
			}
		});
	}

	// Reconstruite (pas juste masquée/affichée) à chaque clic, pour que
	// is-active reflète l'état réel (chip ajoutée/retirée, tri
	// appliqué/annulé) — même raisonnement que renderSearchChipBar, appelée
	// pour la même raison juste après une mutation de chipTokens.
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
					// Bascule : un second clic retire la puce plutôt que d'en
					// ajouter une deuxième identique.
					const idx = this.chipTokens.indexOf(filter.token);
					if (idx >= 0) this.chipTokens.splice(idx, 1);
					else this.chipTokens.push(filter.token);
					this.renderSearchChipBar();
				} else {
					// Même bascule côté tri : re-cliquer la suggestion déjà active
					// revient au tri par défaut plutôt que de rester bloqué dessus.
					this.sortOverride = isActive ? null : { order: filter.order, dir: filter.dir };
				}
				this.renderSuggestedFilters();
				// triggerSearch (debounce 400ms), pas runSearch direct : même
				// chemin que toute autre mutation de puce dans ce fichier (retrait,
				// bascule négation/exact…) — cohérent avec l'existant, et ça évite
				// qu'un clic rapide sur plusieurs suggestions d'affilée déclenche
				// une requête Scryfall par clic au lieu d'une seule une fois
				// retombé.
				this.triggerSearch();
			});
		});

		// Filtres personnalisés enregistrés par l'utilisateur (bouton carré
		// "Save filter" à droite de la barre de puces, voir
		// showSaveFilterPrompt/confirmSaveFilter) — même langage visuel/
		// bascule que les suggestions fixes ci-dessus,
		// mais un filtre enregistré est un instantané de PLUSIEURS jetons (+
		// un tri) à la fois, donc l'appliquer REMPLACE tout l'état courant de
		// la barre plutôt que d'ajouter/retirer un seul jeton. Un petit "x"
		// à l'intérieur du bouton supprime le filtre enregistré lui-même
		// (settings, persisté), pas seulement son application courante.
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
				// stopPropagation : ce span vit à l'intérieur du <button>, un
				// clic dessus déclencherait sinon AUSSI le handler du bouton
				// (bulle jusqu'à lui) — appliquerait/basculerait le filtre au
				// lieu de le supprimer.
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

	// true dès qu'il y a QUOI QUE CE SOIT à enregistrer — une puce déjà
	// validée, un tri actif, OU un mot-clé encore en cours de frappe
	// (chipDraft, pas encore une puce) : demandé explicitement, "dès le
	// premier mot-clé dans la barre de recherche", pas seulement une fois
	// une suggestion cliquée. buildScryfallQueryFromChips (card-search.ts)
	// traite déjà chipDraft comme faisant partie de la recherche EN COURS —
	// ce bouton suit donc exactement ce que l'utilisateur voit déjà chercher,
	// pas seulement ce qui est formellement validé en puce.
	private hasSomethingToSaveFilter(): boolean {
		return this.chipTokens.length > 0 || this.chipDraft.trim().length > 0 || !!this.sortOverride;
	}

	// Séparée de renderSearchChipBar : chipDraft change à chaque frappe SANS
	// reconstruire toute la barre (perte de focus sinon, voir le handler
	// "input" plus haut) — cette méthode-ci ne touche qu'un seul attribut sur
	// un bouton déjà construit, appelable à chaque frappe sans ce risque.
	private updateSaveFilterButtonState() {
		this.saveFilterBtn.disabled = !this.hasSomethingToSaveFilter();
	}

	// Phrase en anglais décrivant la barre de puces (voir describeSearchFilters,
	// card-search.ts) — inclut le mot-clé en cours de frappe (chipDraft), pas
	// seulement les puces déjà validées : contrairement à la recherche
	// elle-même (qui attend maintenant une validation explicite, voir
	// triggerSearch), cette phrase est un simple aperçu textuel de ce qui est
	// en train d'être construit, pas d'aller-retour réseau ni de saut visuel
	// à éviter en la retardant. Garde défensive sur filterDescriptionEl : le
	// tout premier appel de renderSearchChipBar (onOpen, avant que ce bloc ne
	// soit construit plus bas dans la fenêtre) tomberait sinon sur un élément
	// encore undefined.
	// Toujours visible (demandé explicitement — plus de is-visible/masquage
	// conditionnel) : quand il n'y a rien à décrire, affiche un repli neutre
	// plutôt qu'une phrase vide ou un bloc qui disparaît/réapparaît.
	private updateFilterDescription() {
		if (!this.filterDescriptionEl) return;
		const allTokens = this.chipDraft.trim()
			? [...this.chipTokens, this.chipDraft.trim()]
			: this.chipTokens;
		// Nom complet d'édition plutôt que le code court (ex. "Innistrad
		// Remastered", pas "INR") — demandé explicitement. getCachedSetSummary
		// est une lecture SYNCHRONE d'un cache déjà chaud (même source déjà
		// utilisée pour l'icône/le nom de la puce "set:" elle-même un peu plus
		// haut dans ce fichier) — describeSearchFilters retombe elle-même sur
		// le code en majuscules si ce cache n'est pas encore chaud.
		const description = describeSearchFilters(allTokens, (code) => this.plugin.getCachedSetSummary(code)?.name);
		this.filterDescriptionTextEl.setText(description || "No filter applied — showing every card.");
	}

	// Un filtre enregistré est "actif" quand la barre reflète EXACTEMENT son
	// instantané — mêmes jetons (peu importe l'ordre : un Set, pas une
	// comparaison position par position) et même tri, ni plus ni moins.
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
			// Pas de Notice pour un champ vide — re-focus suffit, cohérent
			// avec le reste de ce fichier qui n'alerte que sur un vrai échec
			// réseau/résultat, pas sur une saisie manquante.
			this.saveFilterInputEl.focus();
			return;
		}
		// Un mot-clé encore en cours de frappe (chipDraft) compte déjà dans la
		// recherche affichée (voir hasSomethingToSaveFilter) — on le promeut
		// en puce réelle au moment d'enregistrer, exactement comme le ferait
		// Entrée/espace, pour que le filtre sauvegardé corresponde
		// précisément à ce qui est visible/recherché au moment du clic plutôt
		// que de perdre silencieusement ce mot-clé.
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

	// Options appliquées à une carte ajoutée depuis cette modale — aucun des
	// 3 flux (Collection/Wantlist/Deck) n'expose plus de sélecteur Finish/
	// Language/Condition ici, toujours les valeurs par défaut ; à affiner
	// ensuite depuis le panneau de détail de la carte.
	private computeAddOptions(): AddCardOptions {
		return { finish: "regular", language: "", condition: "" };
	}

	// Résolue par défaut (rien à attendre au tout premier appel, avant
	// qu'aucun commit n'ait jamais déclenché triggerSearch) — voir
	// triggerSearch/loadDefaultResults/runSearch ci-dessous.
	private resultsExitPromise: Promise<void> = Promise.resolve();

	private triggerSearch() {
		// Amorce tout de suite la sortie animée des tuiles actuellement
		// affichées (voir animateResultTilesOut, shared-search-ui.ts) — dès
		// le commit, pas seulement une fois le délai de 400ms écoulé, pour
		// un retour visuel immédiat plutôt qu'un silence de 400ms suivi d'un
		// fondu d'un coup. runSearch()/loadDefaultResults() attendent cette
		// même Promise avant de vider resultsEl (resetResults) — nécessaire
		// depuis que la transition est devenue plus lente que le délai de
		// 400ms lui-même (voir animateResultTilesOut) : sans cette attente,
		// runSearch() couperait l'animation en plein milieu.
		this.resultsExitPromise = animateResultTilesOut(this.resultsEl);
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => void this.runSearch(), 400);
	}

	// "N cards found", discret — demandé explicitement.
	//
	// count === null est maintenant un no-op délibéré (PAS un blanchiment
	// vers "") — bug signalé : le texte disparaissait puis réapparaissait à
	// chaque mise à jour du carrousel, ce qui se lisait comme un petit saut
	// visuel. Le compte précédent reste affiché pendant tout le chargement
	// (le squelette du carrousel, voir renderResultSkeletons, est déjà le
	// signal "chargement en cours" — ce texte n'a pas besoin d'en porter un
	// second) jusqu'à ce que setResultsCount(N) le remplace directement par
	// la vraie valeur, en une seule mise à jour de texte au lieu de deux.
	// clearResultsCount() ci-dessous reste le seul moyen d'effacer
	// explicitement (erreur réseau, résultats entièrement invalidés) —
	// distinct de "ne pas toucher" pour ne jamais laisser un compte obsolète
	// visible à côté d'un message d'erreur. `total` (Scryfall total_cards,
	// voir ScryfallPagedResult) affiche "X of Y cards found" tant qu'il reste
	// des pages à charger (Y > X) — sinon le simple "N cards found" habituel,
	// y compris quand `total` est fourni mais égal à `count` (tout est déjà
	// affiché, rien à distinguer).
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

	// Contenu affiché avant toute frappe : les cartes papier les plus
	// récemment sorties, pour éviter une fenêtre de résultats vide au premier
	// affichage (et donc un saut de taille de la fenêtre au premier caractère
	// tapé).
	async loadDefaultResults() {
		// Attend la fin de la sortie animée des tuiles actuellement affichées
		// (déjà amorcée par triggerSearch, voir resultsExitPromise) avant de
		// les vider réellement — un no-op immédiat au tout premier appel
		// (resultsEl est déjà vide, aucune tuile à faire sortir).
		await this.resultsExitPromise;
		this.resetResults();
		// Pas de setResultsCount(null) ici — voir le commentaire de
		// setResultsCount : le compte précédent reste affiché tel quel
		// pendant le chargement, le squelette ci-dessous est déjà le signal
		// visuel de chargement.
		// Tuiles squelettes (pas un simple texte "Loading…") : voir
		// renderResultSkeletons pour le raisonnement complet — élimine le
		// saut de hauteur signalé entre l'état "en chargement" et l'arrivée
		// des vraies tuiles.
		renderResultSkeletons(this.resultsEl);
		try {
			const { cards, hasMore, totalCards } = await fetchLatestPaperPrintings(this.sortOverride ?? undefined);
			// Si l'utilisateur a déjà commencé à taper pendant le chargement, on
			// n'écrase pas ce qu'il est en train de chercher.
			if (this.chipTokens.length > 0 || this.chipDraft.trim()) {
				return;
			}
			this.resetResults();
			if (cards.length === 0) {
				this.clearResultsCount();
				return;
			}
			this.setResultsCount(cards.length, totalCards);
			// Pas de cap arbitraire ici : cards.length est déjà borné à 175 par
			// Scryfall (une seule page) — au-delà, hasMore/le bouton "Load more"
			// ci-dessous prennent le relais plutôt qu'un slice(0, 40) local, qui
			// raccourcissait artificiellement le carrousel avant même d'atteindre
			// cette limite (signalé : "le carrousel affiche assez peu de cartes").
			cards.forEach((card, i) => this.renderResult(card, i));
			this.updateAddAllButtonState();
			this.loadMoreQuery = null; // recherche par défaut, pas de puces
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
		// Si les puces "set:xyz" et "#numéro" sont toutes les deux présentes
		// (non exclues), on peut encore profiter du lookup exact rapide de
		// searchScryfall plutôt que de repasser par la recherche générale.
		const { setCode, collectorNumber } = extractExactLookupHints(this.chipTokens, this.chipDraft);

		if (!chipQuery) {
			// loadDefaultResults() gère elle-même l'attente de la sortie
			// animée + resetResults() — pas de double vidage ici.
			void this.loadDefaultResults();
			return;
		}

		await this.resultsExitPromise;
		this.resetResults();
		// Pas de setResultsCount(null) ici — même raisonnement que
		// loadDefaultResults ci-dessus, voir le commentaire de
		// setResultsCount.
		// Même raisonnement que loadDefaultResults : squelette plutôt qu'un
		// texte "Searching…" nu, pour ne jamais faire varier la hauteur de la
		// piste entre le début et la fin du chargement.
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
		// Même raisonnement que loadDefaultResults ci-dessus : pas de cap local,
		// hasMore/"Load more" prennent le relais au-delà de la 1ère page.
		cards.forEach((card, i) => this.renderResult(card, i));
		this.updateAddAllButtonState();
		this.loadMoreQuery = { setCode, collectorNumber, chipQuery };
		this.totalCardsFound = totalCards;
		this.hasMorePages = hasMore;
		if (hasMore) this.renderLoadMoreTile();
	}

	// Contenu "au repos" (icône + libellé) de la tuile "Load more" — factorisé
	// pour être appelé à la fois à la construction initiale et pour remettre
	// la tuile dans cet état après un échec de chargement (voir
	// loadMoreResults), plutôt que deux copies de ces 3 lignes à maintenir
	// en parallèle.
	private renderLoadMoreIdleContent(tile: HTMLElement) {
		const iconEl = tile.createDiv({ cls: "mtg-search-load-more-icon" });
		setIcon(iconEl, "chevron-right");
		tile.createSpan({ text: "Load more" });
	}

	// Tuile de fin de piste (voir .mtg-search-load-more-tile, styles.css,
	// pour son propre gabarit) affichée quand hasMorePages est vrai — clic
	// explicite plutôt qu'un IntersectionObserver auto-déclenché en fin de
	// défilement, voir le commentaire de hasMorePages/currentPage plus haut
	// pour le raisonnement.
	private renderLoadMoreTile() {
		const tile = this.resultsEl.createDiv({ cls: "mtg-search-load-more-tile" });
		this.renderLoadMoreIdleContent(tile);
		tile.addEventListener("click", () => void this.loadMoreResults());
		this.loadMoreEl = tile;
	}

	// Charge la page suivante de LA MÊME recherche (loadMoreQuery, capturé au
	// moment où hasMorePages est devenu vrai — voir runSearch/
	// loadDefaultResults) et ajoute les nouvelles tuiles À LA SUITE de celles
	// déjà affichées, sans les toucher — contrairement à runSearch/
	// loadDefaultResults, qui repartent toujours de resetResults(). L'index
	// passé à renderResult continue la numérotation existante
	// (currentResultControls.length, avant l'ajout) : au-delà de
	// RESULT_TILE_STAGGER_MAX (4), applyResultTileStaggerEntrance est de
	// toute façon un no-op, donc les tuiles d'une page suivante n'ont jamais
	// leur propre vague d'entrée — cohérent, elles arrivent hors du champ
	// visible initial du carrousel.
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
			// Retire la tuile "Load more" avant d'insérer les nouvelles cartes —
			// sinon elles s'ajouteraient après elle (toujours en toute fin de
			// piste, via createDiv), pas avant.
			this.loadMoreEl?.remove();
			this.loadMoreEl = null;
			const startIndex = this.currentResultControls.length;
			cards.forEach((card, i) => this.renderResult(card, startIndex + i));
			this.setResultsCount(this.currentResultControls.length, totalCards);
			this.updateAddAllButtonState();
			if (hasMore) this.renderLoadMoreTile();
		} catch {
			new Notice("Failed to load more cards from Scryfall.");
			// Remet la tuile dans son état cliquable initial (retire les points
			// de chargement) — currentPage n'a volontairement pas avancé, un
			// nouveau clic réessaiera la même page suivante.
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

	// listGallery : chaque tuile peut être ajoutée à une destination
	// différente, résolue par id depuis les résumés déjà en main (pas de
	// fetch supplémentaire). Destination fixe (les 2 flux à titre fixe,
	// openAddCollectionCardsModal/openAddWantlistCardsModal) : destinationName est
	// fourni directement par le call site (voir AddCardsModalOptions).
	private resolveDestinationName(listId: string): string {
		if (this.listGallery) {
			const fromGallery = this.listGallery.summaries.find((s) => s.id === listId)?.name;
			if (fromGallery) return fromGallery;
			// Bug rapporté : ajouter une carte dans une liste/wantlist tout
			// juste créée (bouton "+ New list"/"+ New wantlist" DANS le
			// sélecteur par carte) affichait "This destination" au lieu de
			// son vrai nom. Root cause : listGallery.summaries est un
			// INSTANTANÉ pris à l'ouverture de la modale (voir onOpen/
			// openAddCollectionCardsModalWithListPicker), une liste créée PENDANT cette
			// même session n'y figure donc jamais. resolveDestinationNameById
			// lit directement plugin.settings.lists/.wantlists (toujours à
			// jour) plutôt que de retomber sur "this destination" — même
			// méthode déjà utilisée pour résoudre la destination réelle après
			// un déplacement (voir openMoveCardForEntry, qui a le même besoin
			// "identifiant connu, nom pas forcément dans l'instantané").
			return this.resolveDestinationNameById(listId);
		}
		return this.destinationName ?? "this destination";
	}

	// Enregistre une contribution dans le panneau "Add history" — appelé une
	// fois par addOne() réussi (clic "Add" individuel ou "Add all"), JAMAIS
	// pour les ajustements +/- du stepper d'une tuile déjà ajoutée (choix
	// confirmé avant de construire cette fonctionnalité : l'historique ne
	// suit que les clics "Add" explicites). Agrégée par (scryfallId, listId)
	// — même carte + même destination réutilisent la même tuile, sa quantité
	// augmente au lieu d'en créer une nouvelle (choix confirmé, "agrégée par
	// carte"). `syncCallback` est stocké tel quel (pas dans un Map séparé) :
	// il est directement lié au cycle de vie de CETTE HistoryEntry, pas à
	// celui de resultsEl — une entrée d'historique doit survivre à une
	// nouvelle recherche (resetResults()) même si son callback de sync,
	// lui, devient inerte une fois sa tuile carrousel d'origine détruite
	// (voir syncFromHistory dans renderAddControl : appeler ce callback sur
	// une tuile détachée du DOM ne fait rien de visible, ni ne plante).
	private recordHistoryAdd(
		card: ScryfallCard,
		options: AddCardOptions,
		listId: string,
		syncCallback: (row: { id: string; count: number } | undefined) => void
	) {
		// Pendant un "Add all" agrégé (voir addAllBatch/HISTORY_AGGREGATE_
		// THRESHOLD), chaque ajout — rendu ou non, individuel ou auto-paginé —
		// s'accumule ici au lieu de construire/mettre à jour une tuile
		// d'historique par carte ; renderAddAllBatchTile construit UNE tuile
		// résumée une fois le lot entier ajouté (voir runAddAll).
		if (this.addAllBatch) {
			this.addAllBatch.push({ card, options, listId });
			return;
		}
		if (!this.onUndoAdd) return;
		const key = this.historyKey(card.id, listId);
		let hEntry = this.historyEntries.get(key);
		// Une entrée désactivée (déjà annulée) repart de zéro plutôt que de
		// fusionner avec des contributions devenues obsolètes — plus simple
		// et sans ambiguïté que de "réactiver implicitement" une entrée que
		// l'utilisateur a explicitement choisi d'annuler.
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
		// Le callback le plus récent gagne — c'est toujours la tuile
		// carrousel ACTUELLEMENT affichée qui doit être resynchronisée si
		// cette entrée est togglée ensuite, pas une tuile d'une recherche
		// précédente déjà remplacée.
		hEntry.syncCallback = syncCallback;
		if (!hEntry.tileEl) {
			this.renderHistoryTile(hEntry);
		} else {
			this.updateHistoryTileQuantity(hEntry);
			// La dernière action s'affiche toujours en premier — demandé
			// explicitement. flipHistoryListChange anime le déplacement (voir
			// son propre commentaire) — prepend() sur un nœud déjà attaché le
			// DÉPLACE (ne le duplique pas) : une carte déjà présente plus bas
			// dans la liste, re-cliquée "Add"/"+", remonte donc en tête plutôt
			// que de rester à sa position d'origine. renderHistoryTile
			// ci-dessus gère déjà le cas "nouvelle entrée" (voir son propre
			// commentaire).
			const tileEl = hEntry.tileEl;
			this.flipHistoryListChange(() => {
				this.historyListEl.prepend(tileEl);
			});
		}
	}

	// Technique FLIP (First-Last-Invert-Play) identique à flipListChange
	// (view.ts, qui anime déjà les groupes voisins lors d'un pliage/dépliage
	// de la même façon) : mesure la position de chaque tuile DÉJÀ présente
	// AVANT la mutation, applique la mutation réelle instantanément, puis
	// compense visuellement l'écart avec un transform (immédiat, invisible),
	// avant de le relâcher en douceur — demandé explicitement, "une petite
	// animation quand une nouvelle tuile apparait, qu'elle pousse les tuiles
	// du bas". Comme seul "transform" anime, aucun recalcul de mise en page
	// n'a lieu pendant l'animation elle-même. Un seul et même helper sert
	// aux deux cas d'usage ci-dessus/plus bas (renderHistoryTile,
	// recordHistoryAdd) : une tuile pas encore créée à l'instant de la
	// mesure n'est jamais dans `movables` (elle n'existe pas encore dans le
	// DOM) — c'est exactement ce qui fait que SEULES les tuiles déjà
	// présentes sont repoussées/animées, jamais la nouvelle tuile
	// elle-même (qui a sa propre animation d'entrée séparée, voir
	// mtg-search-history-tile-enter/-visible dans renderHistoryTile) ; une
	// tuile déjà présente qu'on déplace en tête (2ᵉ cas d'usage) fait, elle,
	// partie de `movables` et glisse donc normalement vers sa nouvelle
	// position.
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
		// Force le navigateur à "voir" la position décalée avant de relâcher,
		// sinon les deux changements risquent d'être fusionnés et l'animation
		// sautée — même précaution que flipListChange (view.ts).
		this.historyListEl.getBoundingClientRect();
		window.requestAnimationFrame(() => {
			toAnimate.forEach((el) => releaseOffset(el));
		});
	}

	// Symétrique de recordHistoryAdd, pour le "-" du stepper d'une tuile déjà
	// ajoutée (voir applyDelta) — jamais appelée pour un "disable"/"delete"
	// d'historique (qui passent par onUndoAdd, une vraie annulation de
	// données ; ceci ne fait QUE suivre un ajustement de quantité déjà
	// appliqué ailleurs par onChangeQuantity). Ne recrée jamais une entrée
	// manquante — décrémenter quelque chose qui n'existe pas/plus n'a pas de
	// sens, contrairement à un ajout.
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
		// Plus aucune contribution : rien à afficher/annuler pour cette
		// session, la tuile disparaît (même chemin que deleteHistoryEntry,
		// mais sans ré-appeler onUndoAdd — la donnée a déjà été décrémentée
		// via onChangeQuantity juste avant, dans applyDelta).
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
		// Double requestAnimationFrame imbriqué pour -visible (inchangé —
		// toujours la technique la plus robuste pour garantir un vrai paint
		// intermédiaire de -enter avant de la remplacer, indépendante de tout
		// arbitrage macrotask/frame contrairement à setTimeout(0)) : le rAF
		// EXTÉRIEUR s'exécute à la frame N (ne fait que planifier le rAF
		// intérieur, ne change aucune classe) — la frame N est donc peinte
		// avec -enter déjà posée (maintenant le premier état JAMAIS observé,
		// voir ci-dessus) et rien d'autre à recalculer ; le rAF INTÉRIEUR ne
		// s'exécute qu'à la frame N+1, ajoute alors -visible.
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => tile.addClass("mtg-search-history-tile-visible"));
		});

		// Checkbox native (pas une icône œil) — demandé explicitement.
		// accent-color plutôt qu'un widget entièrement personnalisé : recolore
		// une checkbox native dans l'accent du plugin sans avoir à reproduire
		// sa forme/ses états (coché/survolé/focus) à la main.
		hEntry.toggleBtn = tile.createEl("input", { cls: "mtg-search-history-toggle-checkbox" });
		hEntry.toggleBtn.type = "checkbox";
		hEntry.toggleBtn.addEventListener("change", () => this.toggleHistoryEntry(hEntry));

		// Séparateur vertical — align-self: stretch (styles.css) l'étire sur
		// toute la hauteur de la tuile pour bien scinder visuellement la
		// checkbox du texte, demandé explicitement.
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

		// Séparateur vertical avant la suppression/le badge de contexte —
		// demandé explicitement, même classe/même recette que celui déjà
		// posé entre la checkbox et le texte plus haut (align-self: stretch,
		// styles.css).
		tile.createDiv({ cls: "mtg-search-history-divider" });

		this.buildHistoryTileTrailing(hEntry, tile);

		this.updateHistoryTileQuantity(hEntry);
		this.updateHistoryTileState(hEntry);
	}

	// Construit (ou reconstruit intégralement — voir openChangePrintingFor-
	// Entry/openMoveCardForEntry, qui l'appellent à nouveau après un succès)
	// le contenu de la ligne 2 : icône + code de set/numéro (lien "Change
	// printing"), puis destination (lien "Move card") — deux zones
	// CLIQUABLES SÉPARÉES, demandées explicitement l'une après l'autre dans
	// le même message. Le lien "Change printing" est maintenant aussi
	// cliquable pour le flux Deck (ChangePrintingModal accepte "deck" comme
	// source depuis son extension, voir changeDeckCardPrinting/plugin.ts) —
	// demandé explicitement après coup, une fois la même fonctionnalité déjà
	// activée ailleurs dans My Decks (fiche détail, ligne/tuile). Le lien
	// "Move card" RESTE Collection/Wantlist seulement : CopyCardModal
	// n'accepte toujours pas "deck" comme source (DeckCard n'a pas de
	// concept de déplacement — une carte peut légitimement appartenir à
	// plusieurs decks à la fois, contrairement à une liste/wantlist unique —
	// voir "Data model notes" dans CLAUDE.md), donc les deux liens n'ont plus
	// exactement la même condition d'activation, gérées séparément
	// ci-dessous.
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
		// !hEntry.linksDisabled — voir sa propre déclaration : une fois cette
		// carte déplacée hors du périmètre de this.sourceKind (vers un deck,
		// ou vers l'autre côté Collection/Wantlist), aucun des deux liens ne
		// peut plus opérer correctement depuis cette modale — les deux
		// deviennent définitivement non interactifs pour cette tuile,
		// indépendamment de this.sourceKind lui-même. Deck n'a jamais de lien
		// "Move" (voir canMove ci-dessous), donc linksDisabled n'est en
		// pratique jamais posé pour une tuile Deck — gardé quand même pour ce
		// lien-ci par cohérence/à l'épreuve du futur.
		const linksActive = !hEntry.linksDisabled;
		const canChangePrinting =
			linksActive &&
			(this.sourceKind === "collection" || this.sourceKind === "wantlist" || this.sourceKind === "deck");
		const canMove = linksActive && (this.sourceKind === "collection" || this.sourceKind === "wantlist");

		// Symbole d'édition + code/numéro — demandé explicitement. Même
		// recette que .mtg-card-tile-set-icon (view.ts, "Card view") : icône
		// teintée selon la rareté via getSetIconSvg + applySvgColor, pas de
		// garde IntersectionObserver ici contrairement au carrousel de
		// résultats (renderScryfallResultTile) — ce panneau ne contient
		// jamais qu'une poignée de tuiles par session, aucune raison d'en
		// retarder le chargement ; getSetIconSvg sérialise de toute façon
		// déjà ses propres requêtes (setIconFetchQueue, plugin.ts), qui
		// protège cet appel comme tous les autres.
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
		// Cliquable en Collection/Wantlist/Deck, quel que soit le mode (fixe ou
		// listGallery) — "Change printing" ne concerne jamais la
		// destination, seulement l'impression elle-même, donc pas concerné
		// par la restriction listGallery ci-dessous (propre au lien "Move").
		if (canChangePrinting) {
			printingLink.addClass("is-clickable");
			printingLink.setAttribute("title", "Change printing of this card");
			printingLink.addEventListener("click", () => this.openChangePrintingForEntry(hEntry));
		}

		// Séparateur "→" — texte simple, jamais cliquable lui-même, entre les
		// deux liens.
		line2.createSpan({ cls: "mtg-search-history-line2-arrow", text: " → " });

		const destLink = line2.createSpan({
			cls: "mtg-search-history-destination-link",
			text: destinationName,
		});
		// Cliquable UNIQUEMENT en mode listGallery (this.listGallery défini —
		// "All Cards"/l'équivalent Wantlist, où la destination d'un ajout
		// varie tuile par tuile et vaut donc la peine d'être révisée après
		// coup) — demandé explicitement, revenu en arrière depuis la version
		// précédente qui l'affichait toujours pour Collection/Wantlist : dans
		// une liste précise déjà ouverte (openAddCollectionCardsModal/
		// openAddWantlistCardsModal, destination fixe), la carte n'a qu'une
		// seule destination possible et déjà évidente — un lien "déplacer"
		// là-dessus n'apporte rien et prêtait à confusion. Pas de nouvelle
		// option ajoutée pour ça : this.listGallery existe déjà, posé
		// exactement sur cette même distinction (voir son propre champ dans
		// AddCardsModalOptions).
		if (canMove && this.listGallery) {
			destLink.addClass("is-clickable");
			destLink.setAttribute("title", "Move card to another destination");
			destLink.addEventListener("click", () => this.openMoveCardForEntry(hEntry));
		}
	}

	// Retrouve la ligne Collection/Wantlist réellement représentée par cette
	// tuile — utilisée par les 2 liens ci-dessus (Move reste Collection/
	// Wantlist uniquement, voir canMove/buildHistoryLine2 ; Change printing,
	// lui, a aussi besoin de résoudre une ligne Deck — voir
	// resolveDeckHistoryRow juste en dessous, un type de retour différent
	// donc une fonction séparée plutôt qu'un 3ᵉ cas ajouté ici). undefined
	// pour le flux Deck, ou si la ligne a depuis disparu autrement (carte
	// supprimée entre-temps par un autre chemin). Utilise la DERNIÈRE
	// contribution de l'entrée — même approximation, déjà établie ailleurs
	// dans ce panneau (voir toggleHistoryEntry/deleteHistoryEntry), pour une
	// tuile qui agrégerait plusieurs groupes d'options distincts (voir
	// HistoryContribution plus haut — plus aucun chemin réaliste pour
	// produire ce cas aujourd'hui, mais un seul lien ne pourrait de toute
	// façon désigner qu'UNE ligne à la fois).
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

	// Équivalent de resolveHistoryRow ci-dessus, pour le flux Deck — utilisé
	// uniquement par openChangePrintingForEntry (le lien "Move" n'existe pas
	// pour Deck, voir canMove/buildHistoryLine2). Pour ce flux, hEntry.listId
	// est l'id du DECK (voir onAdd, view.ts : la carte ajoutée y est
	// reshapée en { id: row.scryfallId, count, listId: deck.id } faute de
	// champ id propre sur DeckCard) et hEntry.card.id son scryfallId. Une
	// carte ajoutée via "Add cards" n'a jamais de catégorie autre que
	// mainboard (seul importDecklistToDeck en produit d'autres, voir "Data
	// model notes" dans CLAUDE.md) — la ligne est donc résolue par
	// scryfallId + catégorie mainboard, cohérent avec ce que
	// changeDeckCardPrinting (plugin.ts) attend en clé.
	private resolveDeckHistoryRow(hEntry: HistoryEntry): DeckCard | undefined {
		const deck = this.plugin.settings.decks.find((d) => d.id === hEntry.listId);
		return deck?.cards.find(
			(c) => c.scryfallId === hEntry.card.id && getDeckCardCategory(c) === "mainboard"
		);
	}

	// Retrouve la ligne réelle APRÈS un déplacement réussi — bug rapporté,
	// root-caused : `copyToList`/`moveCollectionCardToList` etc. (copy-card-modal.ts/
	// plugin.ts) implémentent TOUJOURS "move" comme "copie vers la
	// destination, PUIS retire l'original" (this.plugin.removeCard(cardId)
	// après coup) — jamais une mutation en place de `row.listId`. La
	// référence `row` capturée AVANT d'ouvrir CopyCardModal (voir
	// openMoveCardForEntry) devient donc une référence PENDANTE une fois le
	// déplacement effectué : elle n'a jamais été retirée de
	// settings.collection/.wantlist, son .listId n'a jamais changé — lire
	// row.listId après coup renvoie encore et toujours l'ANCIENNE
	// destination, jamais la nouvelle. CopyCardModal.onDone n'a d'ailleurs
	// aucun moyen de renvoyer la destination choisie (`() => void`, sans
	// argument), donc il n'y a de toute façon rien à lire côté modale.
	// Cette méthode retrouve la ligne à sa VRAIE position actuelle en
	// cherchant par identité de carte (scryfallId + finish/language/
	// condition) SANS contrainte de listId — contrairement à
	// resolveHistoryRow ci-dessus, qui a justement besoin de cette
	// contrainte pour désigner une ligne précise en usage normal.
	// Approximation acceptée si jamais 2 copies identiques (même
	// printing/finish/langue/état) existaient déjà dans 2 listes
	// différentes avant le déplacement : la première trouvée gagne — même
	// esprit que "dernière contribution gagne" ailleurs dans ce panneau.
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

	// Bug rapporté : déplacer une carte vers un DECK, ou vers l'AUTRE côté
	// Collection/Wantlist (ex. sourceKind === "collection" mais la carte
	// déplacée vers une wantlist), reproduisait EXACTEMENT le même bug déjà
	// corrigé pour un déplacement RESTANT dans le périmètre de
	// this.sourceKind — parce que resolveMovedRow (ci-dessus) ne cherche
	// QUE dans le tableau correspondant à this.sourceKind, il ne trouve
	// rien du tout dans ce cas et le callback de succès ne mettait alors
	// rien à jour, laissant la tuile affichant l'ANCIENNE destination avec
	// des liens qui ne faisaient plus jamais rien silencieusement — même
	// symptôme, cause différente. this.sourceKind est fixe pour toute la
	// durée de vie de la modale (ce n'est pas une propriété par entrée) :
	// ni ChangePrintingModal ni CopyCardModal ne peuvent de toute façon
	// plus opérer sur cette ligne depuis CETTE modale une fois sortie de ce
	// périmètre (DeckCard n'a ni impression alternative ni concept de
	// déplacement — voir "Data model notes" — et rebasculer sourceKind
	// à la volée pour une seule entrée casserait le reste de la modale).
	// Cette méthode cherche donc la carte PARTOUT (collection, wantlist,
	// chaque deck), uniquement pour l'AFFICHAGE — set/numéro/rareté/nom de
	// destination réels, quel que soit où elle a atterri — jamais pour
	// réactiver les liens, qui restent désactivés dans ce cas (voir
	// hEntry.linksDisabled). Même approximation "première trouvée gagne"
	// que resolveMovedRow si une carte identique existait déjà ailleurs.
	private locateMovedCardAnywhere(hEntry: HistoryEntry): {
		setCode: string;
		collectorNumber: string;
		rarity: string;
		destinationName: string;
		// Section où la carte a réellement atterri — sert à composer
		// l'infobulle "Edit in My X" (voir openMoveCardForEntry) une fois
		// linksDisabled posé, demandé explicitement.
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

	// "Edit in My X" — demandé explicitement, l'infobulle posée sur une
	// tuile figée (linksDisabled) pour expliquer où retrouver la carte
	// maintenant que ses 2 liens ne font plus rien ici — même esprit que
	// les autres infobulles "nuance plutôt que silence" déjà établies dans
	// ce fichier (Mana Pool/TCGplayer/Cardmarket dans le panneau Store
	// Prices).
	private editElsewhereTitle(kind: "collection" | "wantlist" | "deck"): string {
		const section = kind === "collection" ? "Collection" : kind === "wantlist" ? "Wantlists" : "Decks";
		return `This card has moved to ${section} — open it there to make further changes.`;
	}

	// Corrige hEntry.card/hEntry.listId (la clé de dédoublonnage — voir
	// historyKey/resolveHistoryRow) APRÈS un changement d'impression ou un
	// déplacement réussi, et déplace l'entrée dans historyEntries vers sa
	// nouvelle clé — bug rapporté, corrigé : sans ça, un 2ᵉ changement
	// d'impression (ou un clic sur la destination, ou un disable/delete)
	// sur la MÊME tuile cherchait la ligne sous son ANCIEN scryfallId/
	// listId, ne la trouvait plus (resolveHistoryRow renvoyait undefined),
	// et silencieusement n'ouvrait/ne faisait plus rien du tout — lisait
	// alors comme "plus rien n'est cliquable" sur cette tuile en
	// particulier. `oldKey` doit être capturé par l'appelant AVANT de
	// muter hEntry.card/hEntry.listId (sinon il ne représenterait déjà
	// plus l'ancienne clé au moment de le calculer ici).
	private reKeyHistoryEntry(hEntry: HistoryEntry, oldKey: string) {
		const newKey = this.historyKey(hEntry.card.id, hEntry.listId);
		if (newKey === oldKey) return;
		this.historyEntries.delete(oldKey);
		this.historyEntries.set(newKey, hEntry);
	}

	// Lien "icône + set + numéro" de la ligne 2 — demandé explicitement,
	// ouvre ChangePrintingModal sur la ligne réellement ajoutée (voir
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
				// changeCollectionCardPrinting/changeWantlistCardPrinting mutent `row` en
				// place (même référence) — ses champs setCode/collectorNumber/
				// rarity/scryfallId/name sont donc déjà à jour ici, pas besoin
				// de re-chercher la ligne. hEntry.card est reconstruit (spread +
				// champs changés) plutôt que muté en place — il reste typé
				// ScryfallCard, seuls les champs que resolveHistoryRow/
				// buildHistoryLine2 lisent réellement changent, voir
				// reKeyHistoryEntry ci-dessus pour pourquoi c'est nécessaire.
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

	// Variante Deck de la méthode ci-dessus — séparée plutôt qu'un 3ᵉ
	// branchement dans la même fonction, parce qu'elle a une vraie différence
	// structurelle : contrairement à changeCollectionCardPrinting/
	// changeWantlistCardPrinting (jamais de fusion, la référence `row`
	// capturée avant ouverture reste valide après coup), changeDeckCardPrinting
	// (plugin.ts) peut FUSIONNER avec une ligne déjà présente pour la même
	// impression dans ce deck — la ligne d'origine (deckRow ci-dessous) peut
	// donc avoir été retirée de deck.cards entre-temps. Le callback onChanged
	// reçoit maintenant le ScryfallCard réellement choisi (voir son propre
	// commentaire, ChangePrintingModal) précisément pour pouvoir retrouver la
	// ligne réelle après coup PAR CE NOUVEAU scryfallId, plutôt que de risquer
	// de lire une ligne fantôme.
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

	// Lien "destination" de la ligne 2 — demandé explicitement, ouvre
	// CopyCardModal en mode "move" sur la ligne réellement ajoutée.
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
				// `row` est maintenant une référence PENDANTE (voir
				// resolveMovedRow ci-dessus pour le pourquoi) — jamais utilisée
				// ici pour retrouver la destination réelle. resolveMovedRow
				// retrouve la ligne à sa vraie position actuelle SI elle est
				// restée dans le tableau correspondant à this.sourceKind
				// (cherche par identité de carte, sans contrainte de listId).
				const movedRow = this.resolveMovedRow(hEntry);
				if (movedRow) {
					// resolveDestinationNameById (pas resolveDestinationName) :
					// cette dernière ignore son paramètre listId hors mode
					// listGallery, elle renvoie toujours le nom de destination
					// FIXE de la modale (this.destinationName) — ce qui aurait
					// silencieusement affiché l'ANCIENNE destination après un
					// déplacement vers une liste/wantlist totalement différente.
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
				// resolveMovedRow n'a rien trouvé : la carte a quitté le
				// périmètre de this.sourceKind (déplacée vers un deck, ou vers
				// l'AUTRE côté Collection/Wantlist) — bug rapporté, root-caused
				// : sans ce cas, la tuile restait bloquée sur son ancienne
				// destination avec des liens qui ne faisaient plus jamais rien.
				// locateMovedCardAnywhere cherche la carte PARTOUT juste pour
				// l'affichage ; hEntry.linksDisabled rend les 2 liens
				// définitivement non interactifs pour cette tuile — ni
				// ChangePrintingModal ni CopyCardModal ne peuvent de toute
				// façon plus opérer dessus depuis cette modale une fois sortie
				// de ce périmètre.
				const located = this.locateMovedCardAnywhere(hEntry);
				hEntry.linksDisabled = true;
				// Grise la tuile + infobulle "Edit in My X" — demandé
				// explicitement, "comprendre visuellement que cette tuile est
				// figée" : même traitement visuel que is-disabled (case à
				// cocher décochée), sous une classe distincte (is-frozen) —
				// les deux états sont sémantiquement différents (une carte
				// figée est toujours "enabled", elle a juste quitté le
				// périmètre de cette modale) mais partagent le même langage
				// visuel. Voir updateHistoryTileState pour la classe elle-même.
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
					// Ne devrait pas arriver (la carte a bien été déplacée
					// quelque part) — filet de sécurité seulement, ne casse
					// rien si un jour elle ne l'est pas.
					this.buildHistoryLine2(hEntry, hEntry.card.set, hEntry.card.collector_number, hEntry.card.rarity, hEntry.destinationName);
				}
				// Remplace la corbeille par le badge de contexte non cliquable
				// ("In Collection"/"In Decks"/"In Wantlists") — voir
				// buildHistoryTileTrailing pour le pourquoi. Après buildHistory-
				// Line2 ci-dessus (l'ordre entre les deux n'a pas d'importance
				// en soi, ce sont deux zones distinctes de la tuile), pour
				// rester groupé avec la mise à jour de tile plutôt que dispersé.
				if (hEntry.tileEl) this.buildHistoryTileTrailing(hEntry, hEntry.tileEl);
			},
			"move"
		).open();
	}

	// Résout le nom réel d'une liste/wantlist par id, indépendamment du mode
	// de cette modale (fixe ou listGallery) — contrairement à
	// resolveDestinationName ci-dessus (pensée pour "quelle destination
	// portait CET ajout", pas "quel est le nom actuel de N'IMPORTE QUEL
	// listId"), nécessaire ici puisqu'un déplacement peut envoyer la carte
	// vers une destination sans aucun rapport avec celle d'origine de cette
	// modale.
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
		// "trash-2" (pas "x") — demandé explicitement, même icône que les
		// autres actions de suppression de ce plugin (bouton "Delete" de la
		// barre d'actions groupées, "Remove from list" du panneau de détail).
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
		// is-frozen — demandé explicitement, distincte de is-disabled (voir
		// le commentaire de HistoryEntry.linksDisabled) : posée une fois pour
		// toutes par openMoveCardForEntry dès que la carte quitte le
		// périmètre de cette modale, jamais retirée ensuite (rien ne peut la
		// ramener dans ce périmètre depuis cette même tuile).
		hEntry.tileEl?.toggleClass("is-frozen", !!hEntry.linksDisabled);
		if (!hEntry.toggleBtn) return;
		hEntry.toggleBtn.checked = hEntry.enabled;
		// disabled une fois figée — demandé explicitement, même raisonnement
		// que le remplacement de la corbeille par le badge de contexte
		// (buildHistoryTileTrailing) : toggleHistoryEntry appellerait
		// onUndoAdd/onAdd avec hEntry.listId, resté volontairement obsolète
		// une fois linksDisabled posé (voir son commentaire) — la case
		// resterait donc cliquable sans plus rien faire de réel derrière,
		// exactement le même piège que la corbeille avant son propre
		// correctif. `disabled` (l'attribut natif, pas juste retirer un
		// listener) empêche tout clic ET toute navigation clavier d'un coup,
		// et le titre est retiré plutôt que mis à "" — un title="" explicite
		// masquerait l'infobulle "Edit in My X" déjà posée sur la tuile
		// elle-même (voir openMoveCardForEntry) au survol précis de la
		// case, alors que retirer l'attribut laisse cette infobulle
		// ancêtre remonter normalement.
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

	// Bascule enabled ↔ disabled — dans les deux sens, la carte réelle est
	// réellement mutée (jamais un simple état visuel), voir onUndoAdd
	// (annulation) ci-dessous et onAdd (réactivation, qui rejoue chaque
	// contribution exactement `count` fois avec ses propres options). Le
	// dernier résultat (ligne réelle résultante, ou undefined si supprimée)
	// resynchronise la tuile carrousel d'origine via syncCallback — une
	// approximation raisonnable, pas garantie exacte, quand une même entrée
	// porte PLUSIEURS groupes de contributions à options différentes (voir
	// le commentaire de HistoryContribution) : la tuile carrousel actuelle
	// ne peut de toute façon représenter qu'UNE seule ligne à la fois.
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

	// Supprime définitivement la tuile — si l'entrée était encore active,
	// l'annule d'abord (mêmes appels qu'un "disable", voir toggleHistoryEntry)
	// ; si elle était déjà désactivée, les données réelles ont déjà été
	// annulées au moment du disable, rien à refaire ici.
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

	// Tiroir "Add history" — masque/affiche tout le panneau par un
	// glissement CSS (largeur/padding/opacity animés, voir
	// .mtg-search-history-panel.is-collapsed dans styles.css) plutôt qu'un
	// simple display:none, pour que bottomMainEl (flex: 1) regagne
	// visiblement l'espace libéré au lieu de sauter instantanément à sa
	// nouvelle taille — demandé explicitement ("apparait par glissement et
	// pousse le contenu... comme un tiroir"). is-history-collapsed sur
	// bottomSection referme aussi le gap entre les 2 colonnes, sinon un
	// vide résiduel resterait visible à droite une fois le panneau à
	// largeur 0.
	private toggleHistoryDrawer() {
		this.historyCollapsed = !this.historyCollapsed;
		this.historyPanelEl?.toggleClass("is-collapsed", this.historyCollapsed);
	}

	// `index` (position dans le lot de résultats affiché, pas l'id de la
	// carte) pilote la vague d'apparition en entrée — voir
	// applyResultTileStaggerEntrance, qui plafonne d'elle-même aux
	// premières tuiles réellement visibles dans le carrousel. Optionnel :
	// un appel sans index (aucun aujourd'hui, gardé pour un futur usage
	// hors "lot de résultats frais") rend la tuile directement visible,
	// sans vague.
	renderResult(card: ScryfallCard, index?: number) {
		const tile = renderScryfallResultTile(this.plugin, this.resultsEl, card, (tile) => {
			this.renderAddControl(tile, card);
		});
		if (index !== undefined) applyResultTileStaggerEntrance(tile, index);
	}

	// Zone "Add" d'une tuile de résultat — un simple bouton au départ, qui se
	// transforme en stepper +/quantité/- une fois la carte effectivement
	// ajoutée quelque part (onAddCard a renvoyé une entrée ET onChangeQuantity
	// est fourni — voir AddCardsModalOptions). Le conteneur est reconstruit
	// en place (empty() + rebuild) plutôt que remplacé par un nouvel élément,
	// pour ne pas perturber la mise en page de la tuile autour de lui.
	private renderAddControl(tile: HTMLElement, card: ScryfallCard) {
		const container = tile.createDiv({ cls: "mtg-result-card-add-control" });
		// Entrée déjà ajoutée cette session, le cas échéant — l'objet renvoyé
		// par addCardToCollection/addCardToWantlist est la même référence que
		// celle mutée en place par changeCollectionCardCount/changeWantlistCardCount, donc son
		// .count reste à jour tout seul après chaque clic +/-.
		let entry: { id: string; count: number } | undefined;
		// Options/destination du tout premier ajout réussi de cette tuile —
		// figées une fois pour toutes (bug signalé : l'historique restait
		// bloqué à "×1" même après plusieurs clics +/-, parce que seul CE tout
		// premier ajout passait par recordHistoryAdd ; le stepper +/- appelle
		// onChangeQuantity directement, jamais onAdd). Ne PAS relire
		// computeAddOptions() au moment d'un clic +/- : ses options sont
		// constantes aujourd'hui, mais figer celles du tout premier ajout
		// reste la bonne défense si un futur sélecteur partagé par toute la
		// modale (comme l'ancien select Finish du flux Wantlist) réapparaissait
		// — un tel sélecteur pourrait avoir changé entre temps pour une AUTRE
		// carte, ce qui ne serait alors plus les options réellement utilisées
		// pour CETTE tuile.
		let historyOptions: AddCardOptions | undefined;
		let historyListId: string | undefined;

		// Toute la tuile devient cliquable une fois la carte ajoutée — demandé
		// explicitement — et ouvre sa fenêtre de détail (onOpenDetail, fourni
		// par le call site qui sait laquelle construire — voir son propre
		// commentaire dans shared-search-ui.ts). Le handler lui-même est posé
		// une seule fois ici (pas dans buildStepper, appelée à chaque fois que
		// la carte est ajoutée depuis cette tuile) ; il lit `entry`/
		// `this.onOpenDetail` au moment du clic, donc il n'a rien à faire tant
		// que l'un des deux manque. Les boutons +/- et "Add" eux-mêmes
		// (enfants de tile) stoppent la propagation de leur propre clic (voir
		// plus bas) pour ne jamais déclencher aussi ce handler.
		// syncFromHistory (définie plus bas, référencée ici par closure comme
		// buildAddButton/applyDelta ailleurs dans cette même fonction) est
		// passée telle quelle comme callback "la fenêtre de détail vient de se
		// fermer" — bug corrigé : modifier la quantité ou supprimer la carte
		// depuis cette fenêtre de détail, puis revenir ici, ne resynchronisait
		// jamais cette tuile. Le call site (view.ts) doit la rappeler avec la
		// ligne réelle à jour une fois la fenêtre refermée ; syncFromHistory
		// sait déjà faire exactement ça (reconstruire le stepper, ou revenir à
		// "Add" si la ligne a disparu) — même mécanisme que le panneau "Add
		// history", juste déclenché par un autre événement.
		tile.addEventListener("click", () => {
			if (!entry || !this.onOpenDetail) return;
			this.onOpenDetail(entry.id, syncFromHistory);
		});

		const buildStepper = () => {
			if (!entry) return;
			container.empty();
			// mtg-result-card-tile-clickable : curseur + surbrillance au survol
			// (voir styles.css) — seulement si onOpenDetail est réellement
			// fourni, sinon la tuile resterait visuellement "cliquable" pour un
			// clic qui ne fait rien.
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
				// Le stepper +/- change aussi la quantité réellement ajoutée
				// cette session — l'historique doit suivre (voir le commentaire
				// de historyOptions/historyListId plus haut pour le bug que ça
				// corrige). "+1" réutilise recordHistoryAdd telle quelle (même
				// logique qu'un nouvel ajout — crée l'entrée si besoin,
				// incrémente sinon) ; "-1" a sa propre logique symétrique, voir
				// decrementHistoryQuantity.
				if (this.onUndoAdd && historyOptions && historyListId) {
					if (delta > 0) {
						this.recordHistoryAdd(card, historyOptions, historyListId, syncFromHistory);
					} else {
						this.decrementHistoryQuantity(card, historyOptions, historyListId);
					}
				}
			};
			// stopPropagation : ces deux boutons vivent à l'intérieur de tile,
			// qui écoute maintenant son propre clic (voir plus haut) — sans ça,
			// ajuster la quantité ouvrirait aussi la fenêtre de détail à chaque
			// clic +/-.
			downBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				applyDelta(-1);
			});
			upBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				applyDelta(1);
			});
		};

		// Reçoit la ligne résultante d'un toggle d'historique (voir
		// toggleHistoryEntry/deleteHistoryEntry) pour resynchroniser CETTE
		// tuile carrousel sur l'état réel — undefined signifie "la ligne
		// n'existe plus", auquel cas la tuile redevient un simple bouton
		// "Add" plutôt que de garder un stepper affichant une quantité
		// périmée. N'a d'effet que si CETTE tuile est bien celle concernée
		// (voir son appel, plus bas, filtré par card.id + listId).
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
			// Pas d'entrée exploitable (un éventuel futur appelant sans
			// onChangeQuantity — les 3 flux actuels, Collection/Wantlist/Deck,
			// le fournissent tous depuis l'uniformisation du flux Deck) : le
			// bouton "Add" reste tel quel, cliquable à nouveau pour ajouter un
			// exemplaire de plus, comme avant.
			if (!result || !this.onChangeQuantity) return;
			entry = result;
			buildStepper();
			if (this.onUndoAdd) {
				historyOptions = options;
				historyListId = result.listId;
				this.recordHistoryAdd(card, options, result.listId, syncFromHistory);
			}
		};

		// Cœur de l'ajout, partagé par le clic individuel sur "Add" ET par
		// "Add all" (performAddAll, via currentResultControls) — un seul chemin
		// de code pour les deux, pas deux logiques d'ajout à garder synchronisées.
		// `listId` vient soit du picker par carte (clic individuel, flux
		// listGallery), soit du picker unique ouvert une fois pour tout le lot
		// (Add all, flux listGallery). `silent` coupe le Notice individuel
		// pendant Add all, qui affiche un seul résumé à la fin plutôt que
		// d'empiler une notification par carte.
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

		// Factorisé (appelé à la construction initiale ET par syncFromHistory,
		// voir plus haut, quand un "undo" d'historique ramène cette tuile à
		// zéro) plutôt que deux copies du même bouton à maintenir en
		// parallèle.
		const buildAddButton = () => {
			const addBtn = container.createEl("button", {
				cls: "mtg-result-card-add-btn",
				text: "Add",
			});
			// stopPropagation : voir le commentaire du clic sur tile plus haut —
			// au moment où cet event remonte jusqu'à tile, handleAdded a déjà pu
			// fixer `entry` et reconstruire le stepper (tout se passe de façon
			// synchrone dans ce même handler avant que la remontée ne reprenne),
			// donc sans stopPropagation, cliquer "Add" ouvrirait aussitôt la
			// fenêtre de détail à la place d'ajouter simplement la carte.
			addBtn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				// defaultListId (Inbox) : ajout direct, sans ouvrir le picker —
				// voir AddCardsModalOptions.listGallery.defaultListId. Le
				// picker reste le comportement quand aucun défaut n'est fourni
				// (flux Wantlist, ou défensivement si Inbox n'existe pas).
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
/*  Add all confirmation (separate window, demandé explicitement — voir      */
/*  showAddAllConfirm ci-dessus, remplace l'ancien message inline)            */
/* -------------------------------------------------------------------------- */

// Petite fenêtre dédiée, plutôt qu'un message inline sous la barre de
// recherche (comme avant) — demandé explicitement. Même habillage que les
// autres petites modales de confirmation de ce plugin (mtg-list-actions-
// modal, animation d'ouverture/fermeture partagée) plutôt qu'un
// window.confirm() natif, jamais utilisé nulle part dans ce plugin.
class AddAllConfirmModal extends Modal {
	// showWarning : au-delà de ADD_ALL_WARNING_THRESHOLD (voir
	// showAddAllConfirm) — un paragraphe supplémentaire prévient que
	// l'opération peut prendre du temps (auto-pagination Scryfall, un aller-
	// retour réseau paisé par page) et qu'Obsidian peut sembler figé pendant
	// ce temps, plutôt que la simple confirmation habituelle.
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
		// Bouton neutre, sans classe particulière — même style par défaut que le
		// "Cancel" de ChangePrintingModal (.mtg-card-detail-actions button).
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

// Reprend l'habillage visuel de CopyCardModal ("Move card") à l'identique —
// mêmes classes CSS de galerie/tuile (zoom au survol, overlay, apparition en
// vague), même barre de recherche, même tuile "+ New X", même clic-direct-
// ajoute (pas de bouton "Add" séparé à cliquer après sélection) — demandé
// explicitement pour que les deux modales se ressemblent en tout point, seul
// le titre diffère. Pas d'onglets Collection/Decks/Wantlists comme
// CopyCardModal : cette modale n'intervient qu'une fois la destination déjà
// fixée par l'appelant (ajout à une liste ou à une wantlist, jamais les
// deux à la fois), donc une galerie unique suffit — `kind` ne sert qu'à
// choisir le bon libellé/la bonne modale de création, pas un onglet.
export class SelectListModal extends Modal {
	private plugin: MTGCollectionPlugin;
	private summaries: (ListGroup | WantlistGroup)[];
	private cardName: string;
	private kind: "list" | "wantlist";
	private onConfirm: (listId: string) => void;
	private galleryEl!: HTMLElement;
	private searchQuery = "";
	private searchInputEl!: HTMLInputElement;
	// Même convention que CopyCardModal.tileStaggerIndex : décale l'apparition
	// des 8 premières tuiles à l'ouverture, jamais pendant la frappe dans la
	// recherche (voir renderGallery/revealTile).
	private tileStaggerIndex = 0;
	// true pour l'appel groupé "Add all" (performAddAll, add-cards-modal.ts) :
	// cardName y vaut déjà "N cards", donc l'entourer de guillemets comme pour
	// un nom de carte unique ("Add "N cards" to") lirait mal — plain retire
	// juste les guillemets du titre, rien d'autre ne change.
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
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		// Mêmes classes que CopyCardModal (pas de classe mtg-search-modal ici,
		// qui porte le style de la recherche de carte elle-même, pas de cette
		// étape de sélection de destination).
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
		// Ne reconstruit que la galerie à chaque frappe, jamais ce <input>
		// lui-même — même raisonnement (perte de focus en cours de saisie) que
		// CopyCardModal.searchInputEl.
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
		// La tuile "+ New X" reste toujours affichée, jamais filtrée par la
		// recherche — même convention que CopyCardModal.renderNewTile : la
		// recherche sert à retrouver une destination existante plus vite, pas
		// à masquer l'option de création.
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

	// Clic sur une tuile ajoute directement, comme CopyCardModal — pas de
	// sélection intermédiaire suivie d'un bouton "Add" séparé.
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
