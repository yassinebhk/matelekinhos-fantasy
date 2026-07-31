/* LaLiga Fantasy — app de panel (pestañas + gráficos + drill-down). Lee window.METRICS. */
(function () {
  const METRICS = window.METRICS || {};
  // Estructura multi-liga: { multi, list:[{id,name}], leagues:{ id: <datos de esa liga> } }.
  // Elegimos el bloque de la liga guardada (o la primera). Todo el resto del código
  // usa `D` igual que antes, así que no cambia nada aguas abajo.
  const MULTI = !!(METRICS.multi && METRICS.leagues);
  const LEAGUES = MULTI ? (METRICS.list || []) : [];
  const leagueBlock = (id) => MULTI ? (METRICS.leagues[id] || METRICS.leagues[(LEAGUES[0] || {}).id] || {}) : METRICS;
  let ffLeague = localStorage.getItem("ff_league");
  if (MULTI && !(METRICS.leagues || {})[ffLeague]) ffLeague = (LEAGUES[0] || {}).id;
  const D = leagueBlock(ffLeague);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const hide = (id) => { const c = document.getElementById(id); if (c) c.style.display = "none"; };

  // ---------- formato ----------
  const num = (n) => (n ?? 0).toLocaleString("es-ES");
  const eur = (n) => n == null ? "—" : num(Math.round(n)) + " €";            // cifra COMPLETA
  const eurK = (n) => {                                                       // compacto (ticker/ejes)
    if (n == null) return "—";
    const a = Math.abs(n), m = n / 1e6;
    return (a >= 1e6 ? m.toFixed(1).replace(/\.0$/, "") + "M" : a >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n)) + " €";
  };
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + eur(Math.abs(n || 0));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fdate = (s) => { const d = new Date(s); return isNaN(d) ? (s || "") : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }); };
  const ftime = (s) => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }); };
  const fshort = (s) => { const d = new Date(s); return isNaN(d) ? (s || "") : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }); };
  const fdt = (s) => { const t = ftime(s); return fshort(s) + (t ? " · " + t : ""); };            // 29 jul · 00:12

  // ---------- índices ----------
  const players = D.players || [];
  const managers = D.managers || [];
  const playersById = {}; players.forEach(p => playersById[p.id] = p);
  const byName = {}; players.forEach(p => { if (!byName[p.name]) byName[p.name] = p; });
  const managersByName = {}; managers.forEach(m => managersByName[m.name] = m);
  const TEAMS = D.teams || {};
  const teamName = (p) => (p && p.teamId && TEAMS[p.teamId] && TEAMS[p.teamId].name) || (p && p.team) || "";

  // movimientos del día ROBUSTOS: cambio real de valor por jugador (p.day), no la
  // diferencia entre las dos últimas capturas (que es 0 si son del mismo día de valores).
  // Es la misma fuente que usa el índice de la cabecera → ticker/mini/índice consistentes.
  const dayMovers = (() => {
    const m = players.filter(p => p.day).map(p => ({ id: p.id, player: p.name, value: p.value, delta: p.day, deltaPct: p.value ? Math.round(p.day / p.value * 1000) / 10 : 0 }));
    const up = m.filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta);
    const down = m.filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta);
    return (up.length || down.length) ? { up, down } : (D.movers || { up: [], down: [] });
  })();

  // ---------- movimientos (compra/venta/fichaje/cláusula) ----------
  // Dirección REAL de un traspaso: quién SUELTA → quién RECIBE (el mercado = null).
  // 33=venta al mercado (el actor va en `to`); 31=fichaje del mercado (sin vendedor);
  // 1/32 = de un mánager a otro; 4 = blindó su propio jugador (sin traspaso).
  const _tp = (t) => (t.type != null ? t.type : t.typeId);
  function moveDir(t) {
    const tp = _tp(t), real = x => (x && x !== "?") ? x : null;
    if (tp === 33) return { giver: real(t.to), receiver: null };
    if (tp === 4) return { giver: real(t.to) || real(t.from), receiver: null, shield: true };
    return { giver: real(t.from), receiver: real(t.to) };
  }
  const mgrOrMarket = (x) => x ? `<span class="linkmgr" data-manager="${esc(x)}">${esc(x)}</span>` : `<span class="mut">el mercado</span>`;
  const playerLink = (t) => t.playerId ? `<b class="linkmgr" data-player="${esc(t.playerId)}">${esc(t.player)}</b>` : `<b>${esc(t.player)}</b>`;
  // línea de un movimiento desde la óptica de un mánager (modal de presidente)
  function moveForManager(t, me) {
    const d = moveDir(t), pl = playerLink(t);
    if (d.shield) return `🛡️ ${pl} <span class="mut">(blindado)</span>`;
    if (d.receiver === me) return `◀ ${pl} <span class="mut">de</span> ${mgrOrMarket(d.giver)}`;
    return `▶ ${pl} <span class="mut">a</span> ${mgrOrMarket(d.receiver)}`;
  }

  // ---------- ordenar tablas pulsando la cabecera (como en Estadísticas) ----------
  // Marca cada <th> ordenable con data-sk="n" (número) o data-sk="t" (texto). El valor
  // exacto se lee de data-v en la celda si existe; si no, del texto. Reordena los <tr>
  // en el sitio (respeta filtros que solo ocultan filas) y persiste tras re-render.
  const _sortState = {};   // tbodyId -> { i, dir, type }
  function _cellVal(tr, i, type) {
    const td = tr.children[i];
    if (!td) return type === "n" ? -Infinity : "";
    if (td.dataset.v != null && td.dataset.v !== "")
      return type === "n" ? (parseFloat(td.dataset.v) || 0) : td.dataset.v.toLowerCase();
    const txt = (td.textContent || "").trim();
    return type === "n" ? (parseFloat(txt.replace(/\./g, "").replace(/[^\d.\-]/g, "")) || 0) : txt.toLowerCase();
  }
  function applySort(tbody) {
    if (!tbody) return;
    const s = _sortState[tbody.id]; if (!s) return;
    Array.from(tbody.querySelectorAll("tr"))
      .filter(r => r.children.length && !r.querySelector(".placeholder"))
      .sort((a, b) => {
        const va = _cellVal(a, s.i, s.type), vb = _cellVal(b, s.i, s.type);
        return s.dir * (s.type === "n" ? va - vb : String(va).localeCompare(String(vb), "es"));
      })
      .forEach(r => tbody.appendChild(r));
  }
  function makeSortable(tableSel) {
    const table = $(tableSel); if (!table || !table.tHead) return;
    const tbody = table.tBodies[0]; if (!tbody) return;
    if (!tbody.id) tbody.id = "sb_" + Math.abs([...tableSel].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7));
    const cells = Array.from(table.tHead.rows[0].cells);
    cells.forEach((th, i) => {
      const type = th.dataset.sk; if (!type) return;
      th.classList.add("srt");
      th.addEventListener("click", () => {
        const cur = _sortState[tbody.id];
        const dir = (cur && cur.i === i) ? -cur.dir : (type === "n" ? -1 : 1);
        _sortState[tbody.id] = { i, dir, type };
        cells.forEach(c => c.classList.remove("sasc", "sdesc"));
        th.classList.add(dir < 0 ? "sdesc" : "sasc");
        applySort(tbody);
      });
    });
  }

  // ---------- gráficos (SVG, sin librerías) ----------
  // divisiones "redondas" de un eje (~count marcas) para etiquetas legibles
  function niceTicks(min, max, count = 5) {
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
    if (min === max) { const p = Math.abs(min) * 0.1 || 1; min -= p; max += p; }
    const raw = (max - min) / Math.max(1, count - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag, step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { min: lo, max: hi, ticks };
  }
  // colores bien diferenciados para N series (ángulo áureo -> máxima separación)
  function palette(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(`hsl(${Math.round((i * 137.508) % 360)} 68% 60%)`);
    return out;
  }
  // registro de gráficas para el tooltip al pasar el ratón (guardamos su escala/series)
  const CHARTS = {};
  let _chartSeq = 0;
  // envuelve un SVG con escalas numéricas: eje Y a la izquierda, eje X debajo.
  // Las etiquetas de los extremos del eje X se alinean para no recortarse.
  function axedChart(svg, yTicks, xTicks, plotId, extra) {
    const y = yTicks.map(k => `<span style="top:${Math.max(3, Math.min(97, k.p)).toFixed(1)}%">${k.t}</span>`).join("");
    const x = (xTicks || []).map(k => {
      const tf = k.p <= 2 ? "translateX(0)" : k.p >= 98 ? "translateX(-100%)" : "translateX(-50%)";
      return `<span style="left:${Math.max(0, Math.min(100, k.p)).toFixed(1)}%;transform:${tf}">${k.t}</span>`;
    }).join("");
    return `<div class="axc"><div class="axc-y">${y}</div><div class="axc-plot"${plotId ? ` data-chart="${plotId}"` : ""}>${svg}${extra || ""}</div><div class="axc-x">${x}</div></div>`;
  }

  // dibuja el SVG + ejes de una gráfica ya registrada en CHARTS[id], según su selección
  // activa (leyenda). Reescala el eje Y a las series VISIBLES para que se vean bien.
  function _buildAxc(id) {
    const c = CHARTS[id], W = 1000, H = c.height, pad = 16, L = c.L;
    const vis = c.all.map((s, i) => ({ s, i })).filter(o => c.active.size === 0 || c.active.has(o.i));
    let mn = Infinity, mx = -Infinity;
    vis.forEach(o => o.s.values.forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; }));
    const nt = niceTicks(mn, mx, c.yTicksN), span = (nt.max - nt.min) || 1;
    const X = (i, n) => (i + (L - n)) / Math.max(1, L - 1) * W;
    const Y = (v) => H - pad - ((v - nt.min) / span) * (H - 2 * pad);
    const grid = nt.ticks.map(v => `<line class="grid-line" x1="0" y1="${Y(v).toFixed(1)}" x2="${W}" y2="${Y(v).toFixed(1)}"/>`).join("");
    const paths = vis.map(o => {
      const s = o.s, n = s.values.length;
      const d = s.values.map((v, i) => (i ? "L" : "M") + X(i, n).toFixed(1) + " " + Y(v).toFixed(1)).join(" ");
      const st = s.color ? ` style="stroke:${s.color};opacity:.92;stroke-width:2.2"` : "";
      return `<path class="eline ${s.color ? "" : (s.cls || "")}" data-si="${o.i}"${st} d="${d}" vector-effect="non-scaling-stroke"><title>${esc(s.title || "")}</title></path>`;
    }).join("");
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${grid}${paths}</svg>`;
    const yTicks = nt.ticks.map(v => ({ t: c.fmtY(v), p: Y(v) / H * 100 }));
    let xTicks = [];
    if (c.dates && c.dates.length >= 2) {
      const D2 = c.dates, n = D2.length, k = Math.min(6, n);
      const idxs = [...new Set(Array.from({ length: k }, (_, j) => Math.round(j * (n - 1) / (k - 1))))];
      xTicks = idxs.map(i => ({ t: fshort(D2[i]), p: i / (n - 1) * 100 }));
    } else if (c.xLabels && c.xLabels.length) {
      xTicks = c.xLabels.map((t, i) => ({ t, p: i / Math.max(1, c.xLabels.length - 1) * 100 }));
    }
    // escala + series visibles para el tooltip
    c.min = nt.min; c.max = nt.max; c.pad = pad; c.H = H;
    c.series = vis.map(o => ({ values: o.s.values, color: o.s.color || null, title: o.s.title || "" }));
    const cross = `<div class="cx-vline"></div><div class="cx-hline"></div><div class="cx-yval"></div><div class="cx-dot"></div><div class="cx-tip"></div>`;
    return axedChart(svg, yTicks, xTicks, id, cross);
  }
  // series: [{values:[num], cls, color, title}]. opts: {fmtY, dates, xLabels, yTicks, chartId}
  function lineChart(series, height = 200, opts = {}) {
    series = (series || []).filter(s => s && (s.values || []).length);
    const L = Math.max(0, ...series.map(s => s.values.length));
    if (L < 2) return `<p class="placeholder">Necesito al menos dos capturas para dibujar esto (se acumulan con cada actualización).</p>`;
    const id = opts.chartId || ("ch" + (++_chartSeq));
    CHARTS[id] = {
      all: series.map(s => ({ values: s.values, color: s.color || null, cls: s.cls || "", title: s.title || "" })),
      active: (CHARTS[id] && CHARTS[id].id === id && CHARTS[id].active) || new Set(),
      id, height, L, yTicksN: opts.yTicks || 5, fmtY: opts.fmtY || (v => num(Math.round(v))),
      dates: opts.dates || null, xLabels: opts.xLabels || null,
    };
    return _buildAxc(id);
  }
  // muestra/oculta una serie al pulsar su entrada de leyenda (vacío = todas)
  function toggleSeries(id, si) {
    const c = CHARTS[id]; if (!c) return;
    if (c.active.has(si)) c.active.delete(si); else c.active.add(si);
    const plot = document.querySelector(`.axc-plot[data-chart="${id}"]`), axc = plot && plot.closest(".axc");
    if (axc) axc.outerHTML = _buildAxc(id);
    $$(`.leg-item[data-chart="${id}"]`).forEach(el => el.classList.toggle("leg-off", c.active.size > 0 && !c.active.has(+el.dataset.si)));
  }
  // construye una leyenda CLICABLE (aísla series) para una gráfica con id conocido
  const legendHTML = (id, items) => items.map((it, i) => `<span class="leg-item" data-chart="${id}" data-si="${i}"><i style="background:${it.color}"></i>${esc(it.name)}</span>`).join("");
  // alinea una lista de fechas (capturas) con la longitud de la serie más larga
  const histDates = (caps, series) => {
    caps = caps || [];
    const L = Math.max(0, ...(series || []).map(s => (s.values || []).length));
    return L && caps.length > L ? caps.slice(caps.length - L) : caps;
  };
  // fechas (t) de una serie de {t,v}; null si alguna falta (para caer a xLabels)
  const seriesDates = (arr) => (arr && arr.length && arr.every(x => x && x.t)) ? arr.map(x => x.t) : null;
  // gráfica de evolución del VALOR de plantilla (usa valueSeries [{t,v}], reconstruida
  // de los snapshots de jugadores; cae a valueHistory [int] si aún no hay). rows:
  // [{name/title, cls, valueSeries, valueHistory}]
  function valueEvoChart(rows, height, opts = {}) {
    const norm = rows.map(r => {
      const vs = (r.valueSeries && r.valueSeries.length >= 2) ? r.valueSeries : null;
      return { values: vs ? vs.map(x => x.v) : (r.valueHistory || []), cls: r.cls || "", color: r.color || null, title: r.title || r.name, _vs: vs };
    }).filter(s => s.values.length >= 2);
    if (!norm.length) return null;
    const withT = norm.find(s => s._vs);
    return lineChart(norm, height, Object.assign({ fmtY: eurK, dates: withT ? withT._vs.map(x => x.t) : null }, opts));
  }
  // filtra las filas con serie suficiente y les asigna un color de la paleta; devuelve
  // {rows, items} -> items para una leyenda COMPLETA y CLICABLE (todos, no solo 2).
  function coloredRows(rows, key) {
    key = key || "valueSeries";
    const has = r => (r[key] && r[key].length >= 2);
    const ok = rows.filter(has);
    const cols = palette(ok.length);
    ok.forEach((r, i) => r.color = cols[i]);
    return { rows: ok, items: ok.map(r => ({ name: r.name || r.title, color: r.color })) };
  }
  // mensaje para la gráfica de puntos: distingue pretemporada (todos a 0) de "faltan capturas"
  const preseasonPts = () => (managers || []).some(m => (m.points || 0) > 0)
    ? "Necesito al menos dos capturas de la clasificación para la evolución (se acumulan solas con cada actualización)."
    : "Estamos en pretemporada: todos los equipos tienen 0 puntos todavía. Esta gráfica se llenará sola en cuanto empiece LaLiga y se jueguen jornadas.";

  // ---------- tooltip al pasar el ratón por una gráfica de líneas ----------
  // Muestra: valor del eje Y a la altura del cursor + la serie más cercana (nombre y
  // valor) y la fecha de esa columna. Un único manejador global sirve a todas.
  (function chartHover() {
    let active = null;
    const clear = (plot) => plot && plot.querySelectorAll(".cx-vline,.cx-hline,.cx-yval,.cx-dot,.cx-tip").forEach(e => (e.style.opacity = 0));
    document.addEventListener("mousemove", e => {
      const plot = e.target.closest && e.target.closest(".axc-plot[data-chart]");
      if (active && active !== plot) clear(active);
      active = plot || null;
      if (!plot) return;
      const meta = CHARTS[plot.dataset.chart]; if (!meta) return;
      const rect = plot.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      const padPx = meta.pad * rect.height / meta.H, plotH = (rect.height - 2 * padPx) || 1, span = (meta.max - meta.min) || 1;
      const yval = meta.min + (1 - (y - padPx) / plotH) * span;
      const L = meta.L, i = Math.max(0, Math.min(L - 1, Math.round(x / rect.width * (L - 1))));
      const colX = i / Math.max(1, L - 1) * rect.width;
      let best = null, bestDy = Infinity;
      meta.series.forEach(s => {
        const n = s.values.length, j = i - (L - n);
        if (j < 0 || j >= n) return;
        const yy = padPx + (1 - (s.values[j] - meta.min) / span) * plotH;
        const dy = Math.abs(yy - y);
        if (dy < bestDy) { bestDy = dy; best = { s, v: s.values[j], yy }; }
      });
      const $$$ = (c) => plot.querySelector(c);
      const vline = $$$(".cx-vline"), hline = $$$(".cx-hline"), yv = $$$(".cx-yval"), dot = $$$(".cx-dot"), tip = $$$(".cx-tip");
      vline.style.left = colX + "px"; vline.style.opacity = .45;
      hline.style.top = y + "px"; hline.style.opacity = .45;
      yv.style.top = y + "px"; yv.textContent = meta.fmtY(yval); yv.style.opacity = 1;
      if (best) {
        dot.style.left = colX + "px"; dot.style.top = best.yy + "px";
        dot.style.background = best.s.color || "var(--blue)"; dot.style.opacity = 1;
        const dt = meta.dates && meta.dates[i] ? fshort(meta.dates[i]) : ("captura " + (i + 1));
        tip.innerHTML = `<div class="cx-dt">${esc(dt)}</div><div class="cx-row"><i style="background:${best.s.color || "var(--blue)"}"></i>${esc(best.s.title)}: <b>${meta.fmtY(best.v)}</b></div>`;
        const tw = tip.offsetWidth || 150; let tx = colX + 12; if (tx + tw > rect.width) tx = colX - tw - 12; if (tx < 0) tx = 4;
        tip.style.left = tx + "px"; tip.style.opacity = 1;
      } else { dot.style.opacity = 0; tip.style.opacity = 0; }
    });
  })();
  // pulsar una entrada de leyenda aísla esa serie (varias = subconjunto; volver a
  // pulsarlas todas = todas otra vez)
  document.addEventListener("click", e => {
    const li = e.target.closest(".leg-item[data-chart]");
    if (li) toggleSeries(li.dataset.chart, +li.dataset.si);
  });

  function scatterChart(pts, height = 220, opts = {}) {
    if (!pts.length) return `<p class="placeholder">Sin datos.</p>`;
    const W = 1000, H = height, pad = 26;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    let xmn = Math.min(...xs), xmx = Math.max(...xs), ymn = Math.min(...ys), ymx = Math.max(...ys);
    const xs2 = (xmx - xmn) || 1, ys2 = (ymx - ymn) || 1;
    const X = (x) => pad + (x - xmn) / xs2 * (W - 2 * pad);
    const Y = (y) => H - pad - (y - ymn) / ys2 * (H - 2 * pad);
    const grid = [0, .5, 1].map(t => `<line class="grid-line" x1="${pad}" y1="${(pad + t * (H - 2 * pad)).toFixed(1)}" x2="${W - pad}" y2="${(pad + t * (H - 2 * pad)).toFixed(1)}"/>`).join("");
    const dots = pts.map(p => `<circle class="dotpt" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="6"><title>${esc(p.label)}</title></circle>`).join("");
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${height}px">${grid}${dots}</svg>`;
    const fx = opts.fmtX || (v => num(Math.round(v))), fy = opts.fmtY || (v => num(Math.round(v)));
    const yTicks = [{ t: fy(ymx), p: 8 }, { t: fy((ymx + ymn) / 2), p: 50 }, { t: fy(ymn), p: 92 }];
    const xTicks = [{ t: fx(xmn), p: 6 }, { t: fx((xmx + xmn) / 2), p: 50 }, { t: fx(xmx), p: 94 }];
    return axedChart(svg, yTicks, xTicks);
  }

  const DONUT_COLORS = { POR: "var(--gold)", DEF: "var(--blue)", MED: "var(--up)", DEL: "var(--red)" };
  function donut(segs, size = 128) {
    const total = segs.reduce((a, s) => a + s.value, 0) || 1;
    let acc = 0; const r = size / 2, ir = r * 0.62, cx = r, cy = r;
    const P = (ang, rad) => [cx + rad * Math.sin(ang), cy - rad * Math.cos(ang)];
    const arcs = segs.filter(s => s.value > 0).map(s => {
      const a0 = acc / total * 2 * Math.PI, a1 = (acc + s.value) / total * 2 * Math.PI; acc += s.value;
      const large = (a1 - a0) > Math.PI ? 1 : 0;
      const [x0, y0] = P(a0, r), [x1, y1] = P(a1, r), [x2, y2] = P(a1, ir), [x3, y3] = P(a0, ir);
      return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} A${ir} ${ir} 0 ${large} 0 ${x3.toFixed(1)} ${y3.toFixed(1)} Z" fill="${s.color}"><title>${esc(s.label)}: ${s.value}</title></path>`;
    }).join("");
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${arcs}</svg>`;
  }

  function barsHTML(rows, cls, fmt) {
    if (!rows.length) return `<p class="placeholder">Sin datos.</p>`;
    const mx = Math.max(...rows.map(r => Math.abs(r.value)), 1);
    return rows.map(r => `<div class="bar-row" ${r.data || ""}><span class="b-name">${esc(r.name)}</span>
      <div class="bar-track"><div class="bar-fill ${cls || ""}" style="width:${Math.max(2, Math.abs(r.value) / mx * 100).toFixed(1)}%"></div></div>
      <span class="b-val">${(fmt || eur)(r.value)}</span></div>`).join("");
  }

  function spark(values, w = 92, h = 26, color = null) {
    const v = (values || []).filter(x => typeof x === "number");
    if (v.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
    const mn = Math.min(...v), mx = Math.max(...v), span = mx - mn || 1;
    const pts = v.map((y, i) => [i / (v.length - 1) * w, h - ((y - mn) / span) * (h - 4) - 2]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    if (!color) color = v[v.length - 1] >= v[0] ? "var(--up)" : "var(--down)";
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function movement(prev, rank) {
    if (prev == null) return `<span class="mv same">•</span>`;
    const d = prev - rank;
    if (d > 0) return `<span class="mv up">▲${d}</span>`;
    if (d < 0) return `<span class="mv down">▼${-d}</span>`;
    return `<span class="mv same">=</span>`;
  }
  const posChip = (p) => `<span class="pos">${esc(p || "—")}</span>`;
  const STATUS = { injured: { t: "🚑", l: "lesión", c: "var(--down)" }, doubtful: { t: "❓", l: "duda", c: "var(--gold)" }, suspended: { t: "🟥", l: "sanción", c: "var(--red)" } };
  const statusBadge = (s) => STATUS[s] ? `<span class="stbadge" title="${STATUS[s].l}">${STATUS[s].t}</span>` : "";

  // foto: PNG local oficial de LaLiga si existe; si no (silueta/nuevo), la de futbolfantasy; si no, placeholder
  function avatar(p, size = 34) {
    const cdn = (p && p.img) || "";
    const useLocal = p && p.official && p.id;
    const src = useLocal ? `img/players/${p.id}.png` : cdn;
    if (!src) return `<span class="avatar ph" style="width:${size}px;height:${size}px"></span>`;
    const onerr = `if(this.dataset.cdn&&!/^https?:/.test(this.getAttribute('src'))){this.src=this.dataset.cdn}else{this.outerHTML='<span class=\\'avatar ph\\'></span>'}`;
    return `<img class="avatar" width="${size}" height="${size}" loading="lazy" src="${esc(src)}"${cdn ? ` data-cdn="${esc(cdn)}"` : ""} onerror="${onerr}">`;
  }

  // fila de jugador con foto (usada en listas de mercado / momentum / top)
  function pRow(p, rightHTML, sub) {
    const name = p.player || p.name || "?", pos = p.pos || p.position || "";
    return `<div class="prow" data-player="${esc(p.id || "")}">${avatar(p, 32)}${posChip(pos)}<div class="pr-main"><div class="p-name">${esc(name)}</div>${sub ? `<div class="p-team">${sub}</div>` : ""}</div><div class="p-fig">${rightHTML}</div></div>`;
  }
  // fila de mercado con foto + racha (sparkline) + variación
  function mktRow(r, rightHTML) {
    const col = r.day > 0 ? "var(--up)" : r.day < 0 ? "var(--down)" : "var(--ink-mute)";
    return `<div class="mktrow" data-player="${esc(r.id || "")}">${avatar(r, 30)}${posChip(r.pos)}<div class="pr-main"><div class="p-name">${esc(r.player)}</div></div><span class="rowspark">${spark(r.hist || [], 74, 22, col)}</span><div class="p-fig">${rightHTML}</div></div>`;
  }
  // foto grande para cabecera de modal
  function faceBig(p) {
    const cdn = (p && p.img) || "";
    const useLocal = p && p.official && p.id;
    const src = useLocal ? `img/players/${p.id}.png` : cdn;
    if (!src) return `<span class="md-face avatar ph"></span>`;
    const onerr = `if(this.dataset.cdn&&!/^https?:/.test(this.getAttribute('src'))){this.src=this.dataset.cdn}else{this.style.display='none'}`;
    return `<img class="md-face" src="${esc(src)}"${cdn ? ` data-cdn="${esc(cdn)}"` : ""} onerror="${onerr}">`;
  }

  // histórico de valor de un jugador -> sparkline y variación de 24h
  function vhValues(id) { const p = playersById[id]; return (p && p.valueHistory) ? p.valueHistory.map(x => x.v) : []; }
  function valueSpark(id) { return spark(vhValues(id), 88, 24); }
  function dayDelta(id) {
    const p = playersById[id]; if (!p || !(p.valueHistory || []).length) return 0;
    const H = p.valueHistory, last = H[H.length - 1], lastT = new Date(last.t).getTime();
    let base = H[0].v;
    for (const x of H) if (new Date(x.t).getTime() <= lastT - 864e5) base = x.v;
    return last.v - base;
  }
  const faceOf = (id) => avatar(playersById[id] || { id }, 24);

  // escudo de equipo: local img/teams/{id}.png, fallback CDN
  function teamBadge(tid, size = 18) {
    if (!tid) return "";
    const cdn = (TEAMS[tid] || {}).badge || "";
    const onerr = cdn ? `if(!/^https?:/.test(this.getAttribute('src'))){this.src=this.dataset.cdn}else{this.style.display='none'}` : `this.style.display='none'`;
    return `<img class="teambadge" width="${size}" height="${size}" src="img/teams/${esc(tid)}.png"${cdn ? ` data-cdn="${esc(cdn)}"` : ""} onerror="${onerr}">`;
  }
  // barras horizontales con escudo (para rankings por equipo)
  function teamBars(rows, cls, fmt) {
    if (!rows.length) return `<p class="placeholder">Sin datos.</p>`;
    const mx = Math.max(...rows.map(r => Math.abs(r.value)), 1);
    return rows.map(r => `<div class="bar-row"><span class="b-name">${teamBadge(r.teamId)} ${esc(r.name)}</span><div class="bar-track"><div class="bar-fill ${cls || ""}" style="width:${Math.max(2, Math.abs(r.value) / mx * 100).toFixed(1)}%"></div></div><span class="b-val">${(fmt || eur)(r.value)}</span></div>`).join("");
  }

  // ---------- cabecera + ticker ----------
  const lg = D.league || {};
  $("#brandLeague").textContent = lg.name || "Mi liga";

  // selector de liga GLOBAL (cabecera): salta entre TODAS tus ligas desde cualquier pestaña
  (function leaguePicker() {
    const el = $("#leaguePick"); if (!el || !MULTI || LEAGUES.length < 2) return;
    el.hidden = false;
    el.innerHTML = `<span class="lp-lbl">Cambiar de liga</span><select id="leagueSwitch" class="lp-sel" aria-label="Cambiar de liga">${LEAGUES.map(l => `<option value="${esc(l.id)}"${String(l.id) === String(ffLeague) ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select>`;
    $("#leagueSwitch").addEventListener("change", e => {
      localStorage.setItem("ff_league", e.target.value);
      location.reload();
    });
  })();
  $("#meta").innerHTML =
    `<span class="chip week">Jornada <b>${lg.currentWeek ?? "—"}</b></span>` +
    `<span class="chip">${lg.managers ?? managers.length} presidentes</span>` +
    `<span class="chip">Actualizado <b>${D.generated ? new Date(D.generated).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</b></span>` +
    (D.sample ? `<span class="chip sample">datos de ejemplo</span>` : "");

  const big = (n) => { const a = Math.abs(n || 0); return a >= 1e9 ? (n / 1e9).toFixed(2) + "B €" : a >= 1e6 ? (n / 1e6).toFixed(1) + "M €" : eurK(n); };
  const hasP = (id) => !!(id && playersById[id]);   // ¿el id abre ficha? (evita clics muertos)
  const signedK = (n) => (n > 0 ? "▲" : n < 0 ? "▼" : "") + eurK(Math.abs(n || 0));

  // ---------- efecto "big board": los números CUENTAN al aparecer (rollo bolsa) ----------
  const _reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const _CFMT = { eur, eurK, num, big, pts: v => num(Math.round(v)) + " pts", x1: v => (Math.round(v * 10) / 10).toFixed(1) };
  function animateCounts(root) {
    (root || document).querySelectorAll("[data-cv]").forEach(el => {
      if (el.dataset.counted) return;
      el.dataset.counted = "1";
      const target = parseFloat(el.dataset.cv) || 0, fmt = _CFMT[el.dataset.cf] || num;
      if (_reduceMotion || !window.requestAnimationFrame) { el.textContent = fmt(target); return; }
      const dur = 720, t0 = performance.now(), dec = el.dataset.cf === "x1";
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        const raw = target * e;
        el.textContent = fmt(dec ? Math.round(raw * 10) / 10 : Math.round(raw));  // sin decimales feos al contar
        if (p < 1) requestAnimationFrame(tick); else el.textContent = fmt(target);
      };
      requestAnimationFrame(tick);
    });
  }
  // celda numérica con cuenta atrás/arriba: <span data-cv=.. data-cf=..>fallback</span>
  const cnum = (v, cf = "num") => `<span data-cv="${v == null ? 0 : v}" data-cf="${cf}">${(_CFMT[cf] || num)(v || 0)}</span>`;

  // ---------- ticker de precios (arriba) ----------
  (function ticker() {
    const pct = m => m.deltaPct != null ? ` ${m.delta > 0 ? "+" : ""}${m.deltaPct}%` : "";
    const item = (m, k) => `<span class="ticker-item"${hasP(m.id) ? ` data-player="${esc(m.id)}"` : ""}><span class="name">${esc(m.player)}</span> ${eurK(m.value)} <span class="${k}">${k === "up" ? "▲" : "▼"}${eurK(Math.abs(m.delta || 0))}${pct(m)}</span></span>`;
    const up = (dayMovers.up || []).filter(m => m.delta).slice(0, 12).map(m => item(m, "up"));
    const down = (dayMovers.down || []).filter(m => m.delta).slice(0, 12).map(m => item(m, "down"));
    // intercalar subidas y bajadas para que la cinta alterne verde/rojo
    const items = [];
    for (let i = 0; i < Math.max(up.length, down.length); i++) { if (up[i]) items.push(up[i]); if (down[i]) items.push(down[i]); }
    const track = items.length ? items.join("") : `<span class="ticker-item">Esperando datos del mercado…</span>`;
    $("#ticker").innerHTML = track + track;
  })();

  // ---------- cinta de operaciones (abajo, sentido inverso) ----------
  (function tape() {
    const el = $("#tape"); if (!el) return;
    const T = (D.transfers || []).slice(0, 24);
    if (!T.length) { el.innerHTML = `<span class="ticker-item">Sin operaciones recientes…</span>`; return; }
    const items = T.map(t => {
      const d = moveDir(t), gv = d.giver || "mercado", rc = d.shield ? null : (d.receiver || "mercado");
      const ic = /claus/.test(t.op) ? "🔴" : "➜";
      return `<span class="ticker-item"${hasP(t.playerId) ? ` data-player="${esc(t.playerId)}"` : ""}>${ic} <span class="name">${esc(t.player)}</span> ${eurK(t.amount)} <span class="tp-mut">${esc(gv)}${rc ? " → " + esc(rc) : ""}</span></span>`;
    });
    el.innerHTML = items.join("") + items.join("");
  })();

  // Igualar la VELOCIDAD (px/seg) de las dos cintas: la de operaciones iba más rápida
  // porque tenía duración fija distinta y otro ancho. Fijamos el mismo px/seg (el del
  // ticker de mercado, ~70s) y calculamos la duración de cada una según su ancho real.
  (function syncTickerSpeeds() {
    const m = $("#ticker"), t = $("#tape");
    if (!m || !t) return;
    const apply = () => {
      const wm = m.scrollWidth; if (!wm) return;
      const speed = (wm / 2) / 70;                    // px/seg de referencia (mercado)
      m.style.animationDuration = "70s";              // mercado igual que antes
      const wt = t.scrollWidth; if (wt && speed) t.style.animationDuration = Math.max(20, (wt / 2) / speed).toFixed(1) + "s";
    };
    apply();
    if (window.requestAnimationFrame) requestAnimationFrame(apply);   // por si el ancho aún no estaba listo
    window.addEventListener("resize", apply);
  })();

  const st = D.standings || [];

  // ---------- barra de índices tipo bolsa (valor liga, movers, volumen) ----------
  (function indices() {
    const el = $("#indices"); if (!el) return;
    const owned = players.filter(p => p.owner);
    const totalVal = st.reduce((a, r) => a + (r.teamValue || 0), 0);
    const dayChange = owned.reduce((a, p) => a + (p.day || 0), 0);
    const pct = totalVal ? dayChange / totalVal * 100 : 0;
    const up = dayMovers.up || [], down = dayMovers.down || [];
    const topUp = up.find(m => m.delta), topDn = down.find(m => m.delta);
    const ops = (D.transfers || []).length, onMkt = (D.market || []).length;
    const arr = v => v > 0 ? "▲" : v < 0 ? "▼" : "•", cl = v => v > 0 ? "up" : v < 0 ? "down" : "";
    const T = [];
    T.push(`<div class="idx live"><span class="idx-l">Mercado · en vivo</span><span class="idx-v"><span class="live-dot"></span><span id="liveClock" class="lc">--:--:--</span></span></div>`);
    T.push(`<div class="idx idx-flash"><span class="idx-l">Índice liga</span><span class="idx-v">${cnum(totalVal, "big")}</span><span class="idx-d ${cl(pct)}">${arr(pct)} ${Math.abs(pct).toFixed(2)}% hoy</span></div>`);
    if (topUp) T.push(`<div class="idx${hasP(topUp.id) ? " clickable" : ""}"${hasP(topUp.id) ? ` data-player="${esc(topUp.id)}"` : ""}><span class="idx-l">Máx. subida</span><span class="idx-v">${esc(topUp.player)}</span><span class="idx-d up">▲ ${eurK(topUp.delta)}${topUp.deltaPct ? ` (+${topUp.deltaPct}%)` : ""}</span></div>`);
    if (topDn) T.push(`<div class="idx${hasP(topDn.id) ? " clickable" : ""}"${hasP(topDn.id) ? ` data-player="${esc(topDn.id)}"` : ""}><span class="idx-l">Máx. bajada</span><span class="idx-v">${esc(topDn.player)}</span><span class="idx-d down">▼ ${eurK(Math.abs(topDn.delta))}${topDn.deltaPct ? ` (${topDn.deltaPct}%)` : ""}</span></div>`);
    T.push(`<div class="idx"><span class="idx-l">Volumen</span><span class="idx-v">${cnum(ops, "num")}</span><span class="idx-d">operaciones</span></div>`);
    T.push(`<div class="idx"><span class="idx-l">En venta</span><span class="idx-v">${cnum(onMkt, "num")}</span><span class="idx-d">jugadores</span></div>`);
    el.innerHTML = T.join("");
    animateCounts(el);
    // reloj en vivo (segundos) — sensación de parqué abierto
    const clock = $("#liveClock");
    if (clock) {
      const tickClock = () => { clock.textContent = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
      tickClock(); if (!_reduceMotion) setInterval(tickClock, 1000);
    }
  })();

  // ---------- KPIs ----------
  (function kpis() {
    const out = [];
    if (st[0]) out.push({ l: "Líder", m: st[0].manager, s: num(st[0].points) + " pts", c: "var(--gold)" });
    const bc = (D.records || {}).biggestClause, bs = (D.records || {}).biggestSigning;
    if (bc) out.push({ l: "Mayor clausulazo", m: bc.player, s: eur(bc.amount), c: "var(--red)" });
    else if (bs) out.push({ l: "Fichaje más caro", m: bs.player, s: eur(bs.amount), c: "var(--red)" });
    const mvp = (D.topPlayers || {}).byValue && D.topPlayers.byValue[0];
    if (mvp) out.push({ l: "Jugador más valioso", m: mvp.player, s: eur(mvp.value), c: "var(--gold)" });
    const _myTeam = localStorage.getItem("ff_team");
    const myCaja = _myTeam ? teamCaja(_myTeam) : null;   // solo TU caja, nunca la del rival
    if (myCaja != null) out.push({ l: "Tu caja", m: eur(myCaja), s: "disponible", c: "var(--up)" });
    $("#kpis").innerHTML = out.map(k => `<div class="kpi" style="--accent:${k.c}"><div class="k-label">${esc(k.l)}</div><div class="k-main">${esc(k.m)}</div><div class="k-sub">${esc(k.s)}</div></div>`).join("");
    if (!out.length) hide("kpis");
  })();

  // ================= RESUMEN =================
  (function records() {
    const R = D.records || {}, recs = [];
    if (R.biggestClause) recs.push(["Clausulazo top", eur(R.biggestClause.amount), `${esc(R.biggestClause.player)} → ${esc(R.biggestClause.to)}`]);
    if (R.biggestSigning) recs.push(["Fichaje más caro", eur(R.biggestSigning.amount), `${esc(R.biggestSigning.player)} → ${esc(R.biggestSigning.to)}`]);
    if (R.biggestPremium) recs.push(["Prima más bestia", "+" + R.biggestPremium.premiumPct + "%", esc(R.biggestPremium.player)]);
    if (R.topSpender) recs.push(["Más gastón", eur(R.topSpender.spent), esc(R.topSpender.manager)]);
    if (R.mostActive) recs.push(["Más activo", R.mostActive.ops + " ops", esc(R.mostActive.manager)]);
    if (recs.length) $("#records").innerHTML = recs.map(r => `<div class="rec"><div class="r-l">${r[0]}</div><div class="r-v">${r[1]}</div><div class="r-s">${r[2]}</div></div>`).join("");
    else hide("recordsCard");
  })();

  (function jornada() {
    const J = D.jornada || {};
    if ((J.top || []).length && J.top[0].weekPoints) {
      const t = J.top;
      $("#jornada").innerHTML = `<div class="mvp"><span class="medal">🏅</span><div><div class="who">${esc(t[0].manager)}</div><div class="pts">+${num(t[0].weekPoints)} pts · jornada ${J.number ?? ""}</div></div></div>` +
        t.slice(1).map(r => `<div class="jrow"><span>${esc(r.manager)}</span><span class="jp">+${num(r.weekPoints)}</span></div>`).join("");
    } else hide("jornadaCard");
  })();

  (function moversMini() {
    const up = dayMovers.up || [], dn = dayMovers.down || [];
    if (!up.length && !dn.length) { hide("moversMiniCard"); return; }
    const row = (m, k) => `<div class="mv-row" data-player="${esc(m.id || "")}"><span class="name">${esc(m.player)}</span><span class="mv-d ${k}">${m.delta ? signed(m.delta) : eur(m.value)}</span></div>`;
    $("#moversUp").innerHTML = up.length ? up.slice(0, 8).map(m => row(m, "up")).join("") : `<p class="placeholder">—</p>`;
    $("#moversDown").innerHTML = dn.length ? dn.slice(0, 8).map(m => row(m, "down")).join("") : `<p class="placeholder">Sin bajadas todavía.</p>`;
  })();

  (function feed() {
    const nov = D.novedades || [];
    if (!nov.length) { hide("feedCard"); return; }
    $("#feed").innerHTML = nov.slice(0, 30).map(e => {
      const isC = /claus/.test(e.op || ""), d = moveDir(e);
      const flow = d.shield ? "🛡️" : `${mgrOrMarket(d.giver)} <span class="mut">→</span> ${mgrOrMarket(d.receiver)}`;
      return `<div class="ev${e.playerId ? " clickable" : ""}"${e.playerId ? ` data-player="${esc(e.playerId)}"` : ""}><span class="when">${esc(fdt(e.date))}</span><span class="tag ${isC ? "clause" : ""}">${esc(e.op || "movimiento")}</span>${e.playerId ? faceOf(e.playerId) : ""}<span>${playerLink(e)} <span class="mut">·</span> ${flow}</span><span class="amt">${e.amount ? eur(e.amount) : ""}</span></div>`;
    }).join("");
  })();

  // ================= CLASIFICACIÓN =================
  (function standings() {
    $("#standCount").textContent = st.length ? `${st.length} equipos` : "";
    $("#standBody").innerHTML = st.map(r => `
      <tr class="clickable ${r.rank === 1 ? "leader" : ""}" data-manager="${esc(r.manager)}">
        <td class="l rk" data-v="${r.rank}">${r.rank}${movement(r.prevRank, r.rank)}</td>
        <td class="l mgr">${esc(r.manager)}</td>
        <td class="num pts" data-v="${r.points || 0}">${num(r.points)}</td>
        <td class="num wk" data-v="${r.weekPoints || 0}">${r.weekPoints ? "+" + num(r.weekPoints) : "—"}</td>
        <td class="num val" data-v="${r.teamValue || 0}">${eur(r.teamValue)}</td>
        <td class="num eff" data-v="${r.points > 0 && r.ptsPerValue != null ? r.ptsPerValue : 0}">${r.points > 0 && r.ptsPerValue != null ? r.ptsPerValue : "—"}</td>
        <td class="l">${spark(r.history)}</td>
      </tr>`).join("") || `<tr><td colspan="7" class="placeholder">Sin clasificación todavía.</td></tr>`;
    makeSortable("#tblStand");
  })();

  (function evolution() {
    const rows = st.filter(r => (r.history || []).length >= 2);
    if (!rows.length) { $("#evo").innerHTML = `<p class="placeholder">Necesito al menos dos capturas para la evolución. Vuelve en unas horas.</p>`; return; }
    const cols = palette(rows.length);
    const series = rows.map((r, i) => ({ values: r.history, color: cols[i], title: r.manager + " · " + num(r.points) + " pts" }));
    $("#evo").innerHTML = lineChart(series, 220, { chartId: "chEvo", fmtY: v => num(Math.round(v)) + " pts", dates: histDates(D.histCaps, series) });
    $("#evoLegend").innerHTML = legendHTML("chEvo", rows.map((r, i) => ({ name: r.manager, color: cols[i] })));
  })();

  (function scatter() {
    if (!st.length) { hide("scatterCard"); return; }
    const pts = st.map(r => ({ x: r.teamValue / 1e6, y: r.points, label: `${r.manager} · ${eur(r.teamValue)} · ${num(r.points)} pts` }));
    $("#scatter").innerHTML = scatterChart(pts, 220, { fmtX: v => Math.round(v) + "M€", fmtY: v => num(Math.round(v)) + " pts" });
  })();

  (function valueBars() {
    if (!st.length) { hide("valueBarCard"); return; }
    const rows = [...st].sort((a, b) => b.teamValue - a.teamValue).map(r => ({ name: r.manager, value: r.teamValue, data: `data-manager="${esc(r.manager)}"` }));
    $("#valueBars").innerHTML = barsHTML(rows, "", eur);
  })();

  (function streaks() {
    const s = D.streaks || [];
    if (!s.length) { hide("streakCard"); return; }
    $("#streaks").innerHTML = s.map(x => {
      const g = x.gains || [], mx = Math.max(1, ...g.map(Math.abs));
      const bars = g.map(v => `<i style="height:${Math.max(3, Math.abs(v) / mx * 24)}px;background:${v >= 0 ? "var(--up)" : "var(--down)"}"></i>`).join("");
      return `<div class="streak"><span class="dot ${x.trend}"></span><span class="who">${esc(x.manager)}</span><span class="bars-mini">${bars}</span><span class="lbl">${esc(x.label)}</span></div>`;
    }).join("");
  })();

  // ================= MERCADO =================
  (function topPlayers() {
    const T = D.topPlayers || {};
    const defs = [["byValue", "Valor", p => eur(p.value)], ["byPoints", "Puntos", p => num(p.points) + " pts"], ["byAvg", "Media", p => p.avg + " /j"]];
    const avail = defs.filter(d => (T[d[0]] || []).length);
    if (!avail.length) { hide("topCard"); return; }
    $("#topTabs").innerHTML = avail.map((d, i) => `<button data-k="${d[0]}" class="${i === 0 ? "active" : ""}">${d[1]}</button>`).join("");
    const draw = (key) => {
      const fmt = (avail.find(d => d[0] === key) || avail[0])[2];
      $("#topList").innerHTML = (T[key] || []).map(p => pRow(p, fmt(p), teamName(p) || "")).join("");
    };
    $("#topTabs").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { $("#topTabs").querySelectorAll("button").forEach(x => x.classList.remove("active")); b.classList.add("active"); draw(b.dataset.k); }));
    draw(avail[0][0]);
  })();

  (function market() {
    const mk = D.market || [];
    $("#marketCount").textContent = mk.length ? `${mk.length} en venta` : "";
    if (!mk.length) { hide("marketCard"); return; }
    const list = $("#marketList");
    const nFree = mk.filter(m => m.source === "league").length, nMgr = mk.length - nFree;
    let filt = "all", q = "", sortK = "price", sortDir = -1;
    const price = m => m.price || m.value || 0;
    const sorters = { price: (a, b) => price(a) - price(b), value: (a, b) => (a.value || 0) - (b.value || 0), name: (a, b) => (a.player || "").localeCompare(b.player || "", "es") };
    const ctl = document.createElement("div");
    ctl.className = "controls mkt-ctl";
    ctl.innerHTML = `<div class="chips" id="mktChips">
        <button data-f="all" class="active">Todos (${mk.length})</button>
        <button data-f="league">🆓 Agentes libres (${nFree})</button>
        <button data-f="manager">🧑 De otros managers (${nMgr})</button>
      </div>
      <div class="chips mktsort" id="mktSort"><span class="chips-lbl">Ordenar:</span>
        <button data-s="price" class="active">Precio</button>
        <button data-s="value">Valor</button>
        <button data-s="name">Nombre</button>
      </div>
      <input type="search" id="mktSaleSearch" placeholder="Buscar jugador o vendedor…">`;
    list.parentNode.insertBefore(ctl, list);
    const srcBadge = m => m.source === "manager"
      ? `<span class="msrc mgr" data-manager="${esc(m.seller || "")}" title="Lo vende otro mánager">🧑 ${esc(m.seller || "otro mánager")}</span>`
      : `<span class="msrc free" title="Jugador de la liga (agente libre)">🆓 Agente libre</span>`;
    const render = () => {
      const rows = mk.filter(m => (filt === "all" || m.source === filt) &&
        (!q || (m.player + " " + (m.seller || "")).toLowerCase().includes(q)))
        .sort((a, b) => sortDir * sorters[sortK](a, b));
      list.innerHTML = rows.length ? rows.map(m => `<div class="mktsale" data-player="${esc(m.id || "")}">
          ${avatar(m, 34)}${posChip(m.position)}
          <div class="pr-main"><div class="p-name">${esc(m.player)}${m.shielded ? " 🛡️" : ""}</div>
            <div class="ms-sub">${srcBadge(m)}${m.clause ? ` · cláusula ${eurK(m.clause)}` : ""}</div></div>
          <div class="p-fig"><div class="m-price">${eur(m.price || m.value)}</div><div class="m-val">valor ${eur(m.value)}</div>${m.bids ? `<div class="m-bids">${m.bids} ${m.source === "manager" ? "ofertas" : "pujas"}</div>` : ""}</div>
        </div>`).join("") : `<p class="placeholder">Nada coincide.</p>`;
    };
    $$("#mktChips button", ctl).forEach(b => b.addEventListener("click", () => {
      $$("#mktChips button", ctl).forEach(x => x.classList.remove("active"));
      b.classList.add("active"); filt = b.dataset.f; render();
    }));
    $$("#mktSort button", ctl).forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.s;
      sortDir = (sortK === k) ? -sortDir : (k === "name" ? 1 : -1);   // repetir clic invierte
      sortK = k;
      $$("#mktSort button", ctl).forEach(x => { x.classList.toggle("active", x === b); x.classList.remove("asc", "desc"); });
      b.classList.add(sortDir < 0 ? "desc" : "asc");
      render();
    }));
    $("#mktSaleSearch").addEventListener("input", e => { q = e.target.value.trim().toLowerCase(); render(); });
    render();
  })();

  (function marketTab() {
    const A = D.marketAnalytics || {};
    // Siempre disponibles (no dependen de variación diaria):
    $("#priceMap").innerHTML = (A.priceMap || []).length
      ? barsHTML(A.priceMap.map(b => ({ name: b.label, value: b.count })), "blue", v => v + " jug.")
      : `<p class="placeholder">Sin datos.</p>`;
    $("#teamVal").innerHTML = (A.teamByValue || []).length
      ? teamBars(A.teamByValue.map(t => ({ teamId: t.teamId, name: t.team, value: t.value })), "", eurK)
      : `<p class="placeholder">Sin datos de equipos.</p>`;

    // Métricas de variación: necesitan ≥2 valores diarios distintos.
    const note = $("#mktNote");
    if (!A.hasHistory) {
      note.hidden = false;
      note.innerHTML = `⏳ Las métricas de <b>variación de valor</b> (subidas y bajadas de hoy, momentum acelera/frena, predicción y patrones por equipo) se activan con el <b>primer cambio de valor diario</b> del mercado — en la próxima actualización automática tras las 00:15&nbsp;h. Ahora todas las capturas son del mismo día, así que aún no hay variación. La tabla del final ya muestra el valor y la racha de cada jugador.`;
      ["predCard", "teamPatCard", "dailyUpCard", "dailyDownCard", "momUpCard", "momDownCard"].forEach(hide);
      return;
    }
    note.hidden = true;
    const fill = (id, list, right, empty) => { const el = $("#" + id); if (el) el.innerHTML = (list && list.length) ? list.map(r => mktRow(r, right(r))).join("") : `<p class="placeholder">${empty || "Sin datos."}</p>`; };
    const momTag = r => `<span class="mono" style="font-size:11px;text-align:right;display:inline-block">hoy ${signedK(r.day)}<br><span style="color:var(--ink-mute)">ayer ${signedK(r.prev)}</span></span>`;
    fill("predList", A.predicted, r => `<span class="up">▲ ${signed(r.day)}</span>`, "Sin previsiones aún.");
    fill("dailyUp", A.dailyUp, r => `<span class="up">${signed(r.day)}</span>`, "Sin subidas hoy.");
    fill("dailyDown", A.dailyDown, r => `<span class="down">${signed(r.day)}</span>`, "Sin bajadas hoy.");
    fill("accelUp", A.accelUp, momTag); fill("brakeUp", A.brakeUp, momTag);
    fill("accelDown", A.accelDown, momTag); fill("brakeDown", A.brakeDown, momTag);
    const pat = (A.teamBest || []).map(t => ({ teamId: t.teamId, name: t.team, value: t.delta })).concat((A.teamWorst || []).map(t => ({ teamId: t.teamId, name: t.team, value: t.delta })));
    $("#teamPat").innerHTML = pat.length ? teamBars(pat, "", signed) : `<p class="placeholder">Sin cambios de valor por equipo.</p>`;
  })();

  // ---- Mercado de valores: tabla con foto, valor, variación 24h y racha ----
  (function valoresTab() {
    const pl = players.filter(p => (p.value || 0) > 0);
    if (!pl.length) { $("#valoresBody").innerHTML = `<tr><td colspan="5" class="placeholder">Sin datos.</td></tr>`; return; }
    const positions = ["Todos", "POR", "DEF", "MED", "DEL", "ENT"];
    let fPos = "Todos", fText = "";
    $("#valPos").innerHTML = positions.map((p, i) => `<button data-pos="${p}" class="${i ? "" : "active"}">${p}</button>`).join("");
    const render = () => {
      const rows = pl.filter(p => (fPos === "Todos" || p.pos === fPos) && (!fText || p.name.toLowerCase().includes(fText)))
        .map(p => ({ p, d: (p.day != null ? p.day : dayDelta(p.id)) }))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || b.p.value - a.p.value);
      $("#valoresBody").innerHTML = rows.slice(0, 100).map(({ p, d }) => `
        <tr class="clickable" data-player="${esc(p.id)}">
          <td class="l p-name-cell"><span class="cellface">${avatar(p, 26)}${esc(p.name)}</span></td>
          <td class="p-team"><span class="teamcell">${teamBadge(p.teamId)}${esc(teamName(p) || "—")}</span></td>
          <td class="num val" data-v="${p.value || 0}">${eur(p.value)}</td>
          <td class="num" data-v="${d || 0}"><span class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d ? signed(d) : "—"}</span></td>
          <td class="l">${valueSpark(p.id)}</td>
        </tr>`).join("") || `<tr><td colspan="5" class="placeholder">Nada coincide.</td></tr>`;
      applySort($("#valoresBody"));
    };
    $("#valSearch").addEventListener("input", e => { fText = e.target.value.trim().toLowerCase(); render(); });
    $("#valPos").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      $("#valPos").querySelectorAll("button").forEach(x => x.classList.remove("active")); b.classList.add("active"); fPos = b.dataset.pos; render();
    }));
    render();
    makeSortable("#tblValores");
  })();

  // ================= JUGADORES =================
  (function playersTab() {
    if (!players.length) { $("#playersBody").innerHTML = `<tr><td colspan="6" class="placeholder">Sin jugadores todavía.</td></tr>`; return; }
    $("#playersCount").textContent = `${players.length}`;
    const positions = ["Todos", "POR", "DEF", "MED", "DEL"];
    let fPos = "Todos", fText = "", fSort = "value";
    $("#posFilter").innerHTML = positions.map((p, i) => `<button data-pos="${p}" class="${i === 0 ? "active" : ""}">${p}</button>`).join("");
    const render = () => {
      let rows = players.filter(p => (fPos === "Todos" || p.pos === fPos) && (!fText || p.name.toLowerCase().includes(fText)));
      rows.sort((a, b) => fSort === "name" ? a.name.localeCompare(b.name) : (b[fSort] || 0) - (a[fSort] || 0));
      $("#playersBody").innerHTML = rows.slice(0, 300).map(p => `
        <tr class="clickable" data-player="${esc(p.id)}">
          <td class="l p-name-cell"><span class="cellface">${avatar(p, 26)}${esc(p.name)} ${statusBadge(p.status)}</span></td><td>${posChip(p.pos)}</td>
          <td class="num val" data-v="${p.value || 0}">${eur(p.value)}</td><td class="num clause" data-v="${p.clause || 0}">${p.clause ? eur(p.clause) : "—"}</td>
          <td class="num pts" data-v="${p.points || 0}">${num(p.points)}</td>
          <td class="l">${p.owner ? `<span class="linkmgr" data-manager="${esc(p.owner)}">${esc(p.owner)}</span>` : `<span class="p-team">libre</span>`}</td>
        </tr>`).join("") || `<tr><td colspan="6" class="placeholder">Nada coincide con el filtro.</td></tr>`;
      applySort($("#playersBody"));   // reaplica el orden por cabecera tras filtrar
    };
    $("#playerSearch").addEventListener("input", e => { fText = e.target.value.trim().toLowerCase(); render(); });
    $("#playerSort").addEventListener("change", e => { fSort = e.target.value; delete _sortState.playersBody; $$("#tblPlayers th").forEach(c => c.classList.remove("sasc", "sdesc")); render(); });
    $("#posFilter").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { $("#posFilter").querySelectorAll("button").forEach(x => x.classList.remove("active")); b.classList.add("active"); fPos = b.dataset.pos; render(); }));
    render();
    makeSortable("#tblPlayers");
  })();

  // ================= PRESIDENTES =================
  (function managersTab() {
    if (!managers.length) { $("#mgrGrid").innerHTML = `<p class="placeholder">Sin presidentes todavía.</p>`; return; }
    $("#mgrCount").textContent = `${managers.length}`;
    $("#mgrGrid").innerHTML = managers.map(m => `
      <div class="mgrcard ${m.rank === 1 ? "lead" : ""}" data-manager="${esc(m.name)}">
        <div class="m-rank">#${m.rank ?? "—"}</div>
        <div class="m-name">${esc(m.name)}</div>
        <div class="m-stats">
          <span>Puntos<b>${num(m.points)}</b></span>
          <span>Valor<b>${eurK(m.value)}</b></span>
          <span>Plantilla<b>${m.count}</b></span>
          <span>Ops<b>${m.ops}</b></span>
        </div>
      </div>`).join("");
  })();

  // ---- evolución del valor de plantilla de TODOS los presidentes ----
  (function managersEvo() {
    const el = $("#mgrEvo"); if (!el) return;
    const c = coloredRows((managers || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99))
      .map(m => ({ name: m.name, valueSeries: m.valueSeries, valueHistory: m.valueHistory })));
    const html = valueEvoChart(c.rows, 260, { chartId: "chMgrVal" });
    if (!html) { hide("mgrEvoCard"); return; }
    el.innerHTML = html;
    $("#mgrEvoLegend").innerHTML = legendHTML("chMgrVal", c.items);
  })();

  // ---- evolución de PUNTOS de todos los presidentes ----
  (function managersPtsEvo() {
    const el = $("#mgrPts"); if (!el) return;
    const rows = (managers || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99))
      .filter(m => (m.pointsHistory || []).length >= 2);
    if (!rows.length) {
      el.innerHTML = `<p class="placeholder">${preseasonPts()}</p>`;
      $("#mgrPtsLegend").innerHTML = "";
      return;
    }
    const cols = palette(rows.length);
    const series = rows.map((r, i) => ({ values: r.pointsHistory, color: cols[i], title: r.name }));
    el.innerHTML = lineChart(series, 240, { chartId: "chMgrPts", fmtY: v => num(Math.round(v)) + " pts", dates: histDates(D.histCaps, series) });
    $("#mgrPtsLegend").innerHTML = legendHTML("chMgrPts", rows.map((r, i) => ({ name: r.name, color: cols[i] })));
  })();

  // ================= ACTIVIDAD =================
  (function activityTab() {
    const T = D.transfers || [];
    $("#actCount").textContent = T.length ? `${T.length}` : "";
    const kinds = [["all", "Todas"], ["32", "Clausulazos"], ["1", "Compras"], ["31", "Fichajes"], ["33", "Ventas"]];
    let f = "all", q = "";
    $("#actFilter").innerHTML = kinds.map((k, i) => `<button data-k="${k[0]}" class="${i === 0 ? "active" : ""}">${k[1]}</button>`).join("");
    const draw = () => {
      const rows = T.filter(t => (f === "all" || String(t.type) === f) &&
        (!q || (t.player + " " + t.from + " " + t.to).toLowerCase().includes(q)));
      $("#actLog").innerHTML = rows.length ? rows.slice(0, 200).map(t => {
        const isC = /claus/.test(t.op), d = moveDir(t);
        const flow = d.shield ? `${mgrOrMarket(d.giver)} 🛡️` : `${mgrOrMarket(d.giver)} → ${mgrOrMarket(d.receiver)}`;
        return `<div class="ev${t.playerId ? " clickable" : ""}"${t.playerId ? ` data-player="${esc(t.playerId)}"` : ""}><span class="when when2">${esc(fdate(t.date))}<br><b class="whenh">${esc(ftime(t.date))}</b></span>
          <span class="tag ${isC ? "clause" : ""}">${esc(t.op)}</span>
          ${t.playerId ? faceOf(t.playerId) : ""}
          <span>${playerLink(t)} · ${flow}</span>
          <span class="amt">${eur(t.amount)}</span></div>`;
      }).join("") : `<p class="placeholder">Sin operaciones de este tipo todavía.</p>`;
    };
    $("#actFilter").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { $("#actFilter").querySelectorAll("button").forEach(x => x.classList.remove("active")); b.classList.add("active"); f = b.dataset.k; draw(); }));
    const as = $("#actSearch"); if (as) as.addEventListener("input", e => { q = e.target.value.trim().toLowerCase(); draw(); });
    draw();

    const sp = D.spending || [];
    if (sp.length) $("#spend").innerHTML = barsHTML(sp.map(s => ({ name: s.manager, value: s.spent, data: `data-manager="${esc(s.manager)}"` })), "", eur);
    else hide("spendCard");
    const ops = managers.filter(m => m.ops).map(m => ({ name: m.name, value: m.ops, data: `data-manager="${esc(m.name)}"` })).sort((a, b) => b.value - a.value);
    if (ops.length) $("#opsBars").innerHTML = barsHTML(ops, "blue", v => v + " ops");
    else hide("opsCard");
  })();

  // ================= PARTIDOS (todas las jornadas) =================
  (function calendarTab() {
    const cal = D.calendar || {}, weeks = cal.weeks || [], byWeek = cal.byWeek || {};
    const sel = $("#calSel");
    if (!weeks.length) { if (sel) sel.style.display = "none"; $("#fixtures").innerHTML = `<p class="placeholder">Aún no hay calendario.</p>`; return; }
    sel.innerHTML = weeks.map(w => `<option value="${w}">Jornada ${w}</option>`).join("");
    // jornada actual = la del próximo partido sin jugar (o la marcada por el back)
    const now = Date.now();
    let auto = null;
    for (const w of weeks) { const gs = byWeek[w] || []; if (gs.some(g => g.date && new Date(g.date).getTime() > now && !(g.localScore != null))) { auto = String(w); break; } }
    const cur = auto || String(cal.current || weeks[0]);
    if (weeks.map(String).includes(cur)) sel.value = cur;
    const wdow = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
    const dayLabel = (s) => { const d = new Date(s); return isNaN(d) ? "Fecha por confirmar" : `${wdow[d.getDay()]} ${d.toLocaleDateString("es-ES", { day: "2-digit", month: "long" })}`; };
    const draw = (w) => {
      const m = (byWeek[w] || []).slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
      if (!m.length) { $("#fixtures").innerHTML = `<p class="placeholder">Sin partidos en esta jornada.</p>`; return; }
      let html = "", curDay = null;
      m.forEach(g => {
        const dk = (g.date || "").slice(0, 10);
        if (dk !== curDay) { curDay = dk; html += `<div class="fx-daysep">${esc(dayLabel(g.date))}</div>`; }
        const played = g.localScore != null && g.visitorScore != null;
        const live = g.state === "playing" || g.state === "live";
        const mid = played ? `<span class="score${live ? " live" : ""}">${g.localScore} - ${g.visitorScore}</span>` : `<span class="vs">${ftime(g.date) || "vs"}</span>`;
        const sc = played ? `${g.localScore}-${g.visitorScore}` : "";
        html += `<div class="fix clickable" data-mh="${esc(g.localId || "")}" data-ma="${esc(g.visitorId || "")}" data-hn="${esc(g.local)}" data-an="${esc(g.visitor)}" data-when="${esc(fshort(g.date))} ${esc(ftime(g.date) || "")}" data-score="${sc}">
          <span class="fx-date">${esc(ftime(g.date) || "—")}</span>
          <span class="fx-team home">${esc(g.local)} ${teamBadge(g.localId, 24)}</span>
          <span class="fx-mid">${mid}</span>
          <span class="fx-team away">${teamBadge(g.visitorId, 24)} ${esc(g.visitor)}</span>
          <span class="fx-go">previa ›</span></div>`;
      });
      $("#fixtures").innerHTML = html;
    };
    const go = (w) => { sel.value = String(w); draw(sel.value); };
    sel.addEventListener("change", () => draw(sel.value));
    const step = (d) => { const i = weeks.map(String).indexOf(sel.value); const ni = Math.max(0, Math.min(weeks.length - 1, i + d)); go(weeks[ni]); };
    const pv = $("#calPrev"), nx = $("#calNext"), td = $("#calToday");
    if (pv) pv.addEventListener("click", () => step(-1));
    if (nx) nx.addEventListener("click", () => step(1));
    if (td) td.addEventListener("click", () => go(cur));
    draw(sel.value);
  })();

  // ============ AGENDA: cuenta atrás, último resultado y aviso de cláusulas ============
  (function schedule() {
    const cal = D.calendar || {}, byWeek = cal.byWeek || {};
    const all = [];
    (cal.weeks || []).forEach(w => (byWeek[w] || byWeek[String(w)] || []).forEach(g => {
      if (!g.date) return; const t = new Date(g.date).getTime(); if (!isNaN(t)) all.push(Object.assign({ w, t }, g));
    }));
    all.sort((a, b) => a.t - b.t);
    const hero = $("#mdHero");
    if (!all.length) { if (hero) hero.hidden = true; return; }
    const two = n => String(n).padStart(2, "0");
    const fmtDur = (ms) => {
      if (ms < 0) ms = 0;
      const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
      return d > 0 ? `${d}d ${two(h)}h ${two(m)}m` : h > 0 ? `${h}h ${two(m)}m ${two(ss)}s` : `${m}m ${two(ss)}s`;
    };
    const teamCol = (id, name) => `${teamBadge(id, 22)} <b>${esc(name || "")}</b>`;
    const snap = () => {
      const now = Date.now();
      const next = all.find(g => g.t > now) || null;
      const played = all.filter(g => g.localScore != null && g.visitorScore != null);
      const last = played.length ? played.reduce((a, b) => b.t > a.t ? b : a) : null;
      let jNum = null, jStart = null, deadline = null;
      if (next) { jNum = next.w; jStart = Math.min(...all.filter(g => g.w === next.w).map(g => g.t)); deadline = jStart - 864e5; }
      return { now, next, last, jNum, jStart, deadline };
    };
    // aviso de cláusulas/cesiones: se pueden hacer hasta 24h antes del inicio de la jornada
    function deadlineHTML(s, slim) {
      if (s.deadline == null) return "";
      const now = Date.now(), rem = s.deadline - now, toStart = s.jStart - now;
      let cls, icon, txt;
      if (rem > 0) {
        cls = rem < 6 * 36e5 ? "warn" : rem < 24 * 36e5 ? "soon" : "open";
        icon = rem < 24 * 36e5 ? "⚠️" : "🟢";
        txt = `Cláusulas y cesiones de la <b>J${s.jNum}</b> abiertas · cierran en <b class="cd" data-dl="${s.deadline}">${fmtDur(rem)}</b> (24h antes de la jornada)`;
      } else if (toStart > 0) {
        cls = "closed"; icon = "⛔";
        txt = `Plazo de cláusulas/cesiones de la <b>J${s.jNum}</b> CERRADO · la jornada empieza en <b class="cd" data-dl="${s.jStart}">${fmtDur(toStart)}</b>`;
      } else {
        cls = "closed"; icon = "🔒"; txt = `<b>J${s.jNum}</b> en juego · cláusulas y cesiones cerradas hasta que acabe`;
      }
      return `<div class="dlbanner ${cls}${slim ? " slim" : ""}"><span class="dl-ic">${icon}</span><span>${txt}</span></div>`;
    }
    function gridHTML(s) {
      const n = s.next, l = s.last;
      const nextB = n
        ? `<div class="md-next clickable" data-mh="${esc(n.localId || "")}" data-ma="${esc(n.visitorId || "")}" data-hn="${esc(n.local)}" data-an="${esc(n.visitor)}" data-when="${esc(fshort(n.date))} ${esc(ftime(n.date) || "")}">
             <div class="md-k">⏱ Próximo partido · J${n.w}</div>
             <div class="md-match">${teamCol(n.localId, n.local)} <span class="md-vs">vs</span> ${teamCol(n.visitorId, n.visitor)}</div>
             <div class="md-when">${esc(fdate(n.date))} · ${esc(ftime(n.date))}</div>
             <div class="md-cd"><span class="cd" data-dl="${n.t}">${fmtDur(n.t - Date.now())}</span></div></div>`
        : `<div class="md-next"><div class="md-k">Temporada finalizada</div></div>`;
      const lastB = l
        ? `<div class="md-last"><div class="md-k">✅ Último resultado · J${l.w}</div>
             <div class="md-match">${teamCol(l.localId, l.local)} <span class="md-score">${l.localScore}–${l.visitorScore}</span> ${teamCol(l.visitorId, l.visitor)}</div>
             <div class="md-when">${esc(fdate(l.date))}</div></div>`
        : `<div class="md-last"><div class="md-k">✅ Último resultado</div><div class="md-when">Se mostrará aquí en cuanto se juegue el primer partido de la liga.</div></div>`;
      return `<div class="md-grid">${nextB}${lastB}</div><div id="mdDeadline" class="md-dl"></div>`;
    }
    let lastKey = "";
    function paint() {
      const s = snap();
      const key = (s.next ? s.next.date : "-") + "|" + (s.last ? s.last.date + s.last.localScore + s.last.visitorScore : "-");
      if (hero && key !== lastKey) { hero.hidden = false; hero.innerHTML = gridHTML(s); lastKey = key; }
      const dl = deadlineHTML(s), dlSlim = deadlineHTML(s, true);
      const md = $("#mdDeadline"); if (md) md.innerHTML = dl;
      const cd = $("#clausuDeadline"); if (cd) cd.innerHTML = dlSlim;
      const mt = $("#mtDeadline"); if (mt) mt.innerHTML = dlSlim;
      const now = Date.now();
      $$("#mdHero .md-grid .cd[data-dl]").forEach(el => { const r = +el.dataset.dl - now; el.textContent = r > 0 ? fmtDur(r) : "¡en juego!"; });
    }
    paint();
    setInterval(paint, 1000);
  })();

  // ================= ONCES PROBABLES (campo + banquillo) =================
  (function oncesTab() {
    const O = D.onces || [];
    const sel = $("#onceSel"), pitch = $("#pitch"), bench = $("#bench"), bt = $("#benchTitle");
    if (!O.length) { if (sel) sel.style.display = "none"; pitch.innerHTML = `<p class="placeholder">Los onces probables se cargan en la próxima actualización.</p>`; return; }
    sel.innerHTML = O.map((t, i) => `<option value="${i}">${esc(t.team)}</option>`).join("");
    const probCol = (p) => p == null ? "var(--ink-mute)" : p >= 75 ? "var(--up)" : p >= 50 ? "var(--gold)" : "var(--down)";
    const face = (p, s) => (p.id || p.img) ? avatar(p, s) : `<span class="avatar ph" style="width:${s}px;height:${s}px"></span>`;
    const fl = $("#onceForm");
    const draw = (i) => {
      const t = O[i]; if (!t) return;
      if (fl) fl.textContent = t.formation ? "Formación " + t.formation : "";
      pitch.innerHTML = (t.xi || []).map(p => {
        const x = p.x != null ? p.x : 50, y = p.y != null ? p.y : 50;
        const prob = p.prob != null ? `<span class="pp-prob" style="background:${probCol(p.prob)}">${p.prob}%</span>` : "";
        return `<div class="pp${p.status ? " hurt" : ""}" style="left:${x}%;top:${y}%" ${p.id ? `data-player="${esc(p.id)}"` : ""}>
          <span class="pp-photo">${face(p, 46)}${prob}</span><span class="pp-name">${esc(p.name)} ${statusBadge(p.status)}</span></div>`;
      }).join("");
      const subs = t.subs || [];
      bt.textContent = subs.length ? `Suplentes (${subs.length})` : "";
      bench.innerHTML = subs.map(p => `<div class="benchp" ${p.id ? `data-player="${esc(p.id)}"` : ""}>${face(p, 30)}
        <span class="bp-name">${esc(p.name)} ${statusBadge(p.status)}</span><span class="pos">${esc(p.pos || "")}</span>
        <span class="bp-prob" style="color:${probCol(p.prob)}">${p.prob != null ? p.prob + "%" : "—"}</span></div>`).join("");
    };
    sel.addEventListener("change", () => draw(+sel.value)); draw(0);
  })();

  // ================= BAJAS Y DUDAS (resumen) =================
  (function injuriesCard() {
    const inj = D.injuries || [];
    if (!inj.length) { hide("injCard"); return; }
    $("#injCount").textContent = inj.length;
    $("#injuries").innerHTML = inj.slice(0, 40).map(b => `<div class="injrow" data-player="${esc(b.id || "")}">
      ${faceOf(b.id)}<div class="pr-main"><div class="p-name">${esc(b.name)}</div><div class="p-team">${b.owner ? esc(b.owner) : "libre"}</div></div>
      <span class="st-lbl" style="color:${(STATUS[b.status] || {}).c || "var(--ink-dim)"}">${statusBadge(b.status)} ${esc(b.statusLabel)}</span></div>`).join("");
  })();

  // caja del equipo. Prioridad: ajuste manual del usuario (si lo puso) > AUTOMÁTICA
  // (reconstruida de la actividad de la liga, vale para todos sin login) > caja real del admin.
  function teamCaja(name) {
    const v = localStorage.getItem("ff_caja_" + name);
    if (v != null && v !== "") return +v;                 // el usuario la ajustó a mano
    const auto = (D.cajas || {})[name];
    if (auto != null) return auto;                        // automática
    if (name && name === D.you) return ((D.budgets || [])[0] || {}).money ?? null;
    return null;
  }
  const cajaIsAuto = (name) => { const v = localStorage.getItem("ff_caja_" + name); return (v == null || v === "") && (D.cajas || {})[name] != null; };
  const currentTeam = () => localStorage.getItem("ff_team");

  // ---------- "Conecta tu cuenta": caja automática por usuario ----------
  const ffConn = () => { const r = localStorage.getItem("ff_conn_refresh"); return r ? { refresh: r, client: localStorage.getItem("ff_conn_client") || "" } : null; };
  // Con los datos de la cuenta conectada, fija el equipo REAL del usuario en cada liga
  // (teamId -> nombre de mánager vía la clasificación) y guarda su caja en vivo. Así
  // nadie queda con un equipo que no es el suyo, aunque en la bienvenida eligiera otro.
  function applyConnectedIdentity(leagues, setCurrent) {
    (leagues || []).forEach(l => {
      const blk = leagueBlock(String(l.id));
      const row = (blk.standings || []).find(s => String(s.teamId) === String(l.teamId));
      const mgr = row && row.manager;
      if (mgr) {
        localStorage.setItem("ff_team_" + l.id, mgr);              // su equipo real en esa liga
        if (l.caja != null) localStorage.setItem("ff_caja_" + mgr, Math.round(l.caja));
      }
    });
    localStorage.setItem("ff_caja_live", "1");
    if (setCurrent) {
      const target = (leagues || []).find(l => String(l.id) === String(ffLeague)) || (leagues || [])[0];
      if (target) {
        localStorage.setItem("ff_league", String(target.id));
        const t = localStorage.getItem("ff_team_" + target.id);
        if (t) localStorage.setItem("ff_team", t);
      }
    }
  }
  function disconnectAcct(silent) {
    ["ff_conn_refresh", "ff_conn_client", "ff_conn_email", "ff_caja_live"].forEach(k => localStorage.removeItem(k));
    if (!silent && window.__renderMyTeam) window.__renderMyTeam();
  }
  async function refreshLiveCaja() {
    const c = ffConn(); if (!c) return;
    try {
      const r = await fetch("api/caja", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
      const j = await r.json();
      if (!j.ok) { if (/token|refresh|grant|expir|invalid/i.test(j.error || "")) disconnectAcct(true); return; }
      if (j.refresh) localStorage.setItem("ff_conn_refresh", j.refresh);
      applyConnectedIdentity(j.leagues, false);
      if (window.__renderMyTeam) window.__renderMyTeam();
    } catch (e) { /* red: reintenta la próxima carga */ }
  }
  function openConnect() {
    openModal(`<div class="conn">
      <h2 class="display">Caja automática</h2>
      <p class="md-sub"><b>¿Para qué sirve?</b> Para que tu dinero disponible (la <b>caja</b>) aparezca y se actualice <b>solo</b>, sin escribirlo a mano. Lo haces <b>una vez</b> y ya está para siempre.</p>
      <p class="conn-safe">🔒 Te identificas en la <b>web oficial de LaLiga</b> (no aquí). Tu acceso se guarda <b>solo en este dispositivo</b>, en ningún servidor.</p>
      <div class="conn-tabs">
        <button class="active" data-m="password">Entro con email y contraseña</button>
        <button data-m="code">Entro con Google o Apple</button>
      </div>
      <div id="connPass" class="conn-pane">
        <p class="conn-hint">Usa el <b>mismo email y contraseña</b> con los que entras en la app de LaLiga&nbsp;Fantasy:</p>
        <input id="cEmail" type="email" placeholder="tu email de LaLiga Fantasy">
        <input id="cPass" type="password" placeholder="tu contraseña">
        <button class="ob-go" id="cGo">Conectar mi caja</button>
        <p class="ob-note">Tu contraseña no se guarda en ningún sitio; solo se usa en ese momento para darte acceso. <b>¿Entras con Google o Apple?</b> Mira la otra pestaña.</p>
      </div>
      <div id="connCode" class="conn-pane" hidden>
        <p class="conn-hint">Las cuentas de <b>Google o Apple</b> no permiten conectar la caja automática. Es un <b>candado de LaLiga</b>: su login solo funciona dentro de su propia app, no en webs de fuera (lo hemos intentado por todas las vías).</p>
        <p class="conn-warn">👉 No pasa nada: escribe tu <b>caja a mano</b> arriba, en «Mi equipo». Es un solo número, se recuerda, y solo lo usa el Clausulómetro. <b>Todo lo demás de la página funciona igual de bien sin esto.</b></p>
      </div>
      <p class="conn-msg" id="connMsg"></p>`);
    const body = $("#modalBody");
    let verifier = null;
    body.querySelectorAll(".conn-tabs button").forEach(b => b.addEventListener("click", () => {
      body.querySelectorAll(".conn-tabs button").forEach(x => x.classList.remove("active")); b.classList.add("active");
      $("#connPass").hidden = b.dataset.m !== "password"; $("#connCode").hidden = b.dataset.m !== "code";
    }));
    const friendlyErr = (e) => {
      e = String(e || "");
      if (/90225|username or password|invalid|contrase/i.test(e)) return "Email o contraseña incorrectos. ⚠️ Si entras a LaLiga con Google o Apple, este método NO vale: usa la pestaña «Entro con Google o Apple», o deja tu caja en manual.";
      if (/90088|not exist|no existe|no user/i.test(e)) return "No encuentro esa cuenta. Revisa el email.";
      if (/expired|caduc|90205|code/i.test(e)) return "El código caducó (dura ~2 min) o no es válido. Vuelve a pulsar «Abrir la web de LaLiga» y repite.";
      return "No se pudo conectar. " + e;
    };
    const msg = (t, ok) => { const el = $("#connMsg"); el.textContent = t; el.className = "conn-msg" + (ok === true ? " ok" : ok === false ? " err" : ""); };
    const finishConn = async (payload) => {
      msg("Conectando…");
      try {
        const r = await fetch("api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const j = await r.json();
        if (!j.ok) { msg(friendlyErr(j.error), false); return; }
        localStorage.setItem("ff_conn_refresh", j.refresh || "");
        localStorage.setItem("ff_conn_client", j.client || "");
        if (payload.email) localStorage.setItem("ff_conn_email", payload.email);
        applyConnectedIdentity(j.leagues, true);
        msg("✅ Conectado. Tu caja ya es automática.", true);
        setTimeout(() => location.reload(), 800);
      } catch (e) { msg("Error de red.", false); }
    };
    $("#cGo").addEventListener("click", () => {
      const email = $("#cEmail").value.trim(), password = $("#cPass").value;
      if (!email || !password) { msg("Pon tu email y contraseña.", false); return; }
      finishConn({ mode: "password", email, password });
    });
  }

  // ================= CLAUSULÓMETRO =================
  (function clausuTab() {
    const C = D.clausulometro || {}, ps = C.players || [];
    const head = $("#clausuHead"), body = $("#clausuBody"), slider = $("#cajaSlider"), cajaVal = $("#cajaVal"), only = $("#onlyAfford"), search = $("#clausuSearch");
    if (!ps.length) { head.innerHTML = `<p class="placeholder">Sin datos de plantillas rivales todavía.</p>`; return; }
    const startCaja = teamCaja(currentTeam()) ?? (C.caja || 0);
    const maxC = Math.max(...ps.map(p => p.clause), startCaja);
    slider.max = Math.ceil(maxC / 1e6) * 1e6; slider.value = startCaja;
    let caja = startCaja, onlyA = false, q = "";
    const fits = p => p.clause <= caja;                       // cabe en tu caja (lo que controla el slider)
    const available = p => fits(p) && !p.shielded && !p.locked;  // clausulable de verdad
    const render = () => {
      cajaVal.textContent = eur(caja);
      const nFit = ps.filter(fits).length, nAvail = ps.filter(available).length;
      head.innerHTML = `<div class="clausu-kpi"><span class="big">${nFit}</span> jugadores caben en tu caja de <b>${eur(caja)}</b>` +
        (nAvail ? ` · <b style="color:var(--up)">${nAvail} clausulables ya</b>` : ` · <span class="mut">0 disponibles ahora (cláusulas bloqueadas en pretemporada 🔒)</span>`) + `</div>`;
      const rows = ps.filter(p => (!onlyA || fits(p)) && (!q || (p.name + " " + p.owner).toLowerCase().includes(q)));
      body.innerHTML = rows.slice(0, 200).map(p => {
        const f = fits(p);
        const badge = p.shielded ? `<span class="cl-bad shield">🛡️ blindado</span>` : p.locked ? `<span class="cl-bad lock">🔒 ${f ? "cabe, bloqueada" : "bloqueada"}</span>` : f ? `<span class="cl-bad ok">✓ puedes</span>` : `<span class="cl-bad no">✗ te falta caja</span>`;
        return `<tr class="clickable ${f ? "affrow" : ""}" data-player="${esc(p.id || "")}">
          <td class="l p-name-cell"><span class="cellface">${avatar(p, 26)}${esc(p.name)} ${statusBadge((playersById[p.id] || {}).status)}</span></td>
          <td>${posChip(p.pos)}</td><td class="l"><span class="linkmgr" data-manager="${esc(p.owner)}">${esc(p.owner)}</span></td>
          <td class="num val" data-v="${p.value || 0}">${eur(p.value)}</td><td class="num clause" data-v="${p.clause || 0}">${eur(p.clause)}</td><td class="l">${badge}</td></tr>`;
      }).join("") || `<tr><td colspan="6" class="placeholder">Nada coincide.</td></tr>`;
      applySort(body);
    };
    slider.addEventListener("input", e => { caja = +e.target.value; render(); });
    only.addEventListener("change", e => { onlyA = e.target.checked; render(); });
    search.addEventListener("input", e => { q = e.target.value.trim().toLowerCase(); render(); });
    render();
    makeSortable("#tblClausu");
  })();

  // ================= NOTICIAS / RUMORES (resumen) =================
  (function newsCard() {
    const n = D.news || [];
    if (!n.length) { hide("newsCard"); return; }
    $("#news").innerHTML = n.slice(0, 22).map(a => `<a class="newsrow" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join("");
  })();

  // ================= CHOLLOS DE CLÁUSULA =================
  (function chollosCard() {
    const ps = (D.clausulometro || {}).players || [];
    const chollos = ps.filter(p => !p.shielded && p.premium != null && p.value > 0)
      .sort((a, b) => (a.premium - b.premium) || (b.value - a.value)).slice(0, 12);
    if (!chollos.length) { hide("chollosCard"); return; }
    $("#chollos").innerHTML = chollos.map(p => pRow(p,
      `<span class="clause">${eur(p.clause)}</span>`,
      `${esc(p.owner)} · vale ${eurK(p.value)} · <span style="color:${p.premium <= 20 ? "var(--up)" : "var(--ink-mute)"}">${p.premium >= 0 ? "+" : ""}${p.premium}% s/valor</span>`)).join("");
  })();

  // ================= COMPARAR PLANTILLAS =================
  (function squadCompare() {
    if (managers.length < 2) { hide("compareSquadsCard"); return; }
    const a = $("#sqA"), b = $("#sqB");
    a.innerHTML = managers.map((m, i) => `<option value="${i}">${esc(m.name)}</option>`).join("");
    b.innerHTML = a.innerHTML; b.selectedIndex = 1;
    const cnt = sq => { const c = { POR: 0, DEF: 0, MED: 0, DEL: 0 }; (sq || []).forEach(p => { if (c[p.pos] != null) c[p.pos]++; }); return c; };
    const side = m => {
      const c = cnt(m.squad);
      return `<div class="sqside"><div class="sq-name">${esc(m.name)}</div>
        <div class="sq-stats"><span>Valor<b>${eurK(m.value)}</b></span><span>Jugadores<b>${m.count}</b></span><span>Puntos<b>${num(m.points)}</b></span></div>
        <div class="sq-pos">POR ${c.POR} · DEF ${c.DEF} · MED ${c.MED} · DEL ${c.DEL}</div>
        <div class="sq-list">${(m.squad || []).slice(0, 25).map(p => `<div class="prow" data-player="${esc(p.id || "")}">${avatar(playersById[p.id] || p, 26)}${posChip(p.pos)}<div class="pr-main"><div class="p-name">${esc(p.name)}</div></div><div class="p-fig">${eurK(p.value)}</div></div>`).join("")}</div></div>`;
    };
    const draw = () => { const A = managers[+a.value], B = managers[+b.value]; if (A && B) $("#sqCompare").innerHTML = side(A) + `<div class="sqvs">VS</div>` + side(B); };
    a.addEventListener("change", draw); b.addEventListener("change", draw); draw();
  })();

  // ================= DIFICULTAD DE CALENDARIO =================
  (function fixtureDiff() {
    const F = D.fixtures || {}, weeks = F.weeks || [], teams = F.teams || [];
    if (!teams.length) { hide("fdCard"); return; }
    const DC = { 0: "var(--surface-2)", 1: "#1f9c74", 2: "#43c08a", 3: "#c9a13b", 4: "#e0714a", 5: "#d94b3f" };
    const shortOf = (tid) => (TEAMS[tid] || {}).name || "?";
    const head = `<div class="fdrow fdhead"><span class="fd-team"></span>${weeks.map(w => `<span class="fdcell">J${w}</span>`).join("")}</div>`;
    const rows = teams.map(t => `<div class="fdrow"><span class="fd-team">${teamBadge(t.teamId, 18)} ${esc(shortOf(t.teamId))}</span>${t.fixtures.map(f => `<span class="fdcell" style="background:${DC[f.diff] || DC[0]};color:${f.diff >= 3 ? "#fff" : "#08111f"}" title="${esc(f.opp)}${f.home === false ? " (fuera)" : f.home ? " (casa)" : ""}">${f.oppId ? esc(shortOf(f.oppId)) + (f.home === false ? "" : "") : "—"}</span>`).join("")}</div>`).join("");
    $("#fixdiff").innerHTML = head + rows;
  })();

  // ================= MI EQUIPO =================
  (function myTeamTab() {
    const cont = $("#myTeam");
    const mgrs = (managers || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (!mgrs.length) { cont.innerHTML = `<section class="card"><h2 class="display">Mi equipo</h2><p class="placeholder">Aún no hay datos de plantillas.</p></section>`; return; }
    let myTeams = {}; try { myTeams = JSON.parse(localStorage.getItem("ff_teams") || "{}"); } catch (e) {}
    const myLids = Object.keys(myTeams).filter(id => LEAGUES.some(l => l.id === id) || !MULTI);
    const saved = localStorage.getItem("ff_team");
    // tu equipo está ATADO a tu cuenta: no es un desplegable libre.
    let current = myTeams[ffLeague] || (mgrs.some(x => x.name === saved) ? saved : (mgrs.some(x => x.name === D.you) ? D.you : mgrs[0].name));
    const boundHere = !MULTI || !!myTeams[ffLeague];   // ¿tienes equipo reclamado en ESTA liga?
    const leagueName = (LEAGUES.find(l => l.id === ffLeague) || {}).name || "esta liga";
    function render() {
      if (!boundHere) {                                // viendo una liga sin equipo reclamado
        cont.innerHTML = `<section class="card"><h2 class="display">Mi equipo · ${esc(leagueName)}</h2>
          <p class="placeholder" style="margin-bottom:14px">Aún no has reclamado tu equipo en <b>${esc(leagueName)}</b>. Reclámalo para ver aquí tu plantilla, alertas, gráficas y tu <b>caja privada</b>.</p>
          <button class="ob-go" id="mtClaimHere" style="max-width:320px">Reclamar mi equipo en ${esc(leagueName)}</button>
          <p class="hint" style="margin-top:12px">Puedes seguir viendo el resto de ${esc(leagueName)} (clasificación, mercado…) con normalidad. Para volver a tu otra liga usa <b>«Cambiar de liga»</b> arriba.</p></section>`;
        const b = $("#mtClaimHere"); if (b) b.addEventListener("click", () => window.__manageLeagues && window.__manageLeagues());
        return;
      }
      const m = managersByName[current]; if (!m) return;
      const squad = (m.squad || []).map(s => ({ ...s, e: playersById[s.id] || {} }));
      const injured = squad.filter(s => s.e.status);
      const movers = squad.filter(s => s.e.day != null && s.e.day !== 0).sort((a, b) => Math.abs(b.e.day) - Math.abs(a.e.day)).slice(0, 6);
      const acts = (D.transfers || []).filter(t => t.from === current || t.to === current).slice(0, 8);
      const caja = teamCaja(current);
      const auto = cajaIsAuto(current);
      const opts = mgrs.map(x => `<option value="${esc(x.name)}"${x.name === current ? " selected" : ""}>${esc(x.name)}</option>`).join("");
      cont.innerHTML = `
        <section class="card myteam-pick"><h2 class="display">Mi equipo</h2>
          <div id="mtDeadline"></div>
          <div class="controls">
            ${(MULTI && myLids.length > 1)
              ? `<label class="mt-lbl">Tu liga</label><select id="mtLeague">${LEAGUES.filter(l => myLids.includes(l.id)).map(l => `<option value="${esc(l.id)}"${l.id === ffLeague ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select>`
              : (MULTI ? `<label class="mt-lbl">Liga</label><b class="mt-fixed">${esc((LEAGUES.find(l => l.id === ffLeague) || {}).name || "—")}</b>` : "")}
            <label class="mt-lbl">Tu equipo</label><b class="mt-fixed">${esc(current)}</b>
            <label class="mt-lbl">Tu caja</label><span class="mt-caja"><input id="mtCaja" type="text" inputmode="numeric" placeholder="—" value="${caja != null ? caja.toLocaleString("es-ES") : ""}"> € <span class="conn-ok">${auto ? "automática ✓" : "ajustada por ti"}</span></span>
            ${auto ? "" : `<button class="linkbtn" id="mtAuto">volver a automática</button>`}
            ${MULTI ? `<button class="linkbtn" id="mtAddLeague" title="Reclamar tu equipo en otra liga">➕ otra liga</button>` : ""}
            <button class="linkbtn" id="mtLogout" title="Salir / elegir otro equipo">salir</button>
          </div>
          <p class="hint">Tu caja se calcula <b>sola</b> con los fichajes, ventas y cláusulas de la liga. Si no te cuadra (p.ej. por el dinero del <b>vídeo diario</b>, que LaLiga no hace público), escríbela y se guardará como la tuya.</p>
        </section>
        <div class="kpis">
          <div class="kpi" style="--accent:var(--gold)"><div class="k-label">Puntos</div><div class="k-main">${cnum(m.points, "num")}</div><div class="k-sub">${esc(current)}</div></div>
          <div class="kpi" style="--accent:var(--red)"><div class="k-label">Valor plantilla</div><div class="k-main">${cnum(m.value, "eur")}</div><div class="k-sub">${esc(current)}</div></div>
          <div class="kpi" style="--accent:var(--up)"><div class="k-label">Tu caja</div><div class="k-main">${caja != null ? cnum(caja, "eur") : "—"}</div><div class="k-sub">${auto ? "automática ✓" : "ajustada por ti"}</div></div>
          <div class="kpi" style="--accent:var(--blue)"><div class="k-label">Posición</div><div class="k-main">#${m.rank ?? "—"}</div><div class="k-sub">${esc(current)}</div></div>
        </div>
        <div class="grid2">
          <section class="card"><h2 class="display">Alertas de tu equipo</h2><div class="feed" id="myAlerts"></div></section>
          <section class="card"><h2 class="display">Tu plantilla <span class="count">${m.count} jugadores</span></h2><div class="ptable-wrap"><table class="ptable"><tbody id="mySquad"></tbody></table></div></section>
        </div>
        <div class="grid2">
          <section class="card" id="mtValCard"><h2 class="display">Evolución del valor de tu plantilla</h2><div class="chart" id="mtValChart"></div><p class="chart-note"><b>Eje Y ↑</b> valor total (€) · <b>Eje X →</b> fecha de cada captura · pasa el ratón para ver el valor</p></section>
          <section class="card" id="mtPtsCard"><h2 class="display">Evolución de tus puntos</h2><div class="chart" id="mtPtsChart"></div><p class="chart-note"><b>Eje Y ↑</b> puntos totales · <b>Eje X →</b> fecha de cada captura</p></section>
        </div>`;
      const A = [];
      injured.forEach(s => A.push([statusBadge(s.e.status), `<b>${esc(s.name)}</b> ${(STATUS[s.e.status] || {}).l || ""}`, ""]));
      movers.forEach(s => A.push([s.e.day > 0 ? "📈" : "📉", `<b>${esc(s.name)}</b> ${s.e.day > 0 ? "sube" : "baja"} de valor`, `<span class="amt ${s.e.day > 0 ? "up" : "down"}">${signed(s.e.day)}</span>`]));
      acts.forEach(t => { const mine = moveDir(t).receiver === current; A.push([mine ? "🟢" : "🔴", `${mine ? "Fichaste a" : "Vendiste a"} <b>${esc(t.player)}</b>`, `<span class="amt">${eur(t.amount)}</span>`]); });
      $("#myAlerts").innerHTML = A.length ? A.map(a => `<div class="ev"><span class="tag">${a[0]}</span><span>${a[1]}</span>${a[2]}</div>`).join("") : `<p class="placeholder">Todo tranquilo: sin bajas ni movimientos relevantes.</p>`;
      $("#mySquad").innerHTML = squad.map(s => `<tr class="clickable" data-player="${esc(s.id || "")}"><td class="l p-name-cell"><span class="cellface">${avatar(s.e.id ? s.e : s, 26)}${esc(s.name)} ${statusBadge(s.e.status)}</span></td><td>${posChip(s.pos)}</td><td class="num val">${eur(s.value)}</td><td class="num clause">${s.clause ? eur(s.clause) : "—"}</td><td class="num">${s.e.day != null && s.e.day !== 0 ? `<span class="${s.e.day > 0 ? "up" : "down"}">${signed(s.e.day)}</span>` : "—"}</td></tr>`).join("");
      const vHtml = valueEvoChart([{ name: current, cls: "hl", valueSeries: m.valueSeries, valueHistory: m.valueHistory }], 210);
      $("#mtValChart").innerHTML = vHtml || `<p class="placeholder">Necesito al menos dos capturas (se acumulan solas con cada actualización).</p>`;
      const myPts = m.pointsHistory || [];
      $("#mtPtsChart").innerHTML = myPts.length >= 2
        ? lineChart([{ values: myPts, cls: "hl", title: current }], 210, { fmtY: v => num(Math.round(v)) + " pts", dates: histDates(D.histCaps, [{ values: myPts }]) })
        : `<p class="placeholder">${preseasonPts()}</p>`;
      animateCounts(cont);   // KPIs con efecto "big board"
      const ml = $("#mtLeague");
      if (ml) ml.addEventListener("change", e => {          // cambiar entre TUS ligas
        const newLid = e.target.value;
        localStorage.setItem("ff_league", newLid);
        if (myTeams[newLid]) localStorage.setItem("ff_team", myTeams[newLid]);
        location.reload();
      });
      const mc = $("#mtCaja");
      if (mc) mc.addEventListener("change", e => {
        const n = parseInt((e.target.value || "").replace(/[^\d]/g, ""), 10);
        if (isNaN(n)) localStorage.removeItem("ff_caja_" + current); else localStorage.setItem("ff_caja_" + current, n);
        render();
      });
      const ab = $("#mtAuto"); if (ab) ab.addEventListener("click", () => { localStorage.removeItem("ff_caja_" + current); render(); });
      const alg = $("#mtAddLeague"); if (alg) alg.addEventListener("click", () => window.__manageLeagues && window.__manageLeagues());
      const lo = $("#mtLogout"); if (lo) lo.addEventListener("click", () => {
        ["ff_email", "ff_teams", "ff_league", "ff_team"].forEach(k => localStorage.removeItem(k));
        sessionStorage.removeItem("ff_gid");
        try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
        location.reload();
      });
    }
    window.__renderMyTeam = render;
    render();
  })();

  // ================= ASISTENTE INTELIGENTE =================
  // Recomendaciones accionables con los datos que ya tenemos: once óptimo de tu plantilla,
  // clausulazos que te MEJORAN (según tu caja) y avisos de venta/lesión. En pretemporada
  // el valor de mercado hace de proxy de calidad; con la liga en marcha pondera la media.
  (function assistantTab() {
    const host = $("#assistant"); if (!host) return;
    const meName = currentTeam();
    const me = meName ? managersByName[meName] : null;
    if (!me || !(me.squad || []).length) {
      host.innerHTML = `<section class="card"><h2 class="display">🧠 Asistente</h2><p class="placeholder">Entra en <b>«Mi equipo»</b> y reclama tu equipo para ver recomendaciones personalizadas: once óptimo, clausulazos que te mejoran y avisos.</p></section>`;
      return;
    }
    const caja = teamCaja(meName) || 0;
    const squad = me.squad.map(s => Object.assign({}, s, { e: playersById[s.id] || {} }));
    const seasonLive = squad.some(s => (s.e.avg || 0) > 0 || (s.e.points || 0) > 0);

    // ---- señales objetivas que alimentan al asistente ----
    // A) titularidad: % de salir en el 11 probable (futbolfantasy)
    const startProb = {}, teamsWithOnce = new Set();
    (D.onces || []).forEach(o => { if (o.teamId) teamsWithOnce.add(String(o.teamId)); (o.xi || []).forEach(p => { if (p.id) startProb[String(p.id)] = (p.prob != null ? p.prob : 100); }); });
    // B) dificultad del próximo rival por equipo (1 fácil … 5 difícil)
    const teamDiff = {}, teamOpp = {};
    ((D.fixtures || {}).teams || []).forEach(t => { const f = (t.fixtures || [])[0]; if (f) { teamDiff[String(t.teamId)] = f.diff; teamOpp[String(t.teamId)] = f; } });
    const probOf = s => startProb[String(s.id)];
    const diffOf = s => teamDiff[String(s.e && s.e.teamId)];
    // C) puntuación: calidad (valor+media) ponderada por titularidad, rival y estado
    function score(s) {
      const e = s.e || {};
      let q = (s.value || 0) / 1e6 + (e.avg || 0) * 1.5;
      if (e.status) q *= 0.35;                                   // lesión/duda/sanción
      else { const pr = probOf(s); q *= (pr != null ? (0.45 + pr / 100 * 0.55) : 0.8); }  // titularidad
      const df = diffOf(s); if (df != null) q *= (1 + (3 - df) * 0.05);                    // rival fácil suma
      return q;
    }

    // ---- 1) once óptimo ----
    const g = { POR: [], DEF: [], MED: [], DEL: [] };
    squad.forEach(s => { if (g[s.pos]) g[s.pos].push(s); });
    Object.keys(g).forEach(k => g[k].sort((a, b) => score(b) - score(a)));
    // mejor 11 posible: busca la formación válida (suma 10 de campo + portero) que
    // maximiza calidad; si la plantilla está incompleta, alinea a todos los disponibles.
    let best = null;
    for (let df = 3; df <= 5; df++) for (let md = 2; md <= 5; md++) for (let dl = 1; dl <= 4; dl++) {
      if (df + md + dl !== 10 || !g.POR.length || df > g.DEF.length || md > g.MED.length || dl > g.DEL.length) continue;
      const xi = [g.POR[0]].concat(g.DEF.slice(0, df), g.MED.slice(0, md), g.DEL.slice(0, dl));
      const sc = xi.reduce((a, p) => a + score(p), 0);
      if (!best || sc > best.sc) best = { f: [df, md, dl], xi, sc, full: true };
    }
    if (!best) {   // plantilla incompleta: alinea a todos los que hay
      const xi = (g.POR.length ? [g.POR[0]] : []).concat(g.DEF, g.MED, g.DEL);
      best = { f: [g.DEF.length, g.MED.length, g.DEL.length], xi, sc: 0, full: false };
    }
    const inXI = new Set(best.xi.map(s => s.id));
    const line = (label, arr, cls) => arr.length ? `<div class="xi-line"><span class="xi-lbl ${cls}">${label}</span><div class="xi-players">${arr.map(s => `<span class="xi-p clickable" data-player="${esc(s.id || "")}">${avatar(s.e.id ? s.e : s, 22)}<span>${esc(s.name)}</span> ${statusBadge(s.e.status)}<b>${eurK(s.value)}</b></span>`).join("")}</div></div>` : "";
    const bench = squad.filter(s => !inXI.has(s.id));
    const need = Math.max(0, 11 - best.xi.length);
    const xiHTML = `<div class="xi-form">${best.full ? "Formación óptima" : "Alineación provisional"} <b>${best.f.join("-")}</b> <span class="mut">· por ${seasonLive ? "media + valor" : "valor de mercado (pretemporada)"}</span></div>
         ${need ? `<p class="placeholder" style="margin:0 0 10px">Tu plantilla tiene <b>${squad.length}</b> jugadores: te ${need === 1 ? "falta 1" : "faltan " + need} para completar el once. Ficha para rellenar los huecos.</p>` : ""}
         ${line("POR", best.xi.filter(s => s.pos === "POR"), "por")}
         ${line("DEF", best.xi.filter(s => s.pos === "DEF"), "def")}
         ${line("MED", best.xi.filter(s => s.pos === "MED"), "med")}
         ${line("DEL", best.xi.filter(s => s.pos === "DEL"), "del")}
         ${bench.length ? `<div class="xi-bench"><span class="xi-lbl">Banquillo</span> ${bench.map(s => `<span class="bench-chip clickable" data-player="${esc(s.id || "")}">${esc(s.name)}</span>`).join(" ")}</div>` : ""}`;

    // ---- 2) clausulazos que te mejoran (ponderando titularidad, rival y momentum) ----
    const diffLabel = d => d == null ? "" : (d <= 2 ? "rival fácil" : d === 3 ? "rival medio" : "rival difícil");
    const worst = {};
    ["POR", "DEF", "MED", "DEL"].forEach(p => { if (g[p].length) worst[p] = g[p][g[p].length - 1]; });  // tu peor de cada línea
    const cand = ((D.clausulometro || {}).players || []).filter(p => p.owner !== meName && !p.shielded && p.clause > 0 && p.clause <= caja);
    const upgrades = cand.map(p => {
      const w = worst[p.pos], gain = w ? (p.value - w.value) : 0, pe = playersById[p.id] || {};
      const pr = startProb[String(p.id)], df = teamDiff[String(pe.teamId)];
      const titF = pr != null ? (0.4 + pr / 100 * 0.6) : 0.75, fixF = df != null ? (1 + (3 - df) * 0.06) : 1;
      return { p, w, gain, pr, df, opp: teamOpp[String(pe.teamId)], day: pe.day, recScore: gain * titF * fixF };
    }).filter(u => u.w && u.gain > 0).sort((a, b) => b.recScore - a.recScore).slice(0, 6);
    const badges = u => [
      u.pr != null ? `<span class="sig ${u.pr >= 70 ? "ok" : "mid"}">titular ${u.pr}%</span>` : `<span class="sig mut">sin dato de once</span>`,
      u.df != null ? `<span class="sig ${u.df <= 2 ? "ok" : u.df >= 4 ? "no" : ""}">${u.opp ? (u.opp.home === false ? "a " : "vs ") + esc(u.opp.opp) + " · " : ""}${diffLabel(u.df)}</span>` : "",
      u.day ? `<span class="sig ${u.day > 0 ? "ok" : "no"}">${u.day > 0 ? "📈" : "📉"} ${signedK(u.day)}</span>` : "",
    ].filter(Boolean).join("");
    const upHTML = upgrades.length
      ? upgrades.map(u => `<div class="rec clickable" data-player="${esc(u.p.id || "")}">
          <div class="rec-main"><b>${esc(u.p.name)}</b> <span class="pos">${esc(u.p.pos)}</span> ${u.p.locked ? `<span class="rec-lock">🔒 al abrir cláusulas</span>` : `<span class="rec-ok">✓ ya</span>`}</div>
          <div class="rec-sub">Cláusula <b>${eurK(u.p.clause)}</b> · valor ${eurK(u.p.value)} · <span class="up">mejora a ${esc(u.w.name)} (+${eurK(u.gain)})</span></div>
          <div class="rec-sig">${badges(u)}</div></div>`).join("")
      : `<p class="placeholder">Con tu caja de <b>${eur(caja)}</b> no hay ahora mismo un fichaje por cláusula que mejore tu once. Ajusta tu caja en «Mi equipo» si no cuadra, o vuelve cuando bajen valores.</p>`;

    // ---- 3) vigila / considera vender ----
    const warns = [], seen = new Set();
    const addW = (id, ic, txt) => { if (id && !seen.has(id)) { seen.add(id); warns.push({ id, ic, txt }); } };
    squad.forEach(s => { if (s.e.status) addW(s.id, statusBadge(s.e.status) || "🚑", `<b>${esc(s.name)}</b> — ${(STATUS[s.e.status] || {}).l || "baja"}: valora suplente o venta`); });
    squad.forEach(s => { if (!s.e.status && s.e.teamId && teamsWithOnce.has(String(s.e.teamId)) && startProb[String(s.id)] == null) addW(s.id, "🪑", `<b>${esc(s.name)}</b> — no aparece en el 11 probable de su equipo (¿suplente?): ojo si cuentas con él`); });
    squad.filter(s => s.e.day != null && s.e.day < 0).sort((a, b) => a.e.day - b.e.day).slice(0, 4)
      .forEach(s => addW(s.id, "📉", `<b>${esc(s.name)}</b> baja de valor (<span class="down">${signed(s.e.day)}</span> hoy) — si no lo alineas, plantéate venderlo`));
    const warnHTML = warns.length
      ? warns.slice(0, 8).map(w => `<div class="rec clickable" data-player="${esc(w.id || "")}"><div class="rec-main"><span class="rec-ic">${w.ic}</span> ${w.txt}</div></div>`).join("")
      : `<p class="placeholder">Sin avisos: ningún titular lesionado ni cayendo de valor. 👌</p>`;

    host.innerHTML = `
      <section class="card asist-head"><h2 class="display">🧠 Asistente de <span class="asist-team">${esc(meName)}</span></h2>
        <p class="movsub">Recomendaciones objetivas con tus datos reales (tu caja: <b>${eur(caja)}</b>). Pondera <b>calidad</b> (${seasonLive ? "media de puntos + valor" : "valor de mercado, en pretemporada"}), <b>titularidad</b> (11 probable de futbolfantasy), <b>dificultad del rival</b> (calendario) y <b>estado</b> (lesiones/sanciones de la API oficial). No es una IA entrenada: son reglas transparentes sobre datos, sin adivinar.</p>
      </section>
      <div class="grid2">
        <section class="card"><h2 class="display">⚡ Once óptimo <span class="count">tu mejor 11 posible</span></h2><div class="xi-wrap">${xiHTML}</div></section>
        <section class="card"><h2 class="display">🎯 Clausulazos que te mejoran <span class="count">según tu caja</span></h2><div class="rec-list">${upHTML}</div></section>
      </div>
      <section class="card"><h2 class="display">⚠️ Vigila tu equipo <span class="count">lesiones y caídas de valor</span></h2><div class="rec-list">${warnHTML}</div></section>`;
  })();

  // ================= PATRIMONIO (Clasificación) =================
  (function patrimonio() {
    const c = coloredRows(st.map(r => ({ name: r.manager, valueSeries: r.valueSeries, valueHistory: r.valueHistory })));
    const html = valueEvoChart(c.rows, 220, { chartId: "chPat" });
    $("#patrimonio").innerHTML = html || `<p class="placeholder">Necesito al menos dos capturas (se acumulan con cada actualización).</p>`;
    $("#patLegend").innerHTML = html ? legendHTML("chPat", c.items) : "";
  })();

  // ================= MODO TV =================
  (function tvMode() {
    const btn = $("#tvBtn"), card = $("#standCard"); if (!btn || !card) return;
    btn.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (card.requestFullscreen) card.requestFullscreen().catch(() => {});
    });
  })();

  // ================= BUSCADOR GLOBAL =================
  (function globalSearch() {
    const inp = $("#globalSearch"), res = $("#gsearchRes"); if (!inp) return;
    const idx = players.map(p => ({ t: "player", id: p.id, name: p.name, sub: p.pos || "jugador", p }))
      .concat(managers.map(m => ({ t: "manager", id: m.name, name: m.name, sub: "presidente" })));
    const run = () => {
      const q = inp.value.trim().toLowerCase();
      if (q.length < 2) { res.hidden = true; return; }
      const hits = idx.filter(x => x.name.toLowerCase().includes(q)).sort((a, b) => a.name.length - b.name.length).slice(0, 12);
      res.innerHTML = hits.length ? hits.map(h => `<div class="gres" data-${h.t}="${esc(h.id)}">${h.t === "player" ? avatar(h.p, 24) : `<span class="gicon">👤</span>`}<span class="gres-n">${esc(h.name)}</span><span class="gres-sub">${esc(h.sub)}</span></div>`).join("") : `<div class="gres mut">Sin resultados</div>`;
      res.hidden = false;
    };
    inp.addEventListener("input", run);
    inp.addEventListener("focus", run);
    inp.addEventListener("blur", () => setTimeout(() => { res.hidden = true; }, 200));
    res.addEventListener("mousedown", () => setTimeout(() => { res.hidden = true; inp.value = ""; }, 30));
  })();

  // ================= CLASIFICACIÓN REAL DE LALIGA =================
  (function laligaTable() {
    const T = D.laligaTable || [];
    if (!T.length) { hide("ltCard"); return; }
    const started = T.some(r => r.pts != null);
    const rows = started ? T : T.slice().sort((a, b) => (a.team || "").localeCompare(b.team || ""));
    const nz = v => v != null ? v : "—";
    const dgf = v => v == null ? "—" : (v > 0 ? "+" + v : "" + v);
    $("#ltBody").innerHTML = rows.map(r => `<tr class="clickable" data-team="${esc(r.teamId || "")}">` +
      `<td class="rk" data-v="${r.pos || 0}">${started ? r.pos : "–"}</td>` +
      `<td class="l p-name-cell"><span class="cellface">${teamBadge(r.teamId, 22)}${esc(r.team)}</span></td>` +
      `<td class="num" data-v="${r.pj || 0}">${nz(r.pj)}</td><td class="num" data-v="${r.pg || 0}">${nz(r.pg)}</td><td class="num" data-v="${r.pe || 0}">${nz(r.pe)}</td><td class="num" data-v="${r.pp || 0}">${nz(r.pp)}</td>` +
      `<td class="num" data-v="${r.gf || 0}">${nz(r.gf)}</td><td class="num" data-v="${r.gc || 0}">${nz(r.gc)}</td>` +
      `<td class="num ${r.dg > 0 ? "up" : r.dg < 0 ? "down" : ""}" data-v="${r.dg || 0}">${dgf(r.dg)}</td>` +
      `<td class="num pts" data-v="${r.pts || 0}">${nz(r.pts)}</td></tr>`).join("");
    makeSortable("#tblLaliga");
    const cnt = $("#ltCard h2 .count"); if (cnt) cnt.textContent = started ? "real · en vivo" : "pretemporada";
    if (!started && !$("#ltNote")) {
      const wrap = $("#ltCard .ptable-wrap");
      if (wrap) wrap.insertAdjacentHTML("beforebegin", `<p class="placeholder" id="ltNote">Pretemporada · la clasificación se actualiza sola en cuanto arranque LaLiga.</p>`);
    }
  })();

  // ================= CALENDARIO POR EQUIPO (todas competiciones) =================
  (function teamCal() {
    const TC = D.teamCalendars || {}, keys = Object.keys(TC), sel = $("#tcSel"), list = $("#tcList");
    if (!keys.length) { if (sel) sel.style.display = "none"; list.innerHTML = `<p class="placeholder">El calendario completo por equipo se carga en la próxima actualización.</p>`; return; }
    const opts = keys.map(k => ({ k, name: TC[k].name || k })).sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = opts.map(o => `<option value="${o.k}">${esc(o.name)}</option>`).join("");
    const compCls = c => /champions/i.test(c) ? "c-ch" : /copa|supercopa/i.test(c) ? "c-cup" : /amistoso/i.test(c) ? "c-fr" : "c-lg";
    const draw = k => {
      const d = TC[k]; if (!d) return;
      list.innerHTML = (d.matches || []).map(mt => {
        const right = mt.score ? `<span class="tc-score">${esc(mt.score)}</span>` : `<span class="tc-when">${esc(mt.when || "")}</span>`;
        return `<div class="tcrow${mt.score ? " played" : ""}"><span class="tc-comp ${compCls(mt.comp)}">${esc(mt.comp || "—")}</span><span class="tc-match">${esc(mt.match)}</span>${right}</div>`;
      }).join("");
    };
    sel.addEventListener("change", () => draw(sel.value)); draw(opts[0].k);
  })();

  // ================= ESTADÍSTICAS DE JUGADORES =================
  (function statsTab() {
    const PS = D.playerStats || { rows: [], live: false };
    const rows = PS.rows || [];
    if (!rows.length) { hide("statsCard"); return; }
    // que todos los jugadores de la tabla sean clicables (modal básico si no eran entidad)
    rows.forEach(r => { if (!playersById[r.id]) playersById[r.id] = { id: r.id, name: r.name, pos: r.pos, teamId: r.teamId, value: r.value, img: r.img, official: r.official }; });
    const body = $("#statsBody"), search = $("#statsSearch"), posSel = $("#statsPos"), note = $("#statsNote");
    if (!PS.live && note) {
      note.hidden = false;
      note.textContent = "Pretemporada · goles, asistencias, remates, despejes, recuperaciones, paradas y porterías a cero se rellenan solos desde la jornada 1. Ahora ves puntos 2025/26, media y valor (datos reales).";
    }
    const num = v => (v == null || isNaN(+v)) ? 0 : +v;
    const d = v => v ? v : "·";                 // 0 -> punto tenue (menos ruido visual)
    let sortKey = PS.live ? "points" : "lastPts", sortDir = -1;
    function view() {
      const q = (search.value || "").trim().toLowerCase(), pf = posSel.value;
      const r = rows.filter(x => (!q || (x.name || "").toLowerCase().includes(q)) && (pf === "ALL" || x.pos === pf));
      r.sort((a, b) => sortDir * (num(a[sortKey]) - num(b[sortKey])) || (a.name || "").localeCompare(b.name || ""));
      body.innerHTML = r.slice(0, 300).map((x, i) => `<tr class="clickable" data-player="${esc(x.id)}">` +
        `<td class="rk">${i + 1}</td>` +
        `<td class="l p-name-cell"><span class="cellface">${avatar(x, 26)}${teamBadge(x.teamId, 18)}${esc(x.name)}</span></td>` +
        `<td>${posChip(x.pos)}</td>` +
        `<td class="num">${d(x.matches)}</td><td class="num">${d(x.minutes)}</td>` +
        `<td class="num st">${x.goals || 0}</td><td class="num st">${x.assists || 0}</td><td class="num">${x.shots || 0}</td>` +
        `<td class="num">${x.clears || 0}</td><td class="num">${x.recoveries || 0}</td><td class="num">${x.saves || 0}</td>` +
        `<td class="num">${x.cleanSheets || 0}</td><td class="num">${x.yellow || 0}</td><td class="num">${x.red || 0}</td>` +
        `<td class="num pts">${x.points || 0}</td><td class="num">${x.lastPts || 0}</td><td class="num">${x.avg || 0}</td>` +
        `<td class="num val">${eurK(x.value)}</td></tr>`).join("");
      $("#statsCount").textContent = r.length + " jugadores";
    }
    $$("#statsCard th[data-sort]").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
      $$("#statsCard th[data-sort]").forEach(t => t.classList.remove("sasc", "sdesc"));
      th.classList.add(sortDir < 0 ? "sdesc" : "sasc");
      view();
    }));
    search.addEventListener("input", view);
    posSel.addEventListener("change", view);
    view();
  })();

  // ================= DRILL-DOWN (modales) =================
  // ---------- previa de partido: onces probables de ambos equipos ----------
  const oncesByTeamId = {};
  (D.onces || []).forEach(o => { if (o.teamId) oncesByTeamId[o.teamId] = o; });
  const _probCol = (p) => p == null ? "var(--ink-mute)" : p >= 75 ? "var(--up)" : p >= 50 ? "var(--gold)" : "var(--down)";
  function miniPitch(o) {
    if (!o || !(o.xi || []).length) return `<div class="pitch mm empty"><span class="mm-none">Once probable no disponible</span></div>`;
    const face = (p, s) => (p.id || p.img) ? avatar(p, s) : `<span class="avatar ph" style="width:${s}px;height:${s}px"></span>`;
    const pts = o.xi.map(p => {
      const x = p.x != null ? p.x : 50, y = p.y != null ? p.y : 50;
      const prob = p.prob != null ? `<span class="pp-prob" style="background:${_probCol(p.prob)}">${p.prob}%</span>` : "";
      return `<div class="pp${p.status ? " hurt" : ""}" style="left:${x}%;top:${y}%" ${p.id ? `data-player="${esc(p.id)}"` : ""}><span class="pp-photo">${face(p, 34)}${prob}</span><span class="pp-name">${esc(p.name)} ${statusBadge(p.status)}</span></div>`;
    }).join("");
    return `<div class="pitch mm">${pts}</div>`;
  }
  function openMatch(hId, aId, hName, aName, when, score) {
    const H = oncesByTeamId[hId], A = oncesByTeamId[aId];
    const mid = score ? `<span class="mm-score">${esc(score)}</span>` : `<span class="mm-vs">${esc(when || "vs")}</span>`;
    const teamCol = (id, name, o, away) => `<div class="mm-team${away ? " away" : ""}">${teamBadge(id, 30)}<span class="mm-tn">${esc((o && o.team) || name)}</span>${o && o.formation ? `<span class="mm-form">${esc(o.formation)}</span>` : ""}</div>`;
    openModal(`<div class="mm-head">${teamCol(hId, hName, H)}${mid}${teamCol(aId, aName, A, true)}</div>
      <p class="md-sub center">Onces probables · fuente: futbolfantasy</p>
      <div class="mm-pitches">${miniPitch(H)}${miniPitch(A)}</div>
      ${(!H && !A) ? `<p class="placeholder center">Los onces probables de este partido aún no están disponibles (se cargan al acercarse la jornada).</p>` : ""}`);
  }

  const modal = $("#modal"), mBody = $("#modalBody");
  function openModal(html) { mBody.innerHTML = html; modal.hidden = false; document.body.style.overflow = "hidden"; animateCounts(mBody); }
  function closeModal() { modal.hidden = true; mBody.innerHTML = ""; document.body.style.overflow = ""; }
  modal.addEventListener("click", e => { if (e.target.hasAttribute("data-close")) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

  function openPlayer(id) {
    const p = playersById[id]; if (!p) return;
    const vh = (p.valueHistory || []).map(x => x.v);
    const vhDates = seriesDates(p.valueHistory);
    const chart = vh.length >= 2 ? `<div class="chart">${lineChart([{ values: vh, cls: "hl", title: p.name }], 170, { fmtY: eurK, dates: vhDates, xLabels: vhDates ? null : ["hace ~30d", "hoy"] })}</div><p class="chart-note"><b>Eje Y ↑</b> valor de mercado · <b>Eje X →</b> ${vhDates ? "fecha de cada captura" : "últimos ~30 días"}</p>` : `<p class="md-sub">Aún no hay histórico de valor (se acumula con cada actualización).</p>`;
    // trayectoria entre presidentes (de los traspasos, del más antiguo al actual)
    const tr = [...(p.transfers || [])].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    let chain = [];
    if (tr.length) { chain.push(tr[0].from); tr.forEach(t => chain.push(t.to)); }
    else if (p.owner) chain = [p.owner];
    const nodes = chain.filter((v, i) => v && v !== "?" && (i === 0 || v !== chain[i - 1]));
    const traj = nodes.length
      ? `<div class="traj">${nodes.map((n, i) => `${i ? `<span class="arrow">→</span>` : ""}<span class="node linkmgr" data-manager="${esc(n)}">${esc(n)}</span>`).join("")}</div>`
      : `<p class="md-sub">Sin propietario registrado (agente libre / mercado).</p>`;
    const trList = tr.length ? `<div class="md-section-title">Traspasos</div>` + [...tr].reverse().map(t => {
      const d = moveDir(t);
      const flow = d.shield ? `${mgrOrMarket(d.giver)} <span class="mut">🛡️ blindó</span>` : `${mgrOrMarket(d.giver)} → ${mgrOrMarket(d.receiver)}`;
      return `<div class="ev"><span class="when">${esc(fdt(t.date))}</span><span class="tag ${/claus/.test(t.op) ? "clause" : ""}">${esc(t.op)}</span><span>${flow}</span><span class="amt">${eur(t.amount)}</span></div>`;
    }).join("") : "";
    const teamTag = p.teamId
      ? `<span class="linkteam" data-team="${esc(p.teamId)}">${teamBadge(p.teamId, 16)} ${esc(teamName(p) || "")}</span>`
      : esc(teamName(p) || "");
    const owner = p.owner
      ? ` · en <span class="linkmgr" data-manager="${esc(p.owner)}">${esc(p.owner)}</span>`
      : ` · agente libre`;
    openModal(`
      <div class="md-head">${faceBig(p)}${posChip(p.pos)}<div><div class="md-title">${esc(p.name)} ${statusBadge(p.status)}</div><div class="md-sub">${teamTag}${owner}</div></div></div>
      <div class="md-stats">
        <div class="md-stat"><div class="s-l">Valor</div><div class="s-v">${cnum(p.value, "eur")}</div></div>
        <div class="md-stat"><div class="s-l">Cláusula</div><div class="s-v" style="color:var(--red)">${p.clause ? cnum(p.clause, "eur") : "—"}</div></div>
        <div class="md-stat"><div class="s-l">Puntos</div><div class="s-v">${cnum(p.points, "num")}</div></div>
        <div class="md-stat"><div class="s-l">Media</div><div class="s-v">${p.avg ? cnum(p.avg, "x1") : "—"}</div></div>
      </div>
      <div class="md-section-title">Valor en el tiempo</div>${chart}
      <div class="md-section-title">Trayectoria entre presidentes</div>${traj}
      ${trList}
      ${p.ffUrl ? `<a class="md-source" href="${esc(p.ffUrl)}" target="_blank" rel="noopener">Ver ficha completa en futbolfantasy ↗</a>` : ""}`);
  }

  function openManager(name) {
    const m = managersByName[name]; if (!m) return;
    const counts = { POR: 0, DEF: 0, MED: 0, DEL: 0 };
    (m.squad || []).forEach(s => { if (counts[s.pos] != null) counts[s.pos]++; });
    const segs = Object.keys(counts).map(k => ({ label: k, value: counts[k], color: DONUT_COLORS[k] }));
    const hasSquad = (m.squad || []).length;
    const donutHTML = hasSquad ? `<div class="donut-wrap">${donut(segs)}<div class="donut-legend">${segs.filter(s => s.value).map(s => `<span><i style="background:${s.color}"></i>${s.label} · ${s.value}</span>`).join("")}</div></div>` : "";
    const ph = (m.pointsHistory || []);
    const ptsChart = ph.length >= 2 ? `<div class="md-section-title">Puntos en el tiempo</div><div class="chart">${lineChart([{ values: ph, cls: "hl", title: m.name }], 160, { fmtY: v => num(Math.round(v)) + " pts", dates: histDates(D.histCaps, [{ values: ph }]) })}</div>` : "";
    const valChartHtml = valueEvoChart([{ name: m.name, cls: "hl", valueSeries: m.valueSeries, valueHistory: m.valueHistory }], 160);
    const valChart = valChartHtml ? `<div class="md-section-title">Valor de plantilla en el tiempo</div><div class="chart">${valChartHtml}</div>` : "";
    const chart = ptsChart + valChart;
    const squad = hasSquad ? `<div class="md-section-title">Plantilla (${m.count})</div><div class="ptable-wrap"><table class="ptable"><tbody>` +
      m.squad.map(s => `<tr class="clickable" data-player="${esc(s.id || "")}"><td class="l p-name-cell"><span class="cellface">${avatar(playersById[s.id] || s, 26)}${esc(s.name)}</span></td><td>${posChip(s.pos)}</td><td class="num val">${eur(s.value)}</td><td class="num clause">${s.clause ? eur(s.clause) : "—"}</td><td class="num pts">${num(s.points)}</td></tr>`).join("") + `</tbody></table></div>` : "";
    const tr = m.transfers || [];
    const buys = tr.filter(t => t.to === m.name && [1, 31, 32].includes(t.type));
    const topBuy = buys.length ? buys.reduce((a, b) => b.amount > a.amount ? b : a) : null;
    const palmares = `<div class="md-section-title">Palmarés</div><div class="records" style="padding:2px 0 4px">
      <div class="rec"><div class="r-l">Gastado en fichajes</div><div class="r-v">${eur(m.spent)}</div></div>
      ${topBuy ? `<div class="rec"><div class="r-l">Fichaje más caro</div><div class="r-v">${eur(topBuy.amount)}</div><div class="r-s">${esc(topBuy.player)}</div></div>` : ""}
      <div class="rec"><div class="r-l">Operaciones</div><div class="r-v">${m.ops}</div></div></div>`;
    const trList = tr.length ? `<div class="md-section-title">Movimientos (${tr.length})</div>` + tr.slice(0, 40).map(t =>
      `<div class="ev"><span class="when">${esc(fdt(t.date))}</span><span class="tag ${/claus/.test(t.op) ? "clause" : ""}">${esc(t.op)}</span><span>${moveForManager(t, m.name)}</span><span class="amt">${eur(t.amount)}</span></div>`).join("") : "";
    openModal(`
      <div class="md-head"><div><div class="md-title">${esc(m.name)}</div><div class="md-sub">#${m.rank ?? "—"} en la clasificación</div></div></div>
      <div class="md-stats">
        <div class="md-stat"><div class="s-l">Puntos</div><div class="s-v">${cnum(m.points, "num")}</div></div>
        <div class="md-stat"><div class="s-l">Valor plantilla</div><div class="s-v">${cnum(m.value, "eur")}</div></div>
        ${(m.money != null && m.name === currentTeam()) ? `<div class="md-stat"><div class="s-l">Caja</div><div class="s-v" style="color:var(--up)">${cnum(m.money, "eur")}</div></div>` : ""}
        <div class="md-stat"><div class="s-l">Gastado</div><div class="s-v">${cnum(m.spent, "eur")}</div></div>
      </div>
      ${palmares}${donutHTML}${chart}${squad}${trList}`);
  }

  // ---------- ficha de equipo real (clasificación, once, calendario, jugadores) ----------
  function openTeam(tid) {
    const t = TEAMS[tid]; if (!t) return;
    const row = (D.laligaTable || []).find(r => String(r.teamId) === String(tid));
    const squad = players.filter(p => String(p.teamId) === String(tid)).sort((a, b) => (b.value || 0) - (a.value || 0));
    const once = oncesByTeamId[tid];
    const cal = D.calendar || {}, byWeek = cal.byWeek || {};
    const fixtures = [];
    (cal.weeks || []).forEach(w => (byWeek[w] || []).forEach(g => {
      if (String(g.localId) === String(tid) || String(g.visitorId) === String(tid)) {
        const home = String(g.localId) === String(tid);
        fixtures.push({ w, home, oppId: home ? g.visitorId : g.localId, oppName: home ? g.visitor : g.local,
          played: g.localScore != null && g.visitorScore != null, ...g });
      }
    }));
    const upcoming = fixtures.filter(f => !f.played).slice(0, 5);
    const dg = row && row.dg != null ? (row.dg > 0 ? "+" + row.dg : "" + row.dg) : "—";
    const statBlock = row ? `<div class="md-stats">
        <div class="md-stat"><div class="s-l">Posición</div><div class="s-v">${row.pos != null ? row.pos + "º" : "—"}</div></div>
        <div class="md-stat"><div class="s-l">Puntos</div><div class="s-v">${row.pts != null ? row.pts : "—"}</div></div>
        <div class="md-stat"><div class="s-l">GF · GC</div><div class="s-v">${row.gf != null ? row.gf : "—"} · ${row.gc != null ? row.gc : "—"}</div></div>
        <div class="md-stat"><div class="s-l">Dif. goles</div><div class="s-v">${dg}</div></div>
      </div>` : `<p class="md-sub">La clasificación real se rellena en cuanto arranque LaLiga.</p>`;
    const fixList = upcoming.length ? `<div class="md-section-title">Próximos partidos</div>` + upcoming.map(f =>
      `<div class="ev clickable" data-mh="${esc(f.localId || "")}" data-ma="${esc(f.visitorId || "")}" data-hn="${esc(f.local)}" data-an="${esc(f.visitor)}" data-when="${esc(fshort(f.date))} ${esc(ftime(f.date) || "")}"><span class="when">J${f.w}</span><span>${f.home ? "🏠 vs" : "✈️ a"} ${teamBadge(f.oppId, 16)} ${esc(f.oppName)}</span><span class="amt">${esc(fshort(f.date))}</span></div>`).join("") : "";
    const xiBlock = once && (once.xi || []).length
      ? `<div class="md-section-title">Once probable ${once.formation ? "· " + esc(once.formation) : ""} <span class="mut" style="font-weight:400">vía futbolfantasy</span></div>${miniPitch(once)}` : "";
    const squadTable = squad.length ? `<div class="md-section-title">Jugadores en la liga (${squad.length})</div><div class="ptable-wrap"><table class="ptable"><tbody>` +
      squad.slice(0, 30).map(p => `<tr class="clickable" data-player="${esc(p.id)}"><td class="l p-name-cell"><span class="cellface">${avatar(p, 26)}${esc(p.name)} ${statusBadge(p.status)}</span></td><td>${posChip(p.pos)}</td><td class="num val">${eur(p.value)}</td><td class="num pts">${num(p.points)}</td></tr>`).join("") + `</tbody></table></div>` : "";
    openModal(`
      <div class="md-head">${teamBadge(tid, 40)}<div><div class="md-title">${esc(t.name)}</div><div class="md-sub">${row && row.pos != null ? row.pos + "º en LaLiga" : "LaLiga"}</div></div></div>
      ${statBlock}${xiBlock}${fixList}${squadTable}
      ${t.ffSlug ? `<a class="md-source" href="https://www.futbolfantasy.com/laliga/equipos/${esc(t.ffSlug)}" target="_blank" rel="noopener">Ver equipo en futbolfantasy ↗</a>` : ""}`);
  }

  // clicks delegados (funciona en cualquier tabla/lista/modal). Orden: mánager → jugador
  // → equipo → partido, para que un enlace de mánager DENTRO de una fila clicable de
  // jugador siga abriendo el mánager (y no el jugador de la fila).
  document.addEventListener("click", e => {
    const mel = e.target.closest("[data-manager]");
    if (mel && mel.dataset.manager) { openManager(mel.dataset.manager); return; }
    const pel = e.target.closest("[data-player]");
    if (pel && pel.dataset.player) { openPlayer(pel.dataset.player); return; }
    const tel = e.target.closest("[data-team]");
    if (tel && tel.dataset.team) { openTeam(tel.dataset.team); return; }
    const fx = e.target.closest("[data-mh]");
    if (fx && fx.dataset.mh) { openMatch(fx.dataset.mh, fx.dataset.ma, fx.dataset.hn, fx.dataset.an, fx.dataset.when, fx.dataset.score); return; }
  });

  // ---------- filtros por texto (clasificación y presidentes) ----------
  (function tableFilters() {
    const wire = (inputSel, rowsSel, attr) => {
      const inp = $(inputSel); if (!inp) return;
      inp.addEventListener("input", e => {
        const qq = e.target.value.trim().toLowerCase();
        $$(rowsSel).forEach(el => {
          const t = ((attr && el.getAttribute(attr)) || el.textContent || "").toLowerCase();
          el.style.display = t.includes(qq) ? "" : "none";
        });
      });
    };
    wire("#standSearch", "#standBody tr", "data-manager");
    wire("#mgrSearch", ".mgrgrid .mgrcard", "data-manager");
  })();

  // ---------- router de pestañas (con hash para enlaces directos) ----------
  const TABS = $$(".tabsnav button").map(b => b.dataset.tab);
  function activate(name) {
    if (!TABS.includes(name)) name = "resumen";
    $$("#tabsNav button").forEach(x => x.classList.toggle("active", x.dataset.tab === name));
    $$(".tab").forEach(s => { s.hidden = s.dataset.tab !== name; });
  }
  $("#tabsNav").addEventListener("click", e => {
    const b = e.target.closest("button[data-tab]"); if (!b) return;
    location.hash = b.dataset.tab;
  });
  window.addEventListener("hashchange", () => activate(location.hash.slice(1)));
  activate(location.hash.slice(1) || "miequipo");

  // deep-link opcional a un jugador (?p=id), presidente (?m=nombre) o previa (?match=hId-aId)
  const qp = new URLSearchParams(location.search);
  if (qp.get("p")) openPlayer(qp.get("p"));
  else if (qp.get("m")) openManager(qp.get("m"));
  else if (qp.get("match")) {
    const [h, a] = qp.get("match").split("-");
    openMatch(h, a, (TEAMS[h] || {}).name || h, (TEAMS[a] || {}).name || a, "", "");
  }

  // ---------- puerta: iniciar sesión con Google + reclamar equipo ----------
  const GOOGLE_CLIENT_ID = "779450162006-4h3v5a03r1amtqkhonouhi82akglo7op.apps.googleusercontent.com";
  (function authGate() {
    const email = localStorage.getItem("ff_email");
    let teams = {}; try { teams = JSON.parse(localStorage.getItem("ff_teams") || "{}"); } catch (e) {}
    const lids = Object.keys(teams);
    if (email && lids.length) {                        // ya identificado
      let lid = localStorage.getItem("ff_league");
      if (!teams[lid]) lid = lids[0];
      localStorage.setItem("ff_league", lid);
      localStorage.setItem("ff_team", teams[lid]);
      return;                                          // app normal
    }
    const ov = document.createElement("div");
    ov.className = "onboard";
    ov.innerHTML = `<div class="onboard-card">
      <div class="ob-brand"><span class="brand-badge">LaLiga</span> Fantasy</div>
      <h2 class="display">Entra en tu liga</h2>
      <p class="ob-sub">Inicia sesión con tu <b>cuenta de Google</b> (la que usas en LaLiga Fantasy) para ver tu equipo y tu caja de forma <b>privada</b>.</p>
      <div id="gbtn" class="gbtn-wrap"></div>
      <p class="ob-note" id="obMsg">Solo usamos tu email para identificarte. Nadie podrá ver tu caja.</p>
    </div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    const msg = (t, err) => { const m = $("#obMsg", ov); if (m) { m.innerHTML = t; m.style.color = err ? "var(--down)" : ""; } };

    async function onCredential(resp) {
      const idToken = resp && resp.credential; if (!idToken) return;
      sessionStorage.setItem("ff_gid", idToken);
      msg("Comprobando tu cuenta…");
      try {
        const r = await fetch("api/whoami", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
        const j = await r.json();
        if (!j.ok) { msg(esc(j.error || "No pude entrar."), true); return; }
        localStorage.setItem("ff_email", j.email);
        localStorage.setItem("ff_teams", JSON.stringify(j.teams || {}));
        if (Object.keys(j.teams || {}).length) { document.body.style.overflow = ""; location.reload(); }
        else showClaim(idToken);
      } catch (e) { msg("Error de red, reintenta.", true); }
    }

    function showClaim(idToken) {
      const card = $(".onboard-card", ov);
      const leagueOpts = LEAGUES.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
      card.innerHTML = `<div class="ob-brand"><span class="brand-badge">LaLiga</span> Fantasy</div>
        <h2 class="display">¿Cuál es tu equipo?</h2>
        <p class="ob-sub">Elige tu liga y tu equipo. Quedará <b>atado a tu cuenta</b>; nadie más podrá usarlo.</p>
        <label>Tu liga</label><select id="obLeague"><option value="">Elige tu liga…</option>${leagueOpts}</select>
        <label>Tu equipo</label><select id="obTeam" disabled><option value="">Elige tu equipo…</option></select>
        <button id="obGo" class="ob-go" disabled>Confirmar</button>
        <p class="ob-note" id="obMsg2"></p>`;
      const selL = $("#obLeague", card), selT = $("#obTeam", card), go = $("#obGo", card);
      const m2 = (t, err) => { const m = $("#obMsg2", card); if (m) { m.textContent = t; m.style.color = err ? "var(--down)" : ""; } };
      const fill = (lid) => {
        const names = (leagueBlock(lid).managers || []).map(x => x.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        selT.innerHTML = `<option value="">Elige tu equipo…</option>` + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
        selT.disabled = !names.length;
      };
      const chk = () => { go.disabled = !(selL.value && selT.value); };
      selL.addEventListener("change", () => { fill(selL.value); selT.value = ""; chk(); });
      selT.addEventListener("change", chk);
      go.addEventListener("click", async () => {
        if (!selL.value || !selT.value) return;
        m2("Guardando…"); go.disabled = true;
        try {
          const r = await fetch("api/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, leagueId: selL.value, team: selT.value }) });
          const j = await r.json();
          if (!j.ok) { m2(j.error || "No se pudo.", true); go.disabled = false; return; }
          localStorage.setItem("ff_teams", JSON.stringify(j.teams || {}));
          localStorage.setItem("ff_league", selL.value);
          localStorage.setItem("ff_team", selT.value);
          document.body.style.overflow = ""; location.hash = "miequipo"; location.reload();
        } catch (e) { m2("Error de red.", true); go.disabled = false; }
      });
    }

    let tries = 0;
    (function initGIS() {
      if (window.google && google.accounts && google.accounts.id) {
        try {
          google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential });
          google.accounts.id.renderButton($("#gbtn", ov), { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill", width: 280 });
          google.accounts.id.prompt();
        } catch (e) { msg("No pude iniciar el login de Google.", true); }
      } else if (tries++ < 50) { setTimeout(initGIS, 150); }
      else { msg("No se pudo cargar el login de Google. Revisa tu conexión y recarga.", true); }
    })();
  })();

  // ---------- auto-refresco: avisa/recarga cuando hay datos nuevos publicados ----------
  // El reloj y las cuentas atrás ya laten solos (en el navegador). Los DATOS (marcadores,
  // valores, caja…) cambian en el servidor cada pocos min; esto detecta una publicación
  // nueva (cambia `generated`) leyendo solo los primeros bytes de metrics.js (barato).
  (function autoRefresh() {
    if (!window.fetch) return;
    let base = null, shown = false, busy = false;   // base = ETag de metrics.js publicado
    async function poll() {
      if (busy || shown) return; busy = true;
      try {
        // HEAD = solo cabeceras (NO baja los 4,7MB); el ETag cambia con cada publicación
        const r = await fetch("data/metrics.js?_=" + Date.now(), { method: "HEAD", cache: "no-store" });
        const tag = r.headers.get("etag") || r.headers.get("last-modified");
        if (!tag) return;
        if (base == null) { base = tag; return; }        // 1ª vez: fija la referencia
        if (tag !== base) {
          if (document.hidden) { location.reload(); return; }   // en 2º plano: recarga sola
          shown = true;
          const bar = document.createElement("div");
          bar.className = "freshbar";
          bar.innerHTML = `<span>🔄 Hay datos nuevos</span><button type="button">Actualizar</button>`;
          bar.querySelector("button").addEventListener("click", () => location.reload());
          document.body.appendChild(bar);
        }
      } catch (e) { } finally { busy = false; }
    }
    poll();   // fija la referencia al cargar
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    setInterval(poll, 150000);   // cada ~2,5 min
  })();

  // ---------- reclamar/añadir equipo en OTRA liga (post-login) ----------
  // La puerta de login solo sale la 1ª vez; esto permite atar tu equipo de la segunda
  // liga cuando quieras. Reusa el login de Google (token fresco) + /api/claim.
  window.__manageLeagues = function () {
    const ov = document.createElement("div"); ov.className = "onboard";
    ov.innerHTML = `<div class="onboard-card">
      <button class="ob-x" id="obX" aria-label="Cerrar">✕</button>
      <div class="ob-brand"><span class="brand-badge">LaLiga</span> Fantasy</div>
      <h2 class="display">Reclama tu equipo en otra liga</h2>
      <p class="ob-sub">Inicia sesión con tu <b>cuenta de Google</b> para atar tu equipo de otra liga. Queda ligado a tu cuenta; nadie más podrá usarlo.</p>
      <div id="gbtnM" class="gbtn-wrap"></div>
      <p class="ob-note" id="obMsgM">Elegirás la liga y el equipo tras identificarte.</p>
    </div>`;
    document.body.appendChild(ov); document.body.style.overflow = "hidden";
    const close = () => { ov.remove(); document.body.style.overflow = ""; };
    $("#obX", ov).addEventListener("click", close);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    const msg = (t, err) => { const m = $("#obMsgM", ov); if (m) { m.innerHTML = t; m.style.color = err ? "var(--down)" : ""; } };
    function showClaim(idToken) {
      const card = $(".onboard-card", ov), cur = localStorage.getItem("ff_league");
      const leagueOpts = LEAGUES.map(l => `<option value="${esc(l.id)}"${String(l.id) === String(cur) ? " selected" : ""}>${esc(l.name)}</option>`).join("");
      card.innerHTML = `<button class="ob-x" id="obX2" aria-label="Cerrar">✕</button>
        <div class="ob-brand"><span class="brand-badge">LaLiga</span> Fantasy</div>
        <h2 class="display">¿Cuál es tu equipo?</h2>
        <p class="ob-sub">Elige la liga y tu equipo.</p>
        <label>Tu liga</label><select id="obL">${leagueOpts}</select>
        <label>Tu equipo</label><select id="obT" disabled><option value="">Elige tu equipo…</option></select>
        <button id="obG" class="ob-go" disabled>Confirmar</button>
        <p class="ob-note" id="obM2"></p>`;
      $("#obX2", card).addEventListener("click", close);
      const selL = $("#obL", card), selT = $("#obT", card), go = $("#obG", card);
      const m2 = (t, err) => { const m = $("#obM2", card); if (m) { m.textContent = t; m.style.color = err ? "var(--down)" : ""; } };
      const fill = (lid) => {
        const names = (leagueBlock(lid).managers || []).map(x => x.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        selT.innerHTML = `<option value="">Elige tu equipo…</option>` + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
        selT.disabled = !names.length;
      };
      const chk = () => { go.disabled = !(selL.value && selT.value); };
      selL.addEventListener("change", () => { fill(selL.value); selT.value = ""; chk(); });
      selT.addEventListener("change", chk);
      if (selL.value) fill(selL.value);
      go.addEventListener("click", async () => {
        if (!selL.value || !selT.value) return;
        m2("Guardando…"); go.disabled = true;
        try {
          const r = await fetch("api/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, leagueId: selL.value, team: selT.value }) });
          const j = await r.json();
          if (!j.ok) { m2(j.error || "No se pudo.", true); go.disabled = false; return; }
          localStorage.setItem("ff_teams", JSON.stringify(j.teams || {}));
          localStorage.setItem("ff_league", selL.value);
          localStorage.setItem("ff_team", selT.value);
          close(); location.hash = "miequipo"; location.reload();
        } catch (e) { m2("Error de red.", true); go.disabled = false; }
      });
    }
    const onCred = (resp) => { const idToken = resp && resp.credential; if (!idToken) return; sessionStorage.setItem("ff_gid", idToken); showClaim(idToken); };
    let tries = 0;
    (function initGIS() {
      if (window.google && google.accounts && google.accounts.id) {
        try {
          google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCred });
          google.accounts.id.renderButton($("#gbtnM", ov), { theme: "filled_blue", size: "large", text: "continue_with", shape: "pill", width: 280 });
        } catch (e) { msg("No pude iniciar el login de Google.", true); }
      } else if (tries++ < 50) setTimeout(initGIS, 150);
      else msg("No se pudo cargar Google. Recarga la página.", true);
    })();
  };
})();
