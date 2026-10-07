import { requestUrlOrNull } from "./safe-request";
import { JsonArrayRowStream } from "../core/json-array-stream";

/* -------------------------------------------------------------------------- */
/*  Card Kingdom pricelist — complète Scryfall avec un vrai prix "magasin"    */
/* -------------------------------------------------------------------------- */

// Endpoint public confirmé (curl direct) : pas de clé, pas de compte, JSON
// complet (~67 Mo, tout le catalogue Card Kingdom en un seul fichier) sous
// {"meta":{"base_url":...},"data":[{scryfall_id, is_foil, price_retail,
// url, ...}]}. Contrairement à /cards/collection chez Scryfall (75 cartes
// par requête), il n'y a pas de version "par carte" — un seul aller-retour
// pour tout le catalogue, indexé une fois en mémoire (voir
// fetchCardKingdomPricelist) plutôt que re-parcouru à chaque carte affichée.
const CARD_KINGDOM_PRICELIST_URL = "https://api.cardkingdom.com/api/v2/pricelist";

const CARD_KINGDOM_HEADERS = {
	// Même identifiant + contact que SCRYFALL_HEADERS (scryfall.ts) — cohérence
	// entre toutes les APIs de ce plugin, pas une exigence propre à Card Kingdom.
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json",
};

export interface CardKingdomPriceEntry {
	priceRetail: number;
	url: string;
}

interface CardKingdomRawEntry {
	scryfall_id?: string;
	is_foil?: string;
	price_retail?: string;
	url?: string;
}

// Clé composite scryfall_id+foil : Card Kingdom donne une ligne séparée par
// finition (comme Scryfall lui-même sépare usd/usd_foil), donc une carte non-
// foil et sa version foil ont deux prix distincts à retrouver indépendamment.
export function cardKingdomKey(scryfallId: string, isFoil: boolean): string {
	return `${scryfallId}:${isFoil ? "foil" : "nonfoil"}`;
}

// Un seul aller-retour pour tout le catalogue, indexé en Map pour une
// recherche en O(1) par carte ensuite — voir plugin.ts getCardKingdomPrices
// pour le cache par session (jamais persisté, comme allSetsCache/
// symbologyCache/legalitiesCache : un objet volumineux, en lecture seule,
// vite périmé, n'a rien à faire dans le blob JSON des réglages).
export async function fetchCardKingdomPricelist(options: { stream?: boolean } = {}): Promise<Map<string, CardKingdomPriceEntry>> {
	return options.stream ? fetchPricelistStreamed() : fetchPricelistWhole();
}

const DEFAULT_BASE_URL = "https://www.cardkingdom.com/";

// Une ligne du tarif -> une entrée de la Map (ou rien). Partagée par les deux façons de lire le tarif, pour qu'elles retiennent
// exactement les mêmes lignes.
function addRow(map: Map<string, CardKingdomPriceEntry>, baseUrl: string, row: CardKingdomRawEntry): void {
	if (!row.scryfall_id || !row.url) return;
	const price = Number(row.price_retail);
	// Un prix à 0 (ou absent/invalide) n'est pas un vrai prix de marché à
	// afficher — Scryfall lui-même ne montre jamais "$0.00" pour une carte
	// sans donnée de prix, même traitement ici.
	if (!Number.isFinite(price) || price <= 0) return;

	const key = cardKingdomKey(row.scryfall_id, row.is_foil === "true");
	// Plusieurs lignes peuvent partager le même scryfall_id+finition
	// (variantes/SKUs différents chez Card Kingdom pour la même
	// impression) — on garde la première rencontrée plutôt que de
	// résoudre ces doublons, hors scope pour un simple prix de vente.
	if (map.has(key)) return;

	map.set(key, {
		priceRetail: price,
		url: `${baseUrl.replace(/\/$/, "")}/${row.url.replace(/^\//, "")}`,
	});
}

