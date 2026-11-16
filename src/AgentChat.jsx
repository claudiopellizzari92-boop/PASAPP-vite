// src/AgentChat.jsx — Chat del Agente IA de Porta al Sole — v2.2
// v2.2: historial de conversaciones 🕘 (cada uno ve lo suyo; el admin ve todo, lee las de Ricardo y puede borrar)
// v2.1: muestra en verde lo que el servidor confirma que se guardó (✅ Tarea #… creada)
// v2.0: sugerencias según el rol (supervisor / técnico) y dictado por voz 🎤
import React, { useState, useRef, useEffect } from 'react';

const SUGERENCIAS = {
  supervisor: [
    '¿Qué tareas están atrasadas?',
    '¿Qué hizo Ricardo esta semana?',
    '¿Qué check-ins hay en los próximos 3 días y tienen algo pendiente?',
    '¿Hay algún consumo anormal de agua o luz?',
  ],
  tecnico: [
    '¿Qué tengo pendiente hoy?',
    'Anota una fuga en el baño del N2 de PAS 8',
    'El A/C de PAS 15 gotea, ¿qué reviso?',
    '¿Qué unidades tienen check-in mañana?',
  ],
};

// Reconocimiento de voz del navegador (gratis). Si no existe, el botón no aparece.
const SpeechRec = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

