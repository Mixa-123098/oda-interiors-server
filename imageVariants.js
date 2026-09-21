// Downscaled WebP copies of every uploaded photo, stored next to the original
// as "<original filename>.w<width>.webp". The originals are up to 6 MB PNGs
// straight from the designers' renders; the public site used to send those
// full-size to every phone, which is what made project pages crawl on weak
// connections. The client picks the right width via srcset (see
// client/src/components/ResponsiveImg.jsx).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const WIDTHS = [480, 960, 1600];
const SOURCE_EXT = /\.(jpe?g|png|webp)$/i;
const VARIANT_NAME = /\.w\d+\.webp$/i;

sharp.concurrency(1); // background work must not starve request handling
sharp.cache(false);

const variantPath = (dir, filename, width) =>
  path.join(dir, `${filename}.w${width}.webp`);

// (Re)builds every width for one original. Written to a temp file and renamed
// so a request never sees a half-written image. withoutEnlargement keeps small
// originals at their own size rather than upscaling.
async function makeVariants(dir, filename) {
  const source = path.join(dir, filename);
  for (const width of WIDTHS) {
    const target = variantPath(dir, filename, width);
    const tmp = `${target}.tmp`;
    // failOn "none": a slightly truncated/damaged JPEG still yields a usable
    // (partially decoded) copy instead of leaving the site on the 2.5MB original.
    await sharp(source, { failOn: "none" })
      .rotate() // honour EXIF orientation before the metadata is dropped
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 74 })
      .toFile(tmp);
    fs.renameSync(tmp, target);
  }
}

// Boot-time pass: builds variants for originals that have none yet, or whose
// original changed after the variant was made (crop-and-replace overwrites a
// file in place). Cheap once everything is up to date.
async function backfillImageVariants(dir) {
  let done = 0;
  for (const filename of fs.readdirSync(dir)) {
    if (!SOURCE_EXT.test(filename) || VARIANT_NAME.test(filename)) continue;
    const sourceTime = fs.statSync(path.join(dir, filename)).mtimeMs;
    const stale = WIDTHS.some((width) => {
      const target = variantPath(dir, filename, width);
      return !fs.existsSync(target) || fs.statSync(target).mtimeMs < sourceTime;
    });
    if (!stale) continue;
    try {
      await makeVariants(dir, filename);
      done++;
    } catch (err) {
      console.error(`Image variants failed for ${filename}:`, err.message);
    }
  }
  if (done) console.log(`Image variants generated for ${done} photos`);
}

module.exports = { makeVariants, backfillImageVariants, SOURCE_EXT };
