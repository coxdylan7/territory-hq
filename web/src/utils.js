// Port of the week / geo / route-optimization helpers from the original single-file app.

/* ---------------- ISO week helpers ---------------- */
export function weekKey(d) {
  let y, mo, da;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    y = +d.slice(0, 4); mo = +d.slice(5, 7); da = +d.slice(8, 10); // treat date-only strings literally
  } else {
    const dt = d ? new Date(d) : new Date();
    y = dt.getFullYear(); mo = dt.getMonth() + 1; da = dt.getDate();
  }
  const dt = new Date(Date.UTC(y, mo - 1, da));
  const dayNum = (dt.getUTCDay() + 6) % 7;           // Mon=0
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);         // nearest Thursday
  const year = dt.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  const wk = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(wk).padStart(2, '0')}`;
}
export function currentWeekKey() { return weekKey(new Date()); }
export function planForWeek(weekPlan, wk) { return weekPlan[wk] || {}; }
export function currentPlan(weekPlan) { return planForWeek(weekPlan, currentWeekKey()); }

// shift an ISO week key by ±delta weeks (handles year rollovers, no timezone drift)
export function shiftWeek(wk, delta) {
  const m = wk.match(/^(\d{4})-W(\d{2})$/); if (!m) return wk;
  const jan4 = new Date(Date.UTC(+m[1], 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(Date.UTC(+m[1], 0, 4 - jan4Day)); // Monday of week 1
  week1Mon.setUTCDate(week1Mon.getUTCDate() + (+m[2] - 1 + delta) * 7);
  return weekKey(week1Mon.toISOString().slice(0, 10));
}
export function prevWeekKey(wk) { return shiftWeek(wk, -1); }
export function nextWeekKey(wk) { return shiftWeek(wk, 1); }

// convert "2026-W27" + "Wed" into an ISO date
export function dateOfWeekDay(wk, day) {
  const m = wk.match(/^(\d{4})-W(\d{2})$/); if (!m) return null;
  const year = +m[1], week = +m[2];
  const dayIdx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[day];
  if (dayIdx == null) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4); week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const target = new Date(week1Mon); target.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7 + dayIdx);
  return target.toISOString().slice(0, 10);
}

export function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr + 'T00:00:00');
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export function todayStr() { return new Date().toISOString().slice(0, 10); }

// credit cost of an event booking: base + extra hours beyond the base duration
export function creditEstimate(et, hours) {
  if (!et) return 0;
  const h = Math.max(0, Number(hours) || 0);
  const baseH = Number(et.baseHours) || 0;
  return Math.round((Number(et.basePriceCredits) || 0) + Math.max(0, h - baseH) * (Number(et.extraHourCredits) || 0));
}

// Dollar value of an expense row. Mileage is valued at miles × rate so a row
// that logged miles but no amount (or was saved before amounts were computed)
// never shows a misleading $0.
export function expenseValue(e, rate) {
  const amt = Number(e && e.amount || 0);
  if (e && e.category === 'Mileage' && amt <= 0 && e.miles) return Math.round(Number(e.miles) * (rate || 0) * 100) / 100;
  return Math.round(amt * 100) / 100;
}

/* ---------------- pending reviews + recommendations ---------------- */
export function pendingReviews(weekPlan, routeLog) {
  const loggedDates = new Set(routeLog.map((l) => l.date));
  const out = [];
  Object.entries(weekPlan || {}).forEach(([wk, plan]) => {
    const byDay = {};
    Object.entries(plan).forEach(([accId, day]) => { (byDay[day] = byDay[day] || []).push(accId); });
    Object.entries(byDay).forEach(([day, accIds]) => {
      const date = dateOfWeekDay(wk, day);
      if (!date) return;
      if (date < todayStr() && !loggedDates.has(date)) {
        out.push({ week: wk, day, date, accountIds: accIds });
      }
    });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function recommendations(accounts, plan) {
  const recs = [];
  accounts.forEach((a) => {
    const ds = daysSince(a.lastVisited);
    const scheduledThisWeek = !!plan[a.id];
    if (scheduledThisWeek) return;
    let reason = null, weight = 0;
    if (a.status === 'Active' && ds >= 28) { reason = `Active account, no visit in ${ds === Infinity ? 'ever' : ds + ' days'}`; weight = ds; }
    else if (a.status === 'Prospect' && ds === Infinity) { reason = 'New prospect never visited'; weight = 25; }
    else if (a.status === 'Tracking' && ds >= 30) { reason = `Tracking account gone quiet (${ds}d)`; weight = ds - 10; }
    else if (ds >= 45) { reason = `No visit in ${ds === Infinity ? 'ever' : ds + ' days'}`; weight = ds; }
    const note = (a.notes || '').toLowerCase();
    if (/follow.?up|circle back|call back|check in|reorder/.test(note)) { reason = reason || 'Notes flag a follow-up'; weight += 15; }
    if (reason) recs.push({ account: a, reason, weight });
  });
  return recs.sort((x, y) => y.weight - x.weight).slice(0, 8);
}

/* ---------------- haversine + straight-line optimizer ---------------- */
export function haversineMiles(a, b) {
  if (a == null || b == null) return null;
  const R = 3958.8, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// nearest-neighbor + 2-opt over the flexible (non-priority) stops; priority stops first by priorityRank.
export function optimizeRoute(home, stops) {
  const withCoords = stops.filter((s) => s.lat != null && s.lng != null);
  const priorityStops = withCoords.filter((s) => s.priority).sort((a, b) => (a.priorityRank || 99) - (b.priorityRank || 99));
  let route = [];
  let cursor = home;
  priorityStops.forEach((s) => { route.push(s); cursor = { lat: s.lat, lng: s.lng }; });

  let remaining = withCoords.filter((s) => !s.priority);
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineMiles(cursor, { lat: s.lat, lng: s.lng });
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    route.push(next);
    cursor = { lat: next.lat, lng: next.lng };
  }

  const pLen = priorityStops.length;
  const routeLength = (seq) => {
    let total = haversineMiles(home, { lat: seq[0]?.lat, lng: seq[0]?.lng }) || 0;
    for (let i = 0; i < seq.length - 1; i++) total += haversineMiles({ lat: seq[i].lat, lng: seq[i].lng }, { lat: seq[i + 1].lat, lng: seq[i + 1].lng }) || 0;
    total += haversineMiles({ lat: seq[seq.length - 1]?.lat, lng: seq[seq.length - 1]?.lng }, home) || 0;
    return total;
  };
  let improved = true, guard = 0;
  while (improved && guard < 200) {
    improved = false; guard++;
    for (let i = pLen; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const newRoute = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
        if (routeLength(newRoute) < routeLength(route) - 0.001) { route = newRoute; improved = true; }
      }
    }
  }

  let totalMiles = 0, prev = home, out = [];
  route.forEach((s) => {
    const d = haversineMiles(prev, { lat: s.lat, lng: s.lng }) || 0;
    totalMiles += d;
    out.push({ ...s, legMiles: d });
    prev = { lat: s.lat, lng: s.lng };
  });
  const lastLeg = haversineMiles(prev, home) || 0;
  totalMiles += lastLeg;
  const skipped = stops.filter((s) => s.lat == null || s.lng == null);
  return { ordered: out, totalMiles, returnLeg: lastLeg, skipped };
}

export function gmapsUrl(home, ordered) {
  const pts = [home.homeAddress, ...ordered.map((o) => o.address + ', ' + (o.city || '') + ', NY'), home.homeAddress];
  return 'https://www.google.com/maps/dir/' + pts.map((p) => encodeURIComponent(p)).join('/');
}

function fmtMi(m) { return (m / 1609.344).toFixed(1) + ' mi'; }
function fmtMin(s) { return Math.round(s / 60) + ' min'; }

// Decode an OSRM/Google encoded polyline into [{lat, lng}, ...].
export function decodePolyline(encoded) {
  const pts = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dLat;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dLng;
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

// Real driving-route optimization via OpenStreetMap (OSRM public server) — no API key.
// Priority stops first (by priorityRank), then the flexible stops solved as a
// traveling-salesman trip, then back home. Falls back is handled by the caller.
const OSRM = 'https://router.project-osrm.org';

async function osrmJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('OSRM http ' + res.status);
      const d = await res.json();
      if (d.code !== 'Ok') throw new Error('OSRM ' + (d.code || 'error') + (d.message ? ': ' + d.message : ''));
      return d;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function optimizeRouteOSRM(home, stops) {
  const withCoords = stops.filter((s) => s.lat != null && s.lng != null);
  const skipped = stops.filter((s) => s.lat == null || s.lng == null);
  if (!withCoords.length) return { legs: [{ name: 'Back home', isHome: true, distanceText: '0.0 mi' }], totalMiles: 0, totalMinutes: 0, geometry: [], skipped, engine: 'osrm' };

  const priorityStops = withCoords.filter((s) => s.priority).sort((a, b) => (a.priorityRank || 99) - (b.priorityRank || 99));
  const flexible = withCoords.filter((s) => !s.priority);

  let ordered = [...priorityStops];
  let anchor = priorityStops.length ? priorityStops[priorityStops.length - 1] : home;

  if (flexible.length) {
    const coords = [[anchor.lng, anchor.lat], ...flexible.map((s) => [s.lng, s.lat]), [anchor.lng, anchor.lat]];
    const d = await osrmJson(OSRM + '/trip/v1/driving/' + coords.map((c) => c.join(',')).join(';') + '?roundtrip=true&source=first&destination=last&overview=false');
    const orderByTrip = d.waypoints.map((w, i) => ({ i, rank: w.waypoint_index })).slice(1, 1 + flexible.length).sort((a, b) => a.rank - b.rank);
    ordered = [...ordered, ...orderByTrip.map(({ i }) => flexible[i - 1])];
  }

  const full = [home, ...ordered, home];
  const route = await osrmJson(OSRM + '/route/v1/driving/' + full.map((p) => p.lng + ',' + p.lat).join(';') + '?overview=full&steps=false&continue_straight=false');
  const r = route.routes[0];

  const legs = ordered.map((s, i) => {
    const leg = r.legs[i] || { distance: 0, duration: 0 };
    return {
      ...s, distanceText: fmtMi(leg.distance || 0), durationText: fmtMin(leg.duration || 0),
      distanceVal: leg.distance || 0, durationVal: leg.duration || 0,
    };
  });
  const last = r.legs[r.legs.length - 1] || { distance: 0, duration: 0 };
  legs.push({ name: 'Back home', isHome: true, distanceText: fmtMi(last.distance), durationText: fmtMin(last.duration), distanceVal: last.distance, durationVal: last.duration });

  const totalMiles = legs.reduce((s, l) => s + (l.distanceVal || 0), 0) / 1609.344;
  const totalMinutes = legs.reduce((s, l) => s + (l.durationVal || 0), 0) / 60;
  return { legs, totalMiles, totalMinutes, geometry: decodePolyline(r.geometry), skipped, engine: 'osrm' };
}

// "Open in Google Maps" / "Open in Apple Maps" launch URLs (coordinate-based when possible).
export function mapsUrls(home, ordered) {
  const pts = [home, ...ordered, home].map((p) => (p.lat != null && p.lng != null) ? `${p.lat},${p.lng}` : null);
  const hasCoords = ordered.every((o) => o.lat != null && o.lng != null) && home.lat != null && home.lng != null;
  const src = hasCoords ? pts.map((p) => p).join('/') : null;
  const gmaps = hasCoords
    ? 'https://www.google.com/maps/dir/' + src
    : gmapsUrl(home, ordered);
  const apple = 'https://maps.apple.com/?dirflg=d' +
    (home.lat != null && home.lng != null ? '&saddr=' + home.lat + ',' + home.lng : '') +
    ordered.filter((o) => o.lat != null && o.lng != null).map((o) => '&daddr=' + o.lat + ',' + o.lng).join('');
  return { gmaps, apple };
}

/* ---------------- Google Maps loading + geocoding ---------------- */
let gmapsLoadPromise = null;
export function loadGoogleMaps(key) {
  if (window.google && window.google.maps) return Promise.resolve();
  if (gmapsLoadPromise) return gmapsLoadPromise;
  gmapsLoadPromise = new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      gmapsLoadPromise = null;
      reject(new Error('timed out loading Google Maps (bad key?)'));
    }, 5000);
    window.__gmapsReady = () => { clearTimeout(watchdog); resolve(); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__gmapsReady&libraries=places`;
    s.onerror = () => { clearTimeout(watchdog); gmapsLoadPromise = null; reject(new Error('Failed to load Google Maps JS API')); };
    document.head.appendChild(s);
  });
  return gmapsLoadPromise;
}

