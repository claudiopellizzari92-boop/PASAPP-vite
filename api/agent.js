// api/agent.js — Agente IA de Porta al Sole (Vercel Serverless Function) — v2.5
// v2.5: el control de "dijo que lo hizo pero no lo guardó" solo actúa si el usuario pidió un cambio
//       y la respuesta afirma haberlo hecho (antes se activaba con simples consultas)
// v2.4: historial de conversaciones en Upstash Redis (cada uno ve lo suyo; el admin ve todo)
// v2.3: el servidor comprueba lo que se guardó de verdad (avisos ✅), corrige si el modelo dice "hecho" sin guardar,
//       Ricardo crea tareas sin "¿Confirmo?", y aviso de unidades que no existen
// v2.2: alertas de consumo por noche ocupada (igual que la pestaña Registros)
// v2.1: noches del consumo de agua = semana ANTERIOR a la lectura (igual que la pestaña Registros)
// Roles: admin = supervisor (Claudio) · resto = técnico (Ricardo)
// Variables de entorno en Vercel:
//   ANTHROPIC_API_KEY  (obligatoria)
//   ANTHROPIC_MODEL    (opcional, por defecto claude-haiku-5-5)
//   KV_REST_API_URL / KV_REST_API_TOKEN  (o UPSTASH_REDIS_REST_URL / _TOKEN) — los crea Vercel al conectar Upstash.
//   Sin ellas el asistente funciona igual, pero sin historial.

export const config = { maxDuration: 60 };

const API = 'https://porta-al-sole-api.onrender.com/api';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_STEPS = 8;
const TZ = 'America/Aruba';

const UNIT_IDS = [1,2,3,4,8,10,11,12,13,14,15,16,17,18,19,20,100,101];
const CATS = ['plomeria','electricidad','pintura','carpinteria','limpieza','electrodomesticos','hvac','otro'];
const PRIOS = ['urgente','normal','programado'];
const TYPES = ['reparacion','preventivo'];
const STATS = ['pendiente','en_proceso','completado'];
const LEVELS = ['N1','N2','N3'];
const UNIDADES_VENDIDAS = { 17: '2026-08-12' }; // igual que en App.jsx

const uname = id => ({100:'Recepción',101:'Áreas Comunes'})[id] ?? `PAS ${id}`;

/* ---------- FECHAS ---------- */
const hoyAruba = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const d10 = v => (v ? String(v).slice(0,10) : null);
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); };
const diffDays = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000);
const activaEn = (uid, fecha) => { const v = UNIDADES_VENDIDAS[uid]; return !v || fecha <= v; };

// Rango de fechas [inicio, fin) de un período: "2026-W45" (semana ISO) o "2026-11" (mes)
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
  if (m) {
    const ini = `${m[1]}-${m[2]}-01`;
    const fin = new Date(Date.UTC(+m[1], +m[2], 1)).toISOString().slice(0,10);
    return [ini, fin];
  }
  return null;
}

