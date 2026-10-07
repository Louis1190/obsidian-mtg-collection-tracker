/* -------------------------------------------------------------------------- */
/*  Rendering helpers shared across My Collection/My Decks/My
	Wantlists: filter chips, scroll/focus/tile-radius, row-DOM caching's
	shared collapse/FLIP animation, thumbnail rendering, Group by/Sort by
	toolbar. Split out of view.ts on 2026-09-10 ("Phase 5b").  */
/* -------------------------------------------------------------------------- */

import { createFlagImg } from "../ui/option-icons";
import { setupChipRowScroll } from "../ui/chip-row-scroll";
import { SearchSyntaxModal } from "../modals/search-syntax-modals";
import { SearchableCard, isNegatedToken, isExactToken, stripNegation, stripExact, recognizeKeywordToken, stripQuotesFromCommittedToken, hasUnclosedQuote, matchNumericField, CATEGORY_LABELS, NumericFieldDef, NUMERIC_OPERATORS, OPERATOR_SYMBOLS, SuggestKeyword, SUGGESTABLE_KEYWORDS, cardMatchesTokens } from "../core/card-search";
import { applySvgColor } from "../api/scryfall";
import { setIcon } from "obsidian";
import type { MTGCollectionView } from "../view";
import { setSvgMarkup } from "../ui/svg-markup";

/* ---------------------------------------------------------------------------- */
/*  Barre de recherche à puces (My Collection / My Decks / My Wantlists) : puces, filtre numérique, suggestions.*/
/* ---------------------------------------------------------------------------- */

export const FILTER_RENDER_DEBOUNCE_MS = 150;
// Regroupe les render() rapprochés déclenchés en tapant dans un filtre
// (voir le champ filterRenderDebounceTimer pour le pourquoi).

export function scheduleFilterRender(this: MTGCollectionView) {
	if (this.filterRenderDebounceTimer !== null) window.clearTimeout(this.filterRenderDebounceTimer);
	this.filterRenderDebounceTimer = window.setTimeout(() => {
		this.filterRenderDebounceTimer = null;
		this.render();
	}, FILTER_RENDER_DEBOUNCE_MS);
}
// Barre de recherche façon Delver : chaque mot validé (espace) devient une
// puce supprimable ; un mot reconnu (couleur/rareté) s'affiche avec son
// icône plutôt qu'en texte brut. Conserve le focus d'une frappe à l'autre.

