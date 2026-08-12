#!/usr/bin/env node
// Regenerates data/buildings.json from OpenStreetMap via the Overpass API.
// Run: node tools/fetch-buildings.mjs
//
// Coordinates are building centroids, not entrances. Use the app's pin-drop
// mode to sharpen any building where the centroid isn't good enough.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'buildings.json');

// Campus bounding box: south, west, north, east
const BBOX = '32.418,-85.715,32.437,-85.690';

const QUERY = `
[out:json][timeout:90];
(
  way["building"](${BBOX});
  relation["building"](${BBOX});
);
out center tags;
`;

// Things inside the bbox that are buildings but never a class location.
const EXCLUDE = /Laundromat|Power Plant|Cooling Plant|Physical Plant|Nursery|Animal (Care|Research)|Gazebo|Apartments/i;

// Hand-seeded aliases: how these buildings actually get written on a schedule,
// in campus slang, or by department. Extend freely — the app also learns
// aliases at import time and stores those in localStorage.
const ALIASES = {
  'the-chappie-james-center': ['James Center', 'Chappie James', 'Engineering', 'Engineering Building', 'ENGR'],
  'andrew-f-brimmer-college-of-business-and-information-sciences': [
    'Brimmer', 'Brimmer Hall', 'Business', 'College of Business', 'Computer Science', 'CS', 'BRIM',
  ],
  'armstrong-science-hall': ['Armstrong', 'Science Hall', 'Chemistry', 'Physics', 'ARMS'],
  'luther-h-foster-hall': ['Foster', 'Foster Hall', 'Agriculture', 'Ag', 'Food Science'],
  'hollis-burke-frissell-building': ['Frissell', 'Library', 'Ford Library', 'Ford Motor Company Library'],
  's-h-kresge-center': ['Kresge', 'Kresge Center'],
  'milbank-hall': ['Milbank', 'Veterinary', 'Vet Med'],
  'basil-o-connor-hall': ["O'Connor", 'Basil O Connor', 'Vet Med', 'Veterinary Medicine'],
  'charles-e-tompkins-hall': ['Tompkins', 'Dining Hall', 'Cafeteria'],
  'andrew-carnegie-hall': ['Carnegie', 'Carnegie Hall'],
  'warren-g-logan-hall': ['Logan', 'Logan Hall'],
  'alexander-m-white-hall': ['White Hall', 'White'],
  'margaret-murray-washington-hall': ['MMW', 'Washington Hall', 'Murray Washington'],
  'james-h-m-henderson-hall': ['Henderson', 'Biology'],
  'thomas-campbell-hall': ['Campbell', 'Campbell Hall'],
  'frederick-d-patterson-hall': ['Patterson', 'Patterson Hall'],
  'william-chambliss-hall': ['Chambliss', 'Chambliss Hall'],
  'morrisson-mayberry-building': ['Morrisson Mayberry', 'Mayberry'],
  'kellogg-hotel-and-conference-center': ['Kellogg', 'Kellogg Center', 'Conference Center'],
  'university-chapel': ['Chapel'],
  'lillian-h-harvey-hall': ['Harvey', 'Harvey Hall', 'Nursing'],
  'russell-sage-hall': ['Sage', 'Sage Hall'],
  'max-b-thrasher-hall': ['Thrasher', 'Thrasher Hall'],
  'john-d-rockefeller-hall': ['Rockefeller'],
  'collis-p-huntington-hall': ['Huntington'],
  'olivia-davidson-hall': ['Davidson'],
  'frederick-douglas-hall': ['Douglas', 'Douglass Hall'],
  'lewis-adams-hall': ['Adams', 'Adams Hall'],
  'robert-moton-hall': ['Moton', 'Moton Hall'],
  'thomas-d-russell-hall': ['Russell Hall'],
  'samuel-l-younge-hall': ['Younge', 'Younge Hall'],
  'benjamin-banneker-hall': ['Banneker'],
  'mary-mcleod-bethune-hall': ['Bethune'],
  'charles-drew-hall': ['Drew', 'Drew Hall'],
  'ellen-c-james-hall': ['James Hall'],
  'james-o-tantum-hall': ['Tantum'],
  'williams-bowie-hall': ['Bowie', 'Bowie Hall'],
  'john-a-kennery-hall': ['Kennery'],
  'carver-foundation-research-building': ['Carver', 'Carver Foundation'],
  'george-washington-carver-museum': ['Carver Museum'],
  'vocational-building': ['Vocational', 'Voc Building'],
  'band-cottage': ['Band', 'Music'],
};

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/["'’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function keep(tags) {
  if (!tags?.name) return false;
  if (EXCLUDE.test(tags.name)) return false;
  return (
    tags.building === 'university' ||
    tags.building === 'chapel' ||
    tags.amenity === 'library' ||
    tags.amenity === 'university'
  );
}

async function main() {
  process.stdout.write('Querying Overpass for Tuskegee campus buildings...\n');

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ClassMapper/1.0 (campus class router; personal use)',
    },
    body: new URLSearchParams({ data: QUERY }),
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status} ${res.statusText}`);

  const { elements } = await res.json();

  const seen = new Set();
  const buildings = [];

  for (const el of elements) {
    if (!keep(el.tags)) continue;

    const lat = el.center?.lat ?? el.lat;
    const lon = el.center?.lon ?? el.lon;
    if (lat == null || lon == null) continue;

    const id = slugify(el.tags.name);
    if (seen.has(id)) continue; // OSM sometimes has a way + relation for one building
    seen.add(id);

    buildings.push({
      id,
      name: el.tags.name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      aliases: ALIASES[id] ?? [],
      source: 'osm',
    });
  }

  buildings.sort((a, b) => a.name.localeCompare(b.name));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generated: new Date().toISOString().slice(0, 10),
        attribution: '© OpenStreetMap contributors, ODbL',
        bbox: BBOX,
        buildings,
      },
      null,
      2,
    ) + '\n',
  );

  const withAliases = buildings.filter((b) => b.aliases.length).length;
  process.stdout.write(`Wrote ${buildings.length} buildings to data/buildings.json (${withAliases} with seeded aliases)\n`);
}

main().catch((err) => {
  process.stderr.write(`Failed: ${err.message}\n`);
  process.exit(1);
});
