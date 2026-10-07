import { ZipEntry, buildZip } from "../core/zip";
import { saveExportedFile } from "../ui/file-export";
import type { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/*  Téléchargement de fichiers texte et ZIP (via saveExportedFile, voir ui/file-export.ts).*/
/* ---------------------------------------------------------------------------- */

// Petit utilitaire d'export texte partagé par tous les exports CSV/TXT de
// My Collection/My Decks/My Wantlists — type MIME optionnel (text/plain par
// défaut, le seul cas d'usage historique de cette fonction avant qu'elle
// absorbe aussi les exports CSV). Le mécanisme réel (téléchargement
// navigateur sur desktop, écriture dans la vault + feuille de partage native
// sur mobile) vit dans ui/file-export.ts — ne jamais recréer ici un
// <a download> à la main : il est silencieusement inopérant sur iOS/Android.

export function downloadTextFile(this: MTGCollectionView, text: string, filename: string, mimeType = "text/plain") {
	void saveExportedFile(this.app, text, filename, mimeType);
}

export function downloadZip(this: MTGCollectionView, entries: ZipEntry[], filename: string) {
	const zip = buildZip(entries);
	// zip.buffer typée ArrayBufferLike par ce lib TS (pourrait en théorie
	// être un SharedArrayBuffer) — jamais le cas ici, buildZip alloue
	// toujours un ArrayBuffer neuf dédié via `new Uint8Array(taille)`.
	// slice() borné à la vue plutôt que zip.buffer brut : sur mobile ces
	// octets sont écrits tels quels dans la vault (ui/file-export.ts), donc
	// un buffer plus grand que la vue y produirait un .zip corrompu.
	const buffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
	void saveExportedFile(this.app, buffer, filename, "application/zip");
}