export function renderChipFilter(this: MTGCollectionView, 
	container: HTMLElement,
	tokens: string[],
	draft: string,
	placeholder: string,
	key: string,
	onTokensChange: (tokens: string[]) => void,
	onDraftChange: (draft: string) => void,
	baseCards: SearchableCard[] = [],
	recentlyAddedIds?: Set<string>,
	// My Collection uniquement (voir renderListDetail) — Decks/Wantlists
	// omettent ce paramètre, comme ils omettent déjà recentlyAddedIds
	// ci-dessus, même précédent : "legal:" n'y est simplement jamais
	// reconnu comme catégorie active côté données (categorizeToken le
	// reconnaît partout, mais sans cette Map le jeton ne matche jamais
	// rien, voir legalityTokenMatches).
	legalitiesByScryfallId?: Map<string, Record<string, string>>
) {
	const wrap = container.createDiv({ cls: "mtg-filter-chip-row" });
	const inner = wrap.createDiv({ cls: "mtg-filter-chip-row-inner" });

	tokens.forEach((token, index) => {
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
			const newTokens = tokens.slice();
			newTokens[index] = isNegated ? baseToken : `-${baseToken}`;
			onTokensChange(newTokens);
			this.lastFocusedFilterKey = key;
			this.render();
		});

		const recognized = recognizeKeywordToken(baseToken);

		// Bascule "identité de couleur exacte" (voir isExactToken,
		// card-search.ts) — seulement pour une puce couleur reconnue : ce
		// concept n'a de sens que pour cette facette (contrairement à
		// l'exclusion "-" ci-dessus, disponible sur n'importe quelle puce).
		// Mutuellement exclusive avec la négation par construction : la
		// bascule pose "=${baseToken}" où baseToken est déjà dépouillé de
		// son éventuel préfixe "-" ci-dessus, donc cliquer ici retire
		// silencieusement la négation le cas échéant (et vice versa).
		if (recognized?.kind === "color") {
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
				const newTokens = tokens.slice();
				newTokens[index] = isExact ? baseToken : `=${baseToken}`;
				onTokensChange(newTokens);
				this.lastFocusedFilterKey = key;
				this.render();
			});
		}

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
		} else if (recognized?.kind === "rarity") {
			chip.addClass("mtg-filter-chip-recognized");
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "language") {
			chip.addClass("mtg-filter-chip-recognized");
			// recognized.flag est toujours un vrai code pays ici : "None"
			// n'est plus une entrée de LANGUAGES, donc jamais reconnu comme
			// jeton de langue par recognizeKeywordToken (voir card-search.ts).
			createFlagImg(chip, recognized.flag, "mtg-flag-img mtg-flag-img-inline");
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "condition") {
			chip.addClass("mtg-filter-chip-recognized");
			const glyphEl = chip.createSpan({ cls: "mtg-condition-badge", text: recognized.glyph });
			glyphEl.style.color = recognized.color;
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "type") {
			chip.addClass("mtg-filter-chip-recognized");
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "foil") {
			chip.addClass("mtg-filter-chip-recognized");
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "keyword") {
			chip.addClass("mtg-filter-chip-recognized");
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "numeric") {
			chip.addClass("mtg-filter-chip-recognized");
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "artist") {
			chip.addClass("mtg-filter-chip-recognized");
			chip.createSpan({ text: recognized.label });
		} else if (recognized?.kind === "set") {
			chip.addClass("mtg-filter-chip-recognized");
			const iconEl = chip.createSpan({ cls: "mtg-filter-chip-icon" });
			void this.plugin.getSetIconSvg(recognized.code).then((svg) => {
				if (!svg) return;
				setSvgMarkup(iconEl, svg);
				applySvgColor(iconEl, "#ffffff");
			});
			const friendlyName = this.plugin
				.getDistinctSets()
				.find((s) => s.code.toLowerCase() === recognized.code.toLowerCase())?.name;
			chip.createSpan({ text: friendlyName ?? recognized.label });
		} else if (recognized?.kind === "cardnum") {
			chip.addClass("mtg-filter-chip-recognized");
			chip.createSpan({ text: recognized.label });
		} else {
			chip.createSpan({ text: baseToken });
		}

		const removeBtn = chip.createSpan({ cls: "mtg-filter-chip-remove" });
		setIcon(removeBtn, "x");
		removeBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			const newTokens = tokens.slice();
			newTokens.splice(index, 1);
			onTokensChange(newTokens);
			this.lastFocusedFilterKey = key;
			this.render();
		});
	});

	const input = inner.createEl("input", {
		cls: "mtg-filter-chip-input",
		type: "text",
		placeholder: tokens.length === 0 ? placeholder : "",
	});
	input.value = draft;

	const commitToken = (value: string) => {
		onTokensChange([...tokens, stripQuotesFromCommittedToken(value)]);
		onDraftChange("");
		this.suggestionHighlightIndex = -1;
		this.lastFocusedFilterKey = key;
		this.lastFocusedFilterCursor = 0;
		this.render();
	};

	input.addEventListener("keydown", (evt) => {
		if (evt.key === "Backspace" && input.value === "" && tokens.length > 0) {
			evt.preventDefault();
			onTokensChange(tokens.slice(0, -1));
			this.lastFocusedFilterKey = key;
			this.render();
			return;
		}

		const currentSuggestions = this.getKeywordSuggestions(
			input.value,
			tokens,
			baseCards,
			recentlyAddedIds,
			legalitiesByScryfallId
		);

		if (
			currentSuggestions.length > 0 &&
			(evt.key === "ArrowDown" || evt.key === "ArrowUp" || evt.key === "Tab")
		) {
			evt.preventDefault();
			const dir = evt.key === "ArrowUp" || (evt.key === "Tab" && evt.shiftKey) ? -1 : 1;
			this.suggestionHighlightIndex =
				(this.suggestionHighlightIndex + dir + currentSuggestions.length) %
				currentSuggestions.length;
			this.lastFocusedFilterKey = key;
			this.lastFocusedFilterCursor = input.selectionStart;
			this.render();
			return;
		}

		if (evt.key === "Enter" && input.value.trim()) {
			evt.preventDefault();
			if (currentSuggestions.length === 0) {
				commitToken(input.value.trim());
				return;
			}
			const chosenIndex =
				this.suggestionHighlightIndex >= 0 &&
				this.suggestionHighlightIndex < currentSuggestions.length
					? this.suggestionHighlightIndex
					: 0;
			commitToken(currentSuggestions[chosenIndex].value);
		}
	});

	input.addEventListener("input", () => {
		const val = input.value;
		this.suggestionHighlightIndex = -1;
		// !hasUnclosedQuote : une phrase entre guillemets encore ouverte
		// (ex. après "oracle:") ne doit pas être coupée au premier espace
		// qu'elle contient — voir le commentaire de hasUnclosedQuote.
		if (val.endsWith(" ") && !hasUnclosedQuote(val)) {
			const token = val.trim();
			if (token) {
				commitToken(token);
			} else {
				onDraftChange("");
				this.lastFocusedFilterKey = key;
				this.lastFocusedFilterCursor = 0;
				this.render();
			}
			return;
		}
		onDraftChange(val);
		this.lastFocusedFilterKey = key;
		this.lastFocusedFilterCursor = input.selectionStart;
		this.scheduleFilterRender();
	});

	if (tokens.length > 0 || draft.length > 0) {
		const clearBtn = inner.createDiv({ cls: "mtg-filter-clear-btn" });
		setIcon(clearBtn, "x-circle");
		clearBtn.setAttribute("title", "Clear filter");
		clearBtn.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			onTokensChange([]);
			onDraftChange("");
			this.lastFocusedFilterKey = key;
			this.lastFocusedFilterCursor = 0;
			this.render();
		});
	}

	const syntaxBtn = wrap.createDiv({ cls: "mtg-filter-syntax-btn" });
	setIcon(syntaxBtn, "help-circle");
	syntaxBtn.setAttribute("title", "Search syntax");
	syntaxBtn.addEventListener("mousedown", (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		new SearchSyntaxModal(this.app).open();
	});

	if (this.lastFocusedFilterKey === key) {
		// input est construit hors DOM à cet instant (render() assemble tout
		// dans un clone détaché avant de l'échanger d'un coup — voir
		// render()) : appeler focus() ici ne fait rien, un élément détaché ne
		// peut pas recevoir le focus. render() exécute ce callback juste
		// après l'échange, dans le MÊME passage synchrone (pas via
		// setTimeout) : un délai, même court, laisse une fenêtre sans aucun
		// élément focus entre le retrait de l'ancien input et le focus du
		// nouveau, où une frappe tombant pile dedans se perdait.
		this.pendingFocusRestore = () => {
			input.focus();
			if (this.lastFocusedFilterCursor != null) {
				input.setSelectionRange(this.lastFocusedFilterCursor, this.lastFocusedFilterCursor);
			}
		};
	}

	// Remet la saisie en vue (la barre défile partout), que la barre ait le focus ou non. La barre est
	// encore détachée ici, le helper attend donc qu'elle soit mise en page — après
	// l'échange de clone ET après pendingFocusRestore, dont le focus() natif fait lui
	// aussi défiler : c'est le passage du helper qui doit avoir le dernier mot.
	setupChipRowScroll(inner);

	// Le compte de résultats ("x of y cards match", et l'indicateur "Fetching
	// legality data" qui l'accompagnait) vivait ici, sous la barre de
	// recherche ; il est passé dans le titre "Cards: …" en tête de la zone
	// de défilement (voir renderCardsCountTitle plus bas) — demandé
	// explicitement, comme le titre "Lists" des galeries.

	const numericField = matchNumericField(draft);
	if (numericField) {
		this.renderNumericFilterBuilder(container, numericField, commitToken);
		return;
	}

	const suggestions = this.getKeywordSuggestions(
		draft,
		tokens,
		baseCards,
		recentlyAddedIds,
		legalitiesByScryfallId
	);
	if (suggestions.length > 0) {
		const dropdown = container.createDiv({ cls: "mtg-filter-suggestions" });
		suggestions.forEach((s, index) => {
			const item = dropdown.createDiv({ cls: "mtg-filter-suggestion-item" });
			if (index === this.suggestionHighlightIndex) {
				item.addClass("is-keyboard-highlighted");
			}
			item.addEventListener("mouseenter", () => {
				this.suggestionHighlightIndex = index;
				dropdown
					.querySelectorAll(".mtg-filter-suggestion-item.is-keyboard-highlighted")
					.forEach((el) => el.removeClass("is-keyboard-highlighted"));
				item.addClass("is-keyboard-highlighted");
			});
			const mainArea = item.createDiv({ cls: "mtg-filter-suggestion-main" });
			if (CATEGORY_LABELS[s.category]) {
				mainArea.createSpan({
					cls: "mtg-filter-suggestion-category",
					text: CATEGORY_LABELS[s.category],
				});
			}
			if (s.flagCode) {
				createFlagImg(mainArea, s.flagCode, "mtg-flag-img mtg-flag-img-inline");
			}
			if (s.setCode) {
				const iconEl = mainArea.createSpan({ cls: "mtg-search-set-suggestion-icon" });
				void this.plugin.getSetIconSvg(s.setCode).then((svg) => {
					if (!svg) return;
					setSvgMarkup(iconEl, svg);
					applySvgColor(iconEl, "#ffffff");
				});
			}
			const nameAndCount = mainArea.createDiv({ cls: "mtg-filter-suggestion-name-count" });
			nameAndCount.createSpan({ text: s.display });
			if (s.count !== undefined) {
				nameAndCount.createSpan({ cls: "mtg-filter-suggestion-count", text: `(${s.count})` });
			}
			// mousedown+preventDefault plutôt que click : évite que l'input
			// perde le focus avant que la sélection ne soit prise en compte.
			mainArea.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				commitToken(s.value);
			});

			const excludeBtn = item.createSpan({ cls: "mtg-filter-suggestion-exclude" });
			setIcon(excludeBtn, "ban");
			excludeBtn.setAttribute("title", `Exclude ${s.display}`);
			excludeBtn.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				commitToken(`-${s.value}`);
			});
		});
	}
}
// Compositeur visuel pour les filtres numériques (Mana Value/Price/Qty) :
// des boutons d'opérateur (< ≤ = ≥ >) + un champ nombre, pour ne jamais
// avoir à taper la syntaxe "cmc>3" soi-même.

