// Draws the PNG app icons (contour rings and a north arrow) without extra tools.
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
for (const size of [192, 512]) {
  const png = new PNG({ width: size, height: size });
  const s = size / 100;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / s, v = y / s;
    let c = [47, 58, 42];
    for (const [rx, ry] of [[38, 26], [25, 16], [11, 7]]) {
      const d = Math.hypot((u - 50) / rx, (v - 56) / ry);
      if (Math.abs(d - 1) * Math.min(rx, ry) < 2) c = [232, 194, 122];
    }
    if (Math.abs(u - 50) < 2 && v > 12 && v < 40) c = [246, 243, 234];
    if (v > 12 && v < 23 && Math.abs(Math.abs(u - 50) - (v - 12) * 0.8) < 2.2) c = [246, 243, 234];
    png.data.set([...c, 255], (y * size + x) * 4);
  }
  writeFileSync(`public/icon-${size}.png`, PNG.sync.write(png));
}
