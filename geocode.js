// Turns a project's "city, country" text into coordinates via OpenStreetMap
// Nominatim (no API key). Their usage policy: identify the app with a real
// User-Agent and send at most 1 request/second — hence the serial queue.
// Every failure resolves to null: a project without a map pin is fine, a
// failed geocode must never block saving a project.

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MIN_GAP_MS = 1100;

let chain = Promise.resolve();
let lastCall = 0;

function geocodeKey(city, country) {
  return `${(city || "").trim()}|${(country || "").trim()}`.toLowerCase();
}

function queueGeocode(city, country) {
  const run = async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "5");
      url.searchParams.set("q", [city, country].map((v) => (v || "").trim()).filter(Boolean).join(", "));
      const res = await fetch(url, {
        headers: {
          "User-Agent": "oda-interiors-portfolio/1.0 (project map geocoder)",
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      // The first hit can be a same-named village or a river ("Дніпро" is
      // all three), and their importance scores tie. Prefer settlements and
      // administrative areas, and among those the largest (lowest place_rank).
      const hits = await res.json();
      const isPlace = (h) => h.category === "place" || h.category === "boundary";
      const hit = hits.sort(
        (x, y) =>
          Number(isPlace(y)) - Number(isPlace(x)) ||
          (x.place_rank || 99) - (y.place_rank || 99) ||
          (y.importance || 0) - (x.importance || 0)
      )[0];
      if (!hit) return null;
      const lat = Number(hit.lat);
      const lng = Number(hit.lon);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    } catch (err) {
      console.error("Geocoding failed:", err.message);
      return null;
    }
  };
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

// Geocodes one project and stores the result. Skips when the admin pinned the
// point by hand (geo_manual) or the city/country haven't changed since the
// last successful lookup (geo_key), so re-saving a project costs nothing.
async function geocodeProject(pool, projectId) {
  const { rows } = await pool.query(
    "SELECT project_city, project_country, geo_manual, geo_key, lat FROM projects WHERE id = $1",
    [projectId]
  );
  const p = rows[0];
  if (!p || p.geo_manual) return;
  const key = geocodeKey(p.project_city, p.project_country);
  if (!key.replace("|", "")) return;
  if (p.geo_key === key && p.lat !== null) return;
  const point = await queueGeocode(p.project_city, p.project_country);
  if (!point) return;
  await pool.query(
    "UPDATE projects SET lat = $1, lng = $2, geo_key = $3 WHERE id = $4",
    [point.lat, point.lng, key, projectId]
  );
}

async function backfillGeocodes(pool) {
  const { rows } = await pool.query(
    "SELECT id FROM projects WHERE lat IS NULL AND geo_manual = false ORDER BY id"
  );
  for (const { id } of rows) {
    await geocodeProject(pool, id).catch((e) =>
      console.error(`Geocode backfill failed for project ${id}:`, e.message)
    );
  }
  if (rows.length) console.log(`Geocode backfill done (${rows.length} projects checked)`);
}

module.exports = { geocodeProject, backfillGeocodes };
