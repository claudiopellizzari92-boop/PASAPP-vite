// api/daily.js — Agente autónomo de Porta al Sole: resumen diario + patrones por Telegram — v3.0
// v3.0: + preventivo de A/C cada 4 meses (modo prueba / creación), reporte mensual el día 1, consumo por noche ocupada
// v2.1: noches del consumo de agua = semana ANTERIOR a la lectura (igual que la pestaña Registros)
// v2.0: + check-ins con pendientes, consumo anormal de agua/luz y huecos sin reservas
// Lo ejecuta Vercel Cron cada mañana (ver "crons" en vercel.json).
// Variables de entorno en Vercel:
//   ANTHROPIC_API_KEY    (ya existe)
//   ANTHROPIC_MODEL      (ya existe, ej. claude-haiku-5-5)
//   AGENT_USERNAME       usuario de la app para el agente (ej. agente)
//   AGENT_PASSWORD       contraseña de ese usuario
//   TELEGRAM_BOT_TOKEN   token del bot (de @BotFather)
//   TELEGRAM_CHAT_ID     tu chat id de Telegram
//   CRON_SECRET          clave para que nadie más pueda ejecutarlo
//   PREVENTIVO_CREAR     "si" para que el agente CREE las tareas de A/C (sin ella, solo informa = modo prueba)
// Pruebas a mano:  /api/daily?secret=...            → resumen diario
//                  /api/daily?secret=...&mensual=1  → además, el reporte mensual del mes anterior

export const config = { maxDuration: 60 };

const API = 'https://porta-al-sole-api.onrender.com/api';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const TZ = 'America/Aruba';

const uname = id => ({100:'Recepción',101:'Áreas Comunes'})[id] ?? `PAS ${id}`;
const CAT_LABEL = {
  plomeria:'Plomería', electricidad:'Electricidad', pintura:'Pintura/Acabados', carpinteria:'Carpintería',
  limpieza:'Limpieza', electrodomesticos:'Electrodomésticos', hvac:'A/C y Ventilación', otro:'Otro',
};
const cat = c => CAT_LABEL[c] || c || 'Otro';
const UNIDADES_VENDIDAS = { 17: '2026-08-12' }; // igual que en App.jsx
const activaEn = (uid, fecha) => { const v = UNIDADES_VENDIDAS[uid]; return !v || fecha <= v; };
const ESPECIALES = { 100: true, 101: true }; // Recepción y Áreas Comunes no tienen huéspedes

/* ---------- FECHAS (hora de Aruba) ---------- */
const dayStr = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
const toDay = v => {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const d = new Date(v);
  return isNaN(d) ? null : dayStr(d);
};
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); };
const diffDays = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000);
const d10 = v => (v ? String(v).slice(0,10) : null);

// Rango [inicio, fin) de un período: "2026-W45" (semana ISO) o "2026-11" (mes)
function rangoPeriodo(p) {
  let m = /^(\d{4})-W(\d{2})$/.exec(p);
  if (m) {
    const y = +m[1], w = +m[2];
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const lunes = new Date(jan4); lunes.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7);
    const ini = lunes.toISOString().slice(0,10);
    return [ini, addDays(ini, 7)];
  }
  m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) return [`${m[1]}-${m[2]}-01`, new Date(Date.UTC(+m[1], +m[2], 1)).toISOString().slice(0,10)];
  return null;
}

/* ---------- HELPERS ---------- */
async function api(token, path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}), ...(opts.headers||{}) },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${path}: ${(data && data.error) || r.status}`);
  return data;
}

async function login() {
  // Render puede estar "dormido": reintenta hasta 3 veces
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const d = await api(null, '/auth/login', { method:'POST', body: JSON.stringify({ username: process.env.AGENT_USERNAME, password: process.env.AGENT_PASSWORD }) });
      return d.token;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 8000)); }
  }
  throw new Error(`No pude iniciar sesión: ${last?.message}`);
}

// Telegram acepta máx. 4096 caracteres por mensaje: si es más largo, se divide en varios (sin cortar líneas)
function partir(text, max = 3800) {
  const partes = []; let actual = '';
  for (const linea of text.split('\n')) {
    if ((actual + '\n' + linea).length > max && actual) { partes.push(actual); actual = ''; }
    actual = actual ? `${actual}\n${linea}` : linea;
    while (actual.length > max) { partes.push(actual.slice(0, max)); actual = actual.slice(max); }
  }
  if (actual.trim()) partes.push(actual);
  return partes;
}

async function telegram(text) {
  for (const parte of partir(text)) {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: parte, disable_web_page_preview: true }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Telegram: ${d.description}`);
  }
}

