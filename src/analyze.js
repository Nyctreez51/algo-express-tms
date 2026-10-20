// analyze.js — load analyzer: lane distance, FSC split (Tree's 65c rule),
// fuel plan, driver pay from the driver's own terms, fixed-cost allocation,
// round-trip/backhaul view, lane history, and HOS feasibility.
// Distances: real road miles via the public OSRM demo router when reachable;
// otherwise a straight-line x1.22 circuity estimate, labeled as such.
'use strict';

const { geocodeCity } = require('./geocode');

// "Rincon, GA" / "Rincon GA" / "Rincon, Georgia" -> { city, state, lat, lon } or null
const STATE_NAMES = {
  GEORGIA: 'GA', ALABAMA: 'AL', FLORIDA: 'FL', TENNESSEE: 'TN', 'SOUTH CAROLINA': 'SC',
  'NORTH CAROLINA': 'NC', TEXAS: 'TX', ILLINOIS: 'IL', MISSOURI: 'MO', OKLAHOMA: 'OK',
  KENTUCKY: 'KY', INDIANA: 'IN', OHIO: 'OH', ARKANSAS: 'AR', MISSISSIPPI: 'MS',
  LOUISIANA: 'LA', VIRGINIA: 'VA', MICHIGAN: 'MI', WISCONSIN: 'WI', IOWA: 'IA', KANSAS: 'KS',
};
function parsePlace(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  let city, state;
  if (s.includes(',')) {
    const parts = s.split(',');
    city = parts[0].trim();
    state = (parts[1] || '').trim().toUpperCase();
  } else {
    const m = s.match(/^(.*?)\s+([A-Za-z]{2})$/);
    if (!m) return null;
    city = m[1].trim(); state = m[2].toUpperCase();
  }
  if (STATE_NAMES[state]) state = STATE_NAMES[state];
  if (!city || !/^[A-Z]{2}$/.test(state)) return null;
  const ll = geocodeCity(city, state);
  if (!ll) return null;
  return { city, state, lat: ll[0], lon: ll[1], label: `${city}, ${state}` };
}

function stateOf(str) {
  const p = parsePlaceLoose(str);
  return p ? p.state : null;
}
function parsePlaceLoose(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  let city, state;
  if (s.includes(',')) {
    const parts = s.split(',');
    city = parts[0].trim(); state = (parts[1] || '').trim().toUpperCase();
  } else {
    const m = s.match(/^(.*?)\s+([A-Za-z]{2})$/);
    if (!m) return null;
    city = m[1].trim(); state = m[2].toUpperCase();
  }
  if (STATE_NAMES[state]) state = STATE_NAMES[state];
  if (!city || !/^[A-Z]{2}$/.test(state)) return null;
  return { city, state };
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function roadRoute(a, b) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4500) });
    const j = await r.json();
    if (j && j.code === 'Ok' && j.routes && j.routes[0]) {
      return {
        miles: Math.round(j.routes[0].distance / 1609.344),
        hours: Math.round((j.routes[0].duration / 3600) * 10) / 10,
        source: 'road',
      };
    }
  } catch (e) { /* fall through to estimate */ }
  const miles = Math.round(haversineMi(a.lat, a.lon, b.lat, b.lon) * 1.22);
  return { miles, hours: Math.round((miles / 47) * 10) / 10, source: 'estimate' };
}

// Split a gross rate by Tree's rule: FSC = $0.65 x loaded miles carved out.
function fscSplit(gross, loadedMiles) {
  const fsc = Math.max(0, Math.min(0.65 * loadedMiles, gross));
  return { fsc: round2(fsc), linehaul: round2(gross - fsc) };
}

function driverPay(driver, linehaul, truckMiles) {
  if (!driver) return null;
  if (driver.pay_type === 'per_mile') {
    const rate = Number(driver.pay_rate) || 0;
    return { amount: round2(rate * truckMiles), basis: `$${rate.toFixed(2)}/mi x ${Math.round(truckMiles)} truck mi` };
  }
  const pct = Number(driver.pay_pct) || 0;
  return { amount: round2(linehaul * pct / 100), basis: `${pct}% of linehaul` };
}

