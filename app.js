/* Resale Ledger — standalone app (Supabase backend). */
(() => {
"use strict";
const APP_VERSION = "1.0.0";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n*100)/100 : null; };
const money = v => v == null ? "—" : (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const money0 = v => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString();
const days = (a, b) => { if (!a) return null; const t = Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00"); return Number.isFinite(t) ? Math.max(0, Math.round(t / 864e5)) : null; };
const fmtDate = d => { if (!d) return ""; const [y,m,dd] = d.split("-"); return new Date(+y, +m-1, +dd).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); };
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const loadScript = (() => { const p = {}; return src => p[src] || (p[src] = new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => { delete p[src]; rej(new Error("load " + src)); }; document.head.appendChild(s); })); })();

const SITES = ["eBay","Poshmark","Mercari","Facebook Marketplace","Depop","Etsy","OfferUp","Whatnot","Craigslist","Amazon","Local / in person"];
const STATUS = {unlisted:"Unlisted", listed:"Listed", toship:"Needs shipping", sold:"Sold"};
const CONDS = ["New with tags","New without tags","Like new","Good","Fair","For parts"];
const BUCKET = "photos";

const S = { sb: null, user: null, items: [], loaded: false, online: navigator.onLine, filter: "all", age: null, q: "", sort: "age",
  edit: null, editId: null, blobs: new Map(), urls: new Map(), objUrls: new Map(), hashDone: false };
S.sort = lsGet("rl_sort") || "age";
$("#sort").value = S.sort;

/* ---------- item logic ---------- */
function status(it) {
  if (it.sale && it.sale.price != null) {
    if ((it.sale.method || "ship") === "ship" && !(it.ship && (it.ship.tracking || it.ship.date))) return "toship";
    return "sold";
  }
  return (it.listings || []).length ? "listed" : "unlisted";
}
function isSold(it) { return !!(it.sale && it.sale.price != null); }
function cost(it) { return (it.purchase && it.purchase.price) || 0; }
function profit(it) {
  if (!isSold(it)) return null;
  const s = it.sale, sh = it.ship || {};
  return Math.round(((s.price||0) + (sh.charged||0) - cost(it) - (s.fees||0) - (sh.cost||0)) * 100) / 100;
}
function age(it) { return days(it.purchase && it.purchase.date, isSold(it) ? (it.sale.date || todayStr()) : todayStr()); }
function ageBucket(d) { return d == null ? null : d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3; }
function listPrice(it) { const p = (it.listings||[]).map(l => l.price).filter(v => v != null); return p.length ? Math.max(...p) : null; }
function rowToItem(r) { return Object.assign({}, r.data || {}, { id: r.sku, sku: r.sku, num: r.num, createdAt: r.created_at, updatedAt: r.updated_at }); }
function itemData(it) { const d = JSON.parse(JSON.stringify(it)); ["id","sku","num","createdAt","updatedAt"].forEach(k => delete d[k]); return d; }

/* ---------- photos ---------- */
const thumbPath = p => p.replace(/(\.[a-z0-9]+)?$/i, "_t.jpg");
function imgTag(path, cls, alt) {
  return `<img class="${cls||""}" data-path="${esc(path)}" alt="${esc(alt||"")}" loading="lazy">`;
}
async function hydrateImages(root) {
  const imgs = [...(root || document).querySelectorAll("img[data-path]:not([src])")];
  if (!imgs.length) return;
  const need = new Set();
  const now = Date.now();
  imgs.forEach(img => {
    const p = img.dataset.path;
    if (S.objUrls.has(p)) { img.src = S.objUrls.get(p); return; }
    const c = S.urls.get(p);
    if (c && c.exp > now) img.src = c.url; else need.add(p);
  });
  if (need.size && S.sb && S.online) {
    try {
      const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrls([...need], 60 * 60 * 12);
      if (!error && data) data.forEach(d => { if (d.signedUrl) S.urls.set(d.path, { url: d.signedUrl, exp: now + 60 * 60 * 11 * 1000 }); });
    } catch {}
  }
  imgs.forEach(img => {
    if (img.src) return;
    const c = S.urls.get(img.dataset.path);
    if (c) img.src = c.url;
  });
}
document.addEventListener("error", e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.path) return;
  const p = img.dataset.path;
  if (/_t\.jpg$/.test(p) && img.dataset.full && !img.dataset.triedFull) {
    img.dataset.triedFull = "1"; img.removeAttribute("src"); img.dataset.path = img.dataset.full; hydrateImages(img.parentNode);
  } else img.style.opacity = .15;
}, true);

async function shrink(file, max = 1600, q = .82) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width*k); c.height = Math.round(bmp.height*k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise(res => c.toBlob(res, "image/jpeg", q));
    return out || file;
  } catch { return file; }
}

/* ---------- summary ---------- */
function renderKpis() {
  const items = S.items;
  const stock = items.filter(i => !isSold(i));
  const sold = items.filter(isSold);
  const unlisted = stock.filter(i => status(i) === "unlisted");
  const listed = stock.filter(i => status(i) === "listed");
  const toship = items.filter(i => status(i) === "toship");
  const stockCost = stock.reduce((a,i) => a + cost(i), 0);
  const revenue = sold.reduce((a,i) => a + (i.sale.price||0) + ((i.ship&&i.ship.charged)||0), 0);
  const prof = sold.reduce((a,i) => a + profit(i), 0);
  const sellDays = sold.map(age).filter(v => v != null);
  const avgSell = sellDays.length ? Math.round(sellDays.reduce((a,b)=>a+b,0) / sellDays.length) : null;
  const soldCost = sold.reduce((a,i)=>a+cost(i),0);
  const roi = soldCost > 0 ? Math.round(prof / soldCost * 100) : null;
  const k = (lbl, val, sub, cls="") => `<div class="kpi"><span class="lbl">${lbl}</span><span class="val ${cls}">${val}</span><span class="sub">${sub}</span></div>`;
  $("#kpis").innerHTML =
    k("In stock", stock.length, `${money0(stockCost)} tied up`) +
    k("Unlisted", unlisted.length, unlisted.length ? "need listing" : "all listed") +
    k("Listed", listed.length, `${listed.reduce((a,i)=>a+(i.listings||[]).length,0)} active listings`) +
    k("Sold", sold.length, toship.length ? `${toship.length} waiting to ship` : `${money0(revenue)} revenue`) +
    k("Net profit", sold.length ? money0(prof) : "$0", roi != null ? `${roi}% return on cost` : "after fees & shipping", prof > 0 ? "pos" : prof < 0 ? "neg" : "") +
    k("Avg days to sell", avgSell ?? "—", sellDays.length ? `across ${sellDays.length} sales` : "no sales yet");

  const buckets = [0,0,0,0], bcost = [0,0,0,0];
  stock.forEach(i => { const b = ageBucket(age(i)); if (b != null) { buckets[b]++; bcost[b] += cost(i); } });
  const total = buckets.reduce((a,b)=>a+b,0);
  const names = ["0–30 days","31–60 days","61–90 days","90+ days"];
  $("#agebar").innerHTML = total ? buckets.map((n, b) => n ? `<button type="button" class="age${b}" style="flex:${n}" aria-pressed="${S.age===b}" data-age="${b}" title="${names[b]}: ${n} items, ${money(bcost[b])} cost">${n}</button>` : "").join("")
    : `<span class="meta" style="padding:6px 10px">No unsold items yet</span>`;
  const oldest = stock.map(age).filter(v=>v!=null).sort((a,b)=>b-a)[0];
  $("#agingNote").textContent = total ? (S.age != null ? `Showing ${names[S.age]} · tap again to clear` : `Oldest unsold item: ${oldest} days`) : "";
}