const fechaCompletada = t => {
  const h = Array.isArray(t.history) ? t.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const a = `${h[i]?.action || h[i]?.note || ''}`.toLowerCase();
    if (a.includes('completad')) return toDay(h[i].date);
  }
  return null;
};

const linea = t => ({
  id: t.id, unidad: uname(t.unitId), nivel: t.level, categoria: cat(t.category), titulo: t.title,
  prioridad: t.priority, estado: t.status, asignado: t.assignee || null, vence: toDay(t.dueDate), creada: toDay(t.createdAt),
});

/* ---------- ANÁLISIS ---------- */
function analizar(tasks, hoy) {
  const ayer = addDays(hoy, -1);
  const hace90 = addDays(hoy, -90);
  const hace30 = addDays(hoy, -30);
  const abiertas = tasks.filter(t => t.status !== 'completado');

  const vencidas    = abiertas.filter(t => toDay(t.dueDate) && toDay(t.dueDate) < hoy);
  const vencenHoy   = abiertas.filter(t => toDay(t.dueDate) === hoy);
  const urgentes    = abiertas.filter(t => t.priority === 'urgente');
  const sinAsignar  = abiertas.filter(t => !String(t.assignee || '').trim());
  const estancadas  = abiertas.filter(t => toDay(t.createdAt) && diffDays(hoy, toDay(t.createdAt)) > 14);
  const creadasAyer = tasks.filter(t => toDay(t.createdAt) === ayer);
  const complAyer   = tasks.filter(t => t.status === 'completado' && fechaCompletada(t) === ayer);

  // Patrones (últimos 90 días, solo reparaciones)
  const recientes = tasks.filter(t => toDay(t.createdAt) && toDay(t.createdAt) >= hace90 && t.type !== 'preventivo');
  const porUnidadCat = {}, porUnidad = {}, porCat30 = {}, porCatPrev = {};
  for (const t of recientes) {
    const k = `${t.unitId}|${t.category}`;
    (porUnidadCat[k] ||= []).push(t);
    (porUnidad[t.unitId] ||= []).push(t);
    const d = toDay(t.createdAt);
    if (d >= hace30) porCat30[t.category] = (porCat30[t.category] || 0) + 1;
    else porCatPrev[t.category] = (porCatPrev[t.category] || 0) + 1;
  }
  const fallasRepetidas = Object.entries(porUnidadCat)
    .filter(([, l]) => l.length >= 3)
    .map(([k, l]) => ({ unidad: uname(+k.split('|')[0]), categoria: cat(k.split('|')[1]), cantidad: l.length,
      tareas: l.map(t => `${toDay(t.createdAt)}: ${t.title}`) }))
    .sort((a, b) => b.cantidad - a.cantidad).slice(0, 6);
  const unidadesCargadas = Object.entries(porUnidad)
    .filter(([, l]) => l.length >= 5)
    .map(([u, l]) => ({ unidad: uname(+u), tareas90d: l.length }))
    .sort((a, b) => b.tareas90d - a.tareas90d).slice(0, 5);
  // Categoría que se disparó: últimos 30 días vs promedio mensual de los 60 anteriores
  const categoriasEnAumento = Object.entries(porCat30)
    .map(([c, n]) => ({ categoria: cat(c), ultimos30d: n, promedioMensualAnterior: +((porCatPrev[c] || 0) / 2).toFixed(1) }))
    .filter(x => x.ultimos30d >= 3 && x.ultimos30d >= 2 * Math.max(x.promedioMensualAnterior, 1))
    .slice(0, 4);

  const top = (l, n = 12) => l.slice(0, n).map(linea);
  return {
    fecha: hoy,
    totales: { abiertas: abiertas.length, vencidas: vencidas.length, vencenHoy: vencenHoy.length, urgentes: urgentes.length,
      sinAsignar: sinAsignar.length, estancadas: estancadas.length, creadasAyer: creadasAyer.length, completadasAyer: complAyer.length },
    vencidas: top(vencidas.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))),
    vencenHoy: top(vencenHoy),
    urgentes: top(urgentes),
    sinAsignar: top(sinAsignar),
    estancadas: top(estancadas.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))), 8),
    completadasAyer: top(complAyer),
    creadasAyer: top(creadasAyer),
    patrones: { fallasRepetidas, unidadesCargadas, categoriasEnAumento },
  };
}

