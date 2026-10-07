
export interface ZipEntry {
	name: string;
	content: string;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

// Date/heure au format DOS (bit-packées, requises par le format ZIP) —
// dérivées de l'heure réelle de création de l'archive ; purement cosmétique,
// aucun extracteur n'en dépend pour la lecture du contenu.
function dosDateTime(date: Date): { time: number; date: number } {
	const time =
		((date.getHours() & 0x1f) << 11) |
		((date.getMinutes() & 0x3f) << 5) |
		((date.getSeconds() >> 1) & 0x1f);
	const dosDate =
		(((Math.max(date.getFullYear(), 1980) - 1980) & 0x7f) << 9) |
		(((date.getMonth() + 1) & 0xf) << 5) |
		(date.getDate() & 0x1f);
	return { time, date: dosDate };
}

const LOCAL_HEADER_FIXED_SIZE = 30;
const CENTRAL_HEADER_FIXED_SIZE = 46;
const END_OF_CENTRAL_DIR_SIZE = 22;

// Construit un ZIP "stored" à partir d'une liste de fichiers texte —
// retourne les octets bruts de l'archive, à envelopper dans un Blob par
// l'appelant (voir MTGCollectionView.downloadZip). Chaque entrée est
// encodée en UTF-8 (nom ET contenu), avec le bit "UTF-8 filename" (0x0800)
// du general purpose flag activé, pour que les noms/contenus accentués
// s'affichent correctement dans tout extracteur conforme. Une seule
// allocation (buffer pré-dimensionné exactement, puis rempli via
// DataView) plutôt que de faire grossir un tableau JS au fil de l'eau —
// un export peut représenter plusieurs centaines de Ko cumulés.
export function buildZip(entries: ZipEntry[]): Uint8Array {
	const encoder = new TextEncoder();
	const now = dosDateTime(new Date());

	const prepared = entries.map((entry) => {
		const nameBytes = encoder.encode(entry.name);
		const contentBytes = encoder.encode(entry.content);
		return { nameBytes, contentBytes, crc: crc32(contentBytes) };
	});

	let localTotal = 0;
	let centralTotal = 0;
	for (const p of prepared) {
		localTotal += LOCAL_HEADER_FIXED_SIZE + p.nameBytes.length + p.contentBytes.length;
		centralTotal += CENTRAL_HEADER_FIXED_SIZE + p.nameBytes.length;
	}
	const buf = new Uint8Array(localTotal + centralTotal + END_OF_CENTRAL_DIR_SIZE);
	const view = new DataView(buf.buffer);
	let offset = 0;
	const localOffsets: number[] = [];

	for (const p of prepared) {
		localOffsets.push(offset);
		view.setUint32(offset, 0x04034b50, true);
		offset += 4;
		view.setUint16(offset, 20, true); // version needed to extract
		offset += 2;
		view.setUint16(offset, 0x0800, true); // general purpose flag: UTF-8 name
		offset += 2;
		view.setUint16(offset, 0, true); // compression method: stored
		offset += 2;
		view.setUint16(offset, now.time, true);
		offset += 2;
		view.setUint16(offset, now.date, true);
		offset += 2;
		view.setUint32(offset, p.crc, true);
		offset += 4;
		view.setUint32(offset, p.contentBytes.length, true); // compressed size
		offset += 4;
		view.setUint32(offset, p.contentBytes.length, true); // uncompressed size
		offset += 4;
		view.setUint16(offset, p.nameBytes.length, true);
		offset += 2;
		view.setUint16(offset, 0, true); // extra field length
		offset += 2;
		buf.set(p.nameBytes, offset);
		offset += p.nameBytes.length;
		buf.set(p.contentBytes, offset);
		offset += p.contentBytes.length;
	}

	const centralDirOffset = offset;
	prepared.forEach((p, i) => {
		view.setUint32(offset, 0x02014b50, true);
		offset += 4;
		view.setUint16(offset, 20, true); // version made by
		offset += 2;
		view.setUint16(offset, 20, true); // version needed to extract
		offset += 2;
		view.setUint16(offset, 0x0800, true);
		offset += 2;
		view.setUint16(offset, 0, true);
		offset += 2;
		view.setUint16(offset, now.time, true);
		offset += 2;
		view.setUint16(offset, now.date, true);
		offset += 2;
		view.setUint32(offset, p.crc, true);
		offset += 4;
		view.setUint32(offset, p.contentBytes.length, true);
		offset += 4;
		view.setUint32(offset, p.contentBytes.length, true);
		offset += 4;
		view.setUint16(offset, p.nameBytes.length, true);
		offset += 2;
		view.setUint16(offset, 0, true); // extra field length
		offset += 2;
		view.setUint16(offset, 0, true); // comment length
		offset += 2;
		view.setUint16(offset, 0, true); // disk number start
		offset += 2;
		view.setUint16(offset, 0, true); // internal file attributes
		offset += 2;
		view.setUint32(offset, 0, true); // external file attributes
		offset += 4;
		view.setUint32(offset, localOffsets[i], true); // offset of local header
		offset += 4;
		buf.set(p.nameBytes, offset);
		offset += p.nameBytes.length;
	});

	const centralDirSize = offset - centralDirOffset;
	view.setUint32(offset, 0x06054b50, true);
	offset += 4;
	view.setUint16(offset, 0, true); // disk number
	offset += 2;
	view.setUint16(offset, 0, true); // disk with start of central dir
	offset += 2;
	view.setUint16(offset, entries.length, true); // entries on this disk
	offset += 2;
	view.setUint16(offset, entries.length, true); // total entries
	offset += 2;
	view.setUint32(offset, centralDirSize, true);
	offset += 4;
	view.setUint32(offset, centralDirOffset, true);
	offset += 4;
	view.setUint16(offset, 0, true); // comment length
	offset += 2;

	return buf;
}