/* ---------- list ---------- */
const TABS = [["all","All"],["unlisted","Unlisted"],["listed","Listed"],["toship","Needs shipping"],["sold","Sold"]];
function renderTabs() {
  const counts = {all: S.items.length, unlisted:0, listed:0, toship:0, sold:0};
  S.items.forEach(i => counts[status(i)]++);
  $("#tabs").innerHTML = TABS.map(([k,l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${S.filter===k}">${l}<span class="ct">${counts[k]}</span></button>`).join("");
}
function visible() {
  const q = S.q.trim().toLowerCase();
  const list = S.items.filter(i => {
    const st = status(i);
    if (S.filter !== "all" && st !== S.filter) return false;
    if (S.age != null && (isSold(i) || ageBucket(age(i)) !== S.age)) return false;
    if (!q) return true;
    const hay = [i.name, i.sku, i.category, i.bin, i.notes, i.purchase&&i.purchase.location, i.sale&&i.sale.site, i.ship&&i.ship.tracking, i.ai&&i.ai.brand, ...(i.listings||[]).map(l=>l.site)].join(" ").toLowerCase();
    return hay.includes(q);
  });
  const by = {
    age: (a,b) => (isSold(a)-isSold(b)) || ((age(b)??-1) - (age(a)??-1)),
    newest: (a,b) => String(b.purchase&&b.purchase.date||"").localeCompare(String(a.purchase&&a.purchase.date||"")),
    idnum: (a,b) => (b.num||0) - (a.num||0),
    profit: (a,b) => (profit(b) ?? -1e9) - (profit(a) ?? -1e9),
    cost: (a,b) => cost(b) - cost(a),
    name: (a,b) => String(a.name||"").localeCompare(String(b.name||"")),
  }[S.sort] || ((a,b) => 0);
  return list.sort(by);
}
function renderList() {
  const el = $("#ledger");
  if (!S.loaded) { el.innerHTML = `<div class="empty"><h2>Loading your inventory…</h2></div>`; return; }
  if (!S.items.length) {
    el.innerHTML = `<div class="empty"><h2>No items yet</h2><p>Add each find as you bring it home: what you paid, where you got it, and a photo. List it, sell it, ship it, and the ledger works out days in stock and profit.</p><button class="btn primary" type="button" data-add>+ Add your first item</button></div>`;
    return;
  }
  const list = visible();
  if (!list.length) { el.innerHTML = `<div class="empty"><h2>Nothing matches</h2><p>Try another tab or clear the search.</p></div>`; return; }
  el.innerHTML = `<div class="ledger-head"><span></span><span>Item</span><span>Status</span><span>Bought</span><span class="r">Price · Profit</span><span class="r">Days</span></div>` +
    list.map(i => {
      const st = status(i), p = profit(i), d = age(i), lp = listPrice(i);
      const cover = (i.photos||[])[0];
      const sites = isSold(i) ? (i.sale.site ? `<span class="site">${esc(i.sale.site)}</span>` : "") : (i.listings||[]).map(l => `<span class="site">${esc(l.site||"Site")}</span>`).join("");
      const moneyCell = isSold(i)
        ? `<span class="money">${money(i.sale.price)}</span><span class="money ${p>=0?"pos":"neg"}">${p>=0?"+":""}${money(p)}</span>`
        : (lp!=null ? `<span class="money">${money(lp)}</span><span class="meta">asking</span>` : i.ai && i.ai.estimate ? `<span class="money">${money0(i.ai.estimate.low)}–${money0(i.ai.estimate.high)}</span><span class="meta">estimate</span>` : `<span class="money">—</span><span class="meta">no price set</span>`);
      return `<button type="button" class="row" data-id="${esc(i.id)}">
        <span class="thumb">${cover ? `<img data-path="${esc(thumbPath(cover))}" data-full="${esc(cover)}" alt="" loading="lazy">` : "No photo"}</span>
        <span class="cell c-name"><span class="nm">${esc(i.name || "Untitled item")}</span><span class="meta mono">${esc(i.sku||"")}${i.category ? " · " + esc(i.category) : ""}${i.bin ? " · " + esc(i.bin) : ""}${!isSold(i) && !i.labeledAt ? ` <span class="nolabel">· no label</span>` : ""}</span></span>
        <span class="cell c-status"><span class="chip st-${st}">${STATUS[st]}</span><span class="sites">${sites}</span></span>
        <span class="cell c-buy"><span class="money">${money(i.purchase && i.purchase.price)}</span><span class="meta">${esc(fmtDate(i.purchase&&i.purchase.date))}${i.purchase&&i.purchase.location ? " · " + esc(i.purchase.location) : ""}</span></span>
        <span class="cell c-money r">${moneyCell}</span>
        <span class="days c-days">${d ?? "—"}<small>${isSold(i) ? "to sell" : "in stock"}</small></span>
      </button>`;
    }).join("");
  hydrateImages(el);
}
function renderLists() {
  const locs = new Set(), cats = new Set(), sites = new Set(SITES);
  S.items.forEach(i => { i.purchase && i.purchase.location && locs.add(i.purchase.location); i.category && cats.add(i.category); (i.listings||[]).forEach(l => l.site && sites.add(l.site)); });
  $("#locList").innerHTML = [...locs].map(v => `<option value="${esc(v)}">`).join("");
  $("#catList").innerHTML = [...cats].map(v => `<option value="${esc(v)}">`).join("");
  $("#siteList").innerHTML = [...sites].map(v => `<option value="${esc(v)}">`).join("");
}
function render() { renderKpis(); renderTabs(); renderList(); renderLists(); renderNotice(); }

function renderNotice() {
  const n = $("#notice");
  if (!S.online) { n.className = "notice offline"; n.textContent = "You're offline. Showing your inventory from the last sync. Saving, photos and lookups need a connection."; n.hidden = false; }
  else if (S.loadError) { n.className = "notice"; n.textContent = S.loadError; n.hidden = false; }
  else n.hidden = true;
  $("#syncState").textContent = !S.online ? "Offline" : S.lastSync ? "Synced " + S.lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  if (S.edit) $("#saveBtn").disabled = !S.online;
}

/* ---------- data: load, realtime, cache ---------- */
function cacheKey() { return "rl_items_" + (S.user ? S.user.id : ""); }
let cacheTimer;
function saveCache() { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => lsSet(cacheKey(), JSON.stringify(S.rows || [])), 400); }
function setRows(rows) {
  S.rows = rows.slice().sort((a, b) => a.num - b.num);
  S.items = S.rows.map(rowToItem);
  saveCache();
}
function upsertRow(r) {
  const rows = (S.rows || []).filter(x => x.num !== r.num); rows.push(r); setRows(rows);
}
function removeRow(numId) { setRows((S.rows || []).filter(x => x.num !== numId)); }
async function loadItems() {
  if (!S.online) return;
  try {
    const all = []; const step = 1000;
    for (let from = 0; ; from += step) {
      const { data, error } = await S.sb.from("items").select("num,sku,data,created_at,updated_at").order("num").range(from, from + step - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < step) break;
    }
    setRows(all);
    S.loaded = true; S.loadError = null; S.lastSync = new Date();
  } catch (e) {
    S.loaded = true;
    S.loadError = /relation .*items.* does not exist|schema cache/i.test(e && e.message || "") ? "The database isn't set up yet. Run setup.sql in the Supabase SQL editor (step 1 of the setup guide), then reload." : "Couldn't reach your inventory. Check your connection; the list below is from the last sync.";
  }
  render();
  if (S.edit) { renderQr(); }
  if (!S.hashDone) { S.hashDone = true; openFromHash(); }
}
let channel;
function subscribe() {
  if (channel) { S.sb.removeChannel(channel); channel = null; }
  channel = S.sb.channel("items-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "items" }, p => {
      if (p.eventType === "DELETE") { if (p.old && p.old.num != null) removeRow(p.old.num); }
      else if (p.new && p.new.num != null) upsertRow(p.new);
      S.lastSync = new Date(); render();
      if (S.edit && S.editId) renderQr();
    })
    .subscribe();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.user) { loadItems(); subscribe(); } });