/* ---------- RESERVAS Y CONSUMOS ---------- */
function normReservas(data) {
  return (Array.isArray(data) ? data : []).map(r => ({
    unitId: Number(r.unit_id ?? r.unitId),
    huesped: (r.is_owner === true || r.isOwner === true) ? '(propietario)' : (r.guest || ''),
    checkIn: d10(r.check_in ?? r.checkIn),
    checkOut: d10(r.check_out ?? r.checkOut),
  })).filter(r => r.unitId && r.checkIn && r.checkOut && r.checkOut > r.checkIn && activaEn(r.unitId, r.checkIn));
}
const ocupada = (rs, uid, d) => rs.some(r => r.unitId === uid && r.checkIn <= d && d < r.checkOut);

function analizarReservas(tasks, rs, hoy) {
  const abiertas = tasks.filter(t => t.status !== 'completado');
  const abiertasDe = uid => abiertas.filter(t => t.unitId === uid);
  const lim = addDays(hoy, 2);

  // Check-ins de hoy a pasado mañana en unidades con tareas abiertas
  const checkinsConPendientes = rs
    .filter(r => r.checkIn >= hoy && r.checkIn <= lim && abiertasDe(r.unitId).length)
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn))
    .map(r => ({
      unidad: uname(r.unitId), checkIn: r.checkIn,
      cuando: r.checkIn === hoy ? 'hoy' : r.checkIn === addDays(hoy, 1) ? 'mañana' : 'pasado mañana',
      pendientes: abiertasDe(r.unitId).map(t => `${cat(t.category)} — ${t.title} (#${t.id}, ${t.priority})`),
    }));

  // Huésped alojado ahora en una unidad con tarea urgente abierta
  const alojadosConUrgente = rs
    .filter(r => r.checkIn < hoy && hoy < r.checkOut)
    .map(r => ({ r, urg: abiertasDe(r.unitId).filter(t => t.priority === 'urgente') }))
    .filter(x => x.urg.length)
    .map(x => ({ unidad: uname(x.r.unitId), checkOut: x.r.checkOut, urgentes: x.urg.map(t => `${t.title} (#${t.id})`) }));

  // Huecos de 2+ noches libres en los próximos 14 días, solo en unidades con tareas pendientes
  const huecos = [];
  const unidadesConPend = [...new Set(abiertas.map(t => t.unitId))].filter(u => !ESPECIALES[u] && activaEn(u, hoy));
  for (const uid of unidadesConPend) {
    let ini = null;
    for (let i = 0; i <= 14; i++) {
      const d = addDays(hoy, i);
      const libre = i < 14 && !ocupada(rs, uid, d);
      if (libre && ini === null) ini = d;
      if (!libre && ini !== null) {
        const noches = diffDays(d, ini);
        if (noches >= 2) {
          huecos.push(i === 14
            ? { unidad: uname(uid), libreDesde: ini, sinReservasHasta: 'al menos 2 semanas', pendientes: abiertasDe(uid).length }
            : { unidad: uname(uid), libreDesde: ini, hasta: d, noches, pendientes: abiertasDe(uid).length });
          break;
        }
        ini = null;
      }
    }
  }
  return { checkinsConPendientes, alojadosConUrgente, huecos: huecos.slice(0, 6) };
}

