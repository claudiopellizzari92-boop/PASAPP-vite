// api/agent.js — Agente IA de Porta al Sole (Vercel Serverless Function) — v1.1
// Variables de entorno en Vercel:
//   ANTHROPIC_API_KEY  (obligatoria)
//   ANTHROPIC_MODEL    (opcional, por defecto claude-sonnet-5-5)

export const config = { maxDuration: 60 };

const API = 'https://porta-al-sole-api.onrender.com/api';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const MAX_STEPS = 8;

const UNIT_IDS = [1,2,3,4,8,10,11,12,13,14,15,16,17,18,19,20,100,101];
const CATS = ['plomeria','electricidad','pintura','carpinteria','limpieza','electrodomesticos','hvac','otro'];
const PRIOS = ['urgente','normal','programado'];
const TYPES = ['reparacion','preventivo'];
const STATS = ['pendiente','en_proceso','completado'];
const LEVELS = ['N1','N2','N3'];

const uname = id => ({100:'Recepción',101:'Áreas Comunes'})[id] ?? `PAS ${id}`;

/* ---------- PROMPT ---------- */
function systemPrompt(user) {
  const hoy = new Date().toLocaleDateString('es', { timeZone:'America/Aruba', weekday:'long', year:'numeric', month:'long', day:'numeric' });
  return `Eres el asistente de mantenimiento de "Porta al Sole", un complejo de 16 townhouses de alquiler vacacional en Aruba.
Hoy es ${hoy}. Hablas con ${user}. Responde siempre en español, breve y claro (es una app móvil).

DATOS DEL COMPLEJO
- Unidades: PAS 1, 2, 3, 4, 8, 10–20 (no hay 5, 6, 7 ni 9). Además: 100 = Recepción, 101 = Áreas Comunes.
- Cada unidad tiene 3 niveles: N1, N2, N3.
- Categorías: plomeria, electricidad, pintura, carpinteria, limpieza, electrodomesticos, hvac (A/C y ventilación), otro.
- Prioridad: urgente, normal, programado. Tipo: reparacion, preventivo. Estado: pendiente, en_proceso, completado.
- Clima: tropical, salino, mucho sol y viento. Considera corrosión por salitre, sarro por agua desalinizada y uso intensivo de A/C al diagnosticar.

REGLAS
1. Para consultar, usa las herramientas; nunca inventes tareas ni datos.
2. ANTES de crear o modificar una tarea, muestra un resumen de lo que vas a guardar (unidad, nivel, categoría, título, prioridad, etc.) y pregunta "¿Confirmo?". Solo ejecuta crear_tarea / actualizar_tarea / agregar_nota cuando el usuario confirme explícitamente (sí, dale, ok, confirmo...).
3. Si falta un dato obligatorio (unidad o título), pregúntalo. Deduce lo demás con sentido común (p. ej. "fuga" → plomeria; "no enfría" → hvac) e indícalo en el resumen.
4. No puedes borrar tareas: si lo piden, indica que se hace desde la app.
5. En diagnósticos y consejos: da causas probables ordenadas, pasos de revisión, materiales y cuándo llamar a un técnico. Advierte de riesgos eléctricos o de gas. Ofrece crear la tarea correspondiente.
6. Al listar tareas, usa formato compacto: "PAS 12 · N2 · Plomería — Fuga lavamanos (urgente, pendiente)". Menciona el número de tarea (#id).`;
}