window.addEventListener("online", () => { S.online = true; if (S.user) { loadItems(); subscribe(); } renderNotice(); });
window.addEventListener("offline", () => { S.online = false; renderNotice(); });

/* ---------- editor ---------- */
const sheet = $("#sheet");
function blank() { return { name:"", category:"", condition:"", bin:"", notes:"", purchase:{date:todayStr(), price:null, location:""}, photos:[], listings:[], sale:null, ship:null }; }
function openEditor(id) {
  const it = id ? S.items.find(x => x.id === id) : null;
  S.editId = it ? it.id : null;
  S.edit = JSON.parse(JSON.stringify(it || blank()));
  fillForm();
  if (!sheet.open) sheet.showModal();
  if (!it) setTimeout(() => $("#f_name").focus(), 30);
}
function fillForm() {
  const e = S.edit, p = e.purchase || {}, s = e.sale || {}, sh = e.ship || {};
  $("#sheetTitle").textContent = S.editId ? (e.name || "Untitled item") : "New item";
  $("#f_name").value = e.name || ""; $("#f_sku").value = e.sku || ""; $("#f_sku").placeholder = "Assigned when you save";
  $("#f_category").value = e.category || "";
  $("#f_condition").value = e.condition || ""; $("#f_bin").value = e.bin || ""; $("#f_notes").value = e.notes || "";
  $("#f_pdate").value = p.date || ""; $("#f_pprice").value = p.price ?? ""; $("#f_ploc").value = p.location || "";
  $("#f_sdate").value = s.date || ""; $("#f_sprice").value = s.price ?? ""; $("#f_ssite").value = s.site || "";
  $("#f_fees").value = s.fees ?? ""; $("#f_method").value = s.method || "ship";
  $("#f_carrier").value = sh.carrier || ""; $("#f_tracking").value = sh.tracking || ""; $("#f_shipdate").value = sh.date || "";
  $("#f_shipcost").value = sh.cost ?? ""; $("#f_shipcharged").value = sh.charged ?? "";
  $("#f_search").value = e.search || "";
  $("#delWrap").innerHTML = S.editId ? `<button class="btn danger" type="button" id="delBtn">Delete item</button>` : "";
  $("#cancelBtn").textContent = "Cancel";
  $("#saveErr").hidden = true; $("#photoErr").hidden = true;
  $("#saveBtn").disabled = !S.online;
  renderPhotos(); renderListings(); updateCalc(); renderIdUi(); renderComps(); renderQr();
}
function closeEditor() { if (sheet.open) sheet.close(); S.edit = null; S.editId = null; }

function renderPhotos() {
  const ph = S.edit.photos || [];
  $("#photos").innerHTML = ph.map((path, k) => `<div class="ph ${k===0?"cover":""}"><img data-path="${esc(thumbPath(path))}" data-full="${esc(path)}" alt="Item photo ${k+1}"><button type="button" data-rmph="${k}" aria-label="Remove photo ${k+1}">✕</button></div>`).join("") +
    `<button type="button" class="addph" id="takePhoto"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Take photo</button><button type="button" class="addph" id="addPhoto"><span style="font-size:20px">+</span>Choose photos</button>`;
  hydrateImages($("#photos"));
}
function renderListings() {
  const L = S.edit.listings || [];
  $("#listings").innerHTML = L.length ? L.map((l, k) => `<div class="lrow" data-lk="${k}">
      <label class="f">Site<input class="field" list="siteList" data-lf="site" value="${esc(l.site||"")}" placeholder="eBay"></label>
      <label class="f">Asking<input class="field money" type="number" step="0.01" min="0" inputmode="decimal" data-lf="price" value="${l.price ?? ""}"></label>
      <label class="f">Listed<input class="field" type="date" data-lf="date" value="${esc(l.date||"")}"></label>
      <label class="f lurl">Listing link<input class="field" type="url" data-lf="url" value="${esc(l.url||"")}" placeholder="https://"></label>
      <button type="button" class="iconbtn" data-rml="${k}" aria-label="Remove listing">✕</button>
    </div>`).join("") : `<span class="meta">Not listed anywhere yet. Add a site when you post it.</span>`;
}
function readForm() {
  const e = S.edit;
  e.name = $("#f_name").value.trim(); e.category = $("#f_category").value.trim();
  e.condition = $("#f_condition").value; e.search = $("#f_search").value.trim(); e.bin = $("#f_bin").value.trim(); e.notes = $("#f_notes").value.trim();
  e.purchase = { date: $("#f_pdate").value, price: num($("#f_pprice").value), location: $("#f_ploc").value.trim() };
  $("#listings").querySelectorAll(".lrow").forEach(r => {
    const l = e.listings[+r.dataset.lk];
    r.querySelectorAll("[data-lf]").forEach(inp => { const f = inp.dataset.lf; l[f] = f === "price" ? num(inp.value) : inp.value.trim(); });
  });
  const sprice = num($("#f_sprice").value);
  const sdate = $("#f_sdate").value;
  e.sale = (sprice != null || sdate) ? { date: sdate || todayStr(), price: sprice ?? 0, site: $("#f_ssite").value.trim(), fees: num($("#f_fees").value), method: $("#f_method").value } : null;
  const sh = { carrier: $("#f_carrier").value, tracking: $("#f_tracking").value.trim(), date: $("#f_shipdate").value, cost: num($("#f_shipcost").value), charged: num($("#f_shipcharged").value) };
  e.ship = Object.values(sh).some(v => v !== "" && v != null) ? sh : null;
  return e;
}
function trackUrl(carrier, t) {
  const u = encodeURIComponent(t);
  return { USPS:`https://tools.usps.com/go/TrackConfirmAction?tLabels=${u}`, UPS:`https://www.ups.com/track?tracknum=${u}`, FedEx:`https://www.fedex.com/fedextrack/?trknbr=${u}`, DHL:`https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${u}` }[carrier] || `https://www.google.com/search?q=${u}+tracking`;
}
function updateCalc() {
  const e = readForm();
  const local = e.sale && e.sale.method === "local";
  $("#shipSet").style.opacity = local ? .55 : 1;
  const sh = e.ship || {};
  const t = $("#trackLine");
  if (sh.tracking) { t.hidden = false; t.innerHTML = `<a href="${trackUrl(sh.carrier, sh.tracking)}" target="_blank" rel="noopener">Track package ↗</a><button type="button" class="btn small" id="copyTrack">Copy number</button>`; }
  else t.hidden = true;
  const c = cost(e), d = age(e);
  if (!isSold(e)) {
    const lp = listPrice(e);
    const est = lp != null ? lp - c : null;
    $("#calc").innerHTML = `<span>Paid <b>${money(c)}</b></span><span>Days in stock <b>${d ?? "—"}</b></span>${lp != null ? `<span class="tot">If it sells at ${money(lp)}: <b class="${est>=0?"pos":"neg"}">${money(est)}</b> before fees &amp; shipping</span>` : `<span class="tot meta">Enter a sale price to see profit</span>`}`;
  } else {
    const p = profit(e);
    $("#calc").innerHTML = `<span>Sold <b>${money(e.sale.price)}</b></span>${sh.charged ? `<span>+ ship charged <b>${money(sh.charged)}</b></span>` : ""}<span>− paid <b>${money(c)}</b></span><span>− fees <b>${money(e.sale.fees||0)}</b></span><span>− shipping <b>${money(sh.cost||0)}</b></span><span>Days to sell <b>${d ?? "—"}</b></span><span class="tot">Profit <b class="${p>=0?"pos":"neg"}">${money(p)}</b></span>`;
  }
}

