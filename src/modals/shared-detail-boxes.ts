import { setIcon } from "obsidian";
import { manaPoolPricesSupported } from "../api/manapool";
import type MTGCollectionPlugin from "../plugin";
import { Finish, finishHasFoilLook } from "../core/card-model";
import { formatCardPrice, formatMoney, LEGALITY_FORMATS, PricedCard } from "../core/price";
import { legalityStatusClass } from "../core/card-search";
import { getCardbaseLatestPrice, getCardbaseDayChange } from "../api/cardbase";
import {
	animateCardNav,
	toCardbaseFinish,
	renderPriceHistoryChart,
	renderPriceHistorySourceFooter,
	appendAsOfToSourceFooter,
	renderLoadingDots,
	renderDayChangeBadge,
	renderManaCostIcons,
	renderTextWithManaSymbols,
	renderCardDescriptionFaces,
	openExternalUrl,
	renderLegalityColorLegend,
} from "../ui/card-detail-fx";
import {
	CARD_KINGDOM_LOGO_SVG,
	TCGPLAYER_LOGO_SVG,
	MANA_POOL_LOGO_SVG,
	CARDMARKET_LOGO_SVG,
} from "../ui/brand-assets";
import { setSvgMarkup } from "../ui/svg-markup";

/* -------------------------------------------------------------------------- */
/*  Boîtes communes aux trois fenêtres de détail de carte                     */
/*  (CardDetailModal / DeckCardDetailModal / WantlistCardDetailModal)         */
/* -------------------------------------------------------------------------- */
// Ces blocs étaient copiés à l'identique (aux noms près) dans les trois modales ; les différences réelles
// entre sections (où vit la finition d'une DeckCard, quelle carte « avec prix » donner à formatCardPrice,
// quel format de deck mettre en évidence, que réinitialiser en changeant de carte) sont des paramètres.
// Le reste — structure, classes CSS, ordre des appels réseau, garde « carte périmée » — est ICI, une seule
// fois : une correction dans une boîte vaut pour les trois fenêtres.
//
// La modale garde ses méthodes renderXBox(panel) : ce sont de minces appelants de ces fonctions, qui lui
// épargnent de changer draw().

// Ce dont chaque boîte a besoin de la modale. `currentScryfallId` est une fonction (pas une valeur) car la
// modale réassigne sa carte en naviguant : chaque requête réseau capture l'id de la carte AU LANCEMENT puis le
// compare à celui de la carte actuelle à la résolution, pour ignorer une réponse arrivée après un changement
// de carte (draw() aura déjà reconstruit la boîte pour la nouvelle carte entre-temps).
export interface DetailBoxHost {
	plugin: MTGCollectionPlugin;
	currentScryfallId: () => string;
}

// État de « Legal Formats » conservé par la modale d'un affichage à l'autre : l'id de la dernière carte dont les
// légalités ont déjà été révélées (voir renderLegalFormatsBox).
export interface LegalFormatsState {
	shownFor: string | null;
}

// Ce que « Store Prices » lit de la carte. `finish` est la finition RÉSOLUE (une DeckCard n'en a pas toujours,
// voir getDeckCardFinish) ; `pricedCard` est ce que formatCardPrice sait lire (voir toDeckPricedCard pour un
// DeckCard).
export interface StorePricesCard {
	scryfallId: string;
	name: string;
	finish: Finish;
	pricedCard: PricedCard;
}

// Une tuile du carrousel « Copies in Lists ».
export type CopyTile = {
	kind: "collection" | "deck" | "wantlist";
	sourceName: string;
	imageUrl: string;
	finish: Finish;
	count: number;
	priceText: string;
	wanted?: boolean;
	onClick?: () => void;
};