/* ---------- PROMPT ---------- */
function systemPrompt(nombre, esAdmin) {
  const hoy = new Date().toLocaleDateString('es', { timeZone: TZ, weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const rol = esAdmin
    ? `Hablas con ${nombre}, el administrador (Claudio), que SUPERVISA el mantenimiento. Ricardo es el único encargado de mantenimiento y es quien ejecuta y registra las tareas.
Enfócate en: visión general, atrasos, tareas estancadas, patrones, desempeño, ocupación e ingresos si los pide. Cuando pregunte "qué hizo Ricardo", revisa tareas completadas y notas del período.`
    : `Hablas con ${nombre}, el encargado de mantenimiento (Ricardo), que EJECUTA las tareas, muchas veces desde el celular y con las manos ocupadas.
Enfócate en: registrar rápido, actualizar estados y notas, diagnósticos prácticos paso a paso (qué revisar primero, materiales, herramientas, cuándo llamar a un técnico) y su lista del día ordenada por urgencia, avisando si la unidad tiene check-in pronto.
Respuestas MUY cortas y directas. Nunca menciones ingresos ni montos de reservas.`;
  return `Eres el asistente de mantenimiento de "Porta al Sole", un complejo de townhouses de alquiler vacacional en Aruba.
Hoy es ${hoy}. ${rol}
Responde siempre en español (texto plano o **negritas**; sin tablas).

DATOS DEL COMPLEJO
- Unidades: PAS 1, 2, 3, 4, 8, 10–20 (no hay 5, 6, 7 ni 9). Además: 100 = Recepción, 101 = Áreas Comunes. PAS 17 se vendió el 12/08/2026.
- Cada unidad tiene 3 niveles: N1, N2, N3.
- Categorías: plomeria, electricidad, pintura, carpinteria, limpieza, electrodomesticos, hvac (A/C y ventilación), otro.
- Prioridad: urgente, normal, programado. Tipo: reparacion, preventivo. Estado: pendiente, en_proceso, completado.
- Clima tropical y salino: considera corrosión por salitre, sarro por agua desalinizada y uso intensivo del A/C.
- Consumos: agua en m³ (lectura semanal), luz en kWh (mensual). Consumo con la unidad vacía o muy por encima de su promedio puede indicar fuga o equipo encendido.

REGLAS
1. Para consultar, usa las herramientas; nunca inventes tareas, reservas ni consumos.
2. ${esAdmin
    ? 'ANTES de crear o modificar una tarea, muestra un resumen corto y pregunta "¿Confirmo?". Solo ejecuta crear_tarea / actualizar_tarea / agregar_nota cuando confirme (sí, dale, ok...).'
    : 'Si la unidad y el problema están claros, ejecuta crear_tarea / actualizar_tarea / agregar_nota DIRECTAMENTE, sin pedir confirmación, y luego muestra en una línea lo que guardaste. Si algo no está claro, pregunta.'}
3. NUNCA digas que creaste, actualizaste o anotaste algo si no llamaste a la herramienta en este mismo turno. Lo que no pasa por la herramienta NO se guarda.
4. Unidades que NO existen: 5, 6, 7 y 9 (y PAS 17 está vendida). Si el usuario nombra una de esas, díselo y pregunta a qué unidad se refiere; no crees nada. Si falta la unidad o qué pasa, pregúntalo. Deduce lo demás con sentido común (fuga → plomeria; ventana/puerta → carpinteria; no enfría → hvac).
5. No puedes borrar tareas: se hace desde la app.
6. Al listar tareas usa formato compacto: "PAS 12 · N2 · Plomería — Fuga lavamanos (urgente, pendiente) #45".
7. Si una unidad con tareas abiertas tiene check-in en los próximos 2 días, menciónalo.`;
}

/* ---------- HERRAMIENTAS ---------- */
function buildTools(esAdmin) {
  return [
    {
      name: 'listar_tareas',
      description: 'Lista tareas de mantenimiento con filtros opcionales. Devuelve un resumen sin fotos ni historial completo.',
      input_schema: {
        type: 'object',
        properties: {
          unidad:    { type:'integer', enum: UNIT_IDS },
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
      description: 'Detalle completo de una tarea, incluyendo su historial de notas.',
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
      description: 'Modifica campos de una tarea existente. Usar SOLO después de confirmación.',
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
      input_schema: { type:'object', properties: { id: { type:'integer' }, nota: { type:'string' } }, required:['id','nota'] },
    },
    {
      name: 'ver_reservas',
      description: `Reservas de huéspedes: quién está, check-ins y check-outs en un rango de fechas. Por defecto, desde hoy hasta 14 días.${esAdmin ? ' Incluye ingresos.' : ''}`,
      input_schema: {
        type: 'object',
        properties: {
          unidad: { type:'integer', enum: UNIT_IDS },
          desde:  { type:'string', description:'YYYY-MM-DD (por defecto hoy)' },
          hasta:  { type:'string', description:'YYYY-MM-DD (por defecto hoy + 14 días)' },
        },
      },
    },
    {
      name: 'ver_consumos',
      description: 'Consumo de agua (m³, semanal) y luz (kWh, mensual) por unidad, con noches ocupadas por período, promedio y alertas de consumo anormal.',
      input_schema: {
        type: 'object',
        properties: {
          unidad:   { type:'integer', enum: UNIT_IDS },
          tipo:     { type:'string', enum: ['agua','luz'] },
          periodos: { type:'integer', description:'Cuántos períodos recientes por unidad (por defecto 6)' },
        },
      },
    },
  ];
}

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

function normReservas(data) {
  return (Array.isArray(data) ? data : []).map(r => ({
    unitId: Number(r.unit_id ?? r.unitId),
    huesped: r.guest || '',
    checkIn: d10(r.check_in ?? r.checkIn),
    checkOut: d10(r.check_out ?? r.checkOut),
    ingreso: r.income ?? null,
    propietario: r.is_owner === true || r.isOwner === true,
  })).filter(r => r.unitId && r.checkIn && r.checkOut && activaEn(r.unitId, r.checkIn));
}

// Noches ocupadas de una unidad dentro de [ini, fin)
function nochesOcupadas(reservas, uid, ini, fin) {
  let n = 0;
  for (let d = ini; d < fin; d = addDays(d, 1)) {
    if (reservas.some(r => r.unitId === uid && r.checkIn <= d && d < r.checkOut)) n++;
  }
  return n;
}

/* ---------- EJECUCIÓN DE HERRAMIENTAS ---------- */
async function runTool(name, input, ctx) {
  const { token, nombre, esAdmin } = ctx;
  const f = input || {};
  switch (name) {
    case 'listar_tareas': {
      let list = await api(token, '/tasks');
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
      const t = list.find(x => x.id === f.id);
      if (!t) return { error: `No existe la tarea #${f.id}` };
      return { ...resumen(t), descripcion: t.description || '', historial: limpiarHistorial(t.history) };
    }
    case 'crear_tarea': {
      const payload = {
        unitId: Number(f.unitId),
        level: f.level || 'N1',
        category: f.category || 'otro',
        title: String(f.title).trim(),
        description: f.description || '',
        priority: f.priority || 'normal',
        type: f.type || 'reparacion',
        status: f.status || 'pendiente',
        assignee: f.assignee || '',
        dueDate: f.dueDate || hoyAruba(),
      };
      const t = await api(token, '/tasks', { method:'POST', body: JSON.stringify(payload) });
      return { ok: true, tarea: resumen(t && t.id ? t : payload) };
    }
    case 'actualizar_tarea': {
      const { id, ...rest } = f;
      const updates = Object.fromEntries(Object.entries(rest).filter(([,v]) => v !== undefined && v !== null));
      if (!Object.keys(updates).length) return { error: 'No hay cambios' };
      const t = await api(token, `/tasks/${id}`, { method:'PATCH', body: JSON.stringify(updates) });
      return { ok: true, tarea: t && t.id ? resumen(t) : { id, ...updates } };
    }
    case 'agregar_nota': {
      await api(token, `/tasks/${f.id}/notes`, { method:'POST', body: JSON.stringify({ note: `🤖 ${f.nota}`, user: nombre, photo: null }) });
      return { ok: true };
    }
    case 'ver_reservas': {
      const hoy = hoyAruba();
      const desde = f.desde || hoy, hasta = f.hasta || addDays(hoy, 14);
      let rs = normReservas(await api(token, '/reservations'))
        .filter(r => r.checkIn <= hasta && r.checkOut >= desde);
      if (f.unidad) rs = rs.filter(r => r.unitId === f.unidad);
      rs.sort((a, b) => a.checkIn.localeCompare(b.checkIn));
      return {
        rango: { desde, hasta }, total: rs.length,
        reservas: rs.slice(0, 60).map(r => ({
          unidad: uname(r.unitId), huesped: r.propietario ? '(uso del propietario)' : r.huesped,
          checkIn: r.checkIn, checkOut: r.checkOut, noches: diffDays(r.checkOut, r.checkIn),
          estado: r.checkOut <= hoy ? 'terminada' : r.checkIn <= hoy ? 'en curso' : `llega en ${diffDays(r.checkIn, hoy)} días`,
          ...(esAdmin && !r.propietario && r.ingreso != null ? { ingreso: r.ingreso } : {}),
        })),
      };
    }
    case 'ver_consumos': {
      const [meds, resData] = await Promise.all([
        api(token, '/measurements'),
        api(token, '/reservations').catch(() => []),
      ]);
      const reservas = normReservas(resData);
      const n = Math.min(Math.max(f.periodos || 6, 2), 12);
      const lista = (Array.isArray(meds) ? meds : []).map(m => ({
        unitId: Number(m.unitId ?? m.unit_id), tipo: m.type, periodo: m.week, valor: Number(m.value),
      })).filter(m => m.unitId && m.periodo && !isNaN(m.valor));

      const grupos = {};
      for (const m of lista) {
        if (f.unidad && m.unitId !== f.unidad) continue;
        if (f.tipo && m.tipo !== f.tipo) continue;
        (grupos[`${m.unitId}|${m.tipo}`] ||= []).push(m);
      }

      const series = [], alertas = [];
      for (const [k, arr] of Object.entries(grupos)) {
        const [uid, tipo] = [Number(k.split('|')[0]), k.split('|')[1]];
        arr.sort((a, b) => a.periodo.localeCompare(b.periodo));
        // Luz mensual ("2026-11"): el valor ES el consumo. Agua / luz semanal ("2026-W45"): lectura acumulada → diferencia
        const consumos = [];
        for (let i = 0; i < arr.length; i++) {
          const m = arr[i];
          let consumo;
          if (/^\d{4}-\d{2}$/.test(m.periodo)) consumo = m.valor;
          else if (i > 0 && /W/.test(arr[i-1].periodo)) consumo = +(m.valor - arr[i-1].valor).toFixed(2);
          else continue;
          if (consumo < 0) continue;
          const rango = rangoPeriodo(m.periodo);
          // La lectura semanal mide lo consumido la semana ANTERIOR (igual que nightsForReading en App.jsx)
          const rN = rango && /W/.test(m.periodo) ? [addDays(rango[0], -7), rango[0]] : rango;
          const noches = rN && !({100:1,101:1})[uid] ? nochesOcupadas(reservas, uid, rN[0], rN[1]) : null;
          consumos.push({ periodo: m.periodo, consumo, noches });
        }
        if (!consumos.length) continue;
        const ult = consumos[consumos.length - 1];
        const previos = consumos.slice(0, -1).slice(-12);
        const prom = previos.length ? previos.reduce((s, c) => s + c.consumo, 0) / previos.length : null;
        const unidadMed = tipo === 'agua' ? 'm³' : 'kWh';
        const MIN_ABS = tipo === 'agua' ? 3 : 60, MIN_VACIO = tipo === 'agua' ? 2 : 30;
        // Promedio por noche ocupada (al menos 3 períodos con huéspedes), igual que Registros
        const conN = previos.filter(c => c.noches > 0);
        const promNoche = conN.length >= 3 ? conN.reduce((s, c) => s + c.consumo / c.noches, 0) / conN.length : null;
        const fmt = v => tipo === 'agua' ? `${Math.round(v * 1000)} L` : `${v.toFixed(1)} kWh`;
        if (ult.noches === 0 && ult.consumo >= MIN_VACIO)
          alertas.push(`${uname(uid)} · ${tipo}: ${ult.consumo} ${unidadMed} en ${ult.periodo} con la unidad vacía`);
        else if (ult.consumo >= MIN_ABS && promNoche != null && ult.noches > 0 && ult.consumo / ult.noches > 2 * promNoche)
          alertas.push(`${uname(uid)} · ${tipo}: ${fmt(ult.consumo / ult.noches)}/noche en ${ult.periodo}, más del doble de lo normal (${fmt(promNoche)}/noche)`);
        else if (ult.consumo >= MIN_ABS && promNoche == null && prom != null && ult.consumo > 2 * prom)
          alertas.push(`${uname(uid)} · ${tipo}: ${ult.consumo} ${unidadMed} en ${ult.periodo}, más del doble de su promedio (${prom.toFixed(1)}); poco historial por noche`);
        series.push({
          unidad: uname(uid), tipo, unidadMedida: unidadMed,
          promedioAnterior: prom != null ? +prom.toFixed(2) : null,
          promedioPorNoche: promNoche != null ? +promNoche.toFixed(3) : null,
          periodos: consumos.slice(-n),
        });
      }
      series.sort((a, b) => a.unidad.localeCompare(b.unidad, 'es', { numeric: true }));
      return { alertas, series: series.slice(0, 40) };
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

/* ---------- HISTORIAL (Upstash Redis por REST, sin librerías) ---------- */
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const hayHistorial = () => !!(KV_URL && KV_TOKEN);

async function kv(...comando) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: JSON.stringify(comando) });
  const d = await r.json();
  if (d.error) throw new Error(`Historial: ${d.error}`);
  return d.result;
}
const idValido = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(id);

async function guardarConversacion({ convId, me, nombre, esAdmin, mensajes }) {
  if (!hayHistorial() || !idValido(convId)) return;
  const clave = `conv:${convId}`;
  const prev = await kv('GET', clave).then(v => v ? JSON.parse(v) : null).catch(() => null);
  if (prev && prev.usuario !== me.username) return; // no pisar la conversación de otro
  const ahora = new Date().toISOString();
  const primero = mensajes.find(m => m.role === 'user')?.content || 'Conversación';
  const conv = {
    id: convId, usuario: me.username, nombre, rol: esAdmin ? 'supervisor' : 'tecnico',
    creada: prev?.creada || ahora, actualizada: ahora,
    titulo: prev?.titulo || primero.slice(0, 70),
    mensajes: mensajes.slice(-200).map(m => ({ role: m.role, content: String(m.content).slice(0, 6000), ...(m.acciones?.length ? { acciones: m.acciones } : {}) })),
  };
  const score = Date.now();
  await kv('SET', clave, JSON.stringify(conv));
  await kv('ZADD', `convs:${me.username}`, score, convId);
  await kv('ZADD', 'convs:todas', score, convId);
}

async function manejarHistorial(req, res, me, esAdmin) {
  if (!hayHistorial()) return res.status(200).json({ historial: false, conversaciones: [] });
  const q = req.query || {};
  // Abrir una conversación
  if (q.conv) {
    if (!idValido(q.conv)) return res.status(400).json({ error: 'ID inválido' });
    const v = await kv('GET', `conv:${q.conv}`);
    if (!v) return res.status(404).json({ error: 'Conversación no encontrada' });
    const conv = JSON.parse(v);
    if (conv.usuario !== me.username && !esAdmin) return res.status(403).json({ error: 'No autorizado' });
    return res.status(200).json({ ...conv, soloLectura: conv.usuario !== me.username });
  }
  // Listar (más recientes primero). El admin ve todas.
  const lista = esAdmin ? 'convs:todas' : `convs:${me.username}`;
  const ids = await kv('ZRANGE', lista, 0, 99, 'REV') || [];
  const convs = [];
  for (const id of ids) {
    const v = await kv('GET', `conv:${id}`).catch(() => null);
    if (!v) continue;
    const c = JSON.parse(v);
    convs.push({ id: c.id, titulo: c.titulo, nombre: c.nombre, usuario: c.usuario, actualizada: c.actualizada, mensajes: c.mensajes.length, propia: c.usuario === me.username });
  }
  return res.status(200).json({ historial: true, conversaciones: convs });
}

/* ---------- HANDLER ---------- */
export default async function handler(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  // Validar el token contra el backend y obtener el usuario
  let me;
  try { me = await api(token, '/auth/me'); }
  catch { return res.status(401).json({ error: 'Sesión inválida' }); }
  const esAdmin = me.username === 'admin';
  const nombre = me.displayName || me.username || 'usuario';

  // GET ?historial=1 / ?conv=ID → historial.  GET sin nada → rol (sugerencias del chat)
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.historial || q.conv) {
      try { return await manejarHistorial(req, res, me, esAdmin); }
      catch (e) { return res.status(500).json({ error: e.message }); }
    }
    return res.status(200).json({ rol: esAdmin ? 'supervisor' : 'tecnico', nombre, historial: hayHistorial() });
  }
  // DELETE ?conv=ID → solo el admin borra conversaciones
  if (req.method === 'DELETE') {
    const id = (req.query || {}).conv;
    if (!esAdmin) return res.status(403).json({ error: 'Solo el administrador puede borrar conversaciones' });
    if (!hayHistorial() || !idValido(id)) return res.status(400).json({ error: 'No se puede borrar' });
    const v = await kv('GET', `conv:${id}`).catch(() => null);
    const usuario = v ? JSON.parse(v).usuario : null;
    await kv('DEL', `conv:${id}`);
    await kv('ZREM', 'convs:todas', id);
    if (usuario) await kv('ZREM', `convs:${usuario}`, id);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY en Vercel' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const convId = body.convId;
  // Lo que se guarda en el historial: la conversación tal como la ve el usuario (+ la respuesta nueva)
  const paraHistorial = incoming.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  const responder = async (status, payload) => {
    if (status === 200 && payload.reply) {
      try { await guardarConversacion({ convId, me, nombre, esAdmin, mensajes: [...paraHistorial, { role: 'assistant', content: payload.reply, acciones: payload.acciones }] }); }
      catch (e) { console.error('historial', e.message); } // si falla el historial, la respuesta igual llega
    }
    return res.status(status).json(payload);
  };
  let messages = incoming
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return res.status(400).json({ error: 'Mensaje vacío' });

  const ctx = { token, nombre, esAdmin };
  const tools = buildTools(esAdmin);
  const system = systemPrompt(nombre, esAdmin);
  let changed = false;
  const acciones = [];      // lo que se guardó DE VERDAD (lo devuelve el servidor, no el modelo)
  let corregido = false;    // ya se le pidió corregirse una vez
  let respuestaOriginal = null;
  // ¿El usuario pidió un cambio? (último mensaje)
  const ultimoUsuario = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string')?.content || '';
  const B = '(?<![\\wáéíóúñ])', E = '(?![\\wáéíóúñ])'; // límites de palabra que entienden acentos
  const PIDE_CAMBIO = new RegExp(`${B}(crea|crear|créame|creame|anota|anotar|apunta|apúntalo|registra|registrar|agrega|agregar|añade|marca|marcar|cambia|cambiar|actualiza|actualizar|completa|completar|cierra|cerrar|asigna|asignar|pon|poner|mueve)${E}|^\\s*(sí|si|dale|ok|okey|confirmo|confirmado|hazlo|adelante|de una)${E}`, 'i');
  const pidioCambio = PIDE_CAMBIO.test(ultimoUsuario);
  // ¿La respuesta afirma, en primera persona, que ya lo hizo?
  const DICE_HECHO = new RegExp(`${B}(creé|he creado|anoté|registré|agregué|actualicé|guardé|marqué|cambié|completé|asigné)${E}|${B}(ya )?(quedó|quedo|está|esta) (cread|anotad|registrad|agregad|actualizad|guardad|marcad|completad|asignad)[ao]s?${E}|${B}está hecho${E}|${B}list[oa][,.!]? *(la )?(tarea|nota|qued)`, 'i');

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, tools, messages }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);

      messages.push({ role: 'assistant', content: data.content });

      if (data.stop_reason !== 'tool_use') {
        let reply = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        // ¿Dice que hizo algo, pero no se guardó nada y no está preguntando? → pedirle que se corrija (una vez)
        const afirmaSinHacer = pidioCambio && !acciones.length && DICE_HECHO.test(reply) && !/\?\s*$/.test(reply);
        if (afirmaSinHacer && !corregido) {
          corregido = true;
          respuestaOriginal = reply;
          messages.push({ role: 'user', content: '[Aviso del sistema, no del usuario] Dijiste que hiciste un cambio, pero NO llamaste a ninguna herramienta, así que no se guardó nada. Si ya tienes la unidad (que exista) y el problema, llama ahora a la herramienta. Si falta un dato o la unidad no existe, explícalo y pregunta. No digas que algo está hecho sin llamar a la herramienta.' });
          continue;
        }
        // Si se le pidió corregirse y aun así no guardó nada, se muestra su respuesta ORIGINAL con el aviso
        // (si en la corrección está preguntando algo —p. ej. "¿qué unidad?"— se deja esa pregunta)
        if (corregido && !acciones.length && respuestaOriginal && !/\?\s*$/.test(reply)) reply = `${respuestaOriginal}\n\n⚠️ No se guardó ningún cambio.`;
        if (data.stop_reason === 'max_tokens') reply += '…\n\n(respuesta recortada, pregunta algo más específico)';
        return responder(200, { reply: reply || '(sin respuesta)', changed, acciones });
      }

      const results = [];
      for (const b of data.content) {
        if (b.type !== 'tool_use') continue;
        let out;
        try {
          out = await runTool(b.name, b.input, ctx);
          if (['crear_tarea','actualizar_tarea','agregar_nota'].includes(b.name) && out?.ok) {
            changed = true;
            const t = out.tarea || {};
            acciones.push(
              b.name === 'crear_tarea' ? `✅ Tarea #${t.id ?? '?'} creada: ${t.unidad || ''} · ${t.titulo || ''}`
              : b.name === 'actualizar_tarea' ? `✅ Tarea #${t.id ?? b.input?.id} actualizada${b.input?.status ? ` (estado: ${b.input.status})` : ''}`
              : `✅ Nota agregada a la tarea #${b.input?.id}`
            );
          }
        } catch (e) {
          out = { error: e.message };
          if (['crear_tarea','actualizar_tarea','agregar_nota'].includes(b.name)) acciones.push(`❌ No se pudo guardar: ${e.message}`);
        }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
    }
    return responder(200, { reply: 'La consulta fue demasiado larga, intenta algo más específico.', changed, acciones });
  } catch (e) {
    console.error('agent error', e);
    return res.status(500).json({ error: e.message, changed, acciones });
  }
}