function errText(err) {
  const m = (err && (err.message || err.error_description)) || "";
  if (!S.online || /Failed to fetch|NetworkError|Load failed/i.test(m)) return "You're offline. Reconnect and tap Save again.";
  if (/JWT|expired|not authenticated|401/i.test(m)) return "Your sign-in expired. Close this, sign in again, and retry.";
  if (/row-level security|permission/i.test(m)) return "The database refused this change. Check the setup guide's security step.";
  return "Couldn't save. Try again.";
}
async function save(ev) {
  ev.preventDefault();
  const e = readForm();
  if (!e.name) { showErr("Give the item a name before saving."); $("#f_name").focus(); return; }
  const data = itemData(e);
  const isNew = !S.editId;
  $("#saveBtn").disabled = true; $("#saveErr").hidden = true;
  try {
    let row;
    if (isNew) {
      const r = await S.sb.from("items").insert({ data }).select("num,sku,data,created_at,updated_at").single();
      if (r.error) throw r.error; row = r.data;
    } else {
      const cur = S.items.find(i => i.id === S.editId);
      const r = await S.sb.from("items").update({ data }).eq("num", cur.num).select("num,sku,data,created_at,updated_at").single();
      if (r.error) throw r.error; row = r.data;
    }
    upsertRow(row); S.lastSync = new Date(); render();
    if (isNew) {
      S.editId = row.sku; S.edit = rowToItem(row); fillForm();
      $("#cancelBtn").textContent = "Close";
      toast(`Saved as ${row.sku}`);
    } else { closeEditor(); toast("Saved"); }
  } catch (err) { showErr(errText(err)); }
  finally { $("#saveBtn").disabled = !S.online; }
}
function showErr(m) { const el = $("#saveErr"); el.textContent = m; el.hidden = false; }

