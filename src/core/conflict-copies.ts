// The copies Syncthing leaves in the plugin's folder when two devices changed the same file at the same time.
//
// The plugin keeps regenerable caches (card legalities, rules text, set icons…) in its folder, and the vault, folder
// included, is shared between devices. Each device rewrites those files on its own, so Syncthing keeps finding them
// changed on two sides at once and keeps the older one next to the file as
//     <name>.sync-conflict-<yyyymmdd>-<hhmmss>-<7-character device id>.<extension>
// On a real vault, 17 such copies had piled up (91 MB: six copies of the 11 MB legalities cache alone), and Syncthing
// sends every one of them to every device (audit of 2026-11-15, docs/history/code-audit-2026-11-15.md).
//
// Only the conflict copies of files whose content can be rebuilt are ever candidates, named in `cacheFiles` by the caller:
// a copy of data.json can hold the only trace of a change the merge did not take, and is never touched.

const SYNCTHING_CONFLICT = /^(.+)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(\.[A-Za-z0-9]+)$/;

// The name of the file a Syncthing conflict copy is a copy OF ("legalities-cache.json"), or null when this is not a
// conflict copy.
export function syncConflictOrigin(fileName: string): string | null {
	const match = SYNCTHING_CONFLICT.exec(fileName);
	return match ? match[1] + match[2] : null;
}

// Of these file names, the conflict copies of one of `cacheFiles`.
export function cacheConflictCopies(fileNames: readonly string[], cacheFiles: ReadonlySet<string>): string[] {
	return fileNames.filter((name) => {
		const origin = syncConflictOrigin(name);
		return origin !== null && cacheFiles.has(origin);
	});
}
