const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf-8');

// Tauri bundle icons must be square. If the SVG's viewBox isn't square,
// expand it to the larger dimension and center the content so the rendered
// PNG is square without distorting or cropping the artwork.
function squareViewBox(src) {
  const match = src.match(/viewBox=["']([^"']+)["']/);
  if (!match) return src;
  const [vx, vy, vw, vh] = match[1].trim().split(/[\s,]+/).map(Number);
  if (vw === vh) return src;
  const size = Math.max(vw, vh);
  const nx = vx - (size - vw) / 2;
  const ny = vy - (size - vh) / 2;
  return src.replace(/viewBox=["'][^"']+["']/, `viewBox="${nx} ${ny} ${size} ${size}"`);
}

const resvg = new Resvg(squareViewBox(svg), {
  fitTo: { mode: 'width', value: 512 },
  font: { loadSystemFonts: true },
});

const png = resvg.render().asPng();
const outPath = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(outPath, png);
console.log('Wrote', outPath);
