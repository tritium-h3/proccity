// v1 terrain stored a dense height grid; v2 doesn't. Only decoding remains, so old saves
// still validate.

export function decodeHeights(s: string): Float32Array {
  const bin = atob(s);
  if (bin.length % 4 !== 0) throw new Error('heights: byte length is not a multiple of 4');
  const view = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
  const out = new Float32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
