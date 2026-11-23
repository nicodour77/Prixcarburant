'use strict';

// Données officielles (flux instantané prix-carburants.gouv.fr), API Opendatasoft, CORS ouvert, sans clé.
const API =
  'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';
const FUEL_LABELS = { sp95: 'SP95', e10: 'SP95-E10', sp98: 'SP98', gazole: 'Gazole', e85: 'E85', gplc: 'GPL' };
const STALE_DAYS = 3; // au-delà, le prix est signalé comme ancien
const PREFS_KEY = 'prixcarburant.v1';

const $ = (id) => document.getElementById(id);
const els = {
  fuel: $('fuel'), radius: $('radius'), sort: $('sort'), refresh: $('refresh'),
  status: $('status'), list: $('list'), map: $('map'), title: $('fuel-title'),
};

let position = null; // { lat, lon }
let stations = [];
let map = null;
let markersLayer = null;
let view = 'list';

// ---------- préférences ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (p.fuel && FUEL_LABELS[p.fuel]) els.fuel.value = p.fuel;
    if (p.radius) els.radius.value = String(p.radius);
    if (p.sort) els.sort.value = p.sort;
  } catch { /* stockage indisponible : valeurs par défaut */ }
  if (!els.radius.value) els.radius.value = '10'; // valeur mémorisée invalide
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      fuel: els.fuel.value, radius: els.radius.value, sort: els.sort.value,
    }));
  } catch { /* ignore */ }
}

// ---------- utilitaires ----------
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}
function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtPrice = (p) => p.toFixed(3).replace('.', ',');
const fmtKm = (d) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1).replace('.', ',')} km`);
function fmtAge(date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 60) return `il y a ${Math.max(mins, 1)} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, p, l) => p + l.toUpperCase());
}

// ---------- géolocalisation ----------
function locate() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Géolocalisation non disponible sur cet appareil.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (err) => reject(new Error(
        err.code === 1 ? 'Accès à la position refusé. Autorisez la localisation pour ce site puis actualisez.'
          : err.code === 3 ? 'La position a mis trop de temps à arriver. Réessayez.'
          : 'Position indisponible.'
      )),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

// ---------- API ----------
// Nom du carburant dans les champs « rupture » du jeu de données.
const FUEL_DATA_NAME = { sp95: 'SP95', e10: 'E10', sp98: 'SP98', gazole: 'Gazole', e85: 'E85', gplc: 'GPLc' };
const PAGE = 100;        // maximum de l'API par requête
const MAX_STATIONS = 1000;

