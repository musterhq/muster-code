/** A minimal ZIP writer (stored entries, no compression): images are already compressed, so a gallery's "Download all" needs no dependency. */
const TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
export function crc32(data: Uint8Array): number { let crc = 0xffffffff; for (const byte of data) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

const dosTime = (date: Date) => ({time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()});

export function zipStore(entries: readonly {name: string; data: Uint8Array}[], now = new Date()): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many files for one zip.');
  const {time, date} = dosTime(now), parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), data = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength), crc = crc32(data);
    if (data.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('The images are too large for one zip.');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(0, 10);
    head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14); head.writeUInt32LE(crc, 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, data); central.push(head, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** File names for the archive: base names only, made unique ("a.png", "a (2).png"). */
export function archiveNames(paths: readonly string[]): string[] {
  const used = new Set<string>();
  return paths.map(path => {
    const base = (path.split(/[\\/]/).pop() || 'image').replace(/[\u0000-\u001f]/g, '_'), dot = base.lastIndexOf('.'), stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
    let name = base, n = 1;
    while (used.has(name.toLowerCase())) name = `${stem} (${++n})${ext}`;
    used.add(name.toLowerCase()); return name;
  });
}