// Bloc "Card Text" — sous Price History. Le nom n'y est pas répété (déjà
// affiché en haut du panneau, voir navTitle/mtg-card-detail-nav-name) ;
// coût de mana + type viennent directement de la carte, déjà en cache
// (voir CollectionCard.manaCost/typeLine), donc affichés immédiatement, sans
// attendre de fetch. Seuls le texte de règles et Force/Endurance/Loyauté
// nécessitent un aller-retour Scryfall à part (getCardTextInfo, jamais
// stocké sur CollectionCard — voir son propre commentaire dans scryfall.ts).
// Pas de garde Proxy ici contrairement à Store Prices/Price History
// juste au-dessus : un proxy représente toujours une vraie carte, avec
// un vrai texte — seule la notion de prix ne s'y applique pas.
export function renderCardDescriptionBox(
	host: DetailBoxHost,
	panel: HTMLElement,
	card: { scryfallId: string; typeLine: string; manaCost: string }
) {
	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-card-description-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Card text" });

	const header = box.createDiv({ cls: "mtg-card-description-header" });
	header.createDiv({ cls: "mtg-card-description-type", text: card.typeLine });
	if (card.manaCost) {
		const manaCostEl = header.createDiv({ cls: "mtg-card-description-mana-cost" });
		renderManaCostIcons(manaCostEl, card.manaCost, (letter) => host.plugin.getManaSymbolSvg(letter));
	}

	const textEl = box.createDiv({ cls: "mtg-card-description-text" });
	renderLoadingDots(textEl);

	const requestedId = card.scryfallId;
	void host.plugin.getCardTextInfo(requestedId).then((info) => {
		if (host.currentScryfallId() !== requestedId) return;
		textEl.removeClass("mtg-loading-dots");
		if (!info) {
			// Échec confirmé après retentative (voir fetchCardTextInfo) — le
			// coût/type ci-dessus restent affichés, seuls le texte et les
			// stats manquent.
			textEl.setText("—");
			return;
		}
		// Carte à plusieurs faces (split, double-face...) : remplace le
		// header+texte fusionnés ci-dessus (coût/type combinés à la racine
		// Scryfall, ex. "Instant // Instant") par une section par face,
		// voir renderCardDescriptionFaces (card-detail-fx.ts) — demande
		// explicite plutôt qu'un "//" textuel entre les deux portions.
		if (info.faces && info.faces.length > 1) {
			header.remove();
			textEl.remove();
			renderCardDescriptionFaces(box, info.faces, (letter) => host.plugin.getManaSymbolSvg(letter));
			return;
		}
		// oracle_text vide est une réponse réelle (créature vanille sans
		// capacité, ex. Grizzly Bears), pas un échec — pas de "—" trompeur.
		// .empty() d'abord : renderTextWithManaSymbols ajoute des noeuds
		// (createSpan/appendChild), contrairement à .setText() ci-dessus qui
		// remplace tout le contenu existant (les 3 points de chargement) de
		// lui-même.
		textEl.empty();
		renderTextWithManaSymbols(textEl, info.oracleText || "No rules text.", (letter) =>
			host.plugin.getManaSymbolSvg(letter)
		);
		if (info.loyalty !== undefined) {
			box.createDiv({ cls: "mtg-card-description-stats", text: `Loyalty: ${info.loyalty}` });
		} else if (info.power !== undefined || info.toughness !== undefined) {
			box.createDiv({
				cls: "mtg-card-description-stats",
				text: `${info.power ?? "?"}/${info.toughness ?? "?"}`,
			});
		}
	});
}

// Historique de prix (cardbase.dev, voir cardbase.ts/card-detail-fx.ts) —
// sous Store Prices. Card Kingdom + TCGplayer seulement : cardbase ne
// couvre pas Mana Pool. Même exclusion Proxy que renderStorePricesBox
// (une carte Proxy n'a de prix nulle part ailleurs dans ce panneau non
// plus).
export function renderPriceHistoryBox(
	host: DetailBoxHost,
	panel: HTMLElement,
	card: { scryfallId: string; finish: Finish },
	onResolved: () => void
) {
	if (card.finish === "proxy") return;

	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-price-history-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Price history" });
	// Spinner plutôt qu'un "…" statique — voir styles.css .mtg-price-
	// history-loading. renderPriceHistoryChart retire la classe/l'icône
	// elle-même une fois le vrai contenu prêt (container.empty()).
	const body = box.createDiv({ cls: "mtg-price-history-body mtg-price-history-loading" });
	setIcon(body, "loader-2");
	const sourceFooterEl = renderPriceHistorySourceFooter(box);

	const requestedId = card.scryfallId;
	const finish = toCardbaseFinish(card.finish);
	const targetCurrency = host.plugin.settings.priceCurrency;
	void Promise.all([host.plugin.getCardbasePriceHistoryWithNativeCardmarket(requestedId, finish), host.plugin.getUsdEurRate()]).then(
		([history, rate]) => {
			if (host.currentScryfallId() !== requestedId) return;
			renderPriceHistoryChart(body, history, targetCurrency, rate);
			appendAsOfToSourceFooter(sourceFooterEl, history?.asOf);
			// La carte affichée est résolue — préchargement des voisines Cover
			// Flow en arrière-plan, jamais en concurrence avec cette requête-ci
			// (voir schedulePrefetchNeighbors/MTGCollectionPlugin.prefetch-
			// CardbaseNeighbors pour le raisonnement rate-limit complet).
			onResolved();
		}
	);
}

