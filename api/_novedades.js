// api/_novedades.js — Lista de novedades de la app Porta al Sole
// (el "_" al inicio hace que Vercel NO lo publique como dirección; solo lo usan novedades.js y daily.js)
//
// CÓMO AGREGAR UNA NOVEDAD: copia un bloque, súbele el id en 1 (el más alto va arriba) y escribe:
//   para:  'todos' | 'tecnico' (Ricardo) | 'supervisor' (Claudio)
//   puntos: frases cortas, en lenguaje simple

export const NOVEDADES = [
  {
    id: 3,
    fecha: '2026-11-16',
    para: 'supervisor',
    titulo: 'Agente diario y supervisión',
    puntos: [
      'Cada mañana recibes por Telegram el resumen del día: atrasos, check-ins con pendientes, consumos raros y patrones.',
      'El día 1 de cada mes llega el reporte mensual con el trabajo del mes anterior.',
      'En el historial 🕘 del asistente puedes leer las conversaciones de Ricardo (solo lectura) y borrar las que quieras.',
    ],
  },
  {
    id: 2,
    fecha: '2026-11-16',
    para: 'tecnico',
    titulo: 'Tareas más rápidas',
    puntos: [
      'Pídele al asistente "crea una tarea en PAS 8 para arreglar la ventana" y la crea de una vez, sin preguntar.',
      'Si no ves el recuadro verde ✅ debajo de la respuesta, la tarea NO se guardó.',
      'El agente crea solo las tareas "Mantenimiento A/C (preventivo)" cada 4 meses. Cuando lo hagas, márcala como Completado (no la borres, o se vuelve a crear).',
    ],
  },
  {
    id: 1,
    fecha: '2026-11-16',
    para: 'todos',
    titulo: 'Nuevo asistente con inteligencia artificial ✦',
    puntos: [
      'Toca el botón dorado ✦ (abajo a la derecha) para hablar con el asistente.',
      'Puedes preguntarle por tareas, reservas y consumos, crear o actualizar tareas y pedirle ayuda para diagnosticar fallas.',
      'Toca 🎤 para dictar por voz en vez de escribir.',
      'Toca 🕘 para ver tus conversaciones anteriores.',
    ],
  },
];

// Novedades que le tocan a cada rol
export const novedadesPara = rol => NOVEDADES.filter(n => n.para === 'todos' || n.para === rol);
export const ULTIMA_NOVEDAD = Math.max(0, ...NOVEDADES.map(n => n.id));

// Texto para Telegram (sin usar Claude)
export function textoTelegram(lista, nombre) {
  if (!lista.length) return '';
  const partes = [`🎁 Novedades en la app de Porta al Sole${nombre ? `, ${nombre}` : ''}:`];
  for (const n of [...lista].sort((a, b) => a.id - b.id)) {
    partes.push('', `✨ ${n.titulo}`, ...n.puntos.map(p => `• ${p}`));
  }
  partes.push('', 'Ábrela en portaalsole.vercel.app');
  return partes.join('\n');
}