export function renderNumericFilterBuilder(this: MTGCollectionView, 
	container: HTMLElement,
	field: NumericFieldDef,
	commitToken: (value: string) => void
) {
	const box = container.createDiv({ cls: "mtg-numeric-builder" });
	box.createDiv({
		cls: "mtg-numeric-builder-label",
		text: `Filter by ${field.label}`,
	});

	const row = box.createDiv({ cls: "mtg-numeric-builder-row" });
	const valueInput = row.createEl("input", {
		cls: "mtg-numeric-builder-input",
		type: field.valueType === "date" ? "date" : "number",
		attr:
			field.valueType === "date"
				? {}
				: { placeholder: "value", step: field.key === "price" ? "0.01" : "1" },
	});

	const isValidValue = () => {
		const raw = valueInput.value.trim();
		if (!raw) return false;
		return field.valueType === "date" ? /^\d{4}-\d{2}-\d{2}$/.test(raw) : !isNaN(Number(raw));
	};

	const opRow = row.createDiv({ cls: "mtg-numeric-builder-ops" });
	NUMERIC_OPERATORS.forEach((op) => {
		const opBtn = opRow.createDiv({ cls: "mtg-numeric-builder-op-btn" });
		opBtn.setText(OPERATOR_SYMBOLS[op]);
		opBtn.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			if (!isValidValue()) {
				valueInput.focus();
				return;
			}
			commitToken(`${field.key}${op}${valueInput.value.trim()}`);
		});
	});

	valueInput.addEventListener("keydown", (evt) => {
		evt.stopPropagation();
		if (evt.key === "Enter" && isValidValue()) {
			commitToken(`${field.key}>=${valueInput.value.trim()}`);
		}
	});

	if (field.valueType === "date") {
		const formatDate = (d: Date) =>
			`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

		const presetsRow = box.createDiv({ cls: "mtg-numeric-builder-presets" });
		const presets: { label: string; getDate: () => Date }[] = [
			{ label: "Today", getDate: () => new Date() },
			{
				label: "This week",
				getDate: () => {
					const d = new Date();
					d.setDate(d.getDate() - 7);
					return d;
				},
			},
			{
				label: "This month",
				getDate: () => {
					const d = new Date();
					d.setMonth(d.getMonth() - 1);
					return d;
				},
			},
		];
		presets.forEach((preset) => {
			const btn = presetsRow.createEl("button", {
				text: preset.label,
				cls: "mtg-numeric-builder-preset-btn",
			});
			btn.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				commitToken(`added>=${formatDate(preset.getDate())}`);
			});
		});
	}
}


export function getKeywordSuggestions(this: MTGCollectionView, 
	draft: string,
	tokens: string[],
	baseCards: SearchableCard[],
	recentlyAddedIds?: Set<string>,
	legalitiesByScryfallId?: Map<string, Record<string, string>>
): SuggestKeyword[] {
	const q = draft.trim().toLowerCase();
	if (!q) return [];

	const staticMatches = SUGGESTABLE_KEYWORDS.filter(
		(k) => !tokens.includes(k.value) && k.matchTexts.some((m) => m.startsWith(q))
	);

	// Suggestions dynamiques, tirées de la collection réelle (mises en cache
	// côté plugin — voir getDistinctArtists/getDistinctSets — donc pas de
	// recalcul coûteux à chaque frappe).
	const artistMatches: SuggestKeyword[] = this.plugin
		.getDistinctArtists()
		.filter((a) => a.toLowerCase().startsWith(q) && !tokens.includes(`artist:${a}`))
		.slice(0, 4)
		.map((a) => ({
			value: `artist:${a}`,
			display: a,
			matchTexts: [a.toLowerCase()],
			category: "artist",
		}));

	const setMatches: SuggestKeyword[] = this.plugin
		.getDistinctSets()
		// includes, pas startsWith — bug rapporté : taper "Alpha" ne
		// suggérait pas "Limited Edition Alpha" (seul "Limited" marchait).
		// Un nom d'édition se cherche naturellement par n'importe quel mot
		// qu'il contient, pas seulement son premier mot.
		.filter(
			(s) => s.name.toLowerCase().includes(q) && !tokens.includes(`set:${s.code}`)
		)
		.slice(0, 6)
		.map((s) => ({
			value: `set:${s.code}`,
			display: s.name,
			matchTexts: [s.name.toLowerCase()],
			category: "set",
			setCode: s.code,
		}));

	const allMatches = [...staticMatches, ...artistMatches, ...setMatches];
	// Plafond de 6 conservé pour la plupart des requêtes (peu d'entrées
	// possibles, ou un préfixe qui les distingue déjà) — mais "legal:"
	// seul (parcourir les formats sans encore savoir lequel chercher)
	// matche d'un coup les 10 entrées curatées en tête de
	// LEGALITY_SEARCH_FORMATS (voir cette constante, card-search.ts) :
	// 6 aurait coupé "Legal: Commander" (bug rapporté). "legal:" est un
	// préfixe qu'aucune autre catégorie ne peut matcher (voir
	// categorizeToken), donc "toutes les correspondances sont de
	// catégorie legality" identifie sans ambiguïté ce cas précis, jamais
	// vrai pour une autre catégorie. Même raisonnement pour "border:" seul
	// (9 entrées, voir BORDER_SEARCH_OPTIONS) — sans ce même correctif, ce
	// serait exactement le même bug une seconde fois.
	const cap =
		allMatches.length > 0 &&
		(allMatches.every((s) => s.category === "legality") || allMatches.every((s) => s.category === "border"))
			? 10
			: 6;
	const combined = allMatches.slice(0, cap);

	// Seuil réglable dans les paramètres (Interface) : 0 = compteur
	// désactivé, -1 = toujours actif (aucune limite), sinon nombre max de
	// cartes de la liste/deck ouvert au-delà duquel on n'affiche plus le
	// compteur (voir cette même méthode pour le détail des mesures).
	const threshold = this.plugin.settings.suggestionCountThreshold;
	if (
		baseCards.length === 0 ||
		threshold === 0 ||
		(threshold > 0 && baseCards.length > threshold)
	) {
		return combined;
	}

	// Pour chaque suggestion : combien de cartes matcheraient si on
	// l'ajoutait aux jetons déjà validés (sans le brouillon en cours).
	return combined.map((s) => ({
		...s,
		count: baseCards.filter((c) =>
			cardMatchesTokens(c, [...tokens, s.value], "", recentlyAddedIds, legalitiesByScryfallId)
		).length,
	}));
}
// Appelée séparément (plutôt qu'inline dans render()) : lire puis vider
// this.pendingFocusRestore directement dans render() faisait narrower
// TypeScript vers "toujours null" à cet endroit précis (le compilateur
// perdait le fil entre l'affectation à null en tout début de méthode et
// la réaffectation par renderChipFilter, appelé entre-temps via
// render*Section), rendant l'appel jugé inatteignable à la compilation
// alors qu'il l'est bel et bien à l'exécution. Cet indirection suffit à
// lui faire réévaluer le type correctement.

export function runPendingFocusRestore(this: MTGCollectionView) {
	const restore = this.pendingFocusRestore;
	this.pendingFocusRestore = null;
	if (restore) restore();
}
