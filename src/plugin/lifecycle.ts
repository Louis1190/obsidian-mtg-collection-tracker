import { WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VIEW_TYPE_MTG_COLLECTION,
} from "../core/data-model";
import type MTGCollectionPlugin from "../plugin";

/* -------------------------------------------------------------------------- */
/*  Plugin lifecycle: activateView, settings load/save, backup/restore.
    Split out of plugin.ts on 2026-09-10 (onload/onunload themselves stay in
    plugin.ts as the literal Obsidian entry point).  */
/* -------------------------------------------------------------------------- */

export const SAVE_DEBOUNCE_MS = 400;
export async function activateView(this: MTGCollectionPlugin) {
	const { workspace } = this.app;
	let leaf: WorkspaceLeaf | null = null;
	const existing = workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION);

	// Un onglet déjà existant peut s'être retrouvé dans une barre
	// latérale (gauche/droite) au lieu de l'espace de travail principal
	// — observé sur iOS/Android : la vue apparaissait coincée dans le
	// tiroir latéral droit (un WorkspaceMobileDrawer sur mobile),
	// limitée à ~50% de la largeur de l'écran, alors que sur desktop
	// c'est un onglet plein écran normal. getLeaf("tab") garantit bien
	// un nouvel onglet "within the root split" (doc Obsidian ci-dessous),
	// mais ça ne s'applique qu'à la CRÉATION — un onglet déjà existant,
	// retrouvé via getLeavesOfType, était simplement révélé là où il se
	// trouvait déjà, même une fois égaré dans rightSplit/leftSplit (une
	// restauration de session mobile imparfaite, ou un déplacement
	// accidentel). On vérifie donc sa racine et on le recrée dans
	// l'espace principal si nécessaire, plutôt que de le révéler tel quel.
	if (existing.length > 0 && existing[0].getRoot() === workspace.rootSplit) {
		leaf = existing[0];
	} else {
		if (existing.length > 0) existing[0].detach();
		// Onglet dans l'espace de travail principal plutôt que dans la
		// barre latérale : la grille a besoin de largeur pour bien s'afficher.
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_MTG_COLLECTION, active: true });
	}

	if (leaf) void workspace.revealLeaf(leaf);
}


export async function loadSettings(this: MTGCollectionPlugin) {
	// Lecture via settings-sync.ts (et non loadData()) : il faut le texte brut du
	// fichier et sa signature pour pouvoir fusionner plus tard avec une version
	// venue d'un autre appareil au lieu de l'écraser.
	this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.readSettingsFromDisk());
	// Tri, mode de vue, menu replié… : propres à cet appareil, jamais synchronisés (core/device-settings.ts).
	this.loadDeviceLocalSettings();
	await this.runSettingsMigrations();
	this.markSettingsLoaded();
}

// Les 3 rattrapages qui interrogent Scryfall (migrateEnrich*/migrateArtCropUrls)
// tournent DANS onload() : fetchScryfallCollection ne rattrape pas les erreurs de
// transport (throw:false ne couvre que les statuts HTTP), donc hors-ligne, derrière
// un pare-feu à inspection TLS (SSLHandshakeException constaté sur l'émulateur
// Android) ou sur un portail captif, l'exception remontait jusqu'à onload() et le
// plugin entier échouait à se charger ("Plugin failure") — alors qu'une seule carte
// sans artiste suffit à déclencher la requête à CHAQUE démarrage. Ces données ne sont
// qu'un enrichissement : on avale la panne, et le prédicat "manquant" de chaque
// rattrapage étant toujours vrai, il réessaiera tout seul au prochain démarrage.
async function tolerateNetworkFailure(label: string, run: () => Promise<void>) {
	try {
		await run();
	} catch (e) {
		console.warn(`MTG Collection Tracker: startup catch-up "${label}" skipped (network unavailable?), will retry at the next start.`, e);
	}
}

// Extrait de loadSettings() pour être réutilisé aussi par restoreBackup()
// ci-dessous : un fichier de sauvegarde peut provenir d'une version plus
// ancienne du plugin (structure de données différente), donc restaurer
// doit repasser par la même chaîne de migrations qu'un chargement normal
// au démarrage plutôt que de faire confiance aveuglément au fichier.