// Légalités récupérées à la demande (jamais persistées, voir
// MTGCollectionPlugin.legalitiesCache) : requestedId capturé au lancement
// de la requête, revérifié à la résolution pour ignorer une réponse
// arrivant après que l'utilisateur a navigué vers une autre carte (draw()
// aura déjà reconstruit ce bloc pour la nouvelle carte entre-temps).
export function renderLegalFormatsBox(
	host: DetailBoxHost,
	panel: HTMLElement,
	card: { scryfallId: string },
	state: LegalFormatsState,
	highlightFormat?: string
) {
	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-legal-formats-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Legal formats" });
	const grid = box.createDiv({ cls: "mtg-legal-formats-grid" });
	// Statique/indépendant des données de la carte — construit une seule
	// fois, peu importe le chemin (cache chaud ou premier fetch) emprunté
	// juste après (voir legalityStatusClass pour le code couleur qu'elle
	// explique).
	renderLegalityColorLegend(box);

	const requestedId = card.scryfallId;
	// Un draw() sur la même carte (changer le finish, sauvegarder le
	// grading…) ne doit pas rejouer la révélation pour une donnée déjà
	// connue. getCardLegalities reste asynchrone même sur un cache hit
	// (une fonction async renvoie toujours une Promise) — passer par elle
	// ici laisserait quand même le navigateur peindre l'état neutre une
	// frame avant que la classe is-legal/is-restricted/is-banned ne soit
	// posée, donc rejouer la transition CSS visuellement.
	// getCachedLegalities lit le cache de façon strictement synchrone
	// pour éviter cet écart.
	if (state.shownFor === requestedId) {
		const cached = host.plugin.getCachedLegalities(requestedId);
		if (cached) {
			LEGALITY_FORMATS.forEach(({ key, label }) => {
				const tile = grid.createDiv({ cls: "mtg-legal-format-tile", text: label });
				if (highlightFormat && key === highlightFormat) tile.addClass("is-deck-format");
				const cls = legalityStatusClass(cached[key]);
				if (cls) tile.addClass(cls);
			});
			return;
		}
	}

	// Première apparition de cette carte dans cette fenêtre : les tuiles
	// sont construites tout de suite (état neutre = "pas légal"), pas
	// après la résolution du fetch — la boîte a donc sa taille définitive
	// dès le premier rendu, et la réponse Scryfall se contente de
	// reteindre les tuiles concernées (vert/orange/rouge selon leur
	// statut réel) plutôt que de faire apparaître/disparaître un bloc
	// entier (évite le saut de mise en page qu'un état "Loading…"
	// provoquait).
	const tiles = new Map<string, HTMLElement>();
	LEGALITY_FORMATS.forEach(({ key, label }) => {
		const tile = grid.createDiv({ cls: "mtg-legal-format-tile", text: label });
		if (highlightFormat && key === highlightFormat) tile.addClass("is-deck-format");
		tiles.set(key, tile);
	});

	void host.plugin.getCardLegalities(requestedId).then((legalities) => {
		if (host.currentScryfallId() !== requestedId || !legalities) return;
		state.shownFor = requestedId;
		grid.addClass("is-revealing");
		window.setTimeout(() => {
			LEGALITY_FORMATS.forEach(({ key }) => {
				const cls = legalityStatusClass(legalities[key]);
				if (cls) tiles.get(key)?.addClass(cls);
			});
			grid.removeClass("is-revealing");
		}, 200);
	});
}

