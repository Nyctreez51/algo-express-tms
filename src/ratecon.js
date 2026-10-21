// Rate-con / tender parsing: pull load fields out of a PDF's text so the
// upload form fills itself in. Only fills fields the document states clearly;
// anything unsure stays blank for the owner to check. Money is in dollars.
'use strict';

const STATE_ABBR = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY',
  LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI',
  MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE',
  NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM',
  'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
  OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX',
  UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
};

function titleCity(s) {
  return s.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function money(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// "CITY, ST ZIP" or "CITY, State Name ZIP" — returns "City, ST" or null.
// mode 'last' (default): last match in the chunk — right for the pickup side,
// where the broker's own address can appear first. mode 'first': first match —
// right for the delivery side, where footers can repeat other addresses after.
function cityState(chunk, mode = 'last') {
  if (!chunk) return null;
  const re = /([A-Za-z][A-Za-z .']+?),\s*([A-Z]{2}|[A-Za-z]+(?: [A-Za-z]+)?)\s*\d{5}(?:-\d{4})?/g;
  let m, found = null;
  while ((m = re.exec(chunk)) !== null) {
    const city = m[1].replace(/^(.*\b)(ST|STE|SUITE|AVE|AVENUE|BLVD|ROAD|RD|DR|WAY)\b.*$/i, '').trim();
    const rawState = m[2].trim();
    const abbr = /^[A-Z]{2}$/.test(rawState) ? rawState.toUpperCase()
      : STATE_ABBR[rawState.toUpperCase()];
    if (!abbr) continue;
    const cleanCity = city.split(/\n/).pop().trim().replace(/^\d+\s+/, '');
    if (!/^[A-Za-z][A-Za-z .']+$/.test(cleanCity) || cleanCity.length > 40) continue;
    found = `${titleCity(cleanCity)}, ${abbr}`;
    if (mode === 'first') break;
  }
  return found;
}

function toYmd(m, d, y) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseRateconText(rawText) {
  const flat = String(rawText || '').replace(/\s+/g, ' ');
  const fields = {};
  const filled = [];

  // ---- load number ----
  const ln = flat.match(/Load\s*(?:Number|#)\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{3,20})/i);
  if (ln) { fields.load_number = ln[1]; filled.push('load #'); }

  // ---- miles ----
  const mi = flat.match(/Estimated Miles:\s*([\d,]+(?:\.\d+)?)/i)
    || flat.match(/Mileage to Next Stop:\s*([\d,]+(?:\.\d+)?)/i);
  if (mi) { fields.loaded_miles = String(Math.round(Number(mi[1].replace(/,/g, '')))); filled.push('loaded miles'); }

  // ---- money ----
  const transit = flat.match(/TRANSIT\s*([\d,]+\.?\d*)/i);
  const fsc = flat.match(/FUELSURCHG\s*([\d,]+\.?\d*)/i);
  const total = flat.match(/TOTAL:\s*USD\s*\$?\s*([\d,]+\.?\d*)/i)
    || flat.match(/Total\s*\$?\s*([\d,]+\.?\d*)/);
  if (transit && fsc) {
    fields.linehaul = String(money(transit[1]));
    fields.fsc = String(money(fsc[1]));
    filled.push('linehaul', 'FSC');
  } else if (total) {
    // One total, no FSC breakdown: the save step carves 65c x miles as FSC.
    fields.linehaul = String(money(total[1]));
    filled.push('linehaul (total — FSC carved out on save)');
  }

  // ---- broker ----
  if (/J\.?\s*B\.?\s*Hunt/i.test(flat)) { fields.broker = 'J.B. Hunt'; filled.push('broker'); }
  else if (/Garrett Logistics/i.test(flat)) { fields.broker = 'Garrett Logistics'; filled.push('broker'); }

  // ---- origin / destination ----
  // Split at the receiver/consignee boundary so each side yields its own city.
  const splitAt = flat.search(/Receiver or Delivery Location|Consignee Information/i);
  const pickupSide = splitAt >= 0 ? flat.slice(0, splitAt) : flat;
  const deliverySide = splitAt >= 0 ? flat.slice(splitAt) : '';
  const origin = cityState(pickupSide, 'last');
  if (origin) { fields.origin = origin; filled.push('origin'); }
  const dest = cityState(deliverySide, 'first');
  if (dest) { fields.destination = dest; filled.push('destination'); }

  // ---- dates ----
  const pickup = flat.match(/Pickup:\s*(\d{4})-(\d{2})-(\d{2})/)
    || flat.match(/Pick Up Time:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (pickup) {
    fields.date = pickup[3].length === 4
      ? toYmd(pickup[1], pickup[2], pickup[3])
      : `${pickup[1]}-${pickup[2]}-${pickup[3]}`;
    filled.push('pick date');
  }
  const delivery = flat.match(/Delivery Date and Time:\s*(\d{4})-(\d{2})-(\d{2})/)
    || flat.match(/Delivery Time:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (delivery) {
    fields.delivery_date = delivery[3].length === 4
      ? toYmd(delivery[1], delivery[2], delivery[3])
      : `${delivery[1]}-${delivery[2]}-${delivery[3]}`;
    filled.push('delivery date');
  }

  return { fields, filled };
}

module.exports = { parseRateconText };
