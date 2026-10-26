"use strict";
// All paths are relative so the site works at any GitHub Pages subpath.
const TIER_ORDER = ["Ore", "Simple", "Refined", "Complex", "Hi-Tech"];
const MACHINE_ORDER = ["Smelter", "Refinery", "Assembler", "Fabricator"];
const $ = (s) => document.querySelector(s);
const ARROW_L = '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><path d="M8 0v10L0 5z"/></svg>';
const ARROW_R = '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><path d="M0 0v10l8-5z"/></svg>';
const meters = (s) => (s ? `${s / 100} m` : "");
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString();
const G = 9.80665; // 1 g in m/s²
// value with the largest unit it reaches, e.g. si(8950, "N") = "8.95 kN"
const si = (n, u, big = ["M", "k"]) => {
  for (const [p, x] of [[big[0], 1e6], [big[1], 1e3]]) if (Math.abs(n) >= x) return `${fmt(n / x)} ${p}${u}`;
  return `${fmt(n)} ${u}`;
};
const draw = (n, u) => (u === "kW" ? si(n * 1000, "W") : `${fmt(n)} ${u}`);
const energy = (s) => (s.u === "kWh" ? si(s.cap * 1000, "Wh") : `${fmt(s.cap)} ${s.u}`);
const duration = (h) => (h < 1 ? `${fmt(Math.floor(h * 60))} min` : `${Math.floor(h)} h ${Math.floor((h % 1) * 60)} min`);
const worksIn = (t) => (t.atm && t.vac ? "anywhere" : t.atm ? "atmosphere" : "vacuum");
const tonnes = (kg) => `${fmt(kg >= 100e3 ? Math.round(kg / 1000) : kg / 1000)} t`;

let D, blockById, recipeFor;
const sel = new Map(); // block id -> qty
const tiles = new Map(); // block id -> catalog tile element
let cat = "all";
let grav = null; // selected gravity in m/s²
let planetsAt; // gravity -> "Byblos, Kemik, and Verdure"
const off = new Set(); // block ids unchecked in the Power panel
let runMin = 10; // battery runtime the Power panel sizes batteries for
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
  buildGravity();
  readHash();
  buildCats();
  renderCatalog();
  render();
  setView(sel.size ? "plan" : "blocks");
  // typing searches every category: the dropdown is for browsing
  $("#search").addEventListener("input", () => { cat = $("#cats").value = "all"; renderCatalog(); catalogTop(); });
  $("#t-power").addEventListener("change", (e) => {
    const boxes = e.target.classList.contains("all") ? e.target.closest("table").querySelectorAll("tbody input") : [e.target];
    for (const c of boxes) e.target.checked ? off.delete(c.value) : off.add(c.value);
    renderPower(); writeHash();
  });
  $("#power-need").addEventListener("change", (e) => {
    runMin = Math.max(1, Math.floor(+e.target.value || 10));
    renderPower(); writeHash();
  });
  $("#grav").addEventListener("change", (e) => { grav = +e.target.value; render(); writeHash(); });
  document.querySelectorAll("[name=mode]").forEach((r) => r.addEventListener("change", () => { render(); writeHash(); }));
  $("#clear").addEventListener("click", clearOrUndo);
  $("#share").addEventListener("click", share);
  // prefill the issue with the current build so wrong numbers can be reproduced
  $("#report").addEventListener("click", (e) => (e.currentTarget.href = "https://github.com/jpott09/se2-calculator/issues/new?body=" +
    encodeURIComponent(`Build: ${location.href}\n\nWhat's wrong:\n`)));
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  document.querySelectorAll(".jump button").forEach((b) => (b.onclick = () => $("#" + b.dataset.to).scrollIntoView({ behavior: "smooth" })));
  new ResizeObserver(layoutJump).observe($("#jump"));
  addEventListener("hashchange", () => { readHash(); renderCatalog(); render(); });
  addEventListener("pointerdown", (e) => { pointer = e.pointerType; hideTip(); if (e.target !== $("#clear")) disarmClear(); }, true);
  addEventListener("scroll", hideTip, true);
}