// Prix "magasin" (complète le prix Scryfall) — une colonne par magasin
// (logo + nom + prix), voir card-kingdom.ts/manapool.ts. Une carte Proxy
// n'est pas un objet réellement possédé/échangeable, même exclusion que
// pour la valeur de la collection — pas de bloc du tout.
export function renderStorePricesBox(host: DetailBoxHost, panel: HTMLElement, card: StorePricesCard) {
	if (card.finish === "proxy") return;

	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-store-prices-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Store prices" });
	const cols = box.createDiv({ cls: "mtg-store-price-cols" });

	// Card Kingdom en premier : construite tout de suite avec un état
	// neutre ("…"), pas après la résolution du fetch — même raison que
	// renderLegalFormatsBox au-dessus, la boîte a sa taille quasi
	// définitive dès le premier rendu.
	const ckCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(ckCol.createDiv({ cls: "mtg-store-price-col-logo" }), CARD_KINGDOM_LOGO_SVG);
	ckCol.createDiv({ cls: "mtg-store-price-col-name", text: "Card Kingdom" });
	const ckValueEl = ckCol.createDiv({ cls: "mtg-store-price-col-value" });
	renderLoadingDots(ckValueEl);
	// Toujours Near Mint (voir card-kingdom.ts) — une constante, pas
	// besoin d'attendre la résolution du fetch pour l'afficher (mais
	// vidée dans la branche "pas de prix" ci-dessous si Card Kingdom ne
	// vend pas cette impression).
	const ckDetailEl = ckCol.createDiv({ cls: "mtg-store-price-col-detail", text: "Near Mint" });
	// Variation veille→aujourd'hui (voir getCardbaseDayChange) — vide tant
	// que rien n'est résolu, pas de "…"/spinner dédié (voir renderDay-
	// ChangeBadge, styles.css .mtg-store-price-col-change).
	const ckChangeEl = ckCol.createDiv({ cls: "mtg-store-price-col-change" });

	// TCGplayer en deuxième colonne (demandé explicitement), via le prix
	// déjà chargé sur cette carte par Scryfall (même donnée que la ligne
	// "Price" plus bas dans ce panneau) — pas de second aller-retour
	// réseau nécessaire pour le prix lui-même, contrairement à Card
	// Kingdom/Mana Pool, donc construite tout de suite. Toujours en USD
	// (pas plugin.settings.priceCurrency) : Card Kingdom/Mana Pool
	// n'ont pas d'EUR, comparer les trois dans la même devise a plus de
	// sens qu'utiliser la devise choisie pour le reste du panneau.
	const tcgCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(tcgCol.createDiv({ cls: "mtg-store-price-col-logo" }), TCGPLAYER_LOGO_SVG);
	tcgCol.createDiv({ cls: "mtg-store-price-col-name", text: "TCGplayer" });
	const tcgPrice = formatCardPrice(card.pricedCard, "usd");
	tcgCol.createDiv({ cls: "mtg-store-price-col-value", text: tcgPrice });
	if (tcgPrice !== "—") {
		tcgCol.setAttribute(
			"title",
			"Synced from TCGplayer's market price via Scryfall, refreshed roughly once a day — not live."
		);
		// Pas une condition (NM/LP/etc.) mais une moyenne de marché — voir
		// le commentaire du "title" ci-dessus pour la nuance complète.
		tcgCol.createDiv({ cls: "mtg-store-price-col-detail", text: "Market price" });
		const tcgChangeEl = tcgCol.createDiv({ cls: "mtg-store-price-col-change" });

		// Lien vers la fiche TCGplayer de cette impression, comme la
		// colonne Card Kingdom — récupéré à part (purchase_uris n'est pas
		// inclus dans le prix déjà en cache sur la carte), donc le clic
		// n'est activé qu'une fois résolu plutôt que de retarder
		// l'affichage du prix lui-même, déjà connu de manière synchrone.
		const tcgRequestedId = card.scryfallId;
		void host.plugin.getTcgplayerUrl(tcgRequestedId).then((url) => {
			if (host.currentScryfallId() !== tcgRequestedId || !url) return;
			tcgCol.addEventListener("click", () => openExternalUrl(url));
		});
		// Même historique cardbase que Card Kingdom/Cardmarket ci-dessous
		// (appel dédoublonné, voir leur commentaire) — juste pour la
		// variation veille→aujourd'hui, le prix lui-même reste celui de
		// Scryfall affiché juste au-dessus, déjà connu de manière
		// synchrone.
		void host.plugin.getCardbasePriceHistoryWithNativeCardmarket(tcgRequestedId, toCardbaseFinish(card.finish)).then((history) => {
			if (host.currentScryfallId() !== tcgRequestedId) return;
			renderDayChangeBadge(tcgChangeEl, getCardbaseDayChange(history, "tcgplayer"));
		});
	} else {
		// Scryfall n'a aucun prix pour cette impression/finition — colonne
		// gardée (pas retirée) pour que les trois magasins restent alignés
		// d'une carte à l'autre, juste grisée et non cliquable.
		tcgCol.addClass("is-unavailable");
	}

	// Mana Pool en troisième colonne — même état neutre "…" en attendant
	// le fetch (voir Card Kingdom juste au-dessus).
	const mpCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(mpCol.createDiv({ cls: "mtg-store-price-col-logo" }), MANA_POOL_LOGO_SVG);
	mpCol.createDiv({ cls: "mtg-store-price-col-name", text: "Mana Pool" });
	const mpValueEl = mpCol.createDiv({ cls: "mtg-store-price-col-value" });
	renderLoadingDots(mpValueEl);
	// Contrairement à Card Kingdom/TCGplayer, la condition réelle n'est
	// connue qu'une fois le fetch résolu (voir pickManaPoolPrice) — laissé
	// vide jusque-là plutôt qu'un texte neutre qui devrait être vidé après.
	const mpDetailEl = mpCol.createDiv({ cls: "mtg-store-price-col-detail" });

	// Cardmarket en quatrième colonne — via cardbase.dev (voir cardbase.ts,
	// getCardbasePriceHistoryWithNativeCardmarket), pas Scryfall. Cette
	// colonne partage le même appel/cache que la boîte "Price History"
	// (voir renderPriceHistoryBox) — mais depuis l'ajout du prix "trend"
	// natif Cardmarket, ce partage coûte désormais 2 aller-retours réseau
	// en plus (cardmarket_id, puis le prix natif lui-même) la première
	// fois qu'une carte est ouverte dans la session, pas 0 comme avant :
	// getCardbasePriceHistoryWithNativeCardmarket dédoublonne quand même
	// ces deux étapes en interne, donc un seul appel ici suffit et reste
	// partagé avec la boîte "Price History". Toujours EUR (devise native
	// de Cardmarket, contrairement aux 3 autres colonnes en USD) :
	// contrairement à TCGplayer/Card Kingdom/Mana Pool, convertir vers une
	// devise commune n'aurait pas de sens ici, Cardmarket n'a jamais eu de
	// prix USD à afficher.
	const cmCol = cols.createDiv({ cls: "mtg-store-price-col" });
	setSvgMarkup(cmCol.createDiv({ cls: "mtg-store-price-col-logo" }), CARDMARKET_LOGO_SVG);
	cmCol.createDiv({ cls: "mtg-store-price-col-name", text: "Cardmarket" });
	const cmValueEl = cmCol.createDiv({ cls: "mtg-store-price-col-value" });
	renderLoadingDots(cmValueEl);
	const cmDetailEl = cmCol.createDiv({ cls: "mtg-store-price-col-detail", text: "Market price" });
	// Prix de la listing la moins chère (price_type="low", voir CardbasePrice-
	// History.cardmarketLow) — même classe/traitement visuel que cmDetailEl
	// juste au-dessus (discrète, muette), vide tant que non résolu. Réutilise
	// la classe existante plutôt qu'en créer une nouvelle : c'est exactement
	// le même rôle ("précision secondaire sous le prix"), juste une seconde
	// ligne de ce type au lieu d'une seule.
	const cmLowEl = cmCol.createDiv({ cls: "mtg-store-price-col-detail" });
	const cmChangeEl = cmCol.createDiv({ cls: "mtg-store-price-col-change" });

	const requestedId = card.scryfallId;
	const isFoil = finishHasFoilLook(card.finish);
	const cardbaseFinish = toCardbaseFinish(card.finish);

	// Combinées en un seul Promise.all plutôt que deux .then() indépendants
	// : le prix Card Kingdom vient de card-kingdom.ts (fetch direct), la
	// variation vient de cardbase.ts (historique) — deux sources
	// différentes pour la même colonne. Les résoudre ensemble évite une
	// course où l'une des deux résout en premier et affiche un badge de
	// variation sous un prix pas encore su "indisponible" (ou l'inverse) ;
	// voir Cardmarket plus bas, qui n'a pas ce risque puisque prix ET
	// variation viennent de la même réponse cardbase.
	void Promise.all([
		host.plugin.getCardKingdomPrice(requestedId, isFoil),
		host.plugin.getCardbasePriceHistoryWithNativeCardmarket(requestedId, cardbaseFinish),
	]).then(([entry, history]) => {
		// La carte affichée a changé (navigation prev/next) pendant
		// l'attente — cette réponse ne concerne plus la carte actuelle.
		if (host.currentScryfallId() !== requestedId) return;
		ckValueEl.removeClass("mtg-loading-dots");
		if (!entry) {
			// Card Kingdom ne vend pas cette impression — colonne gardée
			// (voir TCGplayer ci-dessus), pas de "Near Mint" à afficher
			// puisqu'il n'y a aucun prix à qualifier.
			ckValueEl.setText("—");
			ckDetailEl.setText("");
			ckCol.addClass("is-unavailable");
			return;
		}
		ckValueEl.setText(formatMoney(entry.priceRetail, "usd"));
		ckCol.addEventListener("click", () => openExternalUrl(entry.url));
		renderDayChangeBadge(ckChangeEl, getCardbaseDayChange(history, "cardkingdom"));
	});

	void host.plugin.getManaPoolPrice(requestedId, card.finish).then((result) => {
		if (host.currentScryfallId() !== requestedId) return;
		mpValueEl.removeClass("mtg-loading-dots");
		if (!result) {
			mpValueEl.setText("—");
			// Sur téléphone / tablette le tarif n'est pas chargé du tout (trop gros pour la mémoire, voir manaPoolPricesSupported) :
			// dit-le, plutôt que de laisser croire que Mana Pool ne vend pas cette carte.
			if (!manaPoolPricesSupported()) {
				mpDetailEl.setText("Not on mobile");
				mpDetailEl.addClass("is-note");
			}
			mpCol.addClass("is-unavailable");
			return;
		}
		// Prix retombé sur "le plus bas disponible" faute d'exemplaire NM
		// en stock chez Mana Pool — signalé en infobulle plutôt que
		// silencieusement, pour ne pas faire passer un prix "Played" pour
		// du Near Mint (même raisonnement que la précision TCGplayer
		// ci-dessus).
		if (!result.isNearMint) {
			mpCol.setAttribute(
				"title",
				"No Near Mint copy in stock on Mana Pool right now — showing the lowest available condition instead."
			);
		}
		mpValueEl.setText(formatMoney(result.priceCents / 100, "usd"));
		mpDetailEl.setText(result.isNearMint ? "Near Mint" : "Lowest available");
		mpCol.addEventListener("click", () => openExternalUrl(result.url));
	});

	void host.plugin.getCardbasePriceHistoryWithNativeCardmarket(requestedId, cardbaseFinish).then((history) => {
		if (host.currentScryfallId() !== requestedId) return;
		cmValueEl.removeClass("mtg-loading-dots");
		const entry = getCardbaseLatestPrice(history, "cardmarket");
		if (!entry) {
			cmValueEl.setText("—");
			cmDetailEl.setText("");
			cmCol.addClass("is-unavailable");
			return;
		}
		cmValueEl.setText(formatMoney(entry.price, entry.currency.toLowerCase() === "eur" ? "eur" : "usd"));
		renderDayChangeBadge(cmChangeEl, getCardbaseDayChange(history, "cardmarket"));
		if (history?.cardmarketLow) {
			cmLowEl.setText(
				`Low ${formatMoney(
					history.cardmarketLow.price,
					history.cardmarketLow.currency.toLowerCase() === "eur" ? "eur" : "usd"
				)}`
			);
		}
		// Pas de lien produit exact : cardbase ne renvoie aucune URL sur cet
		// endpoint (juste un prix), et deviner un chemin à partir de
		// cardmarket_id échoue en pratique (vérifié en direct — Cardmarket
		// n'a pas de redirection publique par ID, seulement des URLs à base
		// de slug set+carte que cardbase ne fournit pas). Un lien de
		// RECHERCHE par nom, lui, fonctionne de façon fiable et ne pointe
		// jamais au mauvais endroit — la nuance ("cette impression précise"
		// vs "toutes les versions de cette carte") est signalée en infobulle,
		// même principe que les précisions TCGplayer/Mana Pool ci-dessus.
		cmCol.setAttribute(
			"title",
			"Opens a Cardmarket search for this card name — not necessarily this exact printing."
		);
		cmCol.addEventListener("click", () =>
			window.open(
				`https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(card.name)}`,
				"_blank"
			)
		);
	});
}