// Ordinateur : toute la réponse d'un coup par requestUrl (65 Mo décompressés, sans souci de mémoire sur un ordinateur).
async function fetchPricelistWhole(): Promise<Map<string, CardKingdomPriceEntry>> {
	const map = new Map<string, CardKingdomPriceEntry>();
	const res = await requestUrlOrNull({
		url: CARD_KINGDOM_PRICELIST_URL,
		headers: CARD_KINGDOM_HEADERS,
	});
	if (!res || res.status !== 200) return map;

	const baseUrl: string = res.json?.meta?.base_url ?? DEFAULT_BASE_URL;
	const rows = (res.json?.data as CardKingdomRawEntry[] | undefined) ?? [];
	for (const row of rows) addRow(map, baseUrl, row);
	return map;
}

// Téléphone / tablette : EN FLUX. requestUrl y encode toute la réponse en base64 avant de la rendre (65 Mo -> 86 Mo de texte, soit une
// allocation de ~90 Mo) et l'application Obsidian plante (OutOfMemoryError, vu dans l'émulateur Android ; sur iOS le système tue
// l'application pour la même raison de mémoire) à l'ouverture de la fiche d'une carte. fetch() lit la réponse morceau par morceau
// (≤ 1 Mo chacun) et JsonArrayRowStream n'en garde que la ligne en cours : la mémoire reste bornée, seule la Map finale (~40 Mo de
// petites entrées) est conservée. L'api Card Kingdom répond avec `access-control-allow-origin: *`, ce que fetch exige ; Mana Pool, lui,
// ne l'envoie pas (voir manapool.ts, manaPoolPricesSupported). En-têtes : un navigateur interdit de fixer User-Agent, seul Accept passe.
// Mesuré dans l'application Android réelle (émulateur) : 67,8 Mo lus en 665 morceaux, 4,6 s, tas JavaScript 48 Mo, sans plantage.
// Toute erreur (réseau coupé à mi-réponse comprise) rend une Map vide, jamais une Map partielle : un tarif incomplet serait gardé pour
// la session (une Map non vide est mise en cache) et ferait croire à tort que des cartes n'ont pas de prix.
async function fetchPricelistStreamed(): Promise<Map<string, CardKingdomPriceEntry>> {
	const map = new Map<string, CardKingdomPriceEntry>();
	try {
		// fetch et non requestUrl, volontairement : requestUrl ne sait pas lire en flux (il rend toute la réponse, encodée en base64 sur mobile,
		// donc le plantage décrit ci-dessus). Le linter d'Obsidian recommande requestUrl (no-restricted-globals, un avertissement) et interdit
		// de le désactiver : cet avertissement-ci est connu et assumé, voir docs/obsidian-compliance.md.
		const res = await fetch(CARD_KINGDOM_PRICELIST_URL, { headers: { Accept: "application/json" } });
		if (!res.ok || !res.body) return map;

		let baseUrl: string | null = null;
		const stream = new JsonArrayRowStream("data", (rowJson) => {
			if (baseUrl === null) baseUrl = baseUrlFromPrefix(stream.prefix);
			addRow(map, baseUrl, JSON.parse(rowJson) as CardKingdomRawEntry);
		});
		const reader = res.body.getReader();
		const decoder = new TextDecoder("utf-8");
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			stream.push(decoder.decode(value, { stream: true }));
		}
		stream.push(decoder.decode());
		return stream.failed ? new Map() : map;
	} catch {
		return new Map();
	}
}

// {"meta":{"created_at":"…","base_url":"https:\/\/www.cardkingdom.com\/"}, — le texte qui précède le tableau « data ».
function baseUrlFromPrefix(prefix: string): string {
	const match = /"base_url"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(prefix);
	if (!match) return DEFAULT_BASE_URL;
	try {
		const value: unknown = JSON.parse(match[1]);
		return typeof value === "string" && value ? value : DEFAULT_BASE_URL;
	} catch {
		return DEFAULT_BASE_URL;
	}
}