/* ---------- HERRAMIENTAS ---------- */
const tools = [
  {
    name: 'listar_tareas',
    description: 'Lista tareas de mantenimiento con filtros opcionales. Devuelve un resumen sin fotos ni historial completo.',
    input_schema: {
      type: 'object',
      properties: {
        unidad:    { type:'integer', enum: UNIT_IDS, description:'ID de la unidad' },
        nivel:     { type:'string', enum: LEVELS },
        estado:    { type:'string', enum: [...STATS, 'abiertas'], description:'"abiertas" = pendiente + en_proceso' },
        prioridad: { type:'string', enum: PRIOS },
        categoria: { type:'string', enum: CATS },
        tipo:      { type:'string', enum: TYPES },
        asignado:  { type:'string', description:'Texto a buscar en el responsable' },
        texto:     { type:'string', description:'Texto a buscar en título o descripción' },
        desde:     { type:'string', description:'Fecha de creación mínima YYYY-MM-DD' },
        hasta:     { type:'string', description:'Fecha de creación máxima YYYY-MM-DD' },
        limite:    { type:'integer', description:'Máximo de resultados (por defecto 50)' },
      },
    },
  },
  {
    name: 'ver_tarea',
    description: 'Muestra el detalle completo de una tarea, incluyendo su historial de notas.',
    input_schema: { type:'object', properties: { id: { type:'integer' } }, required:['id'] },
  },
  {
    name: 'crear_tarea',
    description: 'Crea una tarea nueva. Usar SOLO después de que el usuario confirme el resumen.',
    input_schema: {
      type: 'object',
      properties: {
        unitId:      { type:'integer', enum: UNIT_IDS },
        level:       { type:'string', enum: LEVELS },
        category:    { type:'string', enum: CATS },
        title:       { type:'string' },
        description: { type:'string' },
        priority:    { type:'string', enum: PRIOS },
        type:        { type:'string', enum: TYPES },
        status:      { type:'string', enum: STATS },
        assignee:    { type:'string' },
        dueDate:     { type:'string', description:'YYYY-MM-DD' },
      },
      required: ['unitId','title'],
    },
  },
  {
    name: 'actualizar_tarea',
    description: 'Modifica campos de una tarea existente (estado, prioridad, responsable, fecha, etc.). Usar SOLO después de confirmación.',
    input_schema: {
      type: 'object',
      properties: {
        id:          { type:'integer' },
        status:      { type:'string', enum: STATS },
        priority:    { type:'string', enum: PRIOS },
        assignee:    { type:'string' },
        dueDate:     { type:'string', description:'YYYY-MM-DD' },
        title:       { type:'string' },
        description: { type:'string' },
        category:    { type:'string', enum: CATS },
        level:       { type:'string', enum: LEVELS },
        type:        { type:'string', enum: TYPES },
      },
      required: ['id'],
    },
  },
  {
    name: 'agregar_nota',
    description: 'Agrega una nota al historial de una tarea. Usar SOLO después de confirmación.',
    input_schema: {
      type: 'object',
      properties: { id: { type:'integer' }, nota: { type:'string' } },
      required: ['id','nota'],
    },
  },
];

