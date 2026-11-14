/**
 * Browser tile source: fetches Terrarium PNGs and decodes them with the
 * browser's own image decoder. Works in a Web Worker (uses OffscreenCanvas).
 */
import { TERRARIUM_URL, type RGBAImage, type TileSource } from './elevation';

export function browserTileSource(urlTemplate = TERRARIUM_URL): TileSource {
  return {
    async getTile(z, x, y): Promise<RGBAImage> {
      const url = urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`Elevation tile ${z}/${x}/${y} failed: HTTP ${res.status}`);
      // Decode without colour-space conversion or premultiplication: the
      // colours are data, and any adjustment would corrupt the heights.
      const bitmap = await createImageBitmap(await res.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: img.width, height: img.height, data: img.data };
    },
  };
}