export async function runSettingsMigrations(this: MTGCollectionPlugin) {
	this.ensureInboxList();
	this.migrateFoilSplit();
	this.migrateFoilToFinish();
	this.migrateDamagedCondition();
	this.migrateDeckCommanderCategory();
	this.migrateCollectionToLists();
	this.migrateListDateCreated();
	this.migrateDeckDateCreated();
	await tolerateNetworkFailure("métadonnées de la collection", () => this.migrateEnrichMetadata());
	await tolerateNetworkFailure("art crop de la collection", () => this.migrateArtCropUrls());
	this.migrateDeckCardDefaults();
	await tolerateNetworkFailure("métadonnées des decks", () => this.migrateEnrichDeckMetadata());
}

// Les listes créées avant l'introduction du tri "par date de création"
// n'ont pas ce champ. On le complète en utilisant leur ordre actuel dans
// le tableau comme repère (les tableaux JS préservent l'ordre d'insertion
// tant qu'ils ne sont pas explicitement réordonnés) : la première de la
// liste reçoit l'horodatage le plus ancien, la dernière le plus récent.

export async function saveSettings(this: MTGCollectionPlugin) {
	this.dataVersion++;
	// Le cache est invalidé immédiatement (recalcul paresseux au prochain
	// accès, pas ici) : simple et sûr, et le recalcul lui-même reste
	// rapide même sur une grosse collection (voir getDistinctArtists).
	// L'état en mémoire (this.settings) est déjà à jour à cet instant —
	// seule l'écriture sur disque est différée, donc tout ce qui lit
	// this.settings ailleurs (render(), etc.) voit la mutation tout de
	// suite malgré le debounce.
	this.cachedArtists = null;
	this.cachedSets = null;
	// Les réglages d'affichage vont dans le stockage de l'appareil, pas dans data.json.
	this.saveDeviceLocalSettings();
	// Et ce qui a changé doit aussi partir vers GitHub, s'il est activé.
	this.markGithubDirty();
	if (this.pendingSaveTimer !== null) window.clearTimeout(this.pendingSaveTimer);
	this.pendingSaveTimer = window.setTimeout(() => {
		this.pendingSaveTimer = null;
		void this.persistSettings();
	}, SAVE_DEBOUNCE_MS);
}

// Écrit immédiatement toute sauvegarde en attente — utilisé à la
// désactivation du plugin pour ne jamais perdre les dernières
// modifications restées dans le délai de regroupement.

export async function flushPendingSave(this: MTGCollectionPlugin) {
	if (this.pendingSaveTimer === null) return;
	window.clearTimeout(this.pendingSaveTimer);
	this.pendingSaveTimer = null;
	await this.persistSettings();
}

// Liste dédupliquée et triée des artistes présents en collection, mise en
// cache : même à 100 000 cartes, le nombre d'artistes DISTINCTS reste de
// l'ordre de quelques milliers (l'historique de Magic entier n'en compte
// qu'environ 2000-3000), donc chercher un préfixe dedans reste instantané.

export function getDistinctArtists(this: MTGCollectionPlugin): string[] {
	if (this.cachedArtists) return this.cachedArtists;
	const set = new Set<string>();
	this.settings.collection.forEach((c) => {
		if (c.artist) set.add(c.artist);
	});
	this.cachedArtists = Array.from(set).sort();
	return this.cachedArtists;
}

// Éditions distinctes présentes en collection, code + nom (le code sert au
// filtre lui-même et à retrouver le symbole officiel ; le nom reste ce qui
// s'affiche et se tape).

export function getDistinctSets(this: MTGCollectionPlugin): { code: string; name: string }[] {
	if (this.cachedSets) return this.cachedSets;
	const map = new Map<string, string>();
	this.settings.collection.forEach((c) => {
		if (c.setCode && c.setName && !map.has(c.setCode)) map.set(c.setCode, c.setName);
	});
	this.cachedSets = Array.from(map, ([code, name]) => ({ code, name })).sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	return this.cachedSets;
}

// Anciennes versions stockaient un compteur "foilCount" sur la même ligne
// que la version normale. On sépare ça en lignes distinctes (une carte foil
// est maintenant une entrée à part entière), et on attribue à chaque ligne
// un identifiant propre (id) désormais utilisé comme clé pour les actions.
