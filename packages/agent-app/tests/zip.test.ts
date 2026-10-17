import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32 as nodeCrc} from 'node:zlib';
import {archiveNames,crc32,zipStore} from '../src/main/zip.ts';

test('zipStore writes a valid archive of stored entries', () => {
  const a = Buffer.from('hello'), b = Buffer.alloc(300, 7);
  const zip = zipStore([{name: 'a.png', data: a}, {name: 'b.png', data: b}], new Date(2026, 0, 2, 3, 4, 6));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  const dir = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(dir), 0x02014b50);
  assert.equal(zip.readUInt32LE(dir + 16), nodeCrc(a), 'crc of the first entry');
  assert.equal(crc32(b), nodeCrc(b));
  assert.equal(zip.subarray(30 + 5, 30 + 5 + 5).toString(), 'hello', 'data follows the first name');
});
test('archiveNames keeps base names and makes duplicates unique', () => {
  assert.deepEqual(archiveNames(['/tmp/x/a.png', '/other/a.png', 'C:\\w\\a.png', '/tmp/b']), ['a.png', 'a (2).png', 'a (3).png', 'b']);
});
