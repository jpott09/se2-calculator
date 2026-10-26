"use strict";
// All paths are relative so the site works at any GitHub Pages subpath.
const TIER_ORDER = ["Ore", "Simple", "Refined", "Complex", "Hi-Tech"];
const MACHINE_ORDER = ["Smelter", "Refinery", "Assembler", "Fabricator"];
const $ = (s) => document.querySelector(s);
const ARROW_L = '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><path d="M8 0v10L0 5z"/></svg>';
const ARROW_R = '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><path d="M0 0v10l8-5z"/></svg>';
const meters = (s) => (s ? `${s / 100} m` : "");
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString();

let D, blockById, recipeFor;
const sel = new Map(); // block id -> qty
const tiles = new Map(); // block id -> catalog tile element
let cat = "all";
let pointer = "mouse"; // type of the last pointer used, to tell taps from mouse hovers
let undoClear = null;

fetch("data/se2.json").then((r) => r.json()).then(init).catch((e) => {
  $("#empty").textContent = "Failed to load data/se2.json: " + e;
});

function init(data) {
  D = data;
  blockById = Object.fromEntries(D.blocks.map((b) => [b.id, b]));
  recipeFor = {};
  for (const r of D.recipes) for (const o in r.out) recipeFor[o] = r;
  for (const b of D.blocks) {
    const g = D.menu.grp[b.g], s = D.menu.sub[g.p];
    b.cat = s.p; b.sub = g.p;
    b.q = (b.n + " " + meters(b.s) + " " + b.k + " " + g.n + " " + s.n + " " + D.menu.cat[s.p].n).toLowerCase();
  }
  $("#ver").textContent = `Data: SE2 Steam build ${D.game.steamBuild} · v${D.game.dataVersion}`;
  readHash();
  buildCats();
  renderCatalog();
  render();
  setView(sel.size ? "plan" : "blocks");
  $("#search").addEventListener("input", () => { renderCatalog(); catalogTop(); });
  document.querySelectorAll("[name=mode]").forEach((r) => r.addEventListener("change", () => { render(); writeHash(); }));
  $("#clear").addEventListener("click", clearOrUndo);
  $("#share").addEventListener("click", share);
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  document.querySelectorAll(".jump button").forEach((b) => (b.onclick = () => $("#" + b.dataset.to).scrollIntoView({ behavior: "smooth" })));
  addEventListener("hashchange", () => { readHash(); renderCatalog(); render(); });
  addEventListener("pointerdown", (e) => { pointer = e.pointerType; hideTip(); }, true);
  addEventListener("scroll", hideTip, true);
}

// ---------- phone views (Blocks / Plan tabs); each view keeps its own scroll position ----------
const viewScroll = {};
function setView(v) {
  const cur = document.body.dataset.view;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  if (cur === v) return;
  viewScroll[cur] = scrollY;
  document.body.dataset.view = v;
  scrollTo(0, viewScroll[v] || 0);
}

function clearOrUndo() {
  const btn = $("#clear");
  clearTimeout(btn.timer);
  if (undoClear) {
    for (const [id, q] of undoClear) sel.set(id, q);
    undoClear = null;
    btn.textContent = "Clear";
  } else {
    undoClear = new Map(sel);
    sel.clear();
    btn.textContent = "Undo";
    btn.timer = setTimeout(() => { undoClear = null; btn.textContent = "Clear"; render(); }, 6000);
  }
  update();
}

function share() {
  if (navigator.share && matchMedia("(pointer: coarse)").matches)
    return navigator.share({ title: document.title, url: location.href }).catch(() => {});
  navigator.clipboard?.writeText(location.href).then(() => flash($("#share"), "Copied!"));
}

// ---------- state <-> URL hash (#b=id:qty,id:qty&f=1) ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  sel.clear();
  for (const part of (p.get("b") || "").split(",")) {
    const [id, q] = part.split(":");
    if (blockById[id] && +q > 0) sel.set(id, Math.floor(+q));
  }
  $("#functional").checked = p.get("f") === "1";
  $("#allparts").checked = !$("#functional").checked;
}
function writeHash() {
  const b = [...sel].map(([id, q]) => `${id}:${q}`).join(",");
  const h = new URLSearchParams();
  if (b) h.set("b", b);
  if ($("#functional").checked) h.set("f", "1");
  history.replaceState(null, "", h.toString() ? "#" + h.toString().replace(/%3A/g, ":").replace(/%2C/g, ",") : location.pathname);
}
function update() { writeHash(); refreshTiles(); render(); }
function add(id, n) {
  const q = Math.max(0, (sel.get(id) || 0) + n);
  q ? sel.set(id, q) : sel.delete(id);
  update();
}