async function fetchPage(where, offset) {
  const params = new URLSearchParams({
    where,
    select: 'id,adresse,ville,cp,geom,sp95_prix,sp95_maj,e10_prix,e10_maj,sp98_prix,sp98_maj,gazole_prix,gazole_maj,'
      + 'e85_prix,e85_maj,gplc_prix,gplc_maj,horaires_automate_24_24,carburants_rupture_temporaire',
    order_by: 'id', // ordre stable pour la pagination
    limit: String(PAGE),
    offset: String(offset),
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Le service de prix a répondu ${res.status}.`);
  return res.json();
}

// Toutes les stations du rayon, qu'elles vendent ou non le carburant choisi.
async function fetchStations(pos, fuel, radiusKm) {
  const where = `within_distance(geom, geom'POINT(${pos.lon} ${pos.lat})', ${radiusKm}km)`;
  const first = await fetchPage(where, 0);
  const total = first.total_count || 0;
  const offsets = [];
  for (let o = PAGE; o < Math.min(total, MAX_STATIONS); o += PAGE) offsets.push(o);
  const rest = await Promise.all(offsets.map((o) => fetchPage(where, o)));
  const rows = [first, ...rest].flatMap((d) => d.results || []);
  const list = rows
    .filter((r) => r.geom)
    .map((r) => {
      const prix = r[`${fuel}_prix`] > 0 ? r[`${fuel}_prix`] : null;
      const maj = prix && r[`${fuel}_maj`] ? new Date(r[`${fuel}_maj`]) : null;
      const others = Object.keys(FUEL_LABELS)
        .filter((f) => f !== fuel && r[`${f}_prix`] > 0)
        .map((f) => ({ fuel: f, prix: r[`${f}_prix`] }));
      return {
        id: r.id,
        adresse: titleCase(r.adresse),
        ville: titleCase(r.ville),
        cp: r.cp,
        lat: r.geom.lat,
        lon: r.geom.lon,
        prix,
        maj,
        stale: prix != null && (!maj || Date.now() - maj.getTime() > STALE_DAYS * 86400000),
        rupture: String(r.carburants_rupture_temporaire || '').split(/[;,]\s*|\s+/).includes(FUEL_DATA_NAME[fuel]),
        others,
        h24: r.horaires_automate_24_24 === 'Oui',
        distance: haversineKm(pos, { lat: r.geom.lat, lon: r.geom.lon }),
      };
    });
  return { list, total };
}

// ---------- rendu ----------
function priceTiers(list) {
  // Les prix récents servent de référence : terciles bon marché / moyen / cher.
  const prices = list.filter((s) => s.prix != null && !s.stale).map((s) => s.prix).sort((a, b) => a - b);
  if (prices.length < 3) return () => '';
  const q = (f) => prices[Math.min(prices.length - 1, Math.floor(f * prices.length))];
  const lo = q(1 / 3), hi = q(2 / 3);
  return (p) => (p <= lo ? 'cheap' : p >= hi ? 'dear' : 'mid');
}

function sorted() {
  const key = els.sort.value;
  // Les stations qui vendent le carburant choisi d'abord, les autres ensuite par distance.
  return [...stations].sort((a, b) =>
    (a.prix == null) - (b.prix == null)
    || (key === 'distance' || a.prix == null ? a.distance - b.distance : a.prix - b.prix || a.distance - b.distance)
  );
}

const othersText = (s) => s.others.map((o) => `${FUEL_LABELS[o.fuel]} ${fmtPrice(o.prix)}`).join(' · ');

function navLinks(s) {
  const dest = `${s.lat},${s.lon}`;
  return `<a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">Google Maps</a>`;
}

// ---------- historique 7 jours ----------
// Fichiers officiels quotidiens (zip ~1 Mo, CORS ouvert) : dernier prix connu de chaque station à la fin du jour.
// J-6 à J-1 sont téléchargés une fois (Cache Storage, fichiers immuables) ; aujourd'hui = prix du flux instantané.
const HISTORY_DAYS = 7;
const DAY_URL = (ymd) => `https://donnees.roulez-eco.fr/opendata/jour/${ymd}`;
const FUEL_XML = { Gazole: 'gazole', SP95: 'sp95', E85: 'e85', GPLc: 'gplc', E10: 'e10', SP98: 'sp98' };
const dayCache = new Map(); // ymd -> Promise<Map<id, {fuel: {v, maj}}>>

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
function pastDays() {
  const out = [];
  for (let i = HISTORY_DAYS - 1; i >= 1; i--) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
    out.push(d);
  }
  return out;
}

async function fetchZip(url) {
  let cache = null;
  try { cache = await caches.open('prixcarburant-jours'); } catch { /* Cache API indisponible */ }
  let res = cache && (await cache.match(url));
  if (!res) {
    // Le CDN du site officiel sert ses copies en cache sans l'en-tête CORS : un paramètre unique force
    // une réponse de l'origine, qui l'inclut. Un nouvel essai en cas d'échec réseau.
    const get = () => fetch(`${url}?v=${Date.now()}${Math.random().toString(36).slice(2, 8)}`, { cache: 'no-store' });
    res = await get().catch(get);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (cache) await cache.put(url, res.clone()).catch(() => {});
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Extrait le premier fichier d'un zip (méthode deflate) via le répertoire central.
async function unzipFirst(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip invalide');
  const cd = dv.getUint32(eocd + 16, true);
  const method = dv.getUint16(cd + 10, true);
  const csize = dv.getUint32(cd + 20, true);
  const lho = dv.getUint32(cd + 42, true);
  const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
  const data = buf.subarray(start, start + csize);
  const raw = method === 0 ? data
    : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return new TextDecoder('iso-8859-1').decode(raw);
}

function parseDay(xml) {
  const byId = new Map();
  const reP = /<prix nom="([^"]+)"[^>]*?maj="([^"]+)"[^>]*?valeur="([^"]+)"/g;
  for (const chunk of xml.split('<pdv id="').slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const end = chunk.indexOf('</pdv>');
    const body = end >= 0 ? chunk.slice(0, end) : chunk;
    let m, prices = null;
    reP.lastIndex = 0;
    while ((m = reP.exec(body))) {
      const f = FUEL_XML[m[1]];
      if (f) (prices ||= {})[f] = { v: parseFloat(m[3]), maj: m[2] };
    }
    if (prices) byId.set(id, prices);
  }
  return byId;
}

function loadDay(d) {
  const key = ymd(d);
  if (!dayCache.has(key)) {
    const p = fetchZip(DAY_URL(key)).then(unzipFirst).then(parseDay);
    p.catch(() => dayCache.delete(key)); // permettre un nouvel essai
    dayCache.set(key, p);
  }
  return dayCache.get(key);
}

async function stationHistory(s, fuel) {
  const days = pastDays();
  const results = await Promise.allSettled(days.map(loadDay));
  const points = days.map((d, i) => {
    const r = results[i];
    const p = r.status === 'fulfilled' ? r.value.get(String(s.id))?.[fuel] : null;
    return { date: d, v: p ? p.v : null, missing: r.status !== 'fulfilled' };
  });
  points.push({ date: new Date(), v: s.prix, today: true });
  return points;
}

const fmtDay = (d) => d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }).replace('.', '');

