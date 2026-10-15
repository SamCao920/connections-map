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
  let sha = null;          // GitHub blob sha of the file we last read
  let editing = null;      // contact being edited (copy) or null
  let draftPlace = null;   // place chosen in the edit form
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

  function normalize(d) {
    const out = emptyData();
    if (d && Array.isArray(d.contacts)) out.contacts = d.contacts.filter((c) => c && c.id);
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
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    className: dark ? "tiles-dark" : "tiles-light",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  let nearCircle = null, draftMarker = null;

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
    for (const c of contacts) {
      if (!c.place) continue;
      const key = `${c.place.lat.toFixed(2)},${c.place.lng.toFixed(2)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const list of groups.values()) {
      const exp = list.filter((c) => isExpired(c)).length;
      const cls = exp === list.length ? "expired" : exp > 0 ? "mixed" : "";
      const { lat, lng, label } = list[0].place;
      const items = list
        .slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => `<li class="${isExpired(c) ? "expired" : ""}"><button data-id="${esc(c.id)}">${esc(c.name)}</button></li>`)
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
    setDraftPlace({ lat, lng, label: "Looking up place…" });
    const label = await reverseGeocode(lat, lng);
    if (draftPlace && draftPlace.lat === lat && draftPlace.lng === lng) setDraftPlace({ lat, lng, label });
  });

  function fitTo(contacts) {
    const pts = contacts.filter((c) => c.place).map((c) => [c.place.lat, c.place.lng]);
    if (pts.length === 1) map.setView(pts[0], 9);
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 9 });
  }

  // ---------- List rendering ----------
  function filtered() {
    const q = $("#search").value.trim().toLowerCase();
    const showExp = $("#show-expired").checked;
    return live().filter((c) => {
      if (!showExp && isExpired(c)) return false;
      if (activeTags.size && !(c.tags || []).some((t) => activeTags.has(t))) return false;
      if (q) {
        const hay = [c.name, c.place?.label, c.met, c.notes, ...(c.tags || []), ...(c.meetings || []).flatMap((m) => [m.where, m.note])].join(" ").toLowerCase();
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
        .filter((c) => c.place)
        .map((c) => ({ c, d: miles(nearFilter, c.place) }))
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
        const dist = nearFilter && c.place ? ` · ${Math.round(miles(nearFilter, c.place))} mi` : "";
        const meta = [c.place?.label, c.met].filter(Boolean).map(esc).join(" · ");
        return `<li class="row ${exp ? "expired" : ""}" tabindex="0" data-id="${esc(c.id)}">
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
      const mi = +$("#near-radius").value;
      nearFilter = { lat: hit.lat, lng: hit.lng, miles: mi, label: hit.label };
      if (nearCircle) nearCircle.remove();
      nearCircle = L.circle([hit.lat, hit.lng], { radius: mi * 1609.34, color: getCss("--cobalt"), weight: 1, fillOpacity: 0.06 }).addTo(map);
      map.fitBounds(nearCircle.getBounds(), { padding: [20, 20] });
      render();
      const n = $("#list").querySelectorAll(".row").length;
      const active = $("#list").querySelectorAll(".row:not(.expired)").length;
      out.innerHTML = `${n ? `${active} current${n - active ? `, ${n - active} expired` : ""}` : "No one"} within ${mi} mi of <strong>${esc(hit.label)}</strong>. <button class="link-btn clear" type="button">Clear</button>`;
      out.querySelector(".clear").addEventListener("click", clearNear);
    } catch (err) {
      out.textContent = err.message;
    }
  });
  $("#near-radius").addEventListener("change", () => { if (nearFilter) $("#near-form").requestSubmit(); });
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

  function setDraftPlace(p) {
    draftPlace = p;
    const el = $("#f-place-chosen");
    if (p) {
      el.textContent = p.label;
      el.classList.add("set");
      if (draftMarker) draftMarker.remove();
      draftMarker = L.marker([p.lat, p.lng], { icon: pinIcon(1, "draft"), interactive: false }).addTo(map);
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 6));
    } else {
      el.textContent = "No place chosen. Search, or tap the map.";
      el.classList.remove("set");
      if (draftMarker) { draftMarker.remove(); draftMarker = null; }
    }
  }

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
    setDraftPlace(c?.place || null);
    showView("edit");
    $("#edit-view").scrollTop = 0;
    if (!c) $("#f-name").focus({ preventScroll: true });
  }

  function closeEdit() {
    editing = null;
    setDraftPlace(null);
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
        setDraftPlace(hits[+b.dataset.i]);
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
    if (!draftPlace || !Number.isFinite(draftPlace.lat)) { err.textContent = "Choose where they are: search for a city or tap the map."; err.hidden = false; return; }
    addTag($("#f-tags").value);
    const tags = [...draftTags];
    const base = editing || { id: uid(), addedAt: nowISO() };
    const c = {
      ...base,
      name,
      place: { label: draftPlace.label, lat: +draftPlace.lat.toFixed(5), lng: +draftPlace.lng.toFixed(5) },
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
  $("#delete-btn").addEventListener("click", () => {
    if (!editing || !confirm(`Delete ${editing.name}? This can't be undone.`)) return;
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
  $("#s-disconnect").addEventListener("click", () => {
    if (!connected()) return;
    if (!confirm("Disconnect this browser? Your contacts stay safe in the GitHub repo; this browser forgets the token.")) return;
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

  // ---------- Start ----------
  showView("list");
  load().then(() => fitTo(live()));
})();