// jump bar: as few rows as fit, buttons split evenly between them
const JUMP_MIN = 92; // px a button needs for its label
function layoutJump() {
  const nav = $("#jump"), n = [...nav.children].filter((b) => !b.hidden).length;
  if (!n || nav.hidden) return;
  const rows = Math.ceil((n * JUMP_MIN) / nav.clientWidth);
  nav.style.gridTemplateColumns = `repeat(${Math.ceil(n / rows)}, minmax(0, 1fr))`;
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

// Clear asks once ("Clear all?"), then offers Undo for a few seconds
function clearOrUndo() {
  const btn = $("#clear");
  clearTimeout(btn.timer);
  if (undoClear) {
    for (const [id, q] of undoClear) sel.set(id, q);
    undoClear = null;
    btn.textContent = "Clear";
  } else if (!btn.classList.contains("armed")) {
    btn.classList.add("armed");
    btn.textContent = "Clear all?";
    btn.timer = setTimeout(disarmClear, 4000);
    return;
  } else {
    btn.classList.remove("armed");
    undoClear = new Map(sel);
    sel.clear();
    btn.textContent = "Undo";
    btn.timer = setTimeout(() => { undoClear = null; btn.textContent = "Clear"; render(); }, 6000);
  }
  update();
}

function disarmClear() {
  const btn = $("#clear");
  if (!btn.classList.contains("armed")) return;
  clearTimeout(btn.timer);
  btn.classList.remove("armed");
  btn.textContent = "Clear";
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
  const g = $(`#grav input[value="${p.get("g")}"]`) || $("#grav input");
  g.checked = true;
  grav = +g.value;
  off.clear();
  for (const id of (p.get("x") || "").split(",")) if (blockById[id]) off.add(id);
  runMin = Math.max(1, Math.floor(+p.get("t") || 10));
}
function writeHash() {
  const b = [...sel].map(([id, q]) => `${id}:${q}`).join(",");
  const h = new URLSearchParams();
  if (b) h.set("b", b);
  if ($("#functional").checked) h.set("f", "1");
  if (grav !== D.planets[0].g) h.set("g", grav);
  const x = [...off].filter((id) => sel.has(id));
  if (x.length) h.set("x", x.join(","));
  if (runMin !== 10) h.set("t", runMin);
  history.replaceState(null, "", h.toString() ? "#" + h.toString().replace(/%3A/g, ":").replace(/%2C/g, ",") : location.pathname);
}
function update() { writeHash(); refreshTiles(); render(); }
function add(id, n) {
  const q = Math.max(0, (sel.get(id) || 0) + n);
  q ? sel.set(id, q) : sel.delete(id);
  update();
}

// planets grouped by surface gravity, strongest first
function buildGravity() {
  const byG = new Map();
  for (const p of D.planets) byG.set(p.g, [...(byG.get(p.g) || []), p.n]);
  planetsAt = (g) => new Intl.ListFormat("en").format(byG.get(g));
  for (const g of byG.keys()) {
    const l = el("label", { title: `${planetsAt(g)} · ${fmt(g)} m/s²` });
    l.innerHTML = `<input type="radio" name="grav" value="${g}"><span>${fmt(g / G)} g</span>`;
    $("#grav").append(l);
  }
}

// ---------- catalog ----------
function buildCats() {
  const cats = Object.entries(D.menu.cat).sort((a, b) => a[1].o - b[1].o || a[1].n.localeCompare(b[1].n));
  const pick = $("#cats");
  for (const [id, c] of [["all", { n: "All categories" }], ...cats]) pick.append(el("option", { value: id, textContent: c.n }));
  pick.value = cat;
  pick.onchange = () => { cat = pick.value; renderCatalog(); catalogTop(); };
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
    `<div class="tsub">${D.menu.grp[b.g].n} · ${fmt(b.kg)} kg</div>` + (b.th ? thrustTip(b.th) : "") + powerTip(b) +
    (b.th || b.pw || b.st ? `<div class="tsep">Components</div>` : "") + rows(total);
}
function powerTip(b) {
  const p = b.pw || {}, s = b.st, row = (k, v) => `<div class="tr"><span>${k}</span><b>${v}</b></div>`;
  return (p.use ? row("Uses", draw(p.use, "kW")) : "") + (p.work ? row("Uses while working", draw(p.work, "kW")) : "") +
    (p.gen ? row(p.var ? `Makes up to (${p.var})` : "Makes", draw(p.gen, "kW")) : "") +
    (s ? row("Stores", `${energy(s)} ${s.r === "Electricity" ? "" : s.r.toLowerCase()}`) + row("Max output", draw(s.out, s.fu)) : "");
}
function thrustTip(t) {
  const row = (k, v) => `<div class="tr"><span>${k}</span><b>${v}</b></div>`;
  return row("Thrust", si(t.f, "N")) + row("Draw while firing", draw(t.d, t.u)) + row("Works in", worksIn(t)) +
    (t.atm ? row("Lifts at 1 g", tonnes((t.f * t.atm) / G)) : "");
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
  renderThrust();
  renderPower();
  layoutJump();
}

// electricity of one block, kW: draw at full load (thrusters firing, production running), max generation, battery
function powerOf(b) {
  const p = b.pw || {}, bat = b.st?.r === "Electricity" ? b.st : null;
  return { draw: (p.use || 0) + (p.work || 0) + (b.th?.u === "kW" ? b.th.d : 0), gen: p.gen || 0, bat };
}
const POWER_GROUPS = [["use", "Consumption"], ["gen", "Generation"], ["bat", "Batteries"]];
const powerGroup = (p) => (p.bat ? "bat" : p.gen ? "gen" : p.draw ? "use" : null);

function renderPower() {
  const groups = { use: [], gen: [], bat: [] };
  for (const [id, q] of sel) {
    const g = powerGroup(powerOf(blockById[id]));
    if (g) groups[g].push([id, q]);
  }
  const any = Object.values(groups).some((g) => g.length);
  $("#p-power").hidden = $("#jump-power").hidden = !any;
  if (!any) return;
  const tot = { draw: 0, gen: 0, out: 0, cap: 0 };
  let variable = false;
  $("#t-power").innerHTML = POWER_GROUPS.filter(([g]) => groups[g].length).map(([g, title]) => {
    let sub = 0, on = 0;
    const rows = groups[g].map(([id, q]) => {
      const b = blockById[id], p = powerOf(b), w = b.pw || {}, ok = !off.has(id);
      const val = g === "use" ? p.draw : g === "gen" ? p.gen : p.bat.out;
      if (ok) {
        on++; sub += val * q;
        tot.draw += p.draw * q; tot.gen += p.gen * q;
        if (p.bat) { tot.out += p.bat.out * q; tot.cap += p.bat.cap * q; }
        variable ||= !!w.var;
      }
      const each = g === "bat" ? `${draw(p.bat.out, "kW")} · ${energy(p.bat)}` : `${draw(val, "kW")}${w.var ? ` max (${w.var})` : ""}`;
      return `<tr class="${ok ? "" : "off"}"><td class="ck"><input type="checkbox" value="${id}" ${ok ? "checked" : ""} aria-label="Count ${b.n}"></td>` +
        `<td class="ic"><img src="icons/${b.i}.webp" alt=""></td><td class="nm">${b.n} ${b.s ? `<span class="size">${meters(b.s)}</span>` : ""}` +
        `<div class="muted">${q} × ${each}</div></td><td class="n">${draw(val * q, "kW")}</td></tr>`;
    }).join("");
    const all = on === groups[g].length;
    return `<table class="tbl power" data-group="${g}"><thead><tr><td class="ck"><input type="checkbox" class="all" ${all ? "checked" : ""} ` +
      `data-mixed="${on && !all ? 1 : ""}" aria-label="Count all ${title.toLowerCase()}"></td><th colspan="2">${title}</th>` +
      `<td class="n ${g === "use" ? "use" : "make"}">${draw(sub, "kW")}</td></tr></thead><tbody>${rows}</tbody></table>`;
  }).join("");
  $("#t-power").querySelectorAll("[data-mixed='1']").forEach((c) => (c.indeterminate = true));

  const net = tot.gen - tot.draw;
  const bat = net >= 0 || !tot.out ? null : tot.out < -net ? [`${draw(-net - tot.out, "kW")} short`, "use"] : [`last ${duration(tot.cap / -net)}`, ""];
  const row = (k, v, cls, id, n) => `<tr><td class="nm">${k}</td><td class="n ${cls}"${id ? ` id="${id}" data-n="${n}"` : ""}>${v}</td></tr>`;
  // raw kW in data-n for tools/test_site.py
  $("#t-power-sum").innerHTML = row("Draw", draw(tot.draw, "kW"), "use", "pw-draw", tot.draw) +
    row(variable ? "Generation (max)" : "Generation", draw(tot.gen, "kW"), "make", "pw-gen", tot.gen) +
    row(net >= 0 ? "Surplus" : "Shortfall", draw(Math.abs(net), "kW"), net >= 0 ? "make" : "use") +
    (bat ? row("Batteries", bat[0], bat[1]) : "");
  // batteries of each size to cover the shortfall: enough output, and enough charge for runMin
  const need = $("#power-need");
  need.hidden = net >= 0;
  if (net >= 0) return;
  const focus = document.activeElement === need.querySelector("input");
  need.innerHTML = `<span class="needs-l">Batteries needed for <input id="run-min" class="num" type="number" min="1" value="${runMin}" inputmode="numeric" aria-label="Minutes"> min</span>` +
    D.blocks.filter((b) => b.st?.r === "Electricity").map((b) => {
      const n = Math.max(Math.ceil(-net / b.st.out), Math.ceil((-net * runMin) / 60 / b.st.cap));
      return `<span class="chip"><img class="ii" src="icons/${b.i}.webp" alt="">${meters(b.s)}<b>${fmt(n)}</b></span>`;
    }).join("");
  if (focus) need.querySelector("input").focus();
}

// lift = total thrust / gravity, as if every listed thruster faces down
function renderThrust() {
  const list = [...sel].filter(([id]) => blockById[id].th);
  $("#p-thrust").hidden = $("#jump-thrust").hidden = !list.length;
  if (!list.length) return;
  const f = { atm: 0, vac: 0 };
  $("#t-thrust").innerHTML = list.map(([id, q]) => {
    const b = blockById[id], t = b.th;
    f.atm += t.f * t.atm * q;
    f.vac += t.f * t.vac * q;
    return `<tr><td class="ic"><img src="icons/${b.i}.webp" alt=""></td><td class="nm">${b.n} ${b.s ? `<span class="size">${meters(b.s)}</span>` : ""}` +
      `<div class="muted">${q} × ${si(t.f, "N")} · ${worksIn(t)}</div></td><td class="n">${si(t.f * q, "N")}</td></tr>`;
  }).join("");
  $("#grav-where").textContent = `${planetsAt(grav)} · ${fmt(grav)} m/s²`;
  const row = (k, fn, attr = () => "") => `<tr><td class="nm">${k}</td>` +
    ["atm", "vac"].map((e) => `<td class="n"${attr(e)}>${fn(f[e])}</td>`).join("") + "</tr>";
  // raw newtons on the thrust row for tools/test_site.py
  $("#t-lift").innerHTML = row("Thrust", (n) => si(n, "N"), (e) => ` id="thrust-${e}" data-n="${f[e]}"`) +
    row("Lifts (all down)", (n) => tonnes(n / grav));
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