async function addPhotos(files) {
  const err = $("#photoErr"); err.hidden = true;
  if (!S.online) { err.textContent = "You're offline. Photos upload once you're back online."; err.hidden = false; return; }
  for (const file of files) {
    if (file.type && !file.type.startsWith("image/")) continue;
    const ph = document.createElement("div"); ph.className = "ph"; ph.innerHTML = `<span class="meta" style="display:flex;height:100%;align-items:center;justify-content:center">Uploading…</span>`;
    $("#photos").insertBefore(ph, $("#takePhoto"));
    try {
      const full = await shrink(file, 1600, .82);
      const thumb = await shrink(full, 360, .76);
      const path = `${S.user.id}/${uuid()}.jpg`;
      const up = await S.sb.storage.from(BUCKET).upload(path, full, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      try { await S.sb.storage.from(BUCKET).upload(thumbPath(path), thumb, { contentType: "image/jpeg", upsert: true }); } catch {}
      S.blobs.set(path, full);
      S.objUrls.set(thumbPath(path), URL.createObjectURL(thumb));
      if (S.edit) S.edit.photos = [...(S.edit.photos||[]), path];
    } catch (e) {
      const m = (e && e.message) || "";
      err.textContent = /Bucket not found/i.test(m) ? "The photo storage isn't set up. Run setup.sql (step 1 of the guide)." : /exceeded|too large|size/i.test(m) ? "That photo is too large." : "A photo didn't upload. Try again.";
      err.hidden = false;
    }
    if (S.edit) { renderPhotos(); renderIdUi(); }
  }
  if (S.edit && S.editId) $("#saveErr").hidden = true;
}

function del() {
  $("#delWrap").innerHTML = `<span class="confirm">Delete this item for good?<button class="btn small danger" type="button" id="delYes">Delete</button><button class="btn small" type="button" id="delNo">Keep</button></span>`;
}
async function delConfirmed() {
  const it = S.items.find(x => x.id === S.editId);
  if (!it) return closeEditor();
  try {
    const r = await S.sb.from("items").delete().eq("num", it.num);
    if (r.error) throw r.error;
    const paths = (it.photos || []).flatMap(p => [p, thumbPath(p)]);
    if (paths.length) { try { await S.sb.storage.from(BUCKET).remove(paths); } catch {} }
    removeRow(it.num); render();
    closeEditor(); toast(`${it.sku} deleted`);
  } catch (e) { showErr(errText(e)); }
}

/* ---------- identify & comps ---------- */
function compQuery() { return ($("#f_search").value.trim() || $("#f_name").value.trim()); }
function renderComps() {
  const q = compQuery(), u = encodeURIComponent(q);
  if (!q) { $("#comps").innerHTML = `<span class="meta">Enter a name or search terms to check comps.</span>`; return; }
  const L = [
    ["eBay sold", `https://www.ebay.com/sch/i.html?_nkw=${u}&LH_Sold=1&LH_Complete=1`],
    ["Mercari sold", `https://www.mercari.com/search/?keyword=${u}&itemStatuses=2`],
    ["Poshmark sold", `https://poshmark.com/search?query=${u}&availability=sold_out`],
    ["FB Marketplace", `https://www.facebook.com/marketplace/search/?query=${u}`],
    ["Google Shopping", `https://www.google.com/search?tbm=shop&q=${u}`],
    ["Google Lens", `https://lens.google.com/`],
  ];
  $("#comps").innerHTML = L.map(([t,h]) => `<a href="${h}" target="_blank" rel="noopener">${t} ↗</a>`).join("");
}
function renderIdUi() {
  const has = (S.edit && (S.edit.photos||[]).length) > 0;
  $("#identifyBtn").disabled = !has || !S.online;
  $("#idHint").textContent = !S.online ? "Photo lookup needs a connection." : has ? "Claude reads your photos, fills in the details, and estimates what it sells for." : "Take or choose a photo first, then tap Identify.";
  renderAi();
}
function renderAi() {
  const a = S.edit && S.edit.ai, out = $("#idOut");
  if (!a) { out.hidden = true; return; }
  out.hidden = false;
  const est = a.estimate && a.estimate.low != null ? `${money0(a.estimate.low)}–${money0(a.estimate.high)}` : "No estimate";
  const row = (k,v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "";
  out.innerHTML = `<div class="est"><span class="rng">${est}</span><span class="conf conf-${esc(a.confidence||"low")}">${esc(a.confidence||"low")} confidence</span><span class="fine">Claude's estimate from general knowledge, ${esc(fmtDate(a.date))}. Confirm with sold comps.</span></div>
    ${a.pricing_note ? `<div class="fine">${esc(a.pricing_note)}</div>` : ""}
    <dl class="sug">${row("Name", a.name)}${row("Brand", a.brand)}${row("Category", a.category)}${row("Condition", a.condition)}${row("Description", a.description)}</dl>
    <div class="idrow"><button class="btn small primary" type="button" id="aiFill">Fill empty fields</button><button class="btn small" type="button" id="aiReplace">Replace with these</button></div>`;
}
function applyAi(replace) {
  const a = S.edit.ai; if (!a) return;
  const set = (sel, v) => { const el = $(sel); if (v && (replace || !el.value.trim())) el.value = v; };
  set("#f_name", a.name); set("#f_category", a.category);
  if (a.condition && CONDS.includes(a.condition)) set("#f_condition", a.condition);
  if (a.description) {
    const n = $("#f_notes"), d = (a.brand ? `Brand: ${a.brand}. ` : "") + a.description;
    if (replace || !n.value.trim()) n.value = d; else if (!n.value.includes(a.description)) n.value = n.value.trim() + "\n\n" + d;
  }
  if (a.search) set("#f_search", a.search);
  if (!S.editId) $("#sheetTitle").textContent = $("#f_name").value || "New item";
  renderComps(); updateCalc(); toast(replace ? "Details replaced" : "Details filled in");
}
async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer()); let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
async function identify() {
  const paths = (S.edit.photos || []).slice(0, 4);
  if (!paths.length) return;
  const btn = $("#identifyBtn"), hint = $("#idHint");
  btn.disabled = true; btn.innerHTML = `<span class="spark" aria-hidden="true">✦</span> Looking at photos…`;
  hint.textContent = "This takes a few seconds.";
  try {
    const blobs = await Promise.all(paths.map(async p => {
      if (S.blobs.has(p)) return S.blobs.get(p);
      const { data, error } = await S.sb.storage.from(BUCKET).download(p);
      if (error || !data) throw { code: "photo_missing" };
      S.blobs.set(p, data); return data;
    }));
    const images = await Promise.all(blobs.map(async b => ({ media_type: "image/jpeg", data: await blobToBase64(await shrink(b, 1092, .85)) })));
    readForm();
    const typed = { name: S.edit.name, category: S.edit.category, notes: S.edit.notes, paid: S.edit.purchase && S.edit.purchase.price };
    const { data, error } = await S.sb.functions.invoke("identify", { body: { images, typed } });
    if (error) {
      let code = "failed", status = error.context && error.context.status;
      try { const j = error.context && await error.context.json(); if (j && j.error) code = j.error; } catch {}
      if (status === 404) code = "not_deployed";
      throw { code };
    }
    const r = data && data.result;
    if (!r || typeof r !== "object") throw { code: "bad_reply" };
    const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? Math.round(x) : null; };
    const est = r.estimate && n(r.estimate.low) != null && n(r.estimate.high) != null ? { low: n(r.estimate.low), high: n(r.estimate.high) } : null;
    S.edit.ai = { name: String(r.name||"").slice(0,120), brand: r.brand ? String(r.brand) : "", category: r.category ? String(r.category) : "", condition: CONDS.includes(r.condition) ? r.condition : "",
      description: String(r.description||"").slice(0,1200), search: String(r.search||"").slice(0,120), estimate: est,
      confidence: ["high","medium","low"].includes(r.confidence) ? r.confidence : "low", pricing_note: String(r.pricing_note||"").slice(0,300), date: todayStr() };
    if (!$("#f_search").value.trim() && S.edit.ai.search) $("#f_search").value = S.edit.ai.search;
    renderComps(); renderAi();
    hint.textContent = S.editId ? "Done. Fill in the details, then tap Save." : "Done. Review the details, then fill them in.";
  } catch (e) {
    const c = e && e.code;
    hint.textContent =
      c === "not_deployed" ? "Photo lookup isn't set up yet. See step 3 of the setup guide." :
      c === "no_api_key" ? "The lookup has no Anthropic API key. Add ANTHROPIC_API_KEY in Supabase (step 3)." :
      c === "not_signed_in" ? "Your sign-in expired. Sign out, sign back in, and try again." :
      c === "anthropic_auth" ? "Anthropic rejected the API key. Check the key in Supabase secrets." :
      c === "anthropic_credit" ? "Your Anthropic account is out of credit. Add credit in the Anthropic Console." :
      c === "rate_limited" ? "Too many lookups right now. Try again in a minute." :
      c === "photo_missing" ? "A photo couldn't be loaded. Remove it and add it again." :
      c === "bad_reply" ? "Claude's answer came back garbled. Try again." :
      "The lookup didn't finish. Try again.";
  } finally {
    btn.innerHTML = `<span class="spark" aria-hidden="true">✦</span> Identify from photos`;
    btn.disabled = !((S.edit && (S.edit.photos||[]).length) > 0) || !S.online;
  }
}

/* ---------- item IDs, QR codes & labels ---------- */
const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, "");
const itemLink = it => appUrl() + "#" + encodeURIComponent(it.sku || "");
function makeQr(text) { const q = qrcode(0, "M"); q.addData(text); q.make(); return q; }
function renderQr() {
  const box = $("#qrBox"); const e = S.edit;
  if (!e || !S.editId || typeof qrcode !== "function") { box.hidden = true; return; }
  const live = S.items.find(i => i.id === S.editId);
  const q = makeQr(itemLink(e));
  box.hidden = false;
  box.innerHTML = `<div class="qr" aria-label="QR code for ${esc(e.sku)}">${q.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>
    <div class="qinfo"><span class="qid">${esc(e.sku)}</span>
      <span class="meta">${live && live.labeledAt ? "Labeled " + esc(fmtDate(live.labeledAt.slice(0,10))) : "No label printed yet"}</span>
      <div><button class="btn small" type="button" id="qrLabel">Make label PDF</button></div></div>`;
}
function findByCode(code) {
  const s = String(code || "").trim();
  const m = /(RL-\d{1,})/i.exec(s);
  const id = (m ? m[1] : s).toUpperCase();
  const n = /^RL-(\d+)$/.exec(id);
  return S.items.find(i => i.sku === id) || (n ? S.items.find(i => i.num === +n[1]) : null) || S.items.find(i => i.id === s);
}
function openFromHash() {
  const h = decodeURIComponent((location.hash || "").slice(1)).trim();
  if (!h || !S.loaded || h.includes("=")) return;
  const it = findByCode(h);
  history.replaceState(null, "", location.pathname + location.search);
  if (it) openEditor(it.id); else toast(`No item with ID ${h}`);
}
window.addEventListener("hashchange", openFromHash);

