import { App, Modal } from "obsidian";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";

/* -------------------------------------------------------------------------- */
/*  Search syntax help modal                                                  */
/* -------------------------------------------------------------------------- */

export class SearchSyntaxModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-syntax-modal");
		contentEl.createEl("h2", { text: "Search syntax" });
		contentEl.createEl("p", {
			cls: "mtg-status",
			text: "Type a word and press space (or pick a suggestion) to turn it into a chip. Most of this is auto-detected — you rarely need to remember any of it.",
		});

		const section = (title: string, body: (el: HTMLElement) => void) => {
			contentEl.createEl("h3", { text: title });
			const el = contentEl.createDiv({ cls: "mtg-syntax-section" });
			body(el);
		};

		const example = (el: HTMLElement, code: string, desc: string) => {
			const row = el.createDiv({ cls: "mtg-syntax-example" });
			row.createEl("code", { text: code });
			row.createSpan({ text: desc });
		};

		section("Free text", (el) => {
			el.createEl("p", { text: "Matches card name, type line, set name, and artist." });
			example(el, "lightning bolt", "cards whose name/type/set/artist contains this text");
		});

		section("Facets (color, rarity, type…)", (el) => {
			el.createEl("p", {
				text: "Type the start of a value and pick it from the suggestions, or type it in full: color (white/blue/black/red/green, multicolor, colorless), rarity (common/uncommon/rare/mythic), language, condition (mint/near mint/excellent/good/light played/played/poor, or mt/nm/ex/gd/lp/pl/po), foil/nonfoil/etched/surge foil/proxy, card type (land/creature/instant/sorcery…, legendary/basic/snow/world), and keyword abilities (flying, trample, haste, deathtouch…).",
			});
			example(el, "blue rare flying", "blue and rare and has flying");
		});

		section("Artist, Set, and collector number", (el) => {
			el.createEl("p", {
				text: "Start typing an artist or set name — matching suggestions (with the set's icon) are pulled live from your own collection. Unlike free text, artist and set must be picked from the suggestion list (names can contain spaces), but then behave just like any other facet, including “or” between two artists or two sets. Type \"#\" followed by digits for an exact collector number.",
			});
			example(el, "artist:Seb McKinnon", "cards illustrated by that artist");
			example(el, "set:Kaladesh set:Amonkhet", "cards from either set");
			example(el, "#235", "collector number 235");
		});

		section("Format legality", (el) => {
			el.createEl("p", {
				text: 'Type "legal:" followed by a format name — Standard, Pioneer, Modern, Legacy, Vintage, Commander, Pauper, Brawl, and every other format Scryfall tracks. Legality isn\'t stored on your cards up front, so the first time you use it in a given list it fetches in the background (a brief "Fetching legality data…" note appears next to the match count while it does).',
			});
			example(el, "legal:modern", "cards legal in Modern");
			example(el, "legal:commander legal:pauper", "legal in Commander OR Pauper");
			el.createEl("p", {
				text: '"banned:" and "restricted:" work the same way, for cards banned or restricted in a given format instead of legal there.',
			});
			example(el, "banned:legacy", "cards banned in Legacy");
			example(el, "restricted:vintage", "cards restricted in Vintage");
		});

		section("Card border and frame", (el) => {
			el.createEl("p", {
				text: 'Type "border:" followed by a value — Borderless, Extended art, Showcase, Retro frame, or a border color (Black, White, Silver, Gold, Yellow). Unlike format legality, this is stored directly on the card the moment it\'s first fetched, so there\'s no loading delay to wait on.',
			});
			example(el, "border:showcase", "showcase-frame cards");
			example(el, "border:extended border:borderless", "extended art OR borderless");
		});

		section("Card text", (el) => {
			el.createEl("p", {
				text: 'Type "oracle:" followed by a phrase to search a card\'s rules text — stored directly on the card the moment it\'s first fetched, so no loading delay. Quotes are only needed around a phrase with a space in it (otherwise the space would end the chip early); a single word like "instant" works with or without them. Mana symbols appear as "{X}"/"{C}" in the raw text, so search for "{c}" rather than the word "mana" to match them. Two "oracle:" chips combine with “and” (both phrases must appear), unlike other facets.',
			});
			example(el, 'oracle:"draw a card"', "cards whose text mentions drawing a card");
			example(el, 'oracle:"draw a card" oracle:instant', "both phrases present (quotes optional on a single word)");
		});

		section("Combining rules", (el) => {
			el.createEl("p", {
				text: "Two words in the same facet combine with “or”. Words in different facets combine with “and”.",
			});
			example(el, "blue green", "blue or green cards");
			example(el, "rare blue", "rare and blue cards");
		});

		section("Excluding (negation)", (el) => {
			el.createEl("p", {
				text: "Click the 🚫 icon on a chip (or on a suggestion) to exclude instead of include. Typing a leading \"-\" does the same thing.",
			});
			example(el, "-red", "excludes red cards");
		});

		section("Exact color identity (only)", (el) => {
			el.createEl("p", {
				text: 'A plain color chip matches any card containing that color, including a multicolor card. Click the = icon on a color chip (only shown for color chips) to switch it to an exact match instead — the card\'s colors must be exactly this, no more, no less. Typing a leading "=" does the same thing. Mark several colors "=" at once to require an exact multicolor identity.',
			});
			example(el, "=blue", "mono-blue cards only");
			example(el, "=blue =white", "exactly blue-white (Azorius), nothing else");
		});

		section("Numeric filters (mana value, price, quantity, date added)", (el) => {
			el.createEl("p", {
				text: "Type \"cmc\", \"price\", \"qty\", or \"added\" to open the operator builder — pick <, ≤, =, ≥, or > and a value, no syntax to remember. Two constraints on the same field form a range.",
			});
			example(el, "cmc>=2  cmc<=6", "mana value between 2 and 6");
			example(el, "price<5", "price under $5");
			example(el, "qty>=2", "at least 2 copies");
			example(el, "added>=2026-07-01", "added on or after July 1st, 2026");
			el.createEl("p", {
				text: "\"added\" opens a real date picker, plus quick presets: Today, This week, This month.",
			});
		});

		section("Editions and printings", (el) => {
			el.createEl("p", {
				text: "Click a card's set name or number to open the printing picker and switch it to a different edition.",
			});
		});
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* -------------------------------------------------------------------------- */
/*  Add-card search syntax help modal (distinct from SearchSyntaxModal:      */
/*  different facets apply here — no condition/qty/added, but set:/#num do)  */
/* -------------------------------------------------------------------------- */

export class AddCardSearchSyntaxModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		const { contentEl } = this;
		contentEl.addClass("mtg-syntax-modal");
		contentEl.createEl("h2", { text: "Search syntax" });
		contentEl.createEl("p", {
			cls: "mtg-status",
			text: "Type a word and press space (or pick a suggestion) to turn it into a chip. This searches Scryfall's full card database, not your collection — most of it is auto-detected.",
		});

		const section = (title: string, body: (el: HTMLElement) => void) => {
			contentEl.createEl("h3", { text: title });
			const el = contentEl.createDiv({ cls: "mtg-syntax-section" });
			body(el);
		};

		const example = (el: HTMLElement, code: string, desc: string) => {
			const row = el.createDiv({ cls: "mtg-syntax-example" });
			row.createEl("code", { text: code });
			row.createSpan({ text: desc });
		};

		section("Free text", (el) => {
			el.createEl("p", { text: "Matches card name." });
			example(el, "lightning bolt", "cards whose name contains this text");
		});

		section("Facets (color, rarity, type…)", (el) => {
			el.createEl("p", {
				text: "Type the start of a value and pick it from the suggestions, or type it in full: color (white/blue/black/red/green, multicolor, colorless), rarity (common/uncommon/rare/mythic), language, foil/nonfoil/etched/surge foil/proxy, card type (land/creature/instant/sorcery…, legendary/basic/snow/world), and keyword abilities (flying, trample, haste, deathtouch…).",
			});
			example(el, "blue rare flying", "blue and rare and has flying");
		});

		section("Set and collector number", (el) => {
			el.createEl("p", {
				text: 'Start typing a set name — matching suggestions (with icon) are pulled from the full list of Magic sets. Type "#" followed by digits for an exact collector number. Combining both jumps straight to that exact printing.',
			});
			example(el, "set:Kaladesh", "cards from that set");
			example(el, "set:Kaladesh #235", "that exact printing");
		});

		section("Format legality", (el) => {
			el.createEl("p", {
				text: 'Type "legal:" followed by a format name — Standard, Pioneer, Modern, Legacy, Vintage, Commander, Pauper, Brawl, and every other format Scryfall tracks. "banned:" and "restricted:" work the same way, for cards banned or restricted in a given format instead.',
			});
			example(el, "legal:modern", "cards legal in Modern");
			example(el, "banned:legacy", "cards banned in Legacy");
			example(el, "restricted:vintage", "cards restricted in Vintage");
		});

		section("Card border and frame", (el) => {
			el.createEl("p", {
				text: 'Type "border:" followed by a value — Borderless, Extended art, Showcase, Retro frame, or a border color (Black, White, Silver, Gold, Yellow) — translated directly to Scryfall\'s own search.',
			});
			example(el, "border:showcase", "showcase-frame cards");
		});

		section("Card text", (el) => {
			el.createEl("p", {
				text: 'Type "oracle:" followed by a phrase to search a card\'s rules text — translated directly to Scryfall\'s own oracle: search. Quotes are only needed around a phrase with a space in it; a single word like "instant" works with or without them. Two "oracle:" chips combine with “and” (both phrases must appear), unlike other facets.',
			});
			example(el, 'oracle:"draw a card"', "cards whose text mentions drawing a card");
		});

		section("Combining rules", (el) => {
			el.createEl("p", {
				text: "Two words in the same facet combine with “or”. Words in different facets combine with “and”.",
			});
			example(el, "blue green", "blue or green cards");
			example(el, "rare blue", "rare and blue cards");
		});

		section("Excluding (negation)", (el) => {
			el.createEl("p", {
				text: "Click the 🚫 icon on a chip to exclude instead of include. Typing a leading \"-\" does the same thing.",
			});
			example(el, "-red", "excludes red cards");
		});

		section("Exact color identity (only)", (el) => {
			el.createEl("p", {
				text: 'A plain color chip matches any card containing that color, including a multicolor card. Click the = icon on a color chip (only shown for color chips) to switch it to an exact match instead — translated to Scryfall\'s own exact color identity search. Typing a leading "=" does the same thing. Mark several colors "=" at once to require an exact multicolor identity.',
			});
			example(el, "=blue", "mono-blue cards only");
			example(el, "=blue =white", "exactly blue-white (Azorius), nothing else");
		});

		section("Numeric filters (mana value, price)", (el) => {
			el.createEl("p", {
				text: 'Type "cmc" or "price" to open the operator builder — pick <, ≤, =, ≥, or > and a value, no syntax to remember. Two constraints on the same field form a range.',
			});
			example(el, "cmc>=2  cmc<=6", "mana value between 2 and 6");
			example(el, "price<5", "price under $5");
		});
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
