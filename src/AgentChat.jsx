// src/AgentChat.jsx — Chat del Agente IA de Porta al Sole — v1.0
import React, { useState, useRef, useEffect } from 'react';

const SUGERENCIAS = [
  '¿Qué tareas urgentes hay abiertas?',
  '¿Qué está pendiente en PAS 12?',
  'El A/C de PAS 8 nivel 2 no enfría',
  'Resumen de lo completado este mes',
];

export default function AgentChat({ token, onChanged }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy, open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 150); }, [open]);

  const send = async (texto) => {
    const content = (texto ?? input).trim();
    if (!content || busy) return;
    const next = [...msgs, { role: 'user', content }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: next.filter(m => !m.error) }),
      });
      const d = await r.json().catch(() => ({ error: `Error ${r.status}` }));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setMsgs(m => [...m, { role: 'assistant', content: d.reply }]);
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

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 1000, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--gold-dim)', color: 'var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>✦</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontWeight: 700, fontSize: 17, color: 'var(--gold)' }}>Asistente</div>
          <div style={{ fontSize: 11, opacity: .6 }}>Mantenimiento Porta al Sole</div>
        </div>
        {msgs.length > 0 && (
          <button onClick={() => setMsgs([])} disabled={busy} style={btnGhost}>Nuevo</button>
        )}
        <button onClick={() => setOpen(false)} style={{ ...btnGhost, fontSize: 18, padding: '2px 10px' }} aria-label="Cerrar">✕</button>
      </div>

      {/* MENSAJES */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.length === 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 14, opacity: .75, marginBottom: 14, lineHeight: 1.5 }}>
              Puedo consultar tareas, crear o actualizar tareas (siempre te pido confirmación) y ayudarte a diagnosticar problemas.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SUGERENCIAS.map(s => (
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
          }}>{formatear(m.content)}</div>
        ))}
        {busy && (
          <div style={{ alignSelf: 'flex-start', padding: '10px 14px', borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13, opacity: .7 }}>Pensando…</div>
        )}
        <div ref={endRef} />
      </div>

      {/* INPUT */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 12px calc(10px + env(safe-area-inset-bottom))', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
        <textarea
          ref={inputRef} rows={1} value={input} placeholder="Escribe tu consulta…"
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