// ---------- catalog ----------
function buildCats() {
  const cats = Object.entries(D.menu.cat).sort((a, b) => a[1].o - b[1].o || a[1].n.localeCompare(b[1].n));
  const nav = $("#cats");
  nav.innerHTML = "";
  for (const [id, c] of [["all", { n: "All" }], ...cats]) {
    const b = el("button", { className: "cat" + (id === cat ? " on" : ""), textContent: c.n });
    b.dataset.cat = id;
    // clicking the active category again goes back to All
    b.onclick = () => {
      cat = cat === id ? "all" : id;
      nav.querySelectorAll(".cat").forEach((x) => x.classList.toggle("on", x.dataset.cat === cat));
      renderCatalog(); catalogTop();
    };
    nav.append(b);
  }
}

// back to the first block after the filter changes (list scrolls on its own when side by side, with the page on phones)
function catalogTop() {
  $("#blocks").scrollTop = 0;
  const y = $(".catalog").getBoundingClientRect().top + scrollY;
  if (scrollY > y) scrollTo(0, y);
}

function renderCatalog() {
  const q = $("#search").value.trim().toLowerCase();
  const list = D.blocks.filter((b) => (cat === "all" || b.cat === cat) && (!q || q.split(/\s+/).every((w) => b.q.includes(w))));
  // group by subcategory, then by block kind (size variants side by side)
  const subs = new Map();
  for (const b of list) {
    if (!subs.has(b.sub)) subs.set(b.sub, new Map());
    const kinds = subs.get(b.sub);
    const key = b.k + "|" + b.g;
    if (!kinds.has(key)) kinds.set(key, []);
    kinds.get(key).push(b);
  }
  const subOrder = [...subs.keys()].sort((a, b) => {
    const A = D.menu.sub[a], B = D.menu.sub[b], ca = D.menu.cat[A.p], cb = D.menu.cat[B.p];
    return ca.o - cb.o || ca.n.localeCompare(cb.n) || A.o - B.o || A.n.localeCompare(B.n);
  });
  const root = $("#blocks");
  root.innerHTML = "";
  tiles.clear();
  if (!list.length) root.append(el("p", { className: "empty", textContent: "No blocks match." }));
  for (const s of subOrder) {
    const sub = D.menu.sub[s];
    root.append(el("h4", { innerHTML: `<span>${D.menu.cat[sub.p].n}</span> ${sub.n}` }));
    const grid = el("div", { className: "grid" });
    for (const variants of subs.get(s).values()) {
      variants.sort((a, b) => (a.s || 0) - (b.s || 0) || a.n.localeCompare(b.n));
      for (const b of variants) grid.append(tile(b));
    }
    root.append(grid);
  }
}

function tile(b) {
  const t = el("button", { className: "tile", ariaLabel: b.n });
  t.innerHTML = `<img src="icons/${b.i}.webp" alt="" loading="lazy">` +
    (b.s ? `<span class="size">${meters(b.s)}</span>` : "") + `<span class="qty" title="Remove one"><i>−</i><b></b></span><span class="tname">${b.n}</span>`;
  // like in game: Ctrl ×100, Shift ×10; right-click removes. On touch, long-press shows the recipe instead.
  const step = (e) => (e.ctrlKey || e.metaKey ? 100 : e.shiftKey ? 10 : 1);
  t.onclick = (e) => add(b.id, e.target.closest(".qty") ? -step(e) : step(e)); // the count pill is the remove button
  t.oncontextmenu = (e) => { e.preventDefault(); pointer === "mouse" ? add(b.id, -step(e)) : showTip(t, blockTip(b)); };
  hoverTip(t, () => blockTip(b));
  tiles.set(b.id, t);
  setTile(t, sel.get(b.id));
  return t;
}
function setTile(t, q) {
  t.classList.toggle("picked", !!q);
  t.querySelector(".qty b").textContent = q || "";
  t.querySelector(".qty").hidden = !q;
}
function refreshTiles() { for (const [id, t] of tiles) setTile(t, sel.get(id)); }

function blockTip(b) {
  const rows = (o) => Object.entries(o).map(([i, a]) => `<div class="tr">${icon(i)}<span>${D.items[i].n}</span><b>${a}</b></div>`).join("");
  // Combined like the in-game build screen (critical + optional per item).
  const total = { ...b.c };
  for (const [i, a] of Object.entries(b.o)) addTo(total, i, a);
  return `<div class="th">${b.n}${b.s ? ` <span class="size">${meters(b.s)}</span>` : ""}</div>` +
    `<div class="tsub">${D.menu.grp[b.g].n} · ${fmt(b.kg)} kg</div>` + rows(total);
}

// ---------- calculation ----------
function addTo(acc, k, n) { acc[k] = (acc[k] || 0) + n; }

