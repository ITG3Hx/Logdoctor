(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogDoctorZip = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  // Reads the central directory of a zip or jar. Returns null if the bytes are not a zip.
  function listEntries(u8) {
    if (!u8 || u8.length < 22) return null;
    const min = Math.max(0, u8.length - 22 - 65535);
    let i = u8.length - 22;
    for (; i >= min; i--) if (u32(u8, i) === 0x06054b50) break;
    if (i < min) return null;
    const count = u16(u8, i + 10);
    let p = u32(u8, i + 16);
    const dec = new TextDecoder('utf-8');
    const out = [];
    for (let k = 0; k < count; k++) {
      if (p + 46 > u8.length || u32(u8, p) !== 0x02014b50) break;
      const nlen = u16(u8, p + 28);
      const elen = u16(u8, p + 30);
      const clen = u16(u8, p + 32);
      out.push({
        name: dec.decode(u8.subarray(p + 46, p + 46 + nlen)),
        method: u16(u8, p + 10),
        csize: u32(u8, p + 20),
        usize: u32(u8, p + 24),
        offset: u32(u8, p + 42)
      });
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  async function inflateRaw(data) {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      return new Uint8Array(require('zlib').inflateRawSync(data));
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntry(u8, entry, limit) {
    const p = entry.offset;
    if (u32(u8, p) !== 0x04034b50) throw new Error('bad local header');
    if (entry.usize > (limit || 4 * 1024 * 1024)) throw new Error('entry too large');
    const start = p + 30 + u16(u8, p + 26) + u16(u8, p + 28);
    const data = u8.subarray(start, start + entry.csize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    throw new Error('unsupported compression ' + entry.method);
  }

  return { listEntries, readEntry };
});