const SIZES = {
  "2x1": { label: "2 × 1 in roll (Dymo, Zebra)", w: 2, h: 1 },
  "2.25x1.25": { label: "2.25 × 1.25 in roll (Rollo, Munbyn)", w: 2.25, h: 1.25 },
  "1.5x1.5": { label: "1.5 × 1.5 in square roll", w: 1.5, h: 1.5 },
  "avery5160": { label: "Letter sheet, 30 per page (Avery 5160)", w: 2.625, h: 1, sheet: { cols: 3, rows: 10, left: 0.1875, top: 0.5, dx: 2.75, dy: 1 } },
};
let sizeKey = SIZES[lsGet("rl_label")] ? lsGet("rl_label") : "2x1";

function fitLines(P, text, maxW, size, bold, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean); const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (P.measure(t, size, bold) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, maxLines);
  if (lines.length > maxLines || (out.length && P.measure(out[out.length-1], size, bold) > maxW)) {
    let l = out[out.length - 1];
    while (l.length > 1 && P.measure(l + "…", size, bold) > maxW) l = l.slice(0, -1);
    out[out.length - 1] = l.replace(/\s+$/, "") + "…";
  }
  return out;
}
function drawLabel(P, x, y, w, h, it) {
  const m = Math.min(w, h) * 0.07, pt = s => s / 72;
  const q = makeQr(itemLink(it)), n = q.getModuleCount();
  const square = Math.abs(w - h) < 0.2;
  let qs, qx, qy, tx, ty, tw, align;
  if (square) { qs = h * 0.6; qx = x + (w - qs) / 2; qy = y + m; tx = x + m; ty = qy + qs + 0.03; tw = w - 2 * m; align = "center"; }
  else { qs = h - 2 * m; qx = x + m; qy = y + m; tx = qx + qs + m * 1.3; ty = y + m; tw = x + w - m - tx; align = "left"; }
  const cs = qs / n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) P.rect(qx + c * cs, qy + r * cs, cs * 1.02, cs * 1.02);
  const k = Math.min(h, 1.25), idS = square ? 12 : 15 * k, nmS = square ? 7 : 7.5 * k, spS = 7 * Math.min(k, 1.1);
  const bottom = y + h - m;
  let cy = ty + pt(idS);
  P.text(it.sku || "", tx, cy, idS, true, align, tw);
  const lines = fitLines(P, it.name || "", tw, nmS, false, square ? 1 : 2);
  for (const l of lines) { if (cy + pt(nmS) * 1.25 > bottom) break; cy += pt(nmS) * 1.25; P.text(l, tx, cy, nmS, false, align, tw); }
  if (it.bin && cy + pt(spS) * 1.45 <= bottom) { cy += pt(spS) * 1.45; P.text(fitLines(P, "Spot: " + it.bin, tw, spS, true, 1)[0], tx, cy, spS, true, align, tw); }
}
function pdfPainter(doc) {
  doc.setFillColor(0, 0, 0); doc.setTextColor(0, 0, 0);
  const font = (size, bold) => { doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); };
  const clean = s => String(s).replace(/[^\x20-\x7E -ÿ–—‘’“”…]/g, "");
  return {
    rect: (x, y, w, h) => doc.rect(x, y, w, h, "F"),
    text: (s, x, y, size, bold, align, w) => { font(size, bold); doc.text(clean(s), align === "center" ? x + w / 2 : x, y, { align }); },
    measure: (s, size, bold) => { font(size, bold); return doc.getTextWidth(clean(s)); },
  };
}
function canvasPainter(ctx, D) {
  const font = (size, bold) => { ctx.font = `${bold ? 700 : 400} ${size / 72 * D}px Helvetica, Arial, sans-serif`; };
  return {
    rect: (x, y, w, h) => ctx.fillRect(x * D, y * D, w * D, h * D),
    text: (s, x, y, size, bold, align, w) => { font(size, bold); ctx.textAlign = align === "center" ? "center" : "left"; ctx.fillText(s, (align === "center" ? x + w / 2 : x) * D, y * D); },
    measure: (s, size, bold) => { font(size, bold); return ctx.measureText(s).width / D; },
  };
}
function buildPdf(items, key) {
  const z = SIZES[key], { jsPDF } = window.jspdf;
  let doc;
  if (z.sheet) {
    const g = z.sheet, per = g.cols * g.rows;
    doc = new jsPDF({ unit: "in", format: "letter", orientation: "p" }); const P = pdfPainter(doc);
    items.forEach((it, i) => { if (i && i % per === 0) { doc.addPage("letter", "p"); pdfPainter(doc); } const k = i % per; drawLabel(P, g.left + (k % g.cols) * g.dx, g.top + Math.floor(k / g.cols) * g.dy, z.w, z.h, it); });
  } else {
    const o = z.w >= z.h ? "l" : "p";
    doc = new jsPDF({ unit: "in", format: [z.w, z.h], orientation: o }); const P = pdfPainter(doc);
    items.forEach((it, i) => { if (i) { doc.addPage([z.w, z.h], o); pdfPainter(doc); } drawLabel(P, 0, 0, z.w, z.h, it); });
  }
  return new Blob([doc.output("arraybuffer")], { type: "application/pdf" });
}
/* Hand a file to the person: the iPhone share sheet (Print, Save to Files, label printer apps) or a normal download. */
async function deliver(blob, filename) {
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.share && window.File) {
    const file = new File([blob], filename, { type: blob.type });
    if (!navigator.canShare || navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return true; }
      catch (e) { if (e && e.name === "AbortError") return false; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
async function markLabeled(items) {
  const now = new Date().toISOString();
  for (const it of items) {
    const cur = S.items.find(i => i.id === it.id); if (!cur) continue;
    const data = itemData(Object.assign({}, cur, { labeledAt: now }));
    try { const r = await S.sb.from("items").update({ data }).eq("num", cur.num).select("num,sku,data,created_at,updated_at").single(); if (!r.error) upsertRow(r.data); } catch {}
  }
  render(); if (S.edit) renderQr();
}
async function ensurePdfLib() { if (!window.jspdf) await loadScript("vendor/jspdf.umd.min.js"); }
async function oneLabel() {
  readForm();
  const cur = S.items.find(i => i.id === S.editId); if (!cur) return;
  const it = Object.assign({}, cur, { name: S.edit.name, bin: S.edit.bin });
  try {
    await ensurePdfLib();
    const ok = await deliver(buildPdf([it], sizeKey), `label-${it.sku}.pdf`);
    if (ok) { toast(`Label ready for ${it.sku}`); if (S.online) markLabeled([it]); }
  } catch { showErr("The label didn't save. Try again."); }
}

function labelSets() {
  const stock = S.items.filter(i => !isSold(i));
  return {
    unlabeled: { label: "Not labeled yet", items: stock.filter(i => !i.labeledAt) },
    stock: { label: "Everything in stock", items: stock },
    view: { label: "Items in the current list", items: visible() },
  };
}
let labelScope = "unlabeled";
async function openLabels() {
  try { await ensurePdfLib(); } catch { toast("Couldn't load the label maker. Check your connection."); return; }
  const sets = labelSets();
  if (!sets[labelScope].items.length) labelScope = sets.unlabeled.items.length ? "unlabeled" : "stock";
  $("#labelScope").innerHTML = Object.entries(sets).map(([k, v]) => `<label class="opt"><input type="radio" name="scope" value="${k}" ${k === labelScope ? "checked" : ""}>${v.label}<span class="ct">${v.items.length}</span></label>`).join("");
  $("#labelSize").innerHTML = Object.entries(SIZES).map(([k, v]) => `<option value="${k}" ${k === sizeKey ? "selected" : ""}>${v.label}</option>`).join("");
  $("#labelErr").hidden = true;
  updateLabelUi();
  $("#labelSheet").showModal();
}
function updateLabelUi() {
  const items = labelSets()[labelScope].items, z = SIZES[sizeKey];
  const pages = z.sheet ? Math.ceil(items.length / (z.sheet.cols * z.sheet.rows)) : items.length;
  $("#labelCount").textContent = items.length ? `${items.length} label${items.length === 1 ? "" : "s"}${z.sheet ? ` · ${pages} sheet${pages === 1 ? "" : "s"}` : ""}` : "No items in this group";
  $("#labelGo").disabled = !items.length;
  const D = 160, c = $("#labelPreview");
  c.width = Math.round(z.w * D); c.height = Math.round(z.h * D); c.style.width = (z.w * 110) + "px";
  const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = "#000";
  const sample = items[0] || { sku: "RL-00001", name: "Your item name appears here", bin: "Shelf B" };
  drawLabel(canvasPainter(ctx, D), 0, 0, z.w, z.h, sample);
}
$("#labelForm").addEventListener("change", e => {
  if (e.target.name === "scope") labelScope = e.target.value;
  if (e.target.id === "labelSize") { sizeKey = e.target.value; lsSet("rl_label", sizeKey); }
  updateLabelUi();
});
$("#labelForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const items = labelSets()[labelScope].items; if (!items.length) return;
  const btn = $("#labelGo"); btn.disabled = true;
  try {
    const ok = await deliver(buildPdf(items, sizeKey), items.length === 1 ? `label-${items[0].sku}.pdf` : `labels-${todayStr()}-${items.length}.pdf`);
    if (ok) {
      $("#labelSheet").close(); toast(`${items.length} label${items.length === 1 ? "" : "s"} ready`);
      if ($("#labelMark").checked && S.online) markLabeled(items);
    }
  } catch { const el = $("#labelErr"); el.textContent = "The labels didn't save. Try again."; el.hidden = false; }
  finally { btn.disabled = false; }
});

/* ---------- scanner ---------- */
let scanStream = null, scanRaf = 0, scanBusy = false;
async function openScanner() {
  const dlg = $("#scanSheet"), msg = $("#scanMsg"), video = $("#scanVideo");
  $("#scanCode").value = "";
  dlg.showModal();
  msg.textContent = "Starting camera…";
  try {
    await loadScript("vendor/jsQR.js");
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = scanStream; await video.play();
    msg.textContent = "Point at a Resale Ledger label";
    const c = document.createElement("canvas"), ctx = c.getContext("2d", { willReadFrequently: true });
    let last = 0;
    const tick = t => {
      scanRaf = requestAnimationFrame(tick);
      if (t - last < 140 || video.readyState < 2 || scanBusy) return; last = t;
      const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
      const s = Math.min(1, 720 / Math.max(vw, vh)); c.width = Math.round(vw * s); c.height = Math.round(vh * s);
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const code = window.jsQR && window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code && code.data) {
        const it = findByCode(code.data);
        if (it) { if (navigator.vibrate) navigator.vibrate(40); closeScanner(); openEditor(it.id); }
        else { msg.textContent = "That code isn't one of your items"; }
      }
    };
    scanRaf = requestAnimationFrame(tick);
  } catch (e) {
    msg.textContent = e && e.name === "NotAllowedError" ? "Camera access is off. Allow it in Settings, or type the ID below." : "The camera isn't available. Type the ID below.";
  }
}
function closeScanner() {
  cancelAnimationFrame(scanRaf);
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  $("#scanVideo").srcObject = null;
  if ($("#scanSheet").open) $("#scanSheet").close();
}
$("#scanSheet").addEventListener("close", closeScanner);
$("#scanManual").addEventListener("submit", e => {
  e.preventDefault();
  const it = findByCode($("#scanCode").value);
  if (it) { closeScanner(); openEditor(it.id); } else $("#scanMsg").textContent = "No item with that ID";
});