// Noches que corresponden a un período de consumo.
// Agua semanal: la lectura de la semana W mide la semana ANTERIOR (igual que nightsForReading en App.jsx).
function rangoNoches(periodo) {
  const r = rangoPeriodo(periodo);
  if (!r) return null;
  return /W/.test(periodo) ? [addDays(r[0], -7), r[0]] : r;
}
function contarNoches(rs, uid, periodo, hoy) {
  if (ESPECIALES[uid]) return null;
  const r = rangoNoches(periodo); if (!r) return null;
  let n = 0; for (let d = r[0]; d < r[1] && d <= hoy; d = addDays(d, 1)) if (ocupada(rs, uid, d)) n++;
  return n;
}

function analizarConsumos(meds, rs, hoy) {
  const lista = (Array.isArray(meds) ? meds : []).map(m => ({
    unitId: Number(m.unitId ?? m.unit_id), tipo: m.type, periodo: m.week, valor: Number(m.value),
  })).filter(m => m.unitId && m.periodo && !isNaN(m.valor) && activaEn(m.unitId, hoy));
  const grupos = {};
  for (const m of lista) (grupos[`${m.unitId}|${m.tipo}`] ||= []).push(m);

  const alertas = [];
  for (const [k, arr] of Object.entries(grupos)) {
    const uid = Number(k.split('|')[0]), tipo = k.split('|')[1];
    arr.sort((a, b) => a.periodo.localeCompare(b.periodo));
    const consumos = [];
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      let c;
      if (/^\d{4}-\d{2}$/.test(m.periodo)) c = m.valor;                                   // luz mensual: el valor ES el consumo
      else if (i > 0 && /W/.test(arr[i-1].periodo)) c = +(m.valor - arr[i-1].valor).toFixed(2); // lectura acumulada
      else continue;
      if (c >= 0) consumos.push({ periodo: m.periodo, c, n: contarNoches(rs, uid, m.periodo, hoy) });
    }
    if (consumos.length < 2) continue;
    const ult = consumos[consumos.length - 1];
    const rango = rangoPeriodo(ult.periodo);
    // Solo la lectura reciente (período que terminó hace menos de 10 días o en curso)
    if (!rango || diffDays(hoy, rango[1]) > 10) continue;
    const prev = consumos.slice(0, -1).slice(-12);
    const um = tipo === 'agua' ? 'm³' : 'kWh';
    const MIN_ABS = tipo === 'agua' ? 3 : 60, MIN_VACIO = tipo === 'agua' ? 2 : 30;
    // Promedio por noche ocupada (necesita al menos 3 períodos con huéspedes), igual que Registros
    const conNoches = prev.filter(x => x.n > 0);
    const promNoche = conNoches.length >= 3 ? conNoches.reduce((s, x) => s + x.c / x.n, 0) / conNoches.length : null;
    const promTotal = prev.reduce((s, x) => s + x.c, 0) / prev.length;
    const fmt = v => tipo === 'agua' ? `${Math.round(v * 1000)} L` : `${v.toFixed(1)} kWh`;
    const motivos = [];
    if (ult.n === 0 && ult.c >= MIN_VACIO) {
      motivos.push('consumo con la unidad vacía');
    } else if (ult.c >= MIN_ABS) {
      if (promNoche != null && ult.n > 0 && ult.c / ult.n > 2 * promNoche)
        motivos.push(`${fmt(ult.c / ult.n)}/noche, más del doble de lo normal (${fmt(promNoche)}/noche)`);
      else if (promNoche == null && ult.c > 2 * promTotal)
        motivos.push(`más del doble de su promedio (${promTotal.toFixed(1)} ${um}), sin historial suficiente por noche`);
    }
    if (motivos.length) alertas.push({ unidad: uname(uid), tipo, periodo: ult.periodo, consumo: `${ult.c} ${um}`, nochesOcupadas: ult.n, motivo: motivos.join('; ') });
  }
  return alertas.slice(0, 6);
}