function compute() {
  const functional = $("#functional").checked;
  const comps = {};
  for (const [id, q] of sel) {
    const b = blockById[id];
    for (const [i, a] of Object.entries(b.c)) addTo(comps, i, a * q);
    if (!functional) for (const [i, a] of Object.entries(b.o)) addTo(comps, i, a * q);
  }
  // full chain: recurse through recipes down to ore
  const ore = {}, steps = {};
  const expand = (item, n) => {
    const r = recipeFor[item];
    if (!r) return addTo(ore, item, n);
    const crafts = n / r.out[item];
    const machine = r.m.find((m) => m !== "Backpack") || r.m[0];
    steps[machine] ??= {};
    addTo(steps[machine], item, n);
    for (const [i, a] of Object.entries(r.in)) expand(i, a * crafts);
  };
  for (const [i, n] of Object.entries(comps)) expand(i, n);
  // backpack mode: backpack-craftable components become ore, others stay components
  const bpOre = {}, bpComp = {};
  for (const [i, n] of Object.entries(comps)) {
    const r = recipeFor[i];
    if (r && r.m.includes("Backpack")) for (const [o, a] of Object.entries(r.in)) addTo(bpOre, o, (a * n) / r.out[i]);
    else addTo(bpComp, i, n);
  }
  return { comps, ore, steps, bpOre, bpComp };
}

// ---------- render ----------
function render() {
  renderSelection();
  const has = sel.size > 0;
  $("#results").hidden = !has;
  $("#empty").hidden = has;
  if (!has) return;
  const r = compute();
  table($("#t-comp"), r.comps);
  const mass = Object.entries(r.comps).reduce((s, [i, n]) => s + (D.items[i].m || 0) * n, 0);
  $("#comp-foot").textContent = `${fmt(sum(r.comps))} items · ${fmt(mass)} kg`;

  table($("#t-bp-ore"), r.bpOre);
  const bpMade = Object.keys(r.comps).filter((i) => recipeFor[i]?.m.includes("Backpack")).map((i) => D.items[i].n);
  $("#bp-note").textContent = bpMade.length
    ? `Crafted from this ore while welding: ${new Intl.ListFormat("en").format(bpMade)} (Smelter cost, 0.15× speed).`
    : "None of these components can be crafted by the hand welder.";
  machineGroups($("#bp-groups"), byMachine(r.bpComp), "bp", "Plus these from the ");

  const oreBox = $("#ore-tiles");
  oreBox.innerHTML = "";
  oreBox.append(el("div", { className: "ore total", innerHTML: `<div><b>${fmt(sum(r.ore))}</b><span>Total ore</span></div>` }));
  for (const [i, n] of sortItems(r.ore)) {
    oreBox.append(el("div", { className: "ore", innerHTML: `${icon(i)}<div><b>${fmt(n)}</b><span>${D.items[i].n}</span></div>` }));
  }
  machineGroups($("#steps"), r.steps, "st", "");
}

// split {item: n} by the machine that makes each item
function byMachine(obj) {
  const out = {};
  for (const [i, n] of Object.entries(obj)) addTo(out[machineOf(i)] ??= {}, i, n);
  return out;
}
const machineOf = (i) => { const r = recipeFor[i]; return r ? r.m.find((m) => m !== "Backpack") || r.m[0] : "Ore"; };

// direct inputs a machine needs to make {item: n}
function inputsFor(obj) {
  const need = {};
  for (const [i, n] of Object.entries(obj)) {
    const r = recipeFor[i];
    for (const [x, a] of Object.entries(r.in)) addTo(need, x, (a * n) / r.out[i]);
  }
  return need;
}

function machineGroups(root, groups, idp, prefix) {
  root.innerHTML = "";
  for (const m of MACHINE_ORDER.filter((m) => groups[m])) {
    const box = el("div", { className: "mgroup" });
    box.innerHTML = `<h3>${prefix ? prefix + m : m}</h3>`;
    const t = el("table", { className: "tbl", id: `${idp}-${m}` });
    table(t, groups[m]);
    const needs = el("div", { className: "needs", id: `${idp}in-${m}` });
    needs.innerHTML = `<span class="needs-l">${m} input</span>` + sortItems(inputsFor(groups[m]))
      .map(([i, n]) => `<span class="chip" data-item="${i}">${icon(i)}${D.items[i].n}<b>${fmt(n)}</b></span>`).join("");
    needs.querySelectorAll(".chip").forEach((c) => tapTip(c, () => itemTip(c.dataset.item)));
    box.append(t, needs);
    root.append(box);
  }
}

