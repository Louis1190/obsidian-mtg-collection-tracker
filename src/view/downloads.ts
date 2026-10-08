import { ZipEntry, buildZip } from "../core/zip";
import { saveExportedFile } from "../ui/file-export";
import type { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/* Download of text and ZIP files (via saveExportedFile, see ui/file-export.ts). */
/* ---------------------------------------------------------------------------- */

// Small text export utility shared by all the CSV/TXT exports of My
// Collection/My Decks/My Wantlists — optional MIME type (text/plain by
// default, the only historical use case of this function before it also
// absorbed the CSV exports). The actual mechanism (browser download on
// desktop, write into the vault + native share sheet on mobile) lives in
// ui/file-export.ts — never recreate an <a download> by hand here: it is
// silently inoperative on iOS/Android.

export function downloadTextFile(this: MTGCollectionView, text: string, filename: string, mimeType = "text/plain") {
	void saveExportedFile(this.app, text, filename, mimeType);
}

export function downloadZip(this: MTGCollectionView, entries: ZipEntry[], filename: string) {
	const zip = buildZip(entries);
	// zip.buffer is typed ArrayBufferLike by this TS lib (could in theory be a
	// SharedArrayBuffer) — never the case here, buildZip always allocates a
	// fresh dedicated ArrayBuffer via `new Uint8Array(size)`. slice() bounded
	// to the view rather than the raw zip.buffer: on mobile these bytes are
	// written as is into the vault (ui/file-export.ts), so a buffer larger
	// than the view would produce a corrupted .zip there.
	const buffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
	void saveExportedFile(this.app, buffer, filename, "application/zip");
}