export async function geocode(addressStr, gmapsKey) {
  if (gmapsKey && /^AIza/.test(gmapsKey)) {
    try {
      await loadGoogleMaps(gmapsKey);
      const geocoder = new google.maps.Geocoder();
      const result = await new Promise((resolve, reject) => {
        geocoder.geocode({ address: addressStr }, (res, status) => status === 'OK' ? resolve(res) : reject(new Error(status)));
      });
      if (result && result[0]) {
        const loc = result[0].geometry.location;
        return { lat: loc.lat(), lng: loc.lng() };
      }
    } catch (e) { console.error('Google geocode failed, falling back to OSM', e); }
  } else if (gmapsKey) {
    console.error('Ignoring invalid Google Maps key (must start with AIza).');
  }
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(addressStr);
    const res = await fetch(url);
    if (!res.ok) throw new Error('geocode http ' + res.status);
    const data = await res.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    return null;
  } catch (e) { console.error('geocode failed', e); return null; }
}

// Real driving-route optimization via Google Directions API (only used when a gmaps key is set).
export async function optimizeRouteGoogle(home, stops, gmapsKey) {
  await loadGoogleMaps(gmapsKey);
  const svc = new google.maps.DirectionsService();
  const priorityStops = stops.filter((s) => s.priority && s.lat != null).sort((a, b) => (a.priorityRank || 99) - (b.priorityRank || 99));
  const flexible = stops.filter((s) => !s.priority && s.lat != null);
  const skipped = stops.filter((s) => s.lat == null || s.lng == null);
  const homeLoc = { lat: home.lat, lng: home.lng };
  let legs = [], renderResults = [], cursor = homeLoc;

  const runRoute = (origin, destination, waypoints, optimize) => new Promise((resolve, reject) => {
    svc.route({ origin, destination, waypoints, optimizeWaypoints: optimize, travelMode: 'DRIVING' }, (res, status) => {
      status === 'OK' ? resolve(res) : reject(new Error(status));
    });
  });

  if (priorityStops.length) {
    const dest = { lat: priorityStops[priorityStops.length - 1].lat, lng: priorityStops[priorityStops.length - 1].lng };
    const wps = priorityStops.slice(0, -1).map((s) => ({ location: { lat: s.lat, lng: s.lng }, stopover: true }));
    const result = await runRoute(cursor, dest, wps, false);
    renderResults.push(result);
    result.routes[0].legs.forEach((l, i) => legs.push({ ...priorityStops[i], distanceText: l.distance.text, durationText: l.duration.text, distanceVal: l.distance.value, durationVal: l.duration.value }));
    cursor = dest;
  }

  if (flexible.length) {
    const wps = flexible.map((s) => ({ location: { lat: s.lat, lng: s.lng }, stopover: true }));
    const result = await runRoute(cursor, homeLoc, wps, true);
    renderResults.push(result);
    const order = result.routes[0].waypoint_order;
    const legsArr = result.routes[0].legs;
    order.forEach((idx, i) => legs.push({ ...flexible[idx], distanceText: legsArr[i].distance.text, durationText: legsArr[i].duration.text, distanceVal: legsArr[i].distance.value, durationVal: legsArr[i].duration.value }));
    const lastLeg = legsArr[legsArr.length - 1];
    legs.push({ name: 'Back home', isHome: true, distanceText: lastLeg.distance.text, durationText: lastLeg.duration.text, distanceVal: lastLeg.distance.value, durationVal: lastLeg.duration.value });
  } else if (priorityStops.length) {
    const result = await runRoute(cursor, homeLoc, [], false);
    renderResults.push(result);
    const l = result.routes[0].legs[0];
    legs.push({ name: 'Back home', isHome: true, distanceText: l.distance.text, durationText: l.duration.text, distanceVal: l.distance.value, durationVal: l.duration.value });
  }

  const totalMiles = legs.reduce((s, l) => s + (l.distanceVal || 0), 0) / 1609.34;
  const totalMinutes = legs.reduce((s, l) => s + (l.durationVal || 0), 0) / 60;
  return { legs, totalMiles, totalMinutes, renderResults, skipped, engine: 'google' };
}