/* ---------- HELPERS ---------- */
async function api(token, path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}`, ...(opts.headers||{}) },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
  return data;
}

const d10 = v => (v ? String(v).slice(0,10) : null);

function resumen(t) {
  return {
    id: t.id, unidad: uname(t.unitId), unitId: t.unitId, nivel: t.level, categoria: t.category,
    titulo: t.title, prioridad: t.priority, tipo: t.type, estado: t.status,
    asignado: t.assignee || null, vence: d10(t.dueDate), creada: d10(t.createdAt),
  };
}

function limpiarHistorial(h) {
  if (!Array.isArray(h)) return [];
  return h.slice(-20).map(e => {
    const o = {};
    for (const [k, v] of Object.entries(e || {})) {
      if (typeof v === 'string' && (v.startsWith('data:') || v.length > 1500)) continue; // quitar fotos base64
      o[k] = v;
    }
    return o;
  });
}

async function runTool(name, input, ctx) {
  const { token, user } = ctx;
  switch (name) {
    case 'listar_tareas': {
      let list = await api(token, '/tasks');
      const f = input || {};
      if (f.unidad)    list = list.filter(t => t.unitId === f.unidad);
      if (f.nivel)     list = list.filter(t => t.level === f.nivel);
      if (f.estado === 'abiertas') list = list.filter(t => t.status !== 'completado');
      else if (f.estado) list = list.filter(t => t.status === f.estado);
      if (f.prioridad) list = list.filter(t => t.priority === f.prioridad);
      if (f.categoria) list = list.filter(t => t.category === f.categoria);
      if (f.tipo)      list = list.filter(t => t.type === f.tipo);
      if (f.asignado)  list = list.filter(t => (t.assignee||'').toLowerCase().includes(f.asignado.toLowerCase()));
      if (f.texto) {
        const q = f.texto.toLowerCase();
        list = list.filter(t => `${t.title} ${t.description||''}`.toLowerCase().includes(q));
      }
      if (f.desde) list = list.filter(t => d10(t.createdAt) >= f.desde);
      if (f.hasta) list = list.filter(t => d10(t.createdAt) <= f.hasta);
      const total = list.length;
      list.sort((a,b) => String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
      return { total, mostrando: Math.min(total, f.limite || 50), tareas: list.slice(0, f.limite || 50).map(resumen) };
    }
    case 'ver_tarea': {
      const list = await api(token, '/tasks');
      const t = list.find(x => x.id === input.id);
      if (!t) return { error: `No existe la tarea #${input.id}` };
      return { ...resumen(t), descripcion: t.description || '', historial: limpiarHistorial(t.history) };
    }
    case 'crear_tarea': {
      const payload = {
        unitId: Number(input.unitId),
        level: input.level || 'N1',
        category: input.category || 'otro',
        title: String(input.title).trim(),
        description: input.description || '',
        priority: input.priority || 'normal',
        type: input.type || 'reparacion',
        status: input.status || 'pendiente',
        assignee: input.assignee || '',
        dueDate: input.dueDate || new Date().toISOString().split('T')[0],
      };
      const t = await api(token, '/tasks', { method:'POST', body: JSON.stringify(payload) });
      return { ok: true, tarea: resumen(t && t.id ? t : payload) };
    }
    case 'actualizar_tarea': {
      const { id, ...rest } = input;
      const updates = Object.fromEntries(Object.entries(rest).filter(([,v]) => v !== undefined && v !== null));
      if (!Object.keys(updates).length) return { error: 'No hay cambios' };
      const t = await api(token, `/tasks/${id}`, { method:'PATCH', body: JSON.stringify(updates) });
      return { ok: true, tarea: t && t.id ? resumen(t) : { id, ...updates } };
    }
    case 'agregar_nota': {
      await api(token, `/tasks/${input.id}/notes`, { method:'POST', body: JSON.stringify({ note: `🤖 ${input.nota}`, user, photo: null }) });
      return { ok: true };
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

/* ---------- HANDLER ---------- */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY en Vercel' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  // Validar el token contra el backend y obtener el usuario
  let me;
  try { me = await api(token, '/auth/me'); }
  catch { return res.status(401).json({ error: 'Sesión inválida' }); }
  const user = me.displayName || me.username || 'usuario';

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  // Solo texto del usuario/asistente; últimos 20 mensajes
  let messages = incoming
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return res.status(400).json({ error: 'Mensaje vacío' });

  const ctx = { token, user };
  let changed = false;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt(user), tools, messages }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);

      messages.push({ role: 'assistant', content: data.content });

      if (data.stop_reason !== 'tool_use') {
        const reply = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        return res.status(200).json({ reply: reply || '(sin respuesta)', changed });
      }

      const results = [];
      for (const b of data.content) {
        if (b.type !== 'tool_use') continue;
        let out;
        try {
          out = await runTool(b.name, b.input, ctx);
          if (['crear_tarea','actualizar_tarea','agregar_nota'].includes(b.name) && out?.ok) changed = true;
        } catch (e) {
          out = { error: e.message };
        }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
    }
    return res.status(200).json({ reply: 'La consulta fue demasiado larga, intenta algo más específico.', changed });
  } catch (e) {
    console.error('agent error', e);
    return res.status(500).json({ error: e.message, changed });
  }
}
