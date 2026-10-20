// geocode.js — city/state -> [lat, lon] using a bundled GeoNames-derived
// lookup (populated places, most populous wins per key). Stored compressed
// as data/city-geo.json.gz.b64 (base64 of gzipped JSON) to keep pushes
// small; a plain data/city-geo.json, if present, takes precedence.
// Used to place fuel-feed stops (which carry city/state only) on the map.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

let table = null;
function load() {
  if (table) return table;
  const dir = path.join(__dirname, '..', 'data');
  try {
    table = JSON.parse(fs.readFileSync(path.join(dir, 'city-geo.json'), 'utf8'));
    return table;
  } catch (e) { /* fall through to compressed copy */ }
  try {
    const b64 = fs.readFileSync(path.join(dir, 'city-geo.json.gz.b64'), 'utf8');
    table = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
  } catch (e) {
    console.error('[geocode] city lookup unavailable: ' + e.message);
    table = {};
  }
  return table;
}

function normalize(city) {
  let c = String(city || '').trim().toUpperCase();
  c = c.replace(/^ST\.?\s+/, 'SAINT ').replace(/^MT\.?\s+/, 'MOUNT ').replace(/^FT\.?\s+/, 'FORT ')
       .replace(/^N\.?\s+/, 'NORTH ').replace(/^S\.?\s+/, 'SOUTH ')
       .replace(/^E\.?\s+/, 'EAST ').replace(/^W\.?\s+/, 'WEST ');
  return c;
}

// Returns [lat, lon] or null.
function geocodeCity(city, state) {
  const t = load();
  const st = String(state || '').trim().toUpperCase();
  if (!st) return null;
  const raw = String(city || '').trim().toUpperCase();
  return t[`${raw}|${st}`] || t[`${normalize(raw)}|${st}`] || null;
}

module.exports = { geocodeCity };