/* ---------- PREVENTIVO DE A/C (cada 4 meses desde el último en esa unidad) ---------- */
const UNIDADES_AC = [1,2,3,4,8,10,11,12,13,14,15,16,17,18,19,20,100]; // casas + Recepción (Áreas Comunes no tiene A/C)
const MESES_AC = 4;
const addMonths = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0,10); };
const sinAcentos = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ¿Es una tarea de mantenimiento de A/C? (por categoría o texto + que sea preventivo/limpieza/servicio)
function esMantAC(t) {
  const txt = sinAcentos(`${t.title} ${t.description || ''}`);
  const catTxt = sinAcentos(t.category);
  const deAC = /hvac|aire|a\/c/.test(catTxt) || /\ba\/?c\b|aire|aires|split|minisplit|filtro/.test(txt);
  const esMant = t.type === 'preventivo' || /manten|limpi|filtro|servicio|preventiv|lavado/.test(txt);
  return deAC && esMant;
}

function analizarPreventivo(tasks, hoy) {
  const lista = [];
  for (const uid of UNIDADES_AC) {
    if (!activaEn(uid, hoy)) continue;
    const delUnidad = tasks.filter(t => Number(t.unitId) === uid && esMantAC(t));
    const abierta = delUnidad.find(t => t.status !== 'completado');
    const hechas = delUnidad.filter(t => t.status === 'completado')
      .map(t => ({ t, fecha: fechaCompletada(t) || toDay(t.dueDate) || toDay(t.createdAt) }))
      .filter(x => x.fecha).sort((a, b) => b.fecha.localeCompare(a.fecha));
    const ultimo = hechas[0];
    if (!ultimo) { lista.push({ uid, unidad: uname(uid), estado: 'sin registro', abierta: abierta ? `#${abierta.id}` : null }); continue; }
    const proximo = addMonths(ultimo.fecha, MESES_AC);
    const dias = diffDays(proximo, hoy);
    lista.push({
      uid, unidad: uname(uid), ultimo: ultimo.fecha, ultimaTarea: `#${ultimo.t.id} ${ultimo.t.title}`, proximo, diasParaVencer: dias,
      abierta: abierta ? `#${abierta.id}` : null,
      estado: abierta ? 'ya programada' : dias <= 7 ? 'toca crear' : 'al día',
    });
  }
  return lista;
}

async function ejecutarPreventivo(token, lista, hoy) {
  const crear = String(process.env.PREVENTIVO_CREAR || '').toLowerCase() === 'si';
  const porCrear = lista.filter(x => x.estado === 'toca crear');
  const creadas = [];
  if (crear) {
    for (const x of porCrear) {
      const payload = {
        unitId: x.uid, level: 'N1', category: 'hvac', type: 'preventivo', priority: 'programado', status: 'pendiente',
        title: 'Mantenimiento A/C (preventivo)',
        description: `Creada automáticamente por el agente. Revisar y limpiar los A/C de todos los niveles. Último mantenimiento: ${x.ultimo} (${x.ultimaTarea}).`,
        assignee: 'Ricardo',
        dueDate: x.proximo < hoy ? hoy : x.proximo,
      };
      try { const t = await api(token, '/tasks', { method:'POST', body: JSON.stringify(payload) }); creadas.push(`${x.unidad} (#${t?.id ?? '?'}, para el ${payload.dueDate})`); }
      catch (e) { creadas.push(`${x.unidad}: ERROR al crear (${e.message})`); }
    }
  }
  return {
    modo: crear ? 'creación activa' : 'MODO PRUEBA (no se creó nada; para activar: variable PREVENTIVO_CREAR=si)',
    creadas,
    seCrearian: crear ? [] : porCrear.map(x => `${x.unidad}: último ${x.ultimo}, tocaba el ${x.proximo}`),
    sinRegistro: lista.filter(x => x.estado === 'sin registro' && !x.abierta).map(x => x.unidad),
    proximos30dias: lista.filter(x => x.estado === 'al día' && x.diasParaVencer <= 30).map(x => `${x.unidad}: ${x.proximo}`),
  };
}