// Identificador de conversación (se guarda en el historial)
const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const fechaCorta = iso => {
  try {
    const d = new Date(iso), hoy = new Date();
    const mismoDia = d.toDateString() === hoy.toDateString();
    return mismoDia
      ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('es', { day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
};

export default function AgentChat({ token, onChanged }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [convId, setConvId] = useState(nuevoId);
  const [soloLectura, setSoloLectura] = useState(null); // nombre del dueño si es una conversación ajena (admin)
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [rol, setRol] = useState(null);
  const [conHistorial, setConHistorial] = useState(false);
  const [vista, setVista] = useState('chat'); // 'chat' | 'historial'
  const [convs, setConvs] = useState(null);
  const [cargandoHist, setCargandoHist] = useState(false);
  const [listening, setListening] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const recRef = useRef(null);
  const baseRef = useRef('');

  const auth = { Authorization: `Bearer ${token}` };
  const esAdmin = rol === 'supervisor';

  useEffect(() => { if (vista === 'chat') endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy, open, vista]);
  useEffect(() => { if (open && vista === 'chat' && !soloLectura) setTimeout(() => inputRef.current?.focus(), 150); }, [open, vista, soloLectura]);

  // Preguntar el rol (y si hay historial) al abrir el chat por primera vez
  useEffect(() => {
    if (!open || rol || !token) return;
    fetch('/api/agent', { headers: auth })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setRol(d?.rol || 'tecnico'); setConHistorial(!!d?.historial); })
      .catch(() => setRol('tecnico'));
  }, [open, rol, token]);

  // Detener el micrófono al cerrar el chat
  useEffect(() => { if (!open) stopMic(); }, [open]);

  const startMic = () => {
    if (!SpeechRec || listening) return;
    const rec = new SpeechRec();
    rec.lang = 'es-ES';
    rec.interimResults = true;
    rec.continuous = false;
    baseRef.current = input ? input.trim() + ' ' : '';
    rec.onresult = e => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(baseRef.current + txt);
    };
    rec.onend = () => { setListening(false); recRef.current = null; };
    rec.onerror = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };
  const stopMic = () => { try { recRef.current?.stop(); } catch {} setListening(false); };

  const nuevaConversacion = () => {
    setMsgs([]); setConvId(nuevoId()); setSoloLectura(null); setVista('chat');
  };

  const abrirHistorial = async () => {
    setVista('historial'); setCargandoHist(true);
    try {
      const r = await fetch('/api/agent?historial=1', { headers: auth });
      const d = await r.json();
      setConvs(d.conversaciones || []);
    } catch { setConvs([]); }
    setCargandoHist(false);
  };

  const abrirConversacion = async (c) => {
    setCargandoHist(true);
    try {
      const r = await fetch(`/api/agent?conv=${encodeURIComponent(c.id)}`, { headers: auth });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo abrir');
      setMsgs(d.mensajes || []);
      setConvId(d.id);
      setSoloLectura(d.soloLectura ? d.nombre : null);
      setVista('chat');
    } catch (e) { alert(e.message); }
    setCargandoHist(false);
  };

  const borrarConversacion = async (c) => {
    if (!window.confirm(`¿Borrar la conversación "${c.titulo}"? No se puede deshacer.`)) return;
    const r = await fetch(`/api/agent?conv=${encodeURIComponent(c.id)}`, { method: 'DELETE', headers: auth });
    if (r.ok) {
      setConvs(list => (list || []).filter(x => x.id !== c.id));
      if (c.id === convId) nuevaConversacion();
    }
  };

  const send = async (texto) => {
    stopMic();
    const content = (texto ?? input).trim();
    if (!content || busy || soloLectura) return;
    const next = [...msgs, { role: 'user', content }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          convId,
          messages: next.filter(m => !m.error).map(m => ({ role: m.role, content: m.content, ...(m.acciones?.length ? { acciones: m.acciones } : {}) })),
        }),
      });
      const d = await r.json().catch(() => ({ error: `Error ${r.status}` }));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setMsgs(m => [...m, { role: 'assistant', content: d.reply, acciones: d.acciones || [] }]);
      if (d.changed && onChanged) onChanged();
    } catch (e) {
      setMsgs(m => [...m, { role: 'assistant', content: `⚠️ ${e.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const fab = {
    position: 'absolute', right: 16, bottom: 'calc(var(--nav-h, 64px) + 16px)', zIndex: 900,
    width: 54, height: 54, borderRadius: '50%', border: 'none', cursor: 'pointer',
    background: 'linear-gradient(135deg, var(--gold2), var(--gold))', color: '#1a1208',
    boxShadow: '0 6px 20px rgba(201,150,58,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  if (!open) return (
    <button style={fab} onClick={() => setOpen(true)} aria-label="Asistente IA">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>
      </svg>
    </button>
  );

  const sugerencias = SUGERENCIAS[rol] || [];
  const intro = rol === 'supervisor'
    ? 'Puedo revisar tareas, atrasos, reservas y consumos, y detectar problemas. Si me pides crear o cambiar algo, te pido confirmación.'
    : 'Puedo anotar tareas, actualizarlas, ayudarte a diagnosticar fallas y decirte qué tienes pendiente. Toca 🎤 para hablar en vez de escribir. Cuando guardo algo, aparece un recuadro verde ✅.';

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 1000, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 14px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        {vista === 'historial' ? (
          <button onClick={() => setVista('chat')} style={{ ...btnGhost, fontSize: 16, padding: '2px 10px' }} aria-label="Volver">←</button>
        ) : (
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--gold-dim)', color: 'var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>✦</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--serif)', fontWeight: 700, fontSize: 17, color: 'var(--gold)' }}>{vista === 'historial' ? 'Historial' : 'Asistente'}</div>
          <div style={{ fontSize: 11, opacity: .6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {vista === 'historial' ? (esAdmin ? 'Todas las conversaciones' : 'Tus conversaciones') : 'Mantenimiento Porta al Sole'}
          </div>
        </div>
        {vista === 'chat' && conHistorial && (
          <button onClick={abrirHistorial} disabled={busy} style={btnGhost} aria-label="Historial">🕘</button>
        )}
        {vista === 'chat' && (msgs.length > 0 || soloLectura) && (
          <button onClick={nuevaConversacion} disabled={busy} style={btnGhost}>Nuevo</button>
        )}
        <button onClick={() => setOpen(false)} style={{ ...btnGhost, fontSize: 18, padding: '2px 10px' }} aria-label="Cerrar">✕</button>
      </div>

      {/* HISTORIAL */}
      {vista === 'historial' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cargandoHist && <div style={{ fontSize: 13, opacity: .6 }}>Cargando…</div>}
          {!cargandoHist && convs && convs.length === 0 && <div style={{ fontSize: 13, opacity: .6 }}>Todavía no hay conversaciones guardadas.</div>}
          {!cargandoHist && (convs || []).map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
              <button onClick={() => abrirConversacion(c)} style={{
                flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--sans)',
                border: `1.5px solid ${c.id === convId ? 'var(--gold)' : 'var(--border)'}`, background: 'var(--surface)', color: 'var(--text)',
              }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.titulo}</div>
                <div style={{ fontSize: 11, opacity: .6, marginTop: 3 }}>
                  {esAdmin && <span style={{ color: c.propia ? 'var(--gold)' : 'inherit', fontWeight: 600 }}>{c.propia ? 'Tú' : c.nombre} · </span>}
                  {fechaCorta(c.actualizada)} · {c.mensajes} mensajes
                </div>
              </button>
              {esAdmin && (
                <button onClick={() => borrarConversacion(c)} style={{ ...btnGhost, padding: '0 10px' }} aria-label="Borrar">🗑</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* MENSAJES */}
      {vista === 'chat' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {soloLectura && (
            <div style={{ fontSize: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--gold-dim)', color: 'var(--text)' }}>
              👁 Conversación de <b>{soloLectura}</b> (solo lectura)
            </div>
          )}
          {msgs.length === 0 && !soloLectura && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 14, opacity: .75, marginBottom: 14, lineHeight: 1.5 }}>{rol ? intro : 'Cargando…'}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sugerencias.map(s => (
                  <button key={s} onClick={() => send(s)} style={{ textAlign: 'left', padding: '11px 13px', borderRadius: 10, border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--sans)' }}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '86%',
              padding: '10px 13px', borderRadius: 14, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              ...(m.role === 'user'
                ? { background: 'var(--gold)', color: '#1a1208', borderBottomRightRadius: 4 }
                : { background: 'var(--surface)', color: m.error ? '#b83232' : 'var(--text)', border: '1px solid var(--border)', borderBottomLeftRadius: 4 }),
            }}>
              {formatear(m.content)}
              {m.acciones?.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {m.acciones.map((a, j) => (
                    <div key={j} style={{
                      fontSize: 12.5, fontWeight: 600, padding: '6px 9px', borderRadius: 8,
                      background: a.startsWith('❌') ? 'rgba(184,50,50,.12)' : 'rgba(45,110,78,.13)',
                      color: a.startsWith('❌') ? '#b83232' : 'var(--done, #2d6e4e)',
                    }}>{a}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div style={{ alignSelf: 'flex-start', padding: '10px 14px', borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13, opacity: .7 }}>Pensando…</div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {/* INPUT */}
      {vista === 'chat' && !soloLectura && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px calc(10px + env(safe-area-inset-bottom))', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
          {SpeechRec && (
            <button onClick={listening ? stopMic : startMic} disabled={busy} aria-label={listening ? 'Detener dictado' : 'Dictar por voz'} style={{
              width: 44, borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: listening ? 'none' : '1.5px solid var(--border)',
              background: listening ? '#b83232' : 'var(--bg)', color: listening ? '#fff' : 'var(--gold)',
              animation: listening ? 'agentPulse 1.2s ease-in-out infinite' : 'none',
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0014 0v-1M12 18v4M8 22h8"/>
              </svg>
            </button>
          )}
          <textarea
            ref={inputRef} rows={1} value={input} placeholder={listening ? 'Escuchando…' : 'Escribe tu consulta…'}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            style={{ flex: 1, resize: 'none', maxHeight: 110, padding: '10px 12px', borderRadius: 12, border: '1.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontFamily: 'var(--sans)', outline: 'none' }}
          />
          <button onClick={() => send()} disabled={busy || !input.trim()} style={{
            width: 44, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'var(--gold)', color: '#1a1208',
            opacity: busy || !input.trim() ? .45 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} aria-label="Enviar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>
          </button>
        </div>
      )}
      <style>{`@keyframes agentPulse{0%,100%{opacity:1}50%{opacity:.55}}`}</style>
    </div>
  );
}

const btnGhost = { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--sans)' };

// Negritas **texto** simples
function formatear(txt) {
  return String(txt).split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p
  );
}