/* ---------- export ---------- */
async function exportCsv() {
  const cols = ["Item ID","Name","Category","Condition","Storage","Status","Date bought","Paid","Where bought","Listed on","Asking","Date sold","Sold for","Sold on","Fees","Delivery","Carrier","Tracking","Date shipped","Shipping cost","Shipping charged","Profit","Days"];
  const q = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  const rows = S.items.map(i => { const s = i.sale||{}, sh = i.ship||{}, p = i.purchase||{};
    return [i.sku,i.name,i.category,i.condition,i.bin,STATUS[status(i)],p.date,p.price,p.location,(i.listings||[]).map(l=>l.site).join("; "),listPrice(i),s.date,s.price,s.site,s.fees,s.method,sh.carrier,sh.tracking,sh.date,sh.cost,sh.charged,profit(i),age(i)].map(q).join(","); });
  const blob = new Blob([[cols.join(","), ...rows].join("\n")], { type: "text/csv" });
  if (await deliver(blob, `resale-ledger-${todayStr()}.csv`)) toast("Export ready");
}

let tt; function toast(m) { let el = $(".toast"); if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role","status"); document.body.appendChild(el); } el.textContent = m; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => el.hidden = true, 2400); }

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-add]"); if (!t) return;
  if (t.matches("#addBtn, [data-add]")) return openEditor(null);
  if (t.dataset.id) return openEditor(t.dataset.id);
  if (t.dataset.tab) { S.filter = t.dataset.tab; return render(); }
  if (t.dataset.age != null) { const a = +t.dataset.age; S.age = S.age === a ? null : a; if (S.age != null && (S.filter === "sold" || S.filter === "toship")) S.filter = "all"; return render(); }
  if (t.id === "closeBtn" || t.id === "cancelBtn") return closeEditor();
  if (t.id === "addPhoto") return $("#photoInput").click();
  if (t.id === "takePhoto") return $("#cameraInput").click();
  if (t.dataset.rmph != null) { readForm(); S.edit.photos.splice(+t.dataset.rmph, 1); renderPhotos(); renderIdUi(); if (S.editId) toast("Photo removed. Tap Save to keep the change."); return; }
  if (t.id === "identifyBtn") return identify();
  if (t.id === "aiFill") return applyAi(false);
  if (t.id === "aiReplace") return applyAi(true);
  if (t.id === "addListing") { readForm(); S.edit.listings.push({ site:"", price:null, date:todayStr(), url:"" }); renderListings(); updateCalc(); const r = $("#listings").lastElementChild; r && r.querySelector("input").focus(); return; }
  if (t.dataset.rml != null) { readForm(); S.edit.listings.splice(+t.dataset.rml, 1); renderListings(); return updateCalc(); }
  if (t.id === "delBtn") return del();
  if (t.id === "delNo") { $("#delWrap").innerHTML = `<button class="btn danger" type="button" id="delBtn">Delete item</button>`; return; }
  if (t.id === "delYes") return delConfirmed();
  if (t.id === "exportBtn") return exportCsv();
  if (t.id === "labelsBtn") return openLabels();
  if (t.id === "scanBtn") return openScanner();
  if (t.id === "scanClose") return closeScanner();
  if (t.id === "labelClose" || t.id === "labelCancel") return $("#labelSheet").close();
  if (t.id === "qrLabel") return oneLabel();
  if (t.id === "signOutBtn") return signOut();
  if (t.id === "copyTrack") { const v = $("#f_tracking").value; navigator.clipboard.writeText(v).then(() => toast("Tracking number copied"), () => { $("#f_tracking").select(); }); return; }
});
$("#form").addEventListener("submit", save);
$("#form").addEventListener("input", e => { if (!S.edit) return; updateCalc(); if (e.target.id === "f_search" || e.target.id === "f_name") renderComps(); });
$("#form").addEventListener("change", () => S.edit && updateCalc());
["#photoInput","#cameraInput"].forEach(s => $(s).addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; addPhotos(f); }));
sheet.addEventListener("close", () => { S.edit = null; S.editId = null; });
$("#search").addEventListener("input", e => { S.q = e.target.value; renderList(); });
$("#sort").addEventListener("change", e => { S.sort = e.target.value; lsSet("rl_sort", S.sort); renderList(); });