/* ---------- REPORTE MENSUAL ---------- */
function datosMes(tasks, ini, fin) {
  const creadas = tasks.filter(t => { const d = toDay(t.createdAt); return d && d >= ini && d < fin; });
  const resueltas = tasks.map(t => ({ t, f: t.status === 'completado' ? fechaCompletada(t) : null }))
    .filter(x => x.f && x.f >= ini && x.f < fin);
  const tiempos = resueltas.map(x => diffDays(x.f, toDay(x.t.createdAt) || x.f)).filter(n => n >= 0);
  const cuenta = (arr, key) => { const o = {}; for (const v of arr) o[key(v)] = (o[key(v)] || 0) + 1; return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}: ${n}`); };
  return {
    creadas: creadas.length,
    resueltas: resueltas.length,
    diasPromedioResolucion: tiempos.length ? +(tiempos.reduce((a, b) => a + b, 0) / tiempos.length).toFixed(1) : null,
    resueltasTarde: resueltas.filter(x => toDay(x.t.dueDate) && x.f > toDay(x.t.dueDate)).length,
    urgentesCreadas: creadas.filter(t => t.priority === 'urgente').length,
    unidadesConMasTareas: cuenta(creadas, t => uname(t.unitId)),
    categorias: cuenta(creadas, t => cat(t.category)),
    tardaronMas: resueltas.map(x => ({ x, d: diffDays(x.f, toDay(x.t.createdAt) || x.f) })).sort((a, b) => b.d - a.d).slice(0, 3)
      .map(({ x, d }) => `${uname(x.t.unitId)} — ${x.t.title} (#${x.t.id}): ${d} días`),
  };
}

function analizarMes(tasks, hoy) {
  const [y, m] = hoy.split('-').map(Number);
  const iniMes = `${y}-${String(m).padStart(2,'0')}-01`;
  const iniAnt = addMonths(iniMes, -1), iniPrev = addMonths(iniMes, -2);
  const nombre = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('es', { month:'long', year:'numeric', timeZone:'UTC' });
  return {
    mes: nombre(iniAnt),
    actual: datosMes(tasks, iniAnt, iniMes),
    mesAnterior: { mes: nombre(iniPrev), ...datosMes(tasks, iniPrev, iniAnt) },
    abiertasAlCierre: tasks.filter(t => t.status !== 'completado' && toDay(t.createdAt) && toDay(t.createdAt) < iniMes).length,
  };
}

async function redactarMensual(datos) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: `Eres el agente de mantenimiento de "Porta al Sole" (townhouses de alquiler vacacional en Aruba). Ricardo es el único encargado de mantenimiento; Claudio, el administrador, supervisa.
Escribe el REPORTE MENSUAL para Claudio, que lo leerá en Telegram. Texto plano (sin markdown ni asteriscos), emojis como viñetas, en español, máximo 1800 caracteres.
Estructura:
📊 Reporte de <mes>: una línea de balance general.
🔧 Trabajo de Ricardo: tareas resueltas, tiempo promedio de resolución, cuántas se resolvieron tarde, comparación con el mes anterior (mejoró/empeoró).
📥 Lo que entró: tareas creadas, urgentes, unidades y categorías con más tareas.
🐢 Las que más tardaron (si hay).
💡 Conclusión: 2-3 recomendaciones concretas para el próximo mes.
Usa solo los datos dados; si un dato es null o 0, no lo inventes.`,
      messages: [{ role: 'user', content: `Datos:\n${JSON.stringify(datos)}` }],
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Anthropic ${r.status}`);
  const texto = d.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return d.stop_reason === 'max_tokens' ? `${texto}…\n\n(reporte recortado)` : texto;
}

/* ---------- REDACCIÓN CON CLAUDE ---------- */
async function redactar(datos) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: `Eres el agente de mantenimiento de "Porta al Sole" (16 townhouses de alquiler vacacional en Aruba, clima salino y caluroso).
Cada mañana escribes un resumen para Claudio, el administrador, que lo leerá en Telegram desde el celular.
Formato: texto plano (sin markdown, sin asteriscos), con emojis como viñetas. En español. Sé BREVE: máximo 2500 caracteres en total; frases cortas, sin repetir datos.
Estructura:
☀️ Buenos días + una línea con el estado general.
🔴 Atención hoy: vencidas, vencen hoy y urgentes (formato "PAS 12 · Plomería — Fuga lavamanos (#45)"). Si no hay, dilo.
👤 Sin asignar (si hay).
⏳ Estancadas (si hay).
🏠 Check-ins con pendientes: unidades que reciben huésped hoy/mañana/pasado y tienen tareas abiertas (di qué hay que resolver antes). Incluye huéspedes alojados en unidades con tareas urgentes.
💧 Consumo anormal: alertas de agua o luz (unidad, consumo, noches ocupadas, motivo) y la causa probable (fuga, inodoro que corre, A/C encendido sin huéspedes). Recomienda que Ricardo lo revise.
❄️ Preventivo A/C: según "preventivo": si hay tareas creadas, lístalas; si está en MODO PRUEBA, di claramente "Modo prueba" y lista las que se crearían; menciona las casas sin registro (en una línea) y las que tocan en los próximos 30 días (en una línea). Si todo está vacío, omite la sección.
📅 Huecos para trabajar: unidades con tareas pendientes y noches libres próximas; sugiere usar ese hueco.
✅ Ayer: completadas y creadas (cantidades + lo más relevante).
🔍 Patrones (máximo 3, los más importantes, 2-3 líneas cada uno): interpreta las fallas repetidas, unidades cargadas y categorías en aumento. Explica la causa probable (salitre, sarro, uso del A/C, equipo viejo...) y recomienda una acción concreta (cambiar equipo, mantenimiento preventivo, revisar instalación). Si no hay patrones, omite la sección.
🎯 Prioridades: termina con las 3 acciones más importantes del día (lo que afecta a huéspedes que llegan va primero).
Usa solo los datos dados; no inventes tareas. Si una sección está vacía, omítela en vez de escribir "ninguna".`,
      messages: [{ role: 'user', content: `Datos de hoy:\n${JSON.stringify(datos)}` }],
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Anthropic ${r.status}`);
  const texto = d.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  // Si se quedó sin espacio, avisar en vez de cortar en silencio
  return d.stop_reason === 'max_tokens' ? `${texto}…\n\n(resumen recortado)` : texto;
}