function historyHtml(points) {
  const vals = points.filter((p) => p.v != null).map((p) => p.v);
  if (vals.length < 2) return '<p class="hist-msg">Pas assez de données sur 7 jours pour cette station.</p>';
  const min = Math.min(...vals), max = Math.max(...vals);
  const W = 320, H = 120, padX = 24, padTop = 22, padBot = 26;
  const span = max - min || 0.01;
  const x = (i) => padX + (i * (W - 2 * padX)) / (points.length - 1);
  const y = (v) => padTop + ((max - v) * (H - padTop - padBot)) / span;
  const known = points.map((p, i) => ({ ...p, i })).filter((p) => p.v != null);
  const path = known.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const dots = known.map((p) => {
    const prev = known[known.indexOf(p) - 1];
    const label = !prev || prev.v !== p.v || p.today; // n'étiqueter que les changements
    return `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="3.5"/>` +
      (label ? `<text x="${x(p.i)}" y="${y(p.v) - 8}" text-anchor="middle" class="v">${fmtPrice(p.v)}</text>` : '');
  }).join('');
  const days = points.map((p, i) =>
    `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="d">${p.today ? 'auj.' : fmtDay(p.date)}</text>`).join('');
  const first = known[0].v, last = known[known.length - 1].v, diff = last - first;
  const trend = Math.abs(diff) < 0.0005 ? 'stable sur 7 jours'
    : `${diff > 0 ? '▲ +' : '▼ '}${fmtPrice(diff).replace('-', '−')} € sur 7 jours`;
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du prix sur 7 jours">
      <path d="${path}"/>${dots}${days}
    </svg>
    <p class="hist-msg"><span class="${diff > 0.0005 ? 'up' : diff < -0.0005 ? 'down' : ''}">${trend}</span>
      · min ${fmtPrice(min)} · max ${fmtPrice(max)}
      ${points.some((p) => p.missing) ? ' · certains jours indisponibles' : ''}</p>`;
}

async function toggleHistory(li) {
  const box = li.querySelector('.hist');
  if (!box.hidden) { box.hidden = true; li.classList.remove('open'); return; }
  box.hidden = false; li.classList.add('open');
  const s = stations.find((x) => String(x.id) === li.dataset.id);
  if (!s) return;
  const fuel = els.fuel.value;
  const needDownload = pastDays().some((d) => !dayCache.has(ymd(d)));
  box.innerHTML = `<p class="hist-msg">${needDownload ? 'Téléchargement de l\'historique officiel (une seule fois, ~7 Mo)…' : 'Chargement…'}</p>`;
  try {
    const points = await stationHistory(s, fuel);
    if (fuel === els.fuel.value) box.innerHTML = historyHtml(points);
  } catch (e) {
    box.innerHTML = `<p class="hist-msg error">Historique indisponible : ${esc(e.message)}</p>`;
  }
}

function renderList() {
  const tier = priceTiers(stations);
  const label = FUEL_LABELS[els.fuel.value];
  els.list.innerHTML = sorted().map((s) => `
    <li class="station${s.prix == null ? ' without' : ''}" data-id="${esc(s.id)}" tabindex="0" aria-label="Afficher l'historique des prix">
      <div class="addr">${esc(s.adresse)}</div>
      ${s.prix != null
        ? `<div class="price ${s.stale ? 'stale' : tier(s.prix)}">${fmtPrice(s.prix)} <small>€/L</small></div>`
        : `<div class="price none">${s.rupture ? 'Rupture' : `Pas de ${esc(label)}`}</div>`}
      <div class="city">${esc(s.cp)} ${esc(s.ville)}</div>
      <div class="meta">
        <span>📍 ${fmtKm(s.distance)}</span>
        ${s.prix != null ? `<span class="${s.stale ? 'stale' : ''}">🕑 ${s.maj ? fmtAge(s.maj) : 'date inconnue'}</span>` : ''}
        ${s.stale ? '<span class="badge">prix ancien</span>' : ''}
        ${s.h24 ? '<span class="badge">24/24</span>' : ''}
      </div>
      ${s.others.length ? `<div class="others">${esc(othersText(s))}</div>` : ''}
      <div class="go">${navLinks(s)}<span class="hint">📈 Historique 7 j</span></div>
      <div class="hist" hidden></div>
    </li>`).join('');
}

function ensureMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map(els.map, { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function renderMap() {
  ensureMap();
  if (!map || !position) return;
  markersLayer.clearLayers();
  const tier = priceTiers(stations);
  const me = L.marker([position.lat, position.lon], {
    icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    zIndexOffset: 1000,
  }).bindPopup('Vous êtes ici');
  markersLayer.addLayer(me);
  const bounds = [[position.lat, position.lon]];
  for (const s of stations) {
    const has = s.prix != null;
    const cls = !has ? 'none' : s.stale ? 'stale' : tier(s.prix);
    const icon = L.divIcon({ className: '', html: `<div class="pin ${cls}">${has ? fmtPrice(s.prix) : '—'}</div>`,
      iconSize: has ? [52, 20] : [24, 20], iconAnchor: has ? [26, 10] : [12, 10] });
    L.marker([s.lat, s.lon], { icon, zIndexOffset: has ? 100 : 0 })
      .bindPopup(`<b>${esc(s.adresse)}</b><br>${esc(s.cp)} ${esc(s.ville)}<br>
        <b>${has ? fmtPrice(s.prix) + ' €/L' : (s.rupture ? 'Rupture de ' : 'Pas de ') + esc(FUEL_LABELS[els.fuel.value])}</b> · ${fmtKm(s.distance)}<br>
        <small>${s.maj ? 'Mis à jour ' + fmtAge(s.maj) : esc(othersText(s))}</small><br>${navLinks(s)}`)
      .addTo(markersLayer);
    bounds.push([s.lat, s.lon]);
  }
  map.invalidateSize();
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  else map.setView([position.lat, position.lon], 13);
}

function render() {
  if (view === 'list') renderList(); else renderMap();
}

function setView(v) {
  view = v;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  els.list.hidden = v !== 'list';
  els.map.hidden = v !== 'map';
  render();
}

// ---------- chargement ----------
let loading = false;
async function load({ relocate = false } = {}) {
  if (loading) return;
  loading = true;
  els.refresh.classList.add('spin');
  const fuel = els.fuel.value;
  els.title.textContent = FUEL_LABELS[fuel];
  try {
    if (!position || relocate) {
      setStatus('Recherche de votre position…');
      position = await locate();
    }
    setStatus(`Recherche des stations ${FUEL_LABELS[fuel]}…`);
    const { list, total } = await fetchStations(position, fuel, Number(els.radius.value));
    stations = list;
    const selling = list.filter((s) => s.prix != null);
    const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
    const more = total > list.length ? ` (${list.length} premières sur ${total})` : '';
    if (!list.length) {
      setStatus(`Aucune station dans un rayon de ${els.radius.value} km. Élargissez le rayon.`);
    } else if (!selling.length) {
      setStatus(`${plural(list.length, 'station')}${more}, aucune ne vend du ${FUEL_LABELS[fuel]}. Élargissez le rayon.`);
    } else {
      const fresh = selling.filter((s) => !s.stale);
      const best = (fresh.length ? fresh : selling).reduce((a, b) => (b.prix < a.prix ? b : a));
      setStatus(`${plural(list.length, 'station')}${more} dont ${selling.length} avec ${FUEL_LABELS[fuel]} · meilleur prix ${fmtPrice(best.prix)} € à ${fmtKm(best.distance)}`);
    }
    render();
  } catch (e) {
    stations = [];
    render();
    setStatus(e.message || 'Erreur inattendue.', true);
  } finally {
    loading = false;
    els.refresh.classList.remove('spin');
  }
}

// ---------- événements ----------
els.fuel.addEventListener('change', () => { savePrefs(); load(); });
els.radius.addEventListener('change', () => { savePrefs(); load(); });
els.sort.addEventListener('change', () => { savePrefs(); render(); });
els.refresh.addEventListener('click', () => load({ relocate: true }));
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
els.list.addEventListener('click', (e) => {
  const li = e.target.closest('.station');
  if (li && !e.target.closest('a, .hist')) toggleHistory(li);
});
els.list.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('station')) {
    e.preventDefault();
    toggleHistory(e.target);
  }
});

loadPrefs();
load();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
