// api/novedades.js — Novedades de la app: qué vio cada usuario + aviso por Telegram — v1.0
//   GET  (con sesión)                → novedades del usuario y cuáles no vio
//   POST (con sesión) {visto: id}    → marca como vistas hasta ese id
//   GET  ?estado=1 (admin)           → hasta qué novedad vio cada usuario
//   GET  ?secret=CRON_SECRET&telegram=1 → manda YA por Telegram las novedades pendientes
import { NOVEDADES, novedadesPara, ULTIMA_NOVEDAD, textoTelegram } from './_novedades.js';

const API = 'https://porta-al-sole-api.onrender.com/api';
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function kv(...cmd) {
  if (!KV_URL || !KV_TOKEN) throw new Error('Falta la base de datos (KV)');
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: JSON.stringify(cmd) });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

async function telegram(text, chatId) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`Telegram: ${d.description}`);
}

// Manda por Telegram las novedades que aún no se enviaron (la usa también daily.js)
export async function enviarNovedadesTelegram() {
  const enviada = Number(await kv('GET', 'novedades:telegram:ultima').catch(() => 0)) || 0;
  const nuevas = NOVEDADES.filter(n => n.id > enviada);
  if (!nuevas.length) return 'sin novedades nuevas';
  const destinos = [
    { chat: process.env.TELEGRAM_CHAT_ID, rol: 'supervisor', nombre: '' },
    { chat: process.env.TELEGRAM_CHAT_ID_RICARDO, rol: 'tecnico', nombre: 'Ricardo' },
  ].filter(d => d.chat);
  const hechos = [];
  for (const d of destinos) {
    const lista = nuevas.filter(n => n.para === 'todos' || n.para === d.rol);
    if (lista.length) { await telegram(textoTelegram(lista, d.nombre), d.chat); hechos.push(d.rol); }
  }
  await kv('SET', 'novedades:telegram:ultima', ULTIMA_NOVEDAD);
  return `enviadas a: ${hechos.join(', ') || 'nadie'}`;
}

export default async function handler(req, res) {
  const q = req.query || {};

  // Envío manual por Telegram (con la clave del cron)
  if (q.telegram) {
    if (!process.env.CRON_SECRET || q.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'No autorizado' });
    try { return res.status(200).json({ ok: true, resultado: await enviarNovedadesTelegram() }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // El resto necesita sesión de la app
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  let me;
  try {
    const r = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error();
    me = await r.json();
  } catch { return res.status(401).json({ error: 'Sesión inválida' }); }
  const esAdmin = me.username === 'admin';
  const rol = esAdmin ? 'supervisor' : 'tecnico';
  const clave = `novedades:vistas:${me.username}`;

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const id = Math.min(Number(body.visto) || 0, ULTIMA_NOVEDAD);
      await kv('SET', clave, id);
      await kv('HSET', 'novedades:usuarios', me.username, JSON.stringify({ nombre: me.displayName || me.username, visto: id, fecha: new Date().toISOString() }));
      return res.status(200).json({ ok: true });
    }
    if (q.estado) {
      if (!esAdmin) return res.status(403).json({ error: 'Solo el administrador' });
      const h = await kv('HGETALL', 'novedades:usuarios') || [];
      const usuarios = [];
      for (let i = 0; i < h.length; i += 2) usuarios.push({ usuario: h[i], ...JSON.parse(h[i + 1]) });
      return res.status(200).json({ ultima: ULTIMA_NOVEDAD, usuarios });
    }
    const visto = Number(await kv('GET', clave).catch(() => 0)) || 0;
    const mias = novedadesPara(rol);
    return res.status(200).json({ novedades: mias, noVistas: mias.filter(n => n.id > visto).map(n => n.id), ultima: ULTIMA_NOVEDAD });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