function renderSelection() {
  const ul = $("#selection");
  ul.innerHTML = "";
  let count = 0;
  for (const [id, q] of sel) {
    const b = blockById[id];
    count += q;
    const li = el("li");
    li.innerHTML = `<img src="icons/${b.i}.webp" alt=""><span class="sn" title="${b.n}"><span>${b.n}</span>${b.s ? `<span class="size">${meters(b.s)}</span>` : ""}</span>`;
    // in-game style selector: ◀ value ▶
    const minus = el("button", { className: "step-btn", innerHTML: ARROW_L, ariaLabel: "Remove one" });
    const input = el("input", { type: "number", min: 0, value: q, className: "num", ariaLabel: "Quantity", inputMode: "numeric" });
    const plus = el("button", { className: "step-btn", innerHTML: ARROW_R, ariaLabel: "Add one" });
    const stepper = el("span", { className: "sel" });
    const del = el("button", { className: "del", textContent: "×", ariaLabel: "Remove" });
    minus.onclick = () => add(id, -1);
    plus.onclick = () => add(id, 1);
    del.onclick = () => add(id, -q);
    input.onchange = () => add(id, Math.max(0, Math.floor(+input.value || 0)) - q);
    input.onfocus = () => input.select();
    stepper.append(minus, input, plus);
    li.append(stepper, del);
    ul.append(li);
  }
  const kg = [...sel].reduce((t, [id, q]) => t + blockById[id].kg * q, 0);
  $("#summary").textContent = sel.size ? `${count} block${count === 1 ? "" : "s"} · ${sel.size} type${sel.size === 1 ? "" : "s"} · ${fmt(Math.round(kg))} kg grid mass` : "";
  $("#clear").disabled = !sel.size && !undoClear;
  $("#jump").hidden = !sel.size;
  const tc = $("#tab-count"), was = tc.textContent;
  tc.textContent = count || "";
  if (count && was !== tc.textContent) { tc.classList.remove("bump"); void tc.offsetWidth; tc.classList.add("bump"); }
}

function table(t, obj) {
  const rows = sortItems(obj);
  t.hidden = !rows.length;
  t.innerHTML = rows.map(([i, n]) =>
    `<tr data-item="${i}"><td class="ic">${icon(i)}</td><td class="nm">${D.items[i].n}</td><td class="n">${fmt(n)}</td></tr>`).join("");
  t.querySelectorAll("tr").forEach((tr) => tapTip(tr, () => itemTip(tr.dataset.item)));
}

function itemTip(i) {
  const it = D.items[i], r = recipeFor[i];
  let h = `<div class="th">${it.n}</div><div class="tsub">${it.tier || it.t} · ${it.m} kg</div>`;
  if (r) {
    h += `<div class="tsep">Recipe · ${r.m.map((m) => (m === "Backpack" ? "Hand welder" : m)).join(" / ")}</div>` +
      Object.entries(r.in).map(([x, a]) => `<div class="tr">${icon(x)}<span>${D.items[x].n}</span><b>${a}</b></div>`).join("") +
      `<div class="tsep">Makes ${r.out[i]}</div>`;
  }
  return h;
}

function sortItems(obj) {
  return Object.entries(obj).filter(([, n]) => n > 0).sort(([a], [b]) => {
    const A = D.items[a], B = D.items[b];
    const ta = TIER_ORDER.indexOf(A.tier || A.t), tb = TIER_ORDER.indexOf(B.tier || B.t);
    return ta - tb || A.n.localeCompare(B.n);
  });
}

// ---------- helpers ----------
const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);
const icon = (i) => `<img class="ii" src="icons/${D.items[i].i}.webp" alt="" title="${D.items[i].n}">`;
function el(tag, props = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === "ariaLabel" ? e.setAttribute("aria-label", v) : (e[k] = v);
  return e;
}
function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}
// mouse: tooltip on hover. touch: hover never fires; tapTip shows it on tap instead.
function hoverTip(node, html) {
  node.onpointerenter = (e) => e.pointerType === "mouse" && showTip(node, html());
  node.onpointerleave = (e) => e.pointerType === "mouse" && hideTip();
}
function tapTip(node, html) {
  hoverTip(node, html);
  node.onclick = () => pointer !== "mouse" && showTip(node, html());
}
function showTip(anchor, html) {
  const tip = $("#tip");
  tip.innerHTML = html;
  tip.hidden = false;
  const r = anchor.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  let x = r.right + 10, y = r.top;
  if (x + w > innerWidth - 8) x = r.left - w - 10;
  if (x < 8) { // no room beside it (phones): centre it below the anchor, or above if that runs off screen
    x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    y = r.bottom + 6 + h > innerHeight - 8 ? r.top - h - 6 : r.bottom + 6;
  }
  if (y + h > innerHeight - 8) y = innerHeight - h - 8;
  y = Math.max(8, y);
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
function hideTip() { $("#tip").hidden = true; }
