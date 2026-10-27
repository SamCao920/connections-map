/* Connections Map
 * Data lives either in this browser (localStorage) or in a JSON file in a
 * private GitHub repo, read and written with the GitHub contents API.
 */
(() => {
  "use strict";

  // ---------- Storage keys & helpers ----------
  const K = {
    settings: "cm.settings",
    local: "cm.localData",
    cache: "cm.cache",
  };
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const nowISO = () => new Date().toISOString();
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------- State ----------
  let settings = store.get(K.settings, { repo: "", path: "contacts.json", token: "" });
  let data = emptyData();
  let tripsData = null;    // { settings, trips } written by the trip-alert task
  let sha = null;          // GitHub blob sha of the file we last read
  let editing = null;      // contact being edited (copy) or null
  let draftPlaces = [];    // places chosen in the edit form (may be empty)
  let activeTags = new Set();
  let nearFilter = null;   // { lat, lng, miles, label }

  function emptyData() { return { version: 1, updatedAt: nowISO(), contacts: [] }; }
  const connected = () => !!(settings.repo && settings.token);
  const live = () => data.contacts.filter((c) => !c.deleted);

  // ---------- Expiry ----------
  function isExpired(c, at = Date.now()) {
    return !!c.expiresAt && new Date(c.expiresAt).getTime() <= at;
  }
  function fmtMonth(iso) {
    const d = new Date(iso);
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  function expiryText(c) {
    if (!c.expiresAt) return "";
    // expiresAt is the first moment they are expired; show the last month they count
    const last = new Date(new Date(c.expiresAt).getTime() - 1);
    return isExpired(c) ? `Expired after ${fmtMonth(last)}` : `Until ${fmtMonth(last)}`;
  }

  // ---------- Geo ----------
  function miles(a, b) {
    const R = 3958.8, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // A contact has zero or more places. Older data stored a single `place`; normalize() converts it.
  const placesOf = (c) => c.places || [];
  const nearestMiles = (pt, c) => Math.min(Infinity, ...placesOf(c).map((p) => miles(pt, p)));
  const shortName = (p) => p.label.split(",")[0];
  const placesText = (c) => {
    const ps = placesOf(c);
    return ps.length === 1 ? ps[0].label : ps.map(shortName).join(" + ");
  };
  let lastGeocode = 0;
  async function geocode(q) {
    // Nominatim asks for at most 1 request per second.
    const wait = 1100 - (Date.now() - lastGeocode);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocode = Date.now();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    if (!res.ok) throw new Error(`Place search failed (${res.status})`);
    const rows = await res.json();
    return rows.map((r) => ({ label: placeLabel(r), lat: +r.lat, lng: +r.lon }));
  }
  async function reverseGeocode(lat, lng) {
    const wait = 1100 - (Date.now() - lastGeocode);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocode = Date.now();
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=10&lat=${lat}&lon=${lng}`;
    try {
      const res = await fetch(url, { headers: { "Accept-Language": "en" } });
      if (!res.ok) throw 0;
      return placeLabel(await res.json());
    } catch { return `${lat.toFixed(3)}, ${lng.toFixed(3)}`; }
  }
  function placeLabel(r) {
    const a = r.address || {};
    const local = a.city || a.town || a.village || a.municipality || a.county || r.name;
    const parts = [local, a.state, a.country].filter(Boolean);
    const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
    return uniq.join(", ") || r.display_name || "Unknown place";
  }

  // ---------- GitHub sync ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function ghURL() {
    const path = (settings.path || "contacts.json").split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${settings.repo}/contents/${path}`;
  }
  function ghHeaders() {
    return {
      Authorization: `Bearer ${settings.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
  async function ghRead() {
    const res = await fetch(`${ghURL()}?t=${Date.now()}`, { headers: ghHeaders(), cache: "no-store" });
    if (res.status === 404) {
      // Either the file doesn't exist yet (fine) or the repo/token is wrong.
      const repo = await fetch(`https://api.github.com/repos/${settings.repo}`, { headers: ghHeaders() });
      if (!repo.ok) throw new Error(`Can't see ${settings.repo}. Check the repo name and that the token has access to it.`);
      return { data: emptyData(), sha: null };
    }
    if (res.status === 401) throw new Error("GitHub rejected the token. It may be expired or mistyped.");
    if (!res.ok) throw new Error(`GitHub read failed (${res.status}).`);
    const j = await res.json();
    const parsed = JSON.parse(b64decode(j.content || "") || "{}");
    return { data: normalize(parsed), sha: j.sha };
  }
  // trips.json sits next to the contacts file; the trip-alert task writes it.
  async function ghReadTrips() {
    const dir = (settings.path || "contacts.json").split("/").slice(0, -1);
    const path = [...dir, "trips.json"].map(encodeURIComponent).join("/");
    const res = await fetch(`https://api.github.com/repos/${settings.repo}/contents/${path}?t=${Date.now()}`, { headers: ghHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    try { return JSON.parse(b64decode((await res.json()).content || "")); } catch { return null; }
  }
  async function ghWrite(payload, prevSha) {
    const body = {
      message: `Update connections (${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
      content: b64encode(JSON.stringify(payload, null, 2) + "\n"),
    };
    if (prevSha) body.sha = prevSha;
    const res = await fetch(ghURL(), { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (res.status === 401 || res.status === 403) throw new Error("GitHub refused the save. The token needs Contents: Read and write on this repo.");
    if (!res.ok) throw new Error(`GitHub save failed (${res.status}).`);
    const j = await res.json();
    return { sha: j.content.sha };
  }

  function fixContact(c) {
    if (c.deleted || Array.isArray(c.places)) return c;
    const { place, ...rest } = c;
    return { ...rest, places: place && Number.isFinite(place.lat) && Number.isFinite(place.lng) ? [place] : [] };
  }
  function normalize(d) {
    const out = emptyData();
    if (d && Array.isArray(d.contacts)) out.contacts = d.contacts.filter((c) => c && c.id).map(fixContact);
    if (d && d.updatedAt) out.updatedAt = d.updatedAt;
    return out;
  }
  // Union by id; newer updatedAt wins. Deletions are kept as tombstones.
  function merge(a, b) {
    const byId = new Map();
    for (const c of [...a.contacts, ...b.contacts]) {
      const prev = byId.get(c.id);
      if (!prev || (c.updatedAt || "") > (prev.updatedAt || "")) byId.set(c.id, c);
    }
    return { version: 1, updatedAt: nowISO(), contacts: [...byId.values()] };
  }

  // ---------- Load / save ----------
  function setSync(text, err = false) {
    const el = $("#sync");
    el.textContent = text;
    el.classList.toggle("err", err);
  }

  async function load() {
    $("#local-banner").hidden = connected();
    if (!connected()) {
      data = normalize(store.get(K.local, emptyData()));
      setSync("");
      render();
      return;
    }
    // Show the cached copy instantly, then fetch.
    const cached = store.get(K.cache, null);
    if (cached && cached.repo === settings.repo) { data = normalize(cached.data); render(); }
    setSync("Loading…");
    try {
      const r = await ghRead();
      data = r.data; sha = r.sha;
      store.set(K.cache, { repo: settings.repo, data });
      setSync("Synced");
      ghReadTrips().then((t) => { tripsData = t; renderAttention(); });
    } catch (e) {
      setSync(e.message, true);
    }
    render();
  }

  let saveTimer = null, saving = false, pending = false, dirty = false;
  function save() {
    data.updatedAt = nowISO();
    if (!connected()) { store.set(K.local, data); return; }
    store.set(K.cache, { repo: settings.repo, data });
    dirty = true;
    setSync("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  }
  async function flush() {
    if (saving) { pending = true; return; }
    saving = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await ghWrite(data, sha);
        if (!r.conflict) { sha = r.sha; if (!pending) dirty = false; setSync("Synced"); break; }
        // Someone (another device) saved first: pull, merge, retry.
        const remote = await ghRead();
        data = merge(remote.data, data);
        sha = remote.sha;
        render();
        if (attempt === 2) throw new Error("Couldn't save after 3 tries. Reload the page.");
      }
    } catch (e) {
      setSync(e.message, true);
    } finally {
      saving = false;
      if (pending) { pending = false; flush(); }
    }
  }

  // ---------- Map ----------
  const map = L.map("map", { worldCopyJump: true, zoomControl: true }).setView([30, -40], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  window.cmMap = map; // handy for debugging from the console
  let nearCircle = null;

  function pinIcon(count, cls) {
    const size = count > 1 ? 30 : 22;
    return L.divIcon({
      className: "",
      html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px">${count > 1 ? count : ""}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  }

  function drawMarkers(contacts) {
    markerLayer.clearLayers();
    const groups = new Map();
    // One pin per place; a person with several places appears at each of them.
    for (const c of contacts) {
      for (const p of placesOf(c)) {
        const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
        if (!groups.has(key)) groups.set(key, { place: p, list: [] });
        const g = groups.get(key);
        if (!g.list.includes(c)) g.list.push(c);
      }
    }
    for (const { place, list } of groups.values()) {
      const exp = list.filter((c) => isExpired(c)).length;
      const cls = exp === list.length ? "expired" : exp > 0 ? "mixed" : "";
      const { lat, lng, label } = place;
      const items = list
        .slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => {
          const others = placesOf(c).filter((p) => p.label !== label && miles(p, place) > 5).map(shortName);
          const also = others.length ? `<span class="pop-also">also ${esc(others.join(", "))}</span>` : "";
          return `<li class="${isExpired(c) ? "expired" : ""}"><button data-id="${esc(c.id)}">${esc(c.name)}</button>${also}</li>`;
        })
        .join("");
      const m = L.marker([lat, lng], { icon: pinIcon(list.length, cls), keyboard: true, title: list.map((c) => c.name).join(", ") });
      m.bindPopup(`<div class="pop-place">${esc(label)}</div><ul class="pop-list">${items}</ul>`);
      m.addTo(markerLayer);
    }
  }

  map.on("popupopen", (e) => {
    e.popup.getElement().querySelectorAll("button[data-id]").forEach((b) =>
      b.addEventListener("click", () => openEdit(b.dataset.id))
    );
  });

  map.on("click", async (e) => {
    if ($("#edit-view").hidden) return;
    const { lat, lng } = e.latlng.wrap();
    const p = { lat, lng, label: "Looking up place…" };
    addDraftPlace(p);
    p.label = await reverseGeocode(lat, lng);
    renderDraftPlaces();
  });

  // The floating panel covers the left 400px on wide screens and the bottom half on phones.
  function viewPad() {
    return innerWidth > 760 ? { paddingTopLeft: [410, 40], paddingBottomRight: [40, 40] }
      : { paddingTopLeft: [24, 24], paddingBottomRight: [24, innerHeight * 0.56] };
  }
  function centerOn(latlng, zoom) {
    const p = viewPad();
    const dx = (p.paddingTopLeft[0] - p.paddingBottomRight[0]) / 2;
    const dy = (p.paddingTopLeft[1] - p.paddingBottomRight[1]) / 2;
    const pt = map.project(latlng, zoom).subtract([dx, dy]);
    map.setView(map.unproject(pt, zoom), zoom);
  }
  function fitTo(contacts) {
    const pts = contacts.flatMap((c) => placesOf(c).map((p) => [p.lat, p.lng]));
    if (pts.length === 1) centerOn(pts[0], 9);
    else if (pts.length > 1) map.fitBounds(pts, { ...viewPad(), maxZoom: 9 });
  }

  // ---------- List rendering ----------
  function filtered() {
    const q = $("#search").value.trim().toLowerCase();
    const showExp = $("#show-expired").checked;
    return live().filter((c) => {
      if (!showExp && isExpired(c)) return false;
      if (activeTags.size && !(c.tags || []).some((t) => activeTags.has(t))) return false;
      if (q) {
        const hay = [c.name, ...placesOf(c).map((p) => p.label), c.met, c.notes, ...(c.tags || []), ...(c.meetings || []).flatMap((m) => [m.where, m.note])].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function render() {
    const all = live();
    // tags
    const tags = [...new Set(all.flatMap((c) => c.tags || []))].sort();
    for (const t of [...activeTags]) if (!tags.includes(t)) activeTags.delete(t);
    $("#tag-bar").innerHTML = tags
      .map((t) => `<button class="tag" aria-pressed="${activeTags.has(t)}" data-tag="${esc(t)}">${esc(t)}</button>`)
      .join("");

    let list = filtered();
    if (nearFilter) {
      list = list
        .map((c) => ({ c, d: nearestMiles(nearFilter, c) }))
        .filter((x) => x.d <= nearFilter.miles)
        .sort((a, b) => isExpired(a.c) - isExpired(b.c) || a.d - b.d)
        .map((x) => x.c);
    } else {
      list = list.sort((a, b) => isExpired(a) - isExpired(b) || a.name.localeCompare(b.name));
    }

    $("#empty").hidden = all.length > 0;
    $("#list").innerHTML = list
      .map((c) => {
        const exp = isExpired(c);
        const placed = placesOf(c).length > 0;
        const dist = nearFilter && placed ? ` · ${Math.round(nearestMiles(nearFilter, c))} mi` : "";
        const meta = [placed ? placesText(c) : "No location", c.met].filter(Boolean).map(esc).join(" · ");
        return `<li class="row ${exp ? "expired" : ""} ${placed ? "" : "unplaced"}" tabindex="0" data-id="${esc(c.id)}">
          <span class="dot" aria-hidden="true"></span>
          <div>
            <div class="name">${esc(c.name)}</div>
            <div class="meta">${meta}${esc(dist)}</div>
            ${lastMet(c) ? `<div class="exp">Last met ${esc(agoText(lastMet(c)))}${meetCount(c) > 1 ? ` · ${meetCount(c)} meetings` : ""}</div>` : ""}
            ${c.expiresAt ? `<div class="exp">${esc(expiryText(c))}</div>` : ""}
          </div>
        </li>`;
      })
      .join("");
    if (all.length && !list.length) {
      $("#list").innerHTML = `<li class="empty"><p class="muted">${nearFilter ? `No one within ${nearFilter.miles} miles of ${esc(nearFilter.label)}.` : "No matches."}</p></li>`;
    }

    drawMarkers(nearFilter ? list : filtered());
    renderAttention();
  }

  $("#list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) openEdit(row.dataset.id);
  });
  $("#list").addEventListener("keydown", (e) => {
    const row = e.target.closest(".row");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openEdit(row.dataset.id); }
  });
  $("#tag-bar").addEventListener("click", (e) => {
    const b = e.target.closest(".tag");
    if (!b) return;
    const t = b.dataset.tag;
    activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
    render();
  });
  $("#search").addEventListener("input", render);
  $("#show-expired").addEventListener("change", render);

  // ---------- Near search ----------
  $("#near-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#near-input").value.trim();
    const out = $("#near-result");
    if (!q) return clearNear();
    out.hidden = false;
    out.textContent = "Searching…";
    try {
      const [hit] = await geocode(q);
      if (!hit) { out.textContent = `Couldn't find “${q}”. Try a city name.`; return; }
      setNear(hit, +$("#near-radius").value);
    } catch (err) {
      out.textContent = err.message;
    }
  });
  function setNear(hit, mi, prefix = "") {
    const out = $("#near-result");
    out.hidden = false;
    $("#near-input").value = hit.label.split(",")[0];
    nearFilter = { lat: hit.lat, lng: hit.lng, miles: mi, label: hit.label };
    if (nearCircle) nearCircle.remove();
    nearCircle = L.circle([hit.lat, hit.lng], { radius: mi * 1609.34, color: getCss("--cobalt"), weight: 1, fillOpacity: 0.06 }).addTo(map);
    map.fitBounds(nearCircle.getBounds(), viewPad());
    render();
    const n = $("#list").querySelectorAll(".row").length;
    const active = $("#list").querySelectorAll(".row:not(.expired)").length;
    out.innerHTML = `${prefix}${n ? `${active} current${n - active ? `, ${n - active} expired` : ""}` : "No one"} within ${mi} mi of <strong>${esc(hit.label)}</strong>. <button class="link-btn clear" type="button">Clear</button>`;
    out.querySelector(".clear").addEventListener("click", clearNear);
  }
  $("#near-radius").addEventListener("change", () => {
    if (nearFilter) setNear({ lat: nearFilter.lat, lng: nearFilter.lng, label: nearFilter.label }, +$("#near-radius").value);
  });
  function clearNear() {
    nearFilter = null;
    $("#near-input").value = "";
    $("#near-result").hidden = true;
    if (nearCircle) { nearCircle.remove(); nearCircle = null; }
    render();
  }
  function getCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  // ---------- Edit form ----------
  const thisYear = new Date().getFullYear();
  $("#f-exp-month").innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("");
  $("#f-exp-year").innerHTML = Array.from({ length: 31 }, (_, i) => thisYear - 5 + i)
    .map((y) => `<option value="${y}">${y}</option>`).join("");

  function expMode() { return document.querySelector('input[name="exp-mode"]:checked').value; }
  function setExpMode(v) { document.querySelector(`input[name="exp-mode"][value="${v}"]`).checked = true; }

  // Returns ISO of the first moment the contact counts as expired, or null.
  function computeExpiry() {
    const mode = expMode();
    if (mode === "none") return null;
    if (mode === "date") {
      const m = +$("#f-exp-month").value, y = +$("#f-exp-year").value;
      return new Date(y, m + 1, 1).toISOString(); // start of the following month
    }
    const n = Math.max(1, Math.min(99, parseInt($("#f-exp-n").value, 10) || 1));
    const d = new Date();
    if ($("#f-exp-unit").value === "years") d.setFullYear(d.getFullYear() + n);
    else d.setMonth(d.getMonth() + n);
    return d.toISOString();
  }
  function updateExpPreview() {
    const iso = computeExpiry();
    $("#f-exp-preview").textContent = iso ? `${expiryText({ expiresAt: iso })}.` : "";
  }
  document.querySelectorAll('input[name="exp-mode"]').forEach((r) => r.addEventListener("change", updateExpPreview));
  ["#f-exp-month", "#f-exp-year", "#f-exp-n", "#f-exp-unit"].forEach((s) => {
    $(s).addEventListener("input", () => {
      setExpMode(s === "#f-exp-month" || s === "#f-exp-year" ? "date" : "duration");
      updateExpPreview();
    });
  });

  // The form edits a list of places; each shows as a chip and a draft pin on the map.
  let draftMarkers = [];
  function renderDraftPlaces() {
    $("#f-places").innerHTML = draftPlaces
      .map((p, i) => `<li class="chip">${esc(p.label)}<button type="button" data-i="${i}" aria-label="Remove ${esc(p.label)}">×</button></li>`)
      .join("");
    const hint = $("#f-place-chosen");
    hint.textContent = draftPlaces.length
      ? "Add another place if they split their time, or tap the map."
      : "Optional. Leave empty for someone you only reach online. Search, or tap the map.";
    draftMarkers.forEach((m) => m.remove());
    draftMarkers = draftPlaces.map((p) => L.marker([p.lat, p.lng], { icon: pinIcon(1, "draft"), interactive: false }).addTo(map));
  }
  function addDraftPlace(p) {
    draftPlaces.push(p);
    renderDraftPlaces();
    centerOn([p.lat, p.lng], Math.max(map.getZoom(), 6));
  }
  function setDraftPlaces(list) {
    draftPlaces = list.map((p) => ({ ...p }));
    renderDraftPlaces();
  }
  $("#f-places").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    draftPlaces.splice(+b.dataset.i, 1);
    renderDraftPlaces();
  });

  function showView(which) {
    $("#list-view").hidden = which !== "list";
    $("#edit-view").hidden = which !== "edit";
    $("#pick-hint").hidden = which !== "edit";
  }

  function openEdit(id) {
    map.closePopup();
    const c = id ? live().find((x) => x.id === id) : null;
    editing = c ? { ...c } : null;
    $("#edit-title").textContent = c ? c.name : "Add a connection";
    $("#f-name").value = c?.name || "";
    $("#f-met").value = c?.met || "";
    draftTags = [...(c?.tags || [])];
    $("#f-tags").value = "";
    renderChips();
    $("#f-reach").value = c?.reach || "";
    // Old free-text notes become an undated first log entry.
    draftMeetings = (c?.meetings || []).map((m) => ({ ...m }));
    if (c?.notes && !draftMeetings.some((m) => m.legacy)) {
      draftMeetings.push({ id: uid(), date: (c.addedAt || nowISO()).slice(0, 10), where: "Notes", note: c.notes, legacy: true });
    }
    resetMeetingInputs();
    renderMeetings();
    $("#f-place-q").value = "";
    $("#f-place-results").hidden = true;
    $("#form-error").hidden = true;
    $("#delete-btn").hidden = !c;
    disarmDelete();

    if (c?.expiresAt) {
      const last = new Date(new Date(c.expiresAt).getTime() - 1);
      $("#f-exp-month").value = last.getMonth();
      if (![...$("#f-exp-year").options].some((o) => +o.value === last.getFullYear())) {
        $("#f-exp-year").insertAdjacentHTML("beforeend", `<option value="${last.getFullYear()}">${last.getFullYear()}</option>`);
      }
      $("#f-exp-year").value = last.getFullYear();
      setExpMode("date");
    } else {
      const d = new Date(); d.setFullYear(d.getFullYear() + 1);
      $("#f-exp-month").value = d.getMonth();
      $("#f-exp-year").value = d.getFullYear();
      setExpMode("none");
    }
    updateExpPreview();
    setDraftPlaces(c ? placesOf(c) : []);
    if (draftPlaces.length) {
      const pts = draftPlaces.map((p) => [p.lat, p.lng]);
      if (pts.length === 1) centerOn(pts[0], Math.max(map.getZoom(), 6));
      else map.fitBounds(pts, { ...viewPad(), maxZoom: 6 });
    }
    showView("edit");
    $("#edit-view").scrollTop = 0;
    if (!c) $("#f-name").focus({ preventScroll: true });
  }

  function closeEdit() {
    editing = null;
    setDraftPlaces([]);
    showView("list");
    render();
  }

  async function findPlace() {
    const q = $("#f-place-q").value.trim();
    if (!q) return;
    const ul = $("#f-place-results");
    ul.hidden = false;
    ul.innerHTML = `<li><button type="button" disabled>Searching…</button></li>`;
    try {
      const hits = await geocode(q);
      if (!hits.length) { ul.innerHTML = `<li><button type="button" disabled>No matches. Try a city name.</button></li>`; return; }
      ul.innerHTML = hits.map((h, i) => `<li><button type="button" data-i="${i}">${esc(h.label)}</button></li>`).join("");
      ul.querySelectorAll("button[data-i]").forEach((b) => b.addEventListener("click", () => {
        const h = hits[+b.dataset.i];
        if (!draftPlaces.some((p) => Math.abs(p.lat - h.lat) < 0.01 && Math.abs(p.lng - h.lng) < 0.01)) addDraftPlace(h);
        $("#f-place-q").value = "";
        ul.hidden = true;
      }));
    } catch (e) {
      ul.innerHTML = `<li><button type="button" disabled>${esc(e.message)}</button></li>`;
    }
  }

  // ---------- Meeting log ----------
  let draftMeetings = [];
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const sortMeetings = (ms) => ms.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  function fmtDay(s) {
    const [y, m, d] = s.split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
  function lastMet(c) {
    const ms = (c.meetings || []).filter((m) => !m.legacy);
    if (!ms.length) return null;
    return sortMeetings(ms)[0].date;
  }
  function agoText(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const days = Math.floor((Date.now() - new Date(y, m - 1, d).getTime()) / 86400000);
    if (days < 0) return `on ${fmtDay(dateStr)}`;
    if (days === 0) return "today";
    if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    if (days < 730) return `${Math.round(days / 30.4)} months ago`;
    return `${Math.round(days / 365.25)} years ago`;
  }
  const meetCount = (c) => (c.meetings || []).filter((m) => !m.legacy).length;
  function resetMeetingInputs() {
    $("#m-date").value = todayStr();
    $("#m-where").value = "";
    $("#m-note").value = "";
  }
  function logPendingMeeting() {
    const where = $("#m-where").value.trim(), note = $("#m-note").value.trim();
    if (!where && !note) return false;
    draftMeetings.push({ id: uid(), date: $("#m-date").value || todayStr(), where, note });
    resetMeetingInputs();
    renderMeetings();
    return true;
  }
  function renderMeetings() {
    const list = sortMeetings(draftMeetings);
    $("#m-list").innerHTML = list.length
      ? list.map((m) => `<li>
          <div class="log-head"><span class="log-date">${esc(fmtDay(m.date))}</span>${m.where ? `<span class="log-where">${esc(m.where)}</span>` : ""}
            <button type="button" class="log-del" data-id="${esc(m.id)}" aria-label="Remove meeting on ${esc(fmtDay(m.date))}">×</button></div>
          ${m.note ? `<p class="log-note">${esc(m.note)}</p>` : ""}
        </li>`).join("")
      : `<li class="muted small">No meetings logged yet.</li>`;
  }
  $("#m-add").addEventListener("click", () => {
    if (!logPendingMeeting()) { $("#m-where").focus(); }
  });
  $("#m-list").addEventListener("click", (e) => {
    const b = e.target.closest(".log-del");
    if (!b) return;
    draftMeetings = draftMeetings.filter((m) => m.id !== b.dataset.id);
    renderMeetings();
  });

  // ---------- Suggestion dropdowns (tags, where you met) ----------
  let draftTags = [];
  const normTag = (t) => t.trim().toLowerCase().replace(/\s+/g, " ");
  function allTags() {
    const counts = new Map();
    for (const c of live()) for (const t of c.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => ({ value: t, count: n }));
  }
  function allMet() {
    const counts = new Map();
    for (const c of live()) if (c.met) counts.set(c.met, (counts.get(c.met) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => ({ value: t, count: n }));
  }
  function addTag(raw) {
    for (const part of String(raw).split(",")) {
      const t = normTag(part);
      if (t && !draftTags.includes(t)) draftTags.push(t);
    }
    $("#f-tags").value = "";
    renderChips();
  }
  function renderChips() {
    $("#f-tags-chips").innerHTML = draftTags
      .map((t, i) => `<span class="chip">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove ${esc(t)}">×</button></span>`)
      .join("");
  }
  $("#f-tags-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    draftTags.splice(+b.dataset.i, 1);
    renderChips();
    $("#f-tags").focus();
  });
  $("#f-tags-box").addEventListener("click", (e) => { if (e.target.id === "f-tags-box") $("#f-tags").focus(); });

  // Generic combobox: options(query) -> [{value,label,count}], pick(value)
  function combo(input, ul, options, pick, { onEnterNoPick } = {}) {
    let items = [], hi = -1;
    function open() {
      items = options(input.value);
      hi = items.length && input.value.trim() ? 0 : -1;
      draw();
    }
    function close() { ul.hidden = true; input.setAttribute("aria-expanded", "false"); hi = -1; }
    function draw() {
      if (!items.length) return close();
      ul.innerHTML = items
        .map((it, i) => `<li role="option" id="${ul.id}-${i}" aria-selected="${i === hi}" data-i="${i}">${it.label ?? esc(it.value)}${it.count ? `<span class="count">${it.count}</span>` : ""}</li>`)
        .join("");
      ul.hidden = false;
      input.setAttribute("aria-expanded", "true");
      if (hi >= 0) input.setAttribute("aria-activedescendant", `${ul.id}-${hi}`); else input.removeAttribute("aria-activedescendant");
    }
    function choose(i) { pick(items[i].value); open(); }
    ul.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-i]");
      if (!li) return;
      e.preventDefault(); // keep focus in the input
      choose(+li.dataset.i);
    });
    input.addEventListener("input", open);
    input.addEventListener("click", open);
    input.addEventListener("blur", () => setTimeout(close, 100));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (ul.hidden) return open(); hi = Math.min(items.length - 1, hi + 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(0, hi - 1); draw(); }
      else if (e.key === "Escape" && !ul.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter") {
        if (!ul.hidden && hi >= 0) { e.preventDefault(); choose(hi); }
        else if (onEnterNoPick) { e.preventDefault(); onEnterNoPick(); }
      }
    });
    return { open, close };
  }

  const tagCombo = combo(
    $("#f-tags"),
    $("#f-tags-suggest"),
    (q) => {
      const n = normTag(q);
      const list = allTags().filter((t) => !draftTags.includes(t.value) && (!n || t.value.includes(n)));
      if (n && !allTags().some((t) => t.value === n) && !draftTags.includes(n)) {
        list.push({ value: n, label: `Add new tag “${esc(n)}”` });
      }
      return list.slice(0, 12);
    },
    (v) => addTag(v),
    { onEnterNoPick: () => addTag($("#f-tags").value) }
  );
  $("#f-tags").addEventListener("keydown", (e) => {
    if (e.key === ",") { e.preventDefault(); addTag($("#f-tags").value); tagCombo.open(); }
    else if (e.key === "Backspace" && !$("#f-tags").value && draftTags.length) { draftTags.pop(); renderChips(); tagCombo.open(); }
  });

  combo(
    $("#f-met"),
    $("#f-met-suggest"),
    (q) => {
      const n = q.trim().toLowerCase();
      return allMet().filter((m) => m.value.toLowerCase() !== n && (!n || m.value.toLowerCase().includes(n))).slice(0, 8);
    },
    (v) => { $("#f-met").value = v; }
  );

  $("#f-place-find").addEventListener("click", findPlace);
  $("#f-place-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); findPlace(); } });

  $("#edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#f-name").value.trim();
    const err = $("#form-error");
    if (!name) { err.textContent = "Add a name."; err.hidden = false; $("#f-name").focus(); return; }
    if (draftPlaces.some((p) => p.label === "Looking up place…")) { err.textContent = "Still looking up a place. Try again in a second."; err.hidden = false; return; }
    addTag($("#f-tags").value);
    const tags = [...draftTags];
    const { place: _legacy, ...base } = editing || { id: uid(), addedAt: nowISO() };
    const c = {
      ...base,
      name,
      places: draftPlaces.map((p) => ({ label: p.label, lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5) })),
      met: $("#f-met").value.trim(),
      tags,
      reach: $("#f-reach").value.trim(),
      notes: "",
      meetings: (logPendingMeeting(), sortMeetings(draftMeetings)),
      expiresAt: computeExpiry(),
      updatedAt: nowISO(),
    };
    const i = data.contacts.findIndex((x) => x.id === c.id);
    if (i >= 0) data.contacts[i] = c; else data.contacts.push(c);
    save();
    closeEdit();
  });
  $("#cancel-btn").addEventListener("click", closeEdit);
  // Two-tap confirm in the page itself; native confirm() is blocked in some browsers.
  function armConfirm(btn, label, armedLabel, action) {
    let timer = null;
    const disarm = () => { clearTimeout(timer); btn.dataset.armed = ""; btn.textContent = label; };
    btn.addEventListener("click", () => {
      if (btn.dataset.armed === "1") { disarm(); action(); return; }
      btn.dataset.armed = "1";
      btn.textContent = armedLabel;
      timer = setTimeout(disarm, 4000);
    });
    return disarm;
  }
  const disarmDelete = armConfirm($("#delete-btn"), "Delete", "Tap again to delete", () => {
    if (!editing) return;
    const i = data.contacts.findIndex((x) => x.id === editing.id);
    if (i >= 0) data.contacts[i] = { id: editing.id, deleted: true, updatedAt: nowISO() };
    save();
    closeEdit();
  });
  $("#add-btn").addEventListener("click", () => openEdit(null));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#edit-view").hidden && !$("#settings").open) closeEdit(); });

  // ---------- Settings ----------
  const dlg = $("#settings");
  function openSettings() {
    $("#s-repo").value = settings.repo;
    $("#s-path").value = settings.path || "contacts.json";
    $("#s-token").value = settings.token;
    $("#s-msg").textContent = connected() ? `Connected to ${settings.repo}.` : "Not connected. Contacts are saved in this browser only.";
    dlg.showModal();
    refreshNotifStatus();
  }
  $("#settings-btn").addEventListener("click", openSettings);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-open-settings]")) openSettings(); });

  $("#s-connect").addEventListener("click", async () => {
    const repo = $("#s-repo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    const path = $("#s-path").value.trim() || "contacts.json";
    const token = $("#s-token").value.trim();
    const msg = $("#s-msg");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { msg.textContent = "Repo should look like username/repo-name."; return; }
    if (!token) { msg.textContent = "Paste a token first."; return; }
    msg.textContent = "Checking…";
    const prevLocal = !connected() ? live() : [];
    const prev = settings;
    settings = { repo, path, token };
    try {
      const meta = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders() });
      if (meta.status === 401) throw new Error("GitHub rejected the token. It may be expired or mistyped.");
      if (!meta.ok) throw new Error(`Can't see ${repo}. Check the repo name and that the token has access to it.`);
      if (!(await meta.json()).private) throw new Error(`${repo} is public, so your contacts would be visible to anyone. Use a private repo, e.g. your-username/connections-data.`);
      const r = await ghRead();
      data = r.data; sha = r.sha;
      // Carry over anything added while in browser-only mode.
      if (prevLocal.length) {
        data = merge(data, { contacts: store.get(K.local, emptyData()).contacts || [] });
      }
      store.set(K.settings, settings);
      store.set(K.cache, { repo, data });
      msg.textContent = `Connected to ${repo}. ${live().length} connections loaded.`;
      $("#local-banner").hidden = true;
      setSync("Synced");
      render();
      if (prevLocal.length) { save(); store.del(K.local); }
      else if (!sha) save(); // create the file
    } catch (e) {
      settings = prev;
      msg.textContent = e.message;
    }
  });
  armConfirm($("#s-disconnect"), "Disconnect", "Tap again to disconnect", () => {
    if (!connected()) return;
    settings = { repo: "", path: "contacts.json", token: "" };
    store.set(K.settings, settings);
    store.del(K.cache);
    sha = null;
    $("#s-token").value = "";
    $("#s-msg").textContent = "Disconnected.";
    load();
  });
  $("#s-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `connections-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("#s-import").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const incoming = normalize(JSON.parse(await f.text()));
      const before = live().length;
      data = merge(data, incoming);
      save();
      render();
      $("#s-msg").textContent = `Imported. ${live().length - before} new connections.`;
    } catch {
      $("#s-msg").textContent = "That file isn't a valid connections export.";
    }
    e.target.value = "";
  });

  // Re-render when the tab regains focus so expiries flip on time,
  // and pull changes made on other devices.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && $("#edit-view").hidden) {
      if (connected() && !saving && !dirty) load(); else render();
    }
  });

  // ---------- Needs attention: upcoming trips, expiry check-ins ----------
  const DAY = 86400000;
  const dismissedTrips = new Set(store.get("cm.dismissedTrips", []));
  function fmtRange(a, b) {
    const [ya, ma, da] = a.split("-").map(Number), [yb, mb, db] = (b || a).split("-").map(Number);
    if (a === b || !b) return `${MONTHS[ma - 1]} ${da}`;
    if (ma === mb && ya === yb) return `${MONTHS[ma - 1]} ${da} to ${db}`;
    return `${MONTHS[ma - 1]} ${da} to ${MONTHS[mb - 1]} ${db}`;
  }
  function tripMatches(t) {
    const r = tripsData?.settings?.radiusMiles || 50;
    const at = new Date(t.start + "T12:00:00").getTime();
    return live().filter((c) => !isExpired(c, at) && nearestMiles(t, c) <= r);
  }
  function upcomingTrips() {
    const today = todayStr();
    return (tripsData?.trips || [])
      .filter((t) => (t.end || t.start) >= today && !dismissedTrips.has(t.id))
      .map((t) => ({ t, people: tripMatches(t) }))
      .filter((x) => x.people.length)
      .sort((a, b) => a.t.start.localeCompare(b.t.start));
  }
  function needsCheckIn(c, now = Date.now()) {
    // "Still there?" only makes sense for someone pinned somewhere.
    if (!c.expiresAt || c.expiryAck === c.expiresAt || !placesOf(c).length) return false;
    const t = new Date(c.expiresAt).getTime();
    return t - now <= 30 * DAY && now - t <= 120 * DAY;
  }
  function renderAttention() {
    const box = $("#attention");
    if (!$("#edit-view").hidden) return;
    const trips = upcomingTrips();
    const checks = live().filter((c) => needsCheckIn(c)).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    const html = [];
    for (const { t, people } of trips) {
      const names = people.slice(0, 3).map((c) => c.name.split(" ")[0]).join(", ") + (people.length > 3 ? ` +${people.length - 3}` : "");
      html.push(`<li class="card trip" data-trip="${esc(t.id)}">
        <button class="card-main" type="button" data-act="trip">
          <span class="card-title">${esc(t.city)} · ${esc(fmtRange(t.start, t.end))}</span>
          <span class="card-sub">${people.length} ${people.length === 1 ? "person" : "people"} there: ${esc(names)}</span>
        </button>
        <button class="card-x" type="button" data-act="dismiss-trip" aria-label="Dismiss trip to ${esc(t.city)}">×</button>
      </li>`);
    }
    for (const c of checks) {
      const city = placesOf(c).map(shortName).join(" or ");
      const expired = isExpired(c);
      html.push(`<li class="card check" data-id="${esc(c.id)}">
        <div class="card-main">
          <span class="card-title">Is ${esc(c.name.split(" ")[0])} still in ${esc(city)}?</span>
          <span class="card-sub">${expired ? "Expired" : "Expires"} ${esc(fmtMonth(new Date(new Date(c.expiresAt).getTime() - 1).toISOString()))}</span>
          <span class="card-actions">
            <button class="btn small" type="button" data-act="extend">Yes, +1 year</button>
            <button class="btn small" type="button" data-act="moved">Moved</button>
            <button class="btn small danger-text" type="button" data-act="remove">Remove</button>
          </span>
        </div>
        <button class="card-x" type="button" data-act="ack" aria-label="Let it expire">×</button>
      </li>`);
    }
    box.innerHTML = html.join("");
    box.hidden = !html.length;
  }
  const removeArmed = new Map();
  $("#attention").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const card = b.closest(".card");
    const act = b.dataset.act;
    if (act === "trip") {
      const t = tripsData.trips.find((x) => x.id === card.dataset.trip);
      setNear({ lat: t.lat, lng: t.lng, label: t.city }, tripsData?.settings?.radiusMiles || 50, `Trip ${esc(fmtRange(t.start, t.end))}: `);
      return;
    }
    if (act === "dismiss-trip") {
      dismissedTrips.add(card.dataset.trip);
      store.set("cm.dismissedTrips", [...dismissedTrips]);
      renderAttention();
      return;
    }
    const i = data.contacts.findIndex((x) => x.id === card.dataset.id);
    if (i < 0) return;
    const c = data.contacts[i];
    if (act === "extend") {
      const base = Math.max(Date.now(), new Date(c.expiresAt).getTime());
      const d = new Date(base); d.setFullYear(d.getFullYear() + 1);
      data.contacts[i] = { ...c, expiresAt: d.toISOString(), updatedAt: nowISO() };
    } else if (act === "ack") {
      data.contacts[i] = { ...c, expiryAck: c.expiresAt, updatedAt: nowISO() };
    } else if (act === "moved") {
      openEdit(c.id);
      $("#f-place-q").focus();
      return;
    } else if (act === "remove") {
      if (!removeArmed.get(c.id)) {
        removeArmed.set(c.id, setTimeout(() => { removeArmed.delete(c.id); b.textContent = "Remove"; }, 4000));
        b.textContent = "Tap again";
        return;
      }
      clearTimeout(removeArmed.get(c.id)); removeArmed.delete(c.id);
      data.contacts[i] = { id: c.id, deleted: true, updatedAt: nowISO() };
    }
    save();
    render();
  });

  // ---------- Trip notifications (web push) ----------
  function dataPath(name) {
    const dir = (settings.path || "contacts.json").split("/").slice(0, -1);
    return [...dir, name].map(encodeURIComponent).join("/");
  }
  async function ghGetJSON(name) {
    const res = await fetch(`https://api.github.com/repos/${settings.repo}/contents/${dataPath(name)}?t=${Date.now()}`, { headers: ghHeaders(), cache: "no-store" });
    if (res.status === 404) return { json: null, sha: null };
    if (!res.ok) throw new Error(`Couldn’t read ${name} (${res.status}).`);
    const j = await res.json();
    return { json: JSON.parse(b64decode(j.content || "") || "null"), sha: j.sha };
  }
  // Read-modify-write a JSON file in the data repo, retrying if another device or the Action wrote first.
  async function ghUpdateJSON(name, mutate, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { json, sha: fileSha } = await ghGetJSON(name);
      const next = mutate(json);
      const body = { message, content: b64encode(JSON.stringify(next, null, 2) + "\n") };
      if (fileSha) body.sha = fileSha;
      const res = await fetch(`https://api.github.com/repos/${settings.repo}/contents/${dataPath(name)}`, {
        method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (res.ok) return next;
      if (res.status !== 409 && res.status !== 422) throw new Error(`Couldn’t save ${name} (${res.status}).`);
    }
    throw new Error(`Couldn’t save ${name}: it kept changing. Try again.`);
  }
  function b64urlToBytes(s) {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }
  function deviceName() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
      : /Macintosh/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
    const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
    return br && os !== "iPhone" && os !== "iPad" ? `${os} ${br}` : os;
  }
  const isIOS = () => /iPhone|iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  function nShow(state, text) {
    $("#n-status").textContent = text;
    $("#n-on").hidden = state === "on";
    $("#n-test").hidden = state !== "on";
    $("#n-off").hidden = state !== "on";
  }
  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function refreshNotifStatus() {
    if (!connected()) return nShow("off", "Connect your data repo above first.");
    if (isIOS() && !standalone()) return nShow("off", "On iPhone: tap Share, then “Add to Home Screen”, open Connections from your home screen, and turn this on there.");
    if (!pushSupported()) return nShow("off", "This browser can’t receive web notifications.");
    if (Notification.permission === "denied") return nShow("off", "Notifications are blocked for this site. Allow them in your browser or system settings, then try again.");
    try {
      const { json } = await ghGetJSON("push.json");
      $("#n-setup").hidden = !!json?.publicKey && !nKeyShown;
      if (!json?.publicKey) return nShow("off", "Not set up yet.");
      const sub = await currentSub();
      if (!sub) return nShow("off", "Off on this device.");
      const known = (json?.subscriptions || []).some((s) => s.endpoint === sub.endpoint);
      nShow(known ? "on" : "off", known ? `On for this device (${deviceName()}).` : "Off on this device.");
    } catch (e) { nShow("off", e.message); }
  }
  $("#n-on").addEventListener("click", async () => {
    try {
      if (!connected()) return refreshNotifStatus();
      if (isIOS() && !standalone()) return refreshNotifStatus();
      if (!pushSupported()) return refreshNotifStatus();
      nShow("off", "Asking for permission…");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return refreshNotifStatus();
      const { json: cfg } = await ghGetJSON("push.json");
      if (!cfg?.publicKey) { $("#n-setup").hidden = false; return nShow("off", "Create a signing key first (below)."); }
      const reg = await navigator.serviceWorker.register("sw.js");
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub && sub.options?.applicationServerKey) {
        const k = new Uint8Array(sub.options.applicationServerKey);
        const want = b64urlToBytes(cfg.publicKey);
        if (k.length !== want.length || k.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(cfg.publicKey) });
      const j = sub.toJSON();
      nShow("off", "Saving…");
      await ghUpdateJSON("push.json", (p) => {
        p = p || cfg;
        const subs = (p.subscriptions || []).filter((s) => s.endpoint !== j.endpoint);
        subs.push({ endpoint: j.endpoint, keys: j.keys, device: deviceName(), addedAt: nowISO() });
        return { ...p, subscriptions: subs };
      }, `Notifications on: ${deviceName()}`);
      await refreshNotifStatus();
    } catch (e) { nShow("off", `Couldn’t turn on notifications: ${e.message}`); }
  });
  // Create a VAPID key pair in the browser. Only the public half is stored in the repo.
  let nKeyShown = false;
  const bytesToB64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  $("#n-genkey").addEventListener("click", async () => {
    try {
      const { json: existing } = await ghGetJSON("push.json");
      if (existing?.publicKey && $("#n-genkey").dataset.armed !== "1") {
        $("#n-genkey").dataset.armed = "1";
        $("#n-genkey").textContent = "Replace key? Tap again";
        return;
      }
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      const priv = (await crypto.subtle.exportKey("jwk", kp.privateKey)).d; // already base64url
      await ghUpdateJSON("push.json", (p) => ({ subject: "mailto:noreply@example.com", ...(p || {}), publicKey: bytesToB64url(pub), subscriptions: [] }), "Set up notification key");
      $("#n-key").value = priv;
      $("#n-secret-link").href = `https://github.com/${settings.repo}/settings/secrets/actions/new`;
      $("#n-keybox").hidden = false;
      $("#n-genkey").hidden = true;
      nKeyShown = true;
      nShow("off", "Key created. Finish the steps below.");
    } catch (e) { nShow("off", `Couldn’t create the key: ${e.message}`); }
  });
  $("#n-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#n-key").value); $("#n-copy").textContent = "Copied"; }
    catch { $("#n-key").select(); }
  });
  $("#n-test").addEventListener("click", async () => {
    try {
      $("#n-status").textContent = "Sending…";
      await ghUpdateJSON("trips.json", (t) => {
        t = t || { version: 1, trips: [] };
        t.outbox = [...(t.outbox || []), { id: `test-${Date.now()}`, title: "Connections", body: "Test notification. Trip alerts will look like this.", url: location.href.split("#")[0] }];
        return t;
      }, "Test notification");
      $("#n-status").textContent = "Sent. It should arrive within a minute or two.";
    } catch (e) { $("#n-status").textContent = e.message; }
  });
  $("#n-off").addEventListener("click", async () => {
    try {
      const sub = await currentSub();
      const endpoint = sub?.endpoint;
      if (sub) await sub.unsubscribe();
      if (endpoint) await ghUpdateJSON("push.json", (p) => ({ ...p, subscriptions: (p?.subscriptions || []).filter((s) => s.endpoint !== endpoint) }), `Notifications off: ${deviceName()}`);
      await refreshNotifStatus();
    } catch (e) { $("#n-status").textContent = e.message; }
  });

  // ---------- Theme ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $("#theme-btn").setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }
  applyTheme(document.documentElement.dataset.theme || "light");
  $("#theme-btn").addEventListener("click", () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("cm.theme", t); } catch {}
    applyTheme(t);
  });

  // ---------- Apple Contacts (vCard) import ----------
  function parseVcf(text) {
    // Unfold continuation lines, then split into cards.
    const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
    const cards = [];
    let cur = null;
    const unesc = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
    for (const line of lines) {
      if (/^BEGIN:VCARD/i.test(line)) { cur = { name: "", emails: [], phones: [], adr: null, org: "" }; continue; }
      if (/^END:VCARD/i.test(line)) { if (cur && cur.name) cards.push(cur); cur = null; continue; }
      if (!cur) continue;
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).replace(/^item\d+\./i, "").split(";")[0].toUpperCase();
      const val = line.slice(i + 1);
      if (key === "FN") cur.name = unesc(val);
      else if (key === "N" && !cur.name) {
        const [last, first] = val.split(";").map(unesc);
        cur.name = [first, last].filter(Boolean).join(" ");
      }
      else if (key === "EMAIL") cur.emails.push(unesc(val));
      else if (key === "TEL") cur.phones.push(unesc(val));
      else if (key === "ORG" && !cur.org) cur.org = unesc(val.split(";")[0]);
      else if (key === "ADR" && !cur.adr) {
        const p = val.split(";").map(unesc); // pobox;ext;street;city;region;postal;country
        const city = p[3] || "", region = p[4] || "", country = p[6] || "";
        if (city || region || country) cur.adr = { city, region, country, query: [city, region, country].filter(Boolean).join(", ") };
      }
    }
    return cards;
  }

  let vcfCards = [];
  const vdlg = $("#vcf");
  function drawVcf() {
    const q = $("#vcf-filter").value.trim().toLowerCase();
    const existing = new Set(live().map((c) => c.name.toLowerCase()));
    $("#vcf-list").innerHTML = vcfCards
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !q || (c.name + " " + (c.adr?.query || "") + " " + c.org).toLowerCase().includes(q))
      .map(({ c, i }) => {
        const dup = existing.has(c.name.toLowerCase());
        const sub = c.state === "done" ? `Added · ${esc(c.placeLabel || "no location")}`
          : c.state === "fail" ? `Couldn’t place “${esc(c.adr?.query || "")}”; added without a location`
          : dup ? "Already on your map"
          : c.adr ? esc(c.adr.query) : "No address: will be added without a location";
        return `<li class="${c.state === "done" ? "done" : ""}"><label>
          <input type="checkbox" data-i="${i}" ${c.selected ? "checked" : ""} ${dup || c.state ? "disabled" : ""}>
          <span><span class="v-name">${esc(c.name)}</span>${c.org ? ` <span class="v-sub">· ${esc(c.org)}</span>` : ""}<br><span class="v-sub">${sub}</span></span>
        </label></li>`;
      })
      .join("");
    const n = vcfCards.filter((c) => c.selected).length;
    $("#vcf-go").textContent = n ? `Add ${n} ${n === 1 ? "person" : "people"}` : "Add selected";
    $("#vcf-go").disabled = !n;
  }
  $("#vcf-list").addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-i]");
    if (cb) { vcfCards[+cb.dataset.i].selected = cb.checked; drawVcf(); }
  });
  $("#vcf-filter").addEventListener("input", drawVcf);
  $("#vcf-all").addEventListener("change", (e) => {
    const existing = new Set(live().map((c) => c.name.toLowerCase()));
    for (const c of vcfCards) if (c.adr && !c.state && !existing.has(c.name.toLowerCase())) c.selected = e.target.checked;
    drawVcf();
  });
  $("#s-vcf").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    vcfCards = parseVcf(await f.text()).sort((a, b) => a.name.localeCompare(b.name));
    if (!vcfCards.length) { $("#s-msg").textContent = "No contacts found in that file. Make sure it’s a vCard (.vcf) export."; return; }
    const withAdr = vcfCards.filter((c) => c.adr).length;
    $("#vcf-summary").textContent = `${vcfCards.length} contacts in the file, ${withAdr} with an address. Only the people you tick are added.`;
    $("#vcf-filter").value = "";
    $("#vcf-all").checked = false;
    $("#vcf-msg").textContent = "";
    dlg.close();
    vdlg.showModal();
    drawVcf();
  });
  $("#vcf-go").addEventListener("click", async () => {
    const todo = vcfCards.filter((c) => c.selected && !c.state);
    const btn = $("#vcf-go");
    btn.disabled = true;
    let i = 0;
    for (const c of todo) {
      i++;
      $("#vcf-msg").textContent = `Placing ${i} of ${todo.length}… (about ${todo.length - i + 1} s left)`;
      let place = null;
      if (c.adr) {
        // Try the full address, then looser versions (city + country, city alone).
        const tries = [c.adr.query, [c.adr.city, c.adr.country].filter(Boolean).join(", "), c.adr.city]
          .filter((q, k, a) => q && a.indexOf(q) === k);
        for (const q of tries) {
          try { [place] = await geocode(q); } catch {}
          if (place) break;
        }
      }
      const now = nowISO();
      data.contacts.push({
        id: uid(), name: c.name,
        places: place ? [{ label: place.label, lat: +place.lat.toFixed(5), lng: +place.lng.toFixed(5) }] : [],
        met: "", tags: ["imported"],
        reach: [...c.emails, ...c.phones].join(", "),
        notes: "", meetings: [], expiresAt: null, addedAt: now, updatedAt: now,
      });
      c.selected = false;
      c.state = place || !c.adr ? "done" : "fail";
      c.placeLabel = place?.label;
      drawVcf();
    }
    save();
    render();
    $("#vcf-msg").textContent = `Added ${todo.length}. They’re tagged “imported” so you can find and tidy them.`;
    btn.disabled = false;
    drawVcf();
  });

  // ---------- Start ----------
  showView("list");
  load().then(() => fitTo(live()));
})();
