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
/* Chip search bar (My Collection / My Decks / My Wantlists): chips, numeric filter, suggestions. */
/* ---------------------------------------------------------------------------- */

export const FILTER_RENDER_DEBOUNCE_MS = 150;
// Groups together the close-together render() calls triggered by typing in
// a filter (see the filterRenderDebounceTimer field for the why).

export function scheduleFilterRender(this: MTGCollectionView) {
	if (this.filterRenderDebounceTimer !== null) window.clearTimeout(this.filterRenderDebounceTimer);
	this.filterRenderDebounceTimer = window.setTimeout(() => {
		this.filterRenderDebounceTimer = null;
		this.render();
	}, FILTER_RENDER_DEBOUNCE_MS);
}
// Delver-style search bar: each validated word (space) becomes a removable
// chip; a recognized word (color/rarity) is displayed with its icon rather
// than as raw text. Keeps focus from one keystroke to the next.

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
	// My Collection only (see renderListDetail) — Decks/Wantlists omit this
	// parameter, as they already omit recentlyAddedIds above, same precedent:
	// "legal:" is simply never recognized there as an active category on the
	// data side (categorizeToken recognizes it everywhere, but without this
	// Map the token never matches anything, see legalityTokenMatches).
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

		// "Exact color identity" toggle (see isExactToken, card-search.ts) — only
		// for a recognized color chip: this concept only makes sense for that
		// facet (unlike the "-" exclusion above, available on any chip). Mutually
		// exclusive with negation by construction: the toggle sets "=${baseToken}"
		// where baseToken is already stripped of its possible "-" prefix above, so
		// clicking here silently removes the negation if any (and vice versa).
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
			// recognized.flag is always a real country code here: "None" is no longer
			// an entry of LANGUAGES, so never recognized as a language token by
			// recognizeKeywordToken (see card-search.ts).
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
		// !hasUnclosedQuote: a quoted phrase still open (e.g. after "oracle:")
		// must not be cut at the first space it contains — see the comment of
		// hasUnclosedQuote.
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
		// input is built off-DOM at this moment (render() assembles everything in
		// a detached clone before swapping it in at once — see render()): calling
		// focus() here does nothing, a detached element cannot receive focus.
		// render() runs this callback right after the swap, in the SAME
		// synchronous pass (not via setTimeout): a delay, even a short one, leaves
		// a window with no focused element between the removal of the old input
		// and the focus of the new one, where a keystroke landing right in it was
		// lost.
		this.pendingFocusRestore = () => {
			input.focus();
			if (this.lastFocusedFilterCursor != null) {
				input.setSelectionRange(this.lastFocusedFilterCursor, this.lastFocusedFilterCursor);
			}
		};
	}

	// Puts the input back in view (the bar scrolls everywhere), whether or not the bar has focus. The
	// bar is still detached here, so the helper waits for it to be laid out — after the clone swap AND
	// after pendingFocusRestore, whose native focus() also scrolls: it's the helper's pass that must
	// have the last word.
	setupChipRowScroll(inner);

	// The result count ("x of y cards match", and the "Fetching legality data"
	// indicator that accompanied it) used to live here, under the search bar;
	// it has moved into the "Cards: …" title at the head of the scroll area
	// (see renderCardsCountTitle further down) — explicitly requested, like
	// the "Lists" title of the galleries.

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
			// mousedown+preventDefault rather than click: prevents the input from
			// losing focus before the selection is taken into account.
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
// Visual composer for the numeric filters (Mana Value/Price/Qty): operator
// buttons (< ≤ = ≥ >) + a number field, so as never to have to type the
// "cmc>3" syntax yourself.

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

	// Dynamic suggestions, drawn from the real collection (cached on the
	// plugin side — see getDistinctArtists/getDistinctSets — so no expensive
	// recomputation on every keystroke).
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
		// includes, not startsWith — reported bug: typing "Alpha" didn't suggest
		// "Limited Edition Alpha" (only "Limited" worked). A set name is naturally
		// searched by any word it contains, not only its first word.
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
	// Cap of 6 kept for most queries (few possible entries, or a prefix that
	// already distinguishes them) — but "legal:" alone (browsing the formats
	// without yet knowing which one to look for) matches at once the 10
	// curated entries at the head of LEGALITY_SEARCH_FORMATS (see that
	// constant, card-search.ts): 6 would have cut off "Legal: Commander"
	// (reported bug). "legal:" is a prefix that no other category can match
	// (see categorizeToken), so "all the matches are of the legality category"
	// unambiguously identifies this precise case, never true for another
	// category. Same reasoning for "border:" alone (9 entries, see
	// BORDER_SEARCH_OPTIONS) — without this same fix, it would be exactly the
	// same bug a second time.
	const cap =
		allMatches.length > 0 &&
		(allMatches.every((s) => s.category === "legality") || allMatches.every((s) => s.category === "border"))
			? 10
			: 6;
	const combined = allMatches.slice(0, cap);

	// Threshold adjustable in the settings (Interface): 0 = counter disabled,
	// -1 = always on (no limit), otherwise the max number of cards of the open
	// list/deck beyond which the counter is no longer displayed (see this same
	// method for the detail of the measurements).
	const threshold = this.plugin.settings.suggestionCountThreshold;
	if (
		baseCards.length === 0 ||
		threshold === 0 ||
		(threshold > 0 && baseCards.length > threshold)
	) {
		return combined;
	}

	// For each suggestion: how many cards would match if it were added to the
	// already validated tokens (without the current draft).
	return combined.map((s) => ({
		...s,
		count: baseCards.filter((c) =>
			cardMatchesTokens(c, [...tokens, s.value], "", recentlyAddedIds, legalitiesByScryfallId)
		).length,
	}));
}
// Called separately (rather than inline in render()): reading then
// clearing this.pendingFocusRestore directly in render() made TypeScript
// narrow to "always null" at that precise spot (the compiler lost track
// between the assignment to null at the very start of the method and the
// reassignment by renderChipFilter, called in the meantime via
// render*Section), making the call judged unreachable at compile time
// whereas it very much is at runtime. This indirection is enough to make
// it re-evaluate the type correctly.

export function runPendingFocusRestore(this: MTGCollectionView) {
	const restore = this.pendingFocusRestore;
	this.pendingFocusRestore = null;
	if (restore) restore();
}