export function renderCopiesInListsBox(
	panel: HTMLElement,
	active: Omit<CopyTile, "onClick">,
	others: CopyTile[],
	onActiveMeta: (meta: HTMLElement) => void
) {
	const row = panel.createDiv({ cls: "mtg-card-detail-box-row" });
	const box = row.createDiv({ cls: "mtg-card-detail-box mtg-copies-in-lists-box" });
	box.createDiv({ cls: "mtg-card-detail-finish-label", text: "Copies in lists" });

	const carouselRow = box.createDiv({ cls: "mtg-copies-in-lists-carousel-row" });
	const leftArrow = carouselRow.createDiv({ cls: "mtg-copies-in-lists-arrow" });
	setIcon(leftArrow, "chevron-left");
	const track = carouselRow.createDiv({ cls: "mtg-copies-in-lists-track" });
	const rightArrow = carouselRow.createDiv({ cls: "mtg-copies-in-lists-arrow" });
	setIcon(rightArrow, "chevron-right");
	// La carte active occupe toujours la première tuile (voir buildTile
	// plus bas) : une seule "page" (3 tuiles, cf. mtg-copies-in-lists-tile
	// flex-basis) reste possible même sans aucun doublon, d'où le +1.
	const hasOnePage = others.length + 1 <= 3;
	leftArrow.toggleClass("is-disabled", hasOnePage);
	rightArrow.toggleClass("is-disabled", hasOnePage);
	leftArrow.addEventListener("click", () => track.scrollBy({ left: -track.clientWidth, behavior: "smooth" }));
	rightArrow.addEventListener("click", () => track.scrollBy({ left: track.clientWidth, behavior: "smooth" }));

	// Petite icône devant le nom (layers/swords/heart — les mêmes que la
	// barre latérale gauche, voir makeNavItem dans view.ts, et le même
	// mapping déjà utilisé par le badge de contexte du panneau "Add
	// history", add-cards-modal.ts) : indique de quelle section vient
	// chaque tuile, y compris la tuile active (cohérence visuelle).
	const buildTile = (tile: Omit<CopyTile, "onClick">, isActive: boolean, onClick?: () => void) => {
		const tileEl = track.createDiv({ cls: "mtg-copies-in-lists-tile" });
		tileEl.toggleClass("is-active", isActive);
		const imgWrap = tileEl.createDiv({ cls: "mtg-copies-in-lists-tile-image-wrap" });
		if (tile.imageUrl) {
			imgWrap.createEl("img", {
				cls: "mtg-copies-in-lists-tile-image",
				attr: { src: tile.imageUrl, loading: "lazy" },
			});
			if (finishHasFoilLook(tile.finish)) {
				imgWrap.createDiv({ cls: "mtg-foil-overlay" });
			}
		} else {
			imgWrap.createDiv({ cls: "mtg-copies-in-lists-tile-image mtg-no-image" });
		}
		if (tile.wanted) {
			imgWrap.createDiv({ cls: "mtg-thumb-wanted-ribbon", text: "Wanted" });
		}
		const info = tileEl.createDiv({ cls: "mtg-copies-in-lists-tile-info" });
		const meta = info.createDiv({
			cls: "mtg-copies-in-lists-tile-meta",
			text: `${tile.count}x · ${tile.priceText}`,
		});
		if (isActive) {
			onActiveMeta(meta);
		}
		const sourceRow = info.createDiv({ cls: "mtg-copies-in-lists-tile-source" });
		setIcon(
			sourceRow.createSpan({ cls: "mtg-copies-in-lists-tile-source-icon" }),
			tile.kind === "collection" ? "layers" : tile.kind === "deck" ? "swords" : "heart"
		);
		sourceRow.createSpan({ cls: "mtg-copies-in-lists-tile-list", text: tile.sourceName });
		if (!isActive && onClick) {
			tileEl.addEventListener("click", onClick);
		}
	};

	buildTile(active, true);
	others.forEach((other) => buildTile(other, false, other.onClick));
}