/* ---------- HANDLER ---------- */
export default async function handler(req, res) {
  // Seguridad: Vercel Cron envía "Authorization: Bearer CRON_SECRET". Para probar a mano: /api/daily?secret=...
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const q = (req.query && req.query.secret) || '';
  if (!secret || (auth !== `Bearer ${secret}` && q !== secret)) return res.status(401).json({ error: 'No autorizado' });

  const faltan = ['ANTHROPIC_API_KEY','AGENT_USERNAME','AGENT_PASSWORD','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].filter(k => !process.env[k]);
  if (faltan.length) return res.status(500).json({ error: `Faltan variables: ${faltan.join(', ')}` });

  try {
    const token = await login();
    const [tasksRaw, resRaw, medsRaw] = await Promise.all([
      api(token, '/tasks'),
      api(token, '/reservations').catch(() => []),
      api(token, '/measurements').catch(() => []),
    ]);
    const tasks = Array.isArray(tasksRaw) ? tasksRaw : [];
    const hoy = dayStr(new Date());
    const rs = normReservas(resRaw);
    const listaAC = analizarPreventivo(tasks, hoy);
    const preventivo = await ejecutarPreventivo(token, listaAC, hoy);
    const datos = { ...analizar(tasks, hoy), ...analizarReservas(tasks, rs, hoy), consumoAnormal: analizarConsumos(medsRaw, rs, hoy), preventivo };
    const texto = await redactar(datos);
    await telegram(texto);

    // Reporte mensual: el día 1 de cada mes (o a mano con &mensual=1)
    let mensual = false;
    if (hoy.endsWith('-01') || (req.query && req.query.mensual)) {
      await telegram(await redactarMensual(analizarMes(tasks, hoy)));
      mensual = true;
    }
    // En la respuesta del navegador se ve qué detectó del A/C por unidad (para verificar)
    return res.status(200).json({ ok: true, enviado: texto.length, mensual, totales: datos.totales, preventivoAC: listaAC.map(({ uid, ...x }) => x), preventivo });
  } catch (e) {
    console.error('daily error', e);
    try { await telegram(`⚠️ El agente de Porta al Sole no pudo generar el resumen de hoy: ${e.message}`); } catch {}
    return res.status(500).json({ error: e.message });
  }
}
