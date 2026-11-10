// api/daily.js — Agente autónomo de Porta al Sole: resumen diario + patrones por Telegram — v1.0
// Lo ejecuta Vercel Cron cada mañana (ver "crons" en vercel.json).
// Variables de entorno en Vercel:
//   ANTHROPIC_API_KEY    (ya existe)
//   ANTHROPIC_MODEL      (ya existe, ej. claude-haiku-5-5)
//   AGENT_USERNAME       usuario de la app para el agente (ej. agente)
//   AGENT_PASSWORD       contraseña de ese usuario
//   TELEGRAM_BOT_TOKEN   token del bot (de @BotFather)
//   TELEGRAM_CHAT_ID     tu chat id de Telegram
//   CRON_SECRET          clave para que nadie más pueda ejecutarlo

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

async function telegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`Telegram: ${d.description}`);
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

/* ---------- REDACCIÓN CON CLAUDE ---------- */
async function redactar(datos) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: `Eres el agente de mantenimiento de "Porta al Sole" (16 townhouses de alquiler vacacional en Aruba, clima salino y caluroso).
Cada mañana escribes un resumen para Claudio, el administrador, que lo leerá en Telegram desde el celular.
Formato: texto plano (sin markdown, sin asteriscos), con emojis como viñetas, máximo ~2500 caracteres. En español.
Estructura:
☀️ Buenos días + una línea con el estado general.
🔴 Atención hoy: vencidas, vencen hoy y urgentes (formato "PAS 12 · Plomería — Fuga lavamanos (#45)"). Si no hay, dilo.
👤 Sin asignar (si hay).
⏳ Estancadas (si hay).
✅ Ayer: completadas y creadas (cantidades + lo más relevante).
🔍 Patrones: interpreta las fallas repetidas, unidades cargadas y categorías en aumento. Explica la causa probable (salitre, sarro, uso del A/C, equipo viejo...) y recomienda una acción concreta (cambiar equipo, mantenimiento preventivo, revisar instalación). Si no hay patrones, omite la sección.
🎯 Prioridades: termina con las 3 acciones más importantes del día.
Usa solo los datos dados; no inventes tareas.`,
      messages: [{ role: 'user', content: `Datos de hoy:\n${JSON.stringify(datos)}` }],
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Anthropic ${r.status}`);
  return d.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
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
    const tasks = await api(token, '/tasks');
    const hoy = dayStr(new Date());
    const datos = analizar(Array.isArray(tasks) ? tasks : [], hoy);
    const texto = await redactar(datos);
    await telegram(texto);
    return res.status(200).json({ ok: true, enviado: texto.length, totales: datos.totales });
  } catch (e) {
    console.error('daily error', e);
    try { await telegram(`⚠️ El agente de Porta al Sole no pudo generar el resumen de hoy: ${e.message}`); } catch {}
    return res.status(500).json({ error: e.message });
  }
}