/* ---------- config, sign in ---------- */
function getConfig() {
  const c = window.RL_CONFIG || {};
  if (c.supabaseUrl && c.supabaseKey) return { url: c.supabaseUrl.trim(), key: c.supabaseKey.trim() };
  try { const j = JSON.parse(lsGet("rl_config") || "null"); if (j && j.url && j.key) return j; } catch {}
  return null;
}
function show(view) { ["#setupView", "#authView", "#appView"].forEach(v => $(v).hidden = v !== view); }

$("#setupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#setupUrl").value.trim().replace(/\/+$/, ""), key = $("#setupKey").value.trim();
  const err = $("#setupErr"); err.hidden = true;
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) && !/^https?:\/\//.test(url)) { err.textContent = "That doesn't look like a Supabase Project URL. It starts with https:// and ends in .supabase.co"; err.hidden = false; return; }
  if (key.length < 20) { err.textContent = "Paste the full publishable or anon key."; err.hidden = false; return; }
  lsSet("rl_config", JSON.stringify({ url, key }));
  start();
});

let authMode = "signin";
function setAuthMode(m) {
  authMode = m;
  $("#authErr").hidden = true; $("#authOk").hidden = true;
  const sign = m === "signin", forgot = m === "forgot", reset = m === "reset";
  $("#authTitle").textContent = sign ? "Sign in" : forgot ? "Reset your password" : "Choose a new password";
  $("#authLead").textContent = sign ? "Use the email and password you set up in Supabase." : forgot ? "We'll email you a link to set a new password." : "Enter a new password for your account.";
  $("#authEmailWrap").hidden = reset; $("#authPassWrap").hidden = forgot;
  $("#authPass").autocomplete = reset ? "new-password" : "current-password";
  $("#authGo").textContent = sign ? "Sign in" : forgot ? "Send reset link" : "Save password";
  $("#forgotBtn").textContent = sign ? "Forgot password?" : "Back to sign in";
}
$("#forgotBtn").addEventListener("click", () => setAuthMode(authMode === "signin" ? "forgot" : "signin"));
$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#authEmail").value.trim(), pass = $("#authPass").value;
  const err = $("#authErr"), ok = $("#authOk"), btn = $("#authGo");
  err.hidden = true; ok.hidden = true; btn.disabled = true;
  try {
    if (authMode === "signin") {
      const { error } = await S.sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
    } else if (authMode === "forgot") {
      const { error } = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
      if (error) throw error;
      ok.textContent = "Check your email for the reset link. Open it on this device."; ok.hidden = false;
    } else {
      if (pass.length < 8) throw { message: "Use at least 8 characters." };
      const { error } = await S.sb.auth.updateUser({ password: pass });
      if (error) throw error;
      $("#authPass").value = ""; setAuthMode("signin"); enterApp();
    }
  } catch (x) {
    const m = (x && x.message) || "";
    err.textContent = /Invalid login/i.test(m) ? "That email and password don't match." : /Email not confirmed/i.test(m) ? "This account isn't confirmed. In Supabase, open Authentication → Users and confirm it." : /Failed to fetch|Load failed|NetworkError/i.test(m) ? "Can't reach the server. Check your connection." : m || "Something went wrong. Try again.";
    err.hidden = false;
  } finally { btn.disabled = false; }
});
async function signOut() {
  closeEditor();
  if (channel) { S.sb.removeChannel(channel); channel = null; }
  try { await S.sb.auth.signOut(); } catch {}
  lsSet(cacheKey(), null);
  S.user = null; S.items = []; S.rows = []; S.loaded = false;
  setAuthMode("signin"); show("#authView");
}

function enterApp() {
  show("#appView");
  $("#whoami").textContent = S.user && S.user.email ? `Signed in as ${S.user.email} · v${APP_VERSION}` : `v${APP_VERSION}`;
  try {
    const cached = JSON.parse(lsGet(cacheKey()) || "null");
    if (cached && cached.length) { setRows(cached); S.loaded = true; }
  } catch {}
  render();
  loadItems(); subscribe();
  if (!S.online && S.loaded && !S.hashDone) { S.hashDone = true; openFromHash(); }
}

async function start() {
  const cfg = getConfig();
  if (!cfg) { show("#setupView"); return; }
  if (!window.supabase || !window.supabase.createClient) { show("#setupView"); $("#setupErr").textContent = "The app didn't finish loading. Reload the page."; $("#setupErr").hidden = false; return; }
  S.sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "rl-auth" } });
  S.sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { S.user = session && session.user; setAuthMode("reset"); show("#authView"); return; }
    if (event === "SIGNED_IN" && session && (!S.user || S.user.id !== session.user.id) && authMode !== "reset") { S.user = session.user; enterApp(); }
    if (event === "TOKEN_REFRESHED" && session) S.user = session.user;
  });
  const { data } = await S.sb.auth.getSession();
  if (data && data.session) { S.user = data.session.user; if (authMode !== "reset") enterApp(); }
  else if (authMode !== "reset") { setAuthMode("signin"); show("#authView"); }
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
start();
})();