const round2 = (x) => Math.round(x * 100) / 100;

async function analyze(input, ctx) {
  const origin = parsePlace(input.origin);
  const dest = parsePlace(input.destination);
  if (!origin) return { ok: false, error: `Could not find pickup "${input.origin}". Use City, ST.` };
  if (!dest) return { ok: false, error: `Could not find drop-off "${input.destination}". Use City, ST.` };
  const rate = Number(input.rate) || 0;
  if (rate <= 0) return { ok: false, error: 'Enter the rate offered.' };

  const lane = await roadRoute(origin, dest);
  const loadedMiles = lane.miles;

  let deadheadMiles = 0, deadheadHours = 0, truckFrom = null;
  if (input.deadheadOverride !== '' && input.deadheadOverride != null && Number(input.deadheadOverride) >= 0) {
    deadheadMiles = Number(input.deadheadOverride);
    deadheadHours = Math.round((deadheadMiles / 47) * 10) / 10;
  } else if (input.truckFrom) {
    truckFrom = parsePlace(input.truckFrom);
    if (truckFrom) {
      const dh = await roadRoute(truckFrom, origin);
      deadheadMiles = dh.miles; deadheadHours = dh.hours;
    }
  }
  const truckMiles = deadheadMiles + loadedMiles;
  const split = fscSplit(rate, loadedMiles);

  // Fuel plan — price defaults to the best RXO price near the pickup.
  const mpg = Number(input.mpg) > 0 ? Number(input.mpg) : 7.0;
  let fuelPrice = Number(input.fuelPrice) > 0 ? Number(input.fuelPrice) : null;
  let fuelPriceNote = fuelPrice ? 'your entry' : null;
  if (!fuelPrice && ctx.fuelNear) {
    const near = ctx.fuelNear(origin.lat, origin.lon);
    if (near) { fuelPrice = near.cust_price; fuelPriceNote = `RXO near pickup: ${near.name} (${near.city}, ${near.state})`; }
  }
  if (!fuelPrice) { fuelPrice = 5.90; fuelPriceNote = 'planning average (no RXO stop near pickup)'; }
  const gallons = truckMiles / mpg;
  const fuelCost = gallons * fuelPrice;

  // Driver pay + fixed cost per day.
  const pay = driverPay(ctx.driver, split.linehaul, truckMiles);
  const driveHours = deadheadHours + lane.hours;
  let days = Math.max(1, Math.ceil(driveHours / 10));
  let windowHours = null;
  if (input.pickupDate && input.deliveryDate) {
    const p = new Date(input.pickupDate + 'T00:00:00');
    const d = new Date(input.deliveryDate + 'T23:59:59');
    if (!isNaN(p) && !isNaN(d) && d >= p) {
      windowHours = Math.round((d - p) / 3600000);
      days = Math.max(1, Math.round(windowHours / 24));
    }
  }
  const fixedPerDay = Number(input.fixedPerDay) >= 0 ? Number(input.fixedPerDay) : 147;
  const fixedCost = fixedPerDay * days;

  const net = rate - fuelCost - (pay ? pay.amount : 0) - fixedCost;
  const marginPct = rate > 0 ? (net / rate) * 100 : 0;
  const verdict = marginPct >= 25 ? 'Strong' : marginPct >= 12 ? 'Workable' : marginPct >= 0 ? 'Thin' : 'Loses money';

  // Round trip / backhaul.
  const backhaulRate = Number(input.backhaulRate) || 0;
  const rtMiles = truckMiles + loadedMiles; // return leg ~ same road miles
  let rt = null;
  if (backhaulRate > 0) {
    const bSplit = fscSplit(backhaulRate, loadedMiles);
    const bPay = driverPay(ctx.driver, bSplit.linehaul, loadedMiles);
    const rtRevenue = rate + backhaulRate;
    const rtFuel = (rtMiles / mpg) * fuelPrice;
    const rtDays = Math.max(days, Math.ceil((driveHours * 2) / 10));
    const rtFixed = fixedPerDay * rtDays;
    const rtNet = rtRevenue - rtFuel - (pay ? pay.amount : 0) - (bPay ? bPay.amount : 0) - rtFixed;
    rt = {
      backhaulRate, linehaul: bSplit.linehaul, fsc: bSplit.fsc,
      returnMiles: loadedMiles, roundTripMiles: rtMiles,
      revenue: round2(rtRevenue), fuelCost: round2(rtFuel),
      driverPay: round2((pay ? pay.amount : 0) + (bPay ? bPay.amount : 0)),
      fixedCost: round2(rtFixed), net: round2(rtNet),
      rpm: round2(rtRevenue / rtMiles),
    };
  }

  // Feasibility.
  const drivingDaysNeeded = Math.ceil(driveHours / 11 * 10) / 10;
  let feasLabel, avgPerDay = null;
  if (windowHours) {
    avgPerDay = Math.round((driveHours / days) * 10) / 10;
    feasLabel = avgPerDay <= 8 ? 'Comfortable' : avgPerDay <= 11 ? 'Tight but legal (solo)' : 'Not feasible solo — needs a team or more time';
  } else {
    feasLabel = driveHours <= 10 ? 'Comfortable — one driving day' : `Needs ~${Math.ceil(driveHours / 11)} driving days (solo, 11h/day)`;
  }

  // Lane history from completed loads.
  let history = { statePair: `${origin.state} → ${dest.state}`, count: 0, avgGross: null, avgRpm: null, lastDate: null, exactCount: 0 };
  if (ctx.historyLoads) {
    const pair = ctx.historyLoads.filter(l => {
      const o = parsePlaceLoose(l.origin), d = parsePlaceLoose(l.destination);
      return o && d && o.state === origin.state && d.state === dest.state;
    });
    if (pair.length) {
      const gross = pair.map(l => (l.linehaul_cents + l.fsc_cents) / 100);
      const rpms = pair.filter(l => l.loaded_miles > 0)
        .map(l => (l.linehaul_cents + l.fsc_cents) / 100 / l.loaded_miles);
      history = {
        statePair: history.statePair,
        count: pair.length,
        exactCount: pair.filter(l => {
          const o = parsePlaceLoose(l.origin), d = parsePlaceLoose(l.destination);
          return o.city.toUpperCase() === origin.city.toUpperCase() && d.city.toUpperCase() === dest.city.toUpperCase();
        }).length,
        avgGross: round2(gross.reduce((a, b) => a + b, 0) / gross.length),
        avgRpm: rpms.length ? round2(rpms.reduce((a, b) => a + b, 0) / rpms.length) : null,
        lastDate: pair.map(l => l.date).sort().slice(-1)[0],
      };
    }
  }

  return {
    ok: true,
    origin: origin.label, destination: dest.label,
    distanceSource: lane.source,
    loadedMiles, driveHours: lane.hours,
    deadheadMiles, deadheadHours, truckFrom: truckFrom ? truckFrom.label : null,
    truckMiles,
    rate, rpmLoaded: round2(rate / loadedMiles), rpmTruck: round2(rate / truckMiles),
    linehaul: split.linehaul, fsc: split.fsc,
    fuel: { gallons: Math.round(gallons * 10) / 10, mpg, price: fuelPrice, priceNote: fuelPriceNote, cost: round2(fuelCost) },
    driverPay: pay, driverName: ctx.driver ? ctx.driver.name : null,
    fixed: { perDay: fixedPerDay, days, cost: round2(fixedCost) },
    net: round2(net), marginPct: Math.round(marginPct * 10) / 10, verdict,
    roundTrip: rt,
    feasibility: { driveHours: Math.round(driveHours * 10) / 10, drivingDaysNeeded, windowHours, daysAvailable: days, avgPerDay, label: feasLabel },
    history,
  };
}

module.exports = { analyze, parsePlace, stateOf };