// Nom de la carte centré au-dessus des deux colonnes, flanqué de flèches précédent/suivant qui parcourent
// `cards` (la liste filtrée/triée telle qu'elle était affichée à l'ouverture de la fenêtre), avec le repère
// « Card X of Y » en dessous. goTo(carte) est appelé AU MILIEU de l'animation Cover Flow (voir
// animateCardNav) : la modale y change de carte, réinitialise son état propre (finition retournée, split
// pivoté, grading déplié…) puis redessine toute la fenêtre via draw().
export function renderCardNavHeader<T>(
	contentEl: HTMLElement,
	nav: {
	cards: T[];
	// Position de la carte affichée dans `cards`, ou -1 si elle n'y figure pas (navigation alors masquée).
	currentIndex: number;
	name: string;
	// Verrou de la modale : une navigation en cours (animation) ignore tout nouveau clic.
	isAnimating: () => boolean;
	setAnimating: (animating: boolean) => void;
	goTo: (card: T) => void;
	}
) {
	const { cards, currentIndex, name, isAnimating, setAnimating, goTo } = nav;
	const navHeader = contentEl.createDiv({ cls: "mtg-card-detail-nav-header" });
	const canNavigate = cards.length > 1 && currentIndex !== -1;

	// Les deux flèches sont toujours créées (même quand la navigation est impossible, auquel cas elles sont
	// simplement masquées via is-hidden) pour que la grille à 3 colonnes garde des largeurs de colonnes
	// latérales fixes — sinon le titre central se recale et la flèche restante changerait de position selon
	// la longueur du nom.
	const addArrow = (direction: "prev" | "next") => {
		const step = direction === "prev" ? -1 : 1;
		const arrow = navHeader.createDiv({ cls: "mtg-tile-menu-btn mtg-tile-menu-btn-large" });
		setIcon(arrow, direction === "prev" ? "chevron-left" : "chevron-right");
		arrow.setAttribute("title", direction === "prev" ? "Previous card" : "Next card");
		if (!canNavigate) {
			arrow.addClass("is-hidden");
		} else if (direction === "prev" ? currentIndex === 0 : currentIndex === cards.length - 1) {
			arrow.addClass("is-disabled");
		} else {
			arrow.addEventListener("click", () => {
				if (isAnimating()) return;
				setAnimating(true);
				animateCardNav(
					contentEl,
					direction,
					() => goTo(cards[currentIndex + step]),
					() => {
						setAnimating(false);
					}
				);
			});
		}
	};

	addArrow("prev");
	const navTitle = navHeader.createDiv({ cls: "mtg-card-detail-nav-title" });
	navTitle.createDiv({ cls: "mtg-card-detail-nav-name", text: name });
	if (currentIndex !== -1) {
		navTitle.createDiv({
			cls: "mtg-card-detail-nav-count",
			text: `Card ${currentIndex + 1} of ${cards.length}`,
		});
	}
	addArrow("next");
}
