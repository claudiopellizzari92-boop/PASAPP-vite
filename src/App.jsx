import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import './styles.css';

const API = 'https://porta-al-sole-api.onrender.com/api';

/* AUTH */
const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null);
  const [token,   setToken]   = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = localStorage.getItem('ps_token');
    if (t) {
      fetch(`${API}/auth/me`, { headers:{ Authorization:`Bearer ${t}` } })
        .then(r => r.ok ? r.json() : null)
        .then(u => { if(u){ setToken(t); setUser(u); } else { localStorage.removeItem('ps_token'); } })
        .catch(() => { localStorage.removeItem('ps_token'); })
        .finally(() => setLoading(false));
    } else { setLoading(false); }
  }, []);

  const _setSession = (t, u) => { localStorage.setItem('ps_token', t); setToken(t); setUser(u); };

  const login = async (username, password) => {
    const r = await fetch(`${API}/auth/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username, password })
    });
    if (!r.ok) throw new Error('Usuario o contraseña incorrectos');
    const { token: t, user: u } = await r.json();
    _setSession(t, u);
  };

  const logout = () => { localStorage.removeItem('ps_token'); setToken(null); setUser(null); };

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const fromb64url = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));

  const registerBiometric = async () => {
    const r1 = await fetch(`${API}/auth/webauthn/register/start`, {
      method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }
    });
    if (!r1.ok) throw new Error('No se pudo iniciar el registro');
    const opts = await r1.json();
    opts.challenge = fromb64url(opts.challenge);
    opts.user.id   = fromb64url(typeof opts.user.id === 'string' ? opts.user.id : b64url(opts.user.id));
    if (opts.excludeCredentials) opts.excludeCredentials = opts.excludeCredentials.map(c => ({ ...c, id: fromb64url(c.id) }));
    const cred = await navigator.credentials.create({ publicKey: opts });
    const r2 = await fetch(`${API}/auth/webauthn/register/finish`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
      body: JSON.stringify({
        id: cred.id, rawId: b64url(cred.rawId), type: cred.type,
        response: { clientDataJSON: b64url(cred.response.clientDataJSON), attestationObject: b64url(cred.response.attestationObject) },
      })
    });
    if (!r2.ok) throw new Error('No se pudo registrar la huella');
    localStorage.setItem('ps_biometric_user', user.username);
  };

  const loginBiometric = async () => {
    const savedUser = localStorage.getItem('ps_biometric_user') || '';
    const r1 = await fetch(`${API}/auth/webauthn/login/start`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ username: savedUser })
    });
    if (!r1.ok) throw new Error('No se pudo iniciar autenticación');
    const opts = await r1.json();
    const challengeKey = opts._challengeKey;
    const assertion = await navigator.credentials.get({ publicKey: {
      challenge: fromb64url(opts.challenge), rpId: opts.rpId,
      userVerification: 'required', timeout: opts.timeout || 60000,
      allowCredentials: (opts.allowCredentials||[]).map(c => ({ ...c, id: fromb64url(c.id) })),
    }});
    const r2 = await fetch(`${API}/auth/webauthn/login/finish`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ challengeKey, response: {
        id: assertion.id, rawId: b64url(assertion.rawId), type: assertion.type,
        response: {
          clientDataJSON:    b64url(assertion.response.clientDataJSON),
          authenticatorData: b64url(assertion.response.authenticatorData),
          signature:         b64url(assertion.response.signature),
          userHandle:        assertion.response.userHandle ? b64url(assertion.response.userHandle) : null,
        },
      }})
    });
    if (!r2.ok) throw new Error('Autenticación biométrica fallida');
    const { token: t, user: u } = await r2.json();
    _setSession(t, u);
  };

  const hasBiometric = () => !!localStorage.getItem('ps_biometric_user') && !!window.PublicKeyCredential;

  // ── Global data cache ─────────────────────────────────────────────────────
  const [tasks,        setTasks]        = useState(null); // null = not loaded yet
  const [measurements, setMeasurements] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [cancellations, setCancellations] = useState([]);
  const [tasksFetching, setTasksFetching] = useState(false);
  const [measFetching,  setMeasFetching]  = useState(false);

  const fetchTasks = useCallback(async (force=false) => {
    if (!token) return;
    if (tasksFetching) return;
    if (tasks !== null && !force) return; // already cached
    setTasksFetching(true);
    try {
      const r = await fetch(`${API}/tasks`, { headers:{ Authorization:`Bearer ${token}` } });
      if (r.ok) setTasks(await r.json());
    } finally { setTasksFetching(false); }
  }, [token, tasks, tasksFetching]);

  const fetchReservations = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/reservations`, { headers:{ Authorization:`Bearer ${token}` } });
      if (r.ok) {
        const data = await r.json();
        // Convert date strings back to Date objects
        setReservations(data.map(r=>({
          unitId:   r.unit_id,
          guest:    r.guest,
          checkIn:  new Date(r.check_in),
          checkOut: new Date(r.check_out),
          income:   r.income,
          hostawayId: r.hostaway_id,
        })));
      }
    } catch(e) { console.log('Reservations fetch failed', e); }
  }, [token]);

  const fetchCancellations = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/cancellations`, { headers:{ Authorization:`Bearer ${token}` } });
      if (r.ok) {
        const data = await r.json();
        setCancellations(data.map(r=>({
          unitId:   r.unit_id,
          guest:    r.guest,
          checkIn:  new Date(r.check_in),
          checkOut: new Date(r.check_out),
          income:   r.income,
          hostawayId: r.hostaway_id,
        })));
      }
    } catch(e) {}
  }, [token]);

  const saveCancellations = useCallback(async (res) => {
    if (!token) return { ok:false, error:'No autenticado' };
    try {
      const r = await fetch(`${API}/cancellations`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
        body: JSON.stringify({ cancellations: res.map(r=>({
          unitId:     r.unitId,
          guest:      r.guest,
          checkIn:    r.checkIn.toISOString(),
          checkOut:   r.checkOut.toISOString(),
          income:     r.income||'',
          hostawayId: r.hostawayId||'',
        }))})
      });
      if (!r.ok) return { ok:false, error:`Error ${r.status} del servidor` };
      return { ok:true };
    } catch(e) { return { ok:false, error:'No se pudo conectar al servidor' }; }
  }, [token]);

  const saveReservations = useCallback(async (res) => {
    if (!token) return { ok:false, error:'No autenticado' };
    try {
      const r = await fetch(`${API}/reservations`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
        body: JSON.stringify({ reservations: res.map(r=>({
          unitId:     r.unitId,
          guest:      r.guest,
          checkIn:    r.checkIn.toISOString(),
          checkOut:   r.checkOut.toISOString(),
          income:     r.income||'',
          hostawayId: r.hostawayId||'',
        }))})
      });
      if (!r.ok) return { ok:false, error:`Error ${r.status} del servidor` };
      return { ok:true };
    } catch(e) { return { ok:false, error:'No se pudo conectar al servidor' }; }
  }, [token]);

  const fetchMeasurements = useCallback(async (force=false) => {
    if (!token) return;
    if (measFetching) return;
    if (measurements !== null && !force) return;
    setMeasFetching(true);
    try {
      const r = await fetch(`${API}/measurements`, { headers:{ Authorization:`Bearer ${token}` } });
      if (r.ok) setMeasurements(await r.json());
      else setMeasurements([]); // endpoint error → show empty instead of infinite spinner
    } catch { setMeasurements([]); }
    finally { setMeasFetching(false); }
  }, [token, measurements, measFetching]);

  const reloadTasks = useCallback(() => {
    setTasks(null); // force refetch
  }, []);

  const reloadMeasurements = useCallback(() => {
    setMeasurements(null);
  }, []);

  // Fetch on login
  useEffect(() => { if (token) { fetchTasks(true); fetchMeasurements(true); fetchReservations(); fetchCancellations(); } }, [token]);

  // ── Demo data loader (remove after real data exists) ─────────────────────
  const loadDemoData = useCallback(() => {
    const today = new Date().toISOString().split('T')[0];
    const past  = d => { const x=new Date(); x.setDate(x.getDate()-d); return x.toISOString().split('T')[0]; };
    const future= d => { const x=new Date(); x.setDate(x.getDate()+d); return x.toISOString().split('T')[0]; };

    setTasks([
      { id:1,  unitId:1,  level:'N1', category:'electricidad', title:'Lámparas no encendían',       description:'Se chequearon bombillos, se llamó a técnico Toro.',  priority:'urgente',    type:'reparacion',  status:'completado', assignee:'Toro',    createdAt:past(10), dueDate:past(5),    history:[{date:past(10),action:'Tarea creada',user:'Admin'},{date:past(5),action:'Estado → Completado',user:'Toro'}],   photoStart:'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', photoComplete:'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=400&q=80' },
      { id:2,  unitId:3,  level:'N2', category:'plomería',     title:'Fuga en tubería principal',    description:'Fuga detectada bajo el lavamanos del baño.',         priority:'urgente',    type:'reparacion',  status:'en_proceso', assignee:'Carlos',  createdAt:past(3),  dueDate:today,      history:[{date:past(3),action:'Tarea creada',user:'Admin'},{date:past(1),action:'Estado → En Proceso',user:'Carlos'}],  photoStart:'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?w=400&q=80', photoComplete:null },
      { id:3,  unitId:8,  level:'N1', category:'aires',        title:'A/C no enfría correctamente',  description:'Unidad interior no baja de 26°C.',                   priority:'urgente',    type:'reparacion',  status:'pendiente',  assignee:'Toro',    createdAt:past(2),  dueDate:future(1),  history:[{date:past(2),action:'Tarea creada',user:'Admin'}],                                                             photoStart:'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=400&q=80', photoComplete:null },
      { id:4,  unitId:4,  level:'N3', category:'electricidad', title:'Toma corriente quemado',       description:'Toma de la sala presenta quemadura visible.',        priority:'urgente',    type:'reparacion',  status:'pendiente',  assignee:'Toro',    createdAt:past(1),  dueDate:future(2),  history:[{date:past(1),action:'Tarea creada',user:'Admin'}],                                                             photoStart:'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=400&q=80', photoComplete:null },
      { id:5,  unitId:12, level:'N2', category:'plomería',     title:'Presión de agua baja',         description:'El residente reporta presión baja en ducha.',        priority:'normal',     type:'reparacion',  status:'pendiente',  assignee:'Carlos',  createdAt:past(4),  dueDate:future(3),  history:[{date:past(4),action:'Tarea creada',user:'Admin'}],                                                             photoStart:null, photoComplete:null },
      { id:6,  unitId:2,  level:'N1', category:'mantenimiento',title:'Limpieza filtros A/C',         description:'Mantenimiento preventivo mensual de filtros.',        priority:'programado', type:'preventivo',  status:'pendiente',  assignee:'Toro',    createdAt:past(7),  dueDate:future(5),  history:[{date:past(7),action:'Tarea creada',user:'Admin'}],                                                             photoStart:null, photoComplete:null },
      { id:7,  unitId:10, level:'N2', category:'electricidad', title:'Interruptor sala dañado',      description:'Interruptor no responde al accionamiento.',           priority:'normal',     type:'reparacion',  status:'en_proceso', assignee:'Toro',    createdAt:past(5),  dueDate:future(2),  history:[{date:past(5),action:'Tarea creada',user:'Admin'},{date:past(2),action:'Estado → En Proceso',user:'Toro'}],   photoStart:'https://images.unsplash.com/photo-1558618047-3c8c76ca7d13?w=400&q=80', photoComplete:null },
      { id:8,  unitId:15, level:'N3', category:'pintura',      title:'Mancha de humedad en techo',   description:'Mancha oscura en techo del cuarto principal.',        priority:'normal',     type:'reparacion',  status:'pendiente',  assignee:'Carlos',  createdAt:past(6),  dueDate:future(7),  history:[{date:past(6),action:'Tarea creada',user:'Admin'}],                                                             photoStart:'https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=400&q=80', photoComplete:null },
      { id:9,  unitId:1,  level:'N2', category:'plomería',     title:'Revisión general tuberías',    description:'Inspección preventiva trimestral.',                   priority:'programado', type:'preventivo',  status:'completado', assignee:'Carlos',  createdAt:past(15), dueDate:past(8),    history:[{date:past(15),action:'Tarea creada',user:'Admin'},{date:past(8),action:'Estado → Completado',user:'Carlos'}],  photoStart:'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?w=400&q=80', photoComplete:'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=400&q=80' },
      { id:10, unitId:11, level:'N1', category:'cerrajería',   title:'Cerradura puerta principal',   description:'Cerradura difícil de abrir desde exterior.',          priority:'normal',     type:'reparacion',  status:'pendiente',  assignee:'Toro',    createdAt:past(2),  dueDate:future(4),  history:[{date:past(2),action:'Tarea creada',user:'Admin'}],                                                             photoStart:null, photoComplete:null },
      { id:11, unitId:18, level:'N3', category:'electricidad', title:'Medidor luz parpadea',         description:'Medidor eléctrico parpadea intermitentemente.',       priority:'urgente',    type:'reparacion',  status:'pendiente',  assignee:'Toro',    createdAt:past(1),  dueDate:today,      history:[{date:past(1),action:'Tarea creada',user:'Admin'}],                                                             photoStart:'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=400&q=80', photoComplete:null },
      { id:12, unitId:13, level:'N2', category:'aires',        title:'Limpieza unidad exterior A/C', description:'Mantenimiento preventivo semestral.',                 priority:'programado', type:'preventivo',  status:'completado', assignee:'Toro',    createdAt:past(20), dueDate:past(12),   history:[{date:past(20),action:'Tarea creada',user:'Admin'},{date:past(12),action:'Estado → Completado',user:'Toro'}],   photoStart:'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=400&q=80', photoComplete:'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=400&q=80' },
    ]);

    const w = () => { const d=new Date(); const day=d.getDay()||7; d.setDate(d.getDate()+4-day); const ys=new Date(d.getFullYear(),0,1); const wn=Math.ceil(((d-ys)/86400000+1)/7); return `${d.getFullYear()}-W${String(wn).padStart(2,'0')}`; };
    setMeasurements([
      {id:1,unitId:1, type:'agua',value:12.5,week:w(),createdAt:today},
      {id:2,unitId:2, type:'agua',value:9.8, week:w(),createdAt:today},
      {id:3,unitId:3, type:'agua',value:15.2,week:w(),createdAt:today},
      {id:4,unitId:1, type:'luz', value:145, week:w(),createdAt:today},
      {id:5,unitId:2, type:'luz', value:98,  week:w(),createdAt:today},
    ]);
  }, []);

  const authFetch = useCallback(async (url, opts = {}) => {
    const r = await fetch(`${API}${url}`, {
      ...opts,
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}`, ...(opts.headers||{}) }
    });
    if (r.status === 401) { localStorage.removeItem('ps_token'); setToken(null); setUser(null); }
    return r;
  }, [token]);

  useEffect(() => {
    if (!user) return;
    let t = setTimeout(logout, 30*60*1000);
    const reset = () => { clearTimeout(t); t = setTimeout(logout, 30*60*1000); };
    const evs = ['mousedown','mousemove','keydown','touchstart','scroll','click'];
    evs.forEach(e => window.addEventListener(e, reset, true));
    return () => { clearTimeout(t); evs.forEach(e => window.removeEventListener(e, reset, true)); };
  }, [user]);

  return React.createElement(AuthCtx.Provider, {value:{user,token,loading,login,logout,authFetch,registerBiometric,loginBiometric,hasBiometric,tasks,measurements,tasksFetching,measFetching,fetchTasks,fetchMeasurements,reloadTasks,reloadMeasurements,setTasks,setMeasurements,loadDemoData,reservations,setReservations,saveReservations,cancellations,setCancellations,saveCancellations}}, children);
}

/* CONSTANTS */
const UNIT_IDS  = [1,2,3,4,8,10,11,12,13,14,15,16,17,18,19,20,100,101];

// Hostaway ID → unit IDs mapping
const HOSTAWAY_MAP = {
  'portaalsole1':    [1],
  'portaalsole1-old':[1],
  'portaalsole-sub1':[1],
  'portaalsole-sub-test-old':[1],
  'portaalsole2':    [2],
  'portaalsole3':    [3],
  'portaalsole4':    [4],
  'portaalsole2-3-4':[2,3,4],
  'portaalsole8':    [8],
  'portaalsole10':   [10],
  'portaalsole11':   [11],
  'portaalsole12':   [12],
  'portaalsole12-old':[12],
  'portaalsole-sub12':[12],
  'portaalsole13':   [13],
  'portaalsole-sub13':[13],
  'portaalsole14':   [14],
  'portaalsole15':   [15],
  'portaalsole15-16':[15,16],
  'portaalsole16':   [16],
  'portaalsole17':   [17],
  'portaalsole18':   [18],
  'portaalsole19':   [19],
  'portaalsole20':   [20],
  'portaalsole-sub20':[20],
};

// Parse Hostaway CSV - confirmed reservations only
function parseHostawayCSV(csvText) {
  return parseHostawayCSVWithStatus(csvText, 'confirmed');
}

// Parse and collect import statistics (for showing a summary to the user)
function parseHostawayWithStats(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].replace(/\r/,'').split(',');
  const stats = {
    totalRows: 0, confirmed: 0, cancelled: 0,
    skippedOwner: 0, skippedUnknownUnit: 0, skippedBadDate: 0,
    unknownUnits: new Set(),
  };
  for (let i=1; i<lines.length; i++) {
    const vals = lines[i].replace(/\r/,'').match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g)||[];
    const row = {};
    headers.forEach((h,j) => row[h.trim()] = (vals[j]||'').replace(/^"|"$/g,'').trim());
    if (!row.status) continue;
    stats.totalRows++;
    if (row.type !== 'guest') { stats.skippedOwner++; continue; }
    const hostawayId = (row.display_id||'').split('|')[0].trim().replace(/^aw-/, '');
    if (!HOSTAWAY_MAP[hostawayId]) { stats.skippedUnknownUnit++; stats.unknownUnits.add(hostawayId); continue; }
    const dateParts = (row.display_dates||'').split(' - ');
    if (dateParts.length !== 2) { stats.skippedBadDate++; continue; }
    if (row.status === 'confirmed') stats.confirmed++;
    else if (row.status === 'cancelled') stats.cancelled++;
  }
  stats.unknownUnits = [...stats.unknownUnits];
  return stats;
}

// Parse Hostaway CSV - cancelled reservations only
function parseHostawayCancellationsCSV(csvText) {
  return parseHostawayCSVWithStatus(csvText, 'cancelled');
}

function parseHostawayCSVWithStatus(csvText, filterStatus) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].replace(/\r/,'').split(',');
  const reservations = [];

  for (let i=1; i<lines.length; i++) {
    const vals = lines[i].replace(/\r/,'').match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g)||[];
    const row = {};
    headers.forEach((h,j) => row[h.trim()] = (vals[j]||'').replace(/^"|"$/g,'').trim());

    if (row.status !== filterStatus) continue;
    if (row.type !== 'guest') continue;

    const hostawayId = (row.display_id||'').split('|')[0].trim().replace(/^aw-/, '');
    const unitIds = HOSTAWAY_MAP[hostawayId];
    if (!unitIds) continue;

    // Parse dates: "May 12 - May 25" or "May 12 - Jan 1 2028"
    const dateParts = (row.display_dates||'').split(' - ');
    if (dateParts.length !== 2) continue;

    const parseDate = (s) => {
      // If string already has a 4-digit year, use as-is; otherwise append current year
      const d = /\d{4}/.test(s) ? new Date(s) : new Date(s + ' ' + new Date().getFullYear());
      return isNaN(d) ? null : d;
    };

    const checkIn  = parseDate(dateParts[0].trim());
    const checkOut = parseDate(dateParts[1].trim());
    if (!checkIn || !checkOut) continue;

    const rawIncome = row.Income||'';
    const incomeNum = parseFloat(String(rawIncome).replace(/[^0-9.-]/g,''));
    const splitIncome = unitIds.length > 1 && !isNaN(incomeNum) && incomeNum > 0
      ? '$' + (incomeNum / unitIds.length).toFixed(2)
      : rawIncome;

    unitIds.forEach(uid => {
      reservations.push({
        unitId:   uid,
        guest:    row.name,
        checkIn,
        checkOut,
        income:   splitIncome,
        hostawayId,
      });
    });
  }
  // Deduplicar por unitId + checkIn + checkOut
  const seen = new Set();
  return reservations.filter(r => {
    const key = `${r.unitId}_${r.checkIn.getTime()}_${r.checkOut.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const SPECIAL   = {100:'Recepción',101:'Áreas Comunes'};
const uname     = id => SPECIAL[id] ?? `PAS ${id}`;
const pColor    = p => p==='urgente'?'#b83232':p==='normal'?'#c9963a':p==='programado'?'#2d6e4e':'#2471a3';

const CATS = [
  {id:'plomeria',label:'Plomería'},{id:'electricidad',label:'Electricidad'},
  {id:'pintura',label:'Pintura / Acabados'},{id:'carpinteria',label:'Carpintería'},
  {id:'limpieza',label:'Limpieza Profunda'},{id:'electrodomesticos',label:'Electrodomésticos'},
  {id:'hvac',label:'A/C y Ventilación'},{id:'otro',label:'Otro'},
];
const PRIOS = [
  {id:'urgente',   label:'Urgente',    c:'#b83232'},
  {id:'normal',    label:'Normal',     c:'#c9963a'},
  {id:'programado',label:'Programado', c:'#2d6e4e'},
];
const TYPES = [
  {id:'reparacion', label:'Reparación'},
  {id:'preventivo', label:'Preventivo'},
];
const STATS = [
  {id:'pendiente', label:'Pendiente'},
  {id:'en_proceso',label:'En proceso'},
  {id:'completado',label:'Completado'},
];

/* ICONS */
function Ic({d,sz=20,col='currentColor',sw=1.8,ch}) {
  return (
    <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {d?<path d={d}/>:ch}
    </svg>
  );
}
const D = {
  tasks:   'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  records: 'M18 20V10M12 20V4M6 20v-6',
  plus:    'M12 5v14M5 12h14',
  logout:  'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  edit:    'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  trash:   'M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2',
  check:   'M20 6L9 17l-5-5',
  send:    'M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z',
  x:       'M18 6L6 18M6 6l12 12',
  search:  'M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z',
  dl:      'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  uplus:   'M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M8.5 7a4 4 0 100 8 4 4 0 000-8zM20 8v6M23 11h-6',
  undo:    'M3 7v6h6M3.51 15A9 9 0 1021 12',
};

/* LOGIN */
function LoginScreen() {
  const { login, loginBiometric, hasBiometric } = useAuth();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [biobusy, setBioBusy] = useState(false);

  const submit = async e => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await login(u, p); }
    catch(e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  const doBio = async () => {
    setErr(''); setBioBusy(true);
    try { await loginBiometric(); }
    catch(e2) { setErr(e2.message||'Error con la huella'); }
    finally { setBioBusy(false); }
  };

  return (
    <div className="login">
      <div className="login-grid"/>
      <div className="login-accent"/>
      <div className="login-body">
        <div className="login-eyebrow">Sistema de Mantenimiento</div>
        <img src="customcolor_text-logoname_transparent_background.png" alt="Porta Al Sole" className="login-logo"
          onError={e=>{e.target.style.display='none';document.querySelector('.login-logo-fb').style.display='block'}}/>
        <div className="login-logo-fb">Porta Al <span>Sole</span></div>
        <div className="login-tag">Condos · v2.0</div>
      </div>
      <div className="login-panel">
        <div className="lpanel-title">Acceso al sistema</div>
        {err&&<div className="login-err">{err}</div>}
        {hasBiometric()&&(
          <button className="login-btn-bio" onClick={doBio} disabled={biobusy}>
            {biobusy
              ? <span>Verificando...</span>
              : <><span style={{fontSize:22}}>&#x1F4F1;</span><span>Ingresar con huella dactilar</span></>
            }
          </button>
        )}
        <form onSubmit={submit}>
          {hasBiometric()&&<div style={{display:'flex',alignItems:'center',gap:10,margin:'14px 0',opacity:.35}}><div style={{flex:1,height:1,background:'rgba(201,150,58,.3)'}}/><span style={{fontSize:9,color:'rgba(201,150,58,.5)',letterSpacing:2,textTransform:'uppercase'}}>o</span><div style={{flex:1,height:1,background:'rgba(201,150,58,.3)'}}/></div>}
          <div className="lfield">
            <label>Usuario</label>
            <input value={u} onChange={e=>setU(e.target.value)} placeholder="nombre de usuario" autoCapitalize="none" autoComplete="username"/>
          </div>
          <div className="lfield">
            <label>Contraseña</label>
            <input type="password" value={p} onChange={e=>setP(e.target.value)} placeholder="••••••••" autoComplete="current-password"/>
          </div>
          <button type="submit" className="login-btn" disabled={busy||!u||!p}>
            {busy?'Verificando...':'Ingresar →'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* NEW TASK MODAL */
function NewTaskModal({ onClose, onSaved, defaultUnitId }) {
  const { authFetch } = useAuth();
  const [f, setF] = useState({unitId:1,level:'N1',category:'plomeria',title:'',description:'',priority:'normal',type:'reparacion',status:'pendiente',assignee:'',dueDate: new Date().toISOString().split('T')[0]});
  const [busy, setBusy] = useState(false);
  const s = (k,v) => setF(prev=>({...prev,[k]:v}));

  const save = async () => {
    if (!f.title.trim()) return;
    setBusy(true);
    const payload = {
      unitId: Number(f.unitId),
      level: f.level,
      category: f.category,
      title: f.title.trim(),
      description: f.description || '',
      priority: f.priority,
      type: f.type,
      status: f.status,
      assignee: f.assignee || '',
      dueDate: f.dueDate || new Date().toISOString().split('T')[0],
    };
    const r = await authFetch('/tasks',{method:'POST',body:JSON.stringify(payload)});
    if (!r.ok) {
      const err = await r.json().catch(()=>({error:'Error desconocido'}));
      alert('Error: ' + (err.error || r.status));
    } else {
      onSaved();
    }
    setBusy(false);
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="mhandle"/>
        <div className="mtitle">Nueva Tarea</div>
        <div className="msec"><span className="mlbl">Unidad</span>
          <select className="minp msel" value={f.unitId} onChange={e=>s('unitId',e.target.value)}>
            {UNIT_IDS.map(id=><option key={id} value={id}>{uname(id)}</option>)}
          </select></div>
        <div className="msec"><span className="mlbl">Nivel</span>
          <div className="cgrid">{['N1','N2','N3'].map(l=><button key={l} className={`cchip ${f.level===l?'csel':''}`} onClick={()=>s('level',l)}>{l}</button>)}</div></div>
        <div className="msec"><span className="mlbl">Categoría</span>
          <select className="minp msel" value={f.category} onChange={e=>s('category',e.target.value)}>
            {CATS.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
          </select></div>
        <div className="msec"><span className="mlbl">Título</span>
          <input className="minp" value={f.title} onChange={e=>s('title',e.target.value)} placeholder="Describe el problema..."/></div>
        <div className="msec"><span className="mlbl">Descripción (opcional)</span>
          <input className="minp" value={f.description} onChange={e=>s('description',e.target.value)} placeholder="Detalles adicionales..."/></div>
        <div className="msec"><span className="mlbl">Prioridad</span>
          <div className="cgrid">{PRIOS.map(p=><button key={p.id} className={`cchip ${f.priority===p.id?'csel':''}`} onClick={()=>s('priority',p.id)}>{p.label}</button>)}</div></div>
        <div className="msec"><span className="mlbl">Tipo</span>
          <div className="cgrid">{TYPES.map(t=><button key={t.id} className={`cchip ${f.type===t.id?'csel':''}`} onClick={()=>s('type',t.id)}>{t.label}</button>)}</div></div>
        <div className="msec"><span className="mlbl">Asignado a (opcional)</span>
          <input className="minp" value={f.assignee} onChange={e=>s('assignee',e.target.value)} placeholder="Nombre del responsable"/></div>
        <div className="msec"><span className="mlbl">Fecha límite (opcional)</span>
          <input className="minp" type="date" value={f.dueDate} onChange={e=>s('dueDate',e.target.value)}/></div>
        <div className="macts">
          <button className="mcancel" onClick={onClose}>Cancelar</button>
          <button className="msave" onClick={save} disabled={busy||!f.title.trim()}>{busy?'Guardando...':'Crear Tarea'}</button>
        </div>
      </div>
    </div>
  );
}

/* TASK DETAIL MODAL */
function TaskDetailModal({ task, onClose, onUpdated }) {
  const { authFetch, user } = useAuth();
  const [t, setT] = useState(task);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(null); // 'start' | 'complete' | null
  const [notePhoto, setNotePhoto] = useState(null); // base64 photo attached to note
  const [notePhotoUploading, setNotePhotoUploading] = useState(false);

  const upd = async updates => {
    setBusy(true);
    const r = await authFetch(`/tasks/${t.id}`,{method:'PATCH',body:JSON.stringify(updates)});
    if (r.ok) setT(await r.json());
    setBusy(false);
  };

  const addNote = async () => {
    if (!note.trim() && !notePhoto) return;
    setBusy(true);
    let photoUrl = null;
    if (notePhoto) {
      setNotePhotoUploading(true);
      const r = await authFetch(`/tasks/${t.id}/photo?type=note_${Date.now()}`,{method:'POST',body:JSON.stringify({data:notePhoto})});
      if (r.ok) { const d = await r.json(); photoUrl = notePhoto; } // use base64 as fallback
      setNotePhotoUploading(false);
    }
    const noteText = [note.trim(), photoUrl?`[foto adjunta]`:null].filter(Boolean).join(' ');
    const r = await authFetch(`/tasks/${t.id}/notes`,{method:'POST',body:JSON.stringify({note:noteText,user:user.displayName||user.username,photo:photoUrl})});
    if (r.ok) {
      const updated = await r.json();
      // Inject photo into last history entry locally if backend doesn't support it
      if (photoUrl && updated.history) {
        updated.history[updated.history.length-1].photo = notePhoto;
      }
      setT(updated);
      setNote('');
      setNotePhoto(null);
    }
    setBusy(false);
  };

  const del = async () => {
    if (!confirm('Eliminar esta tarea?')) return;
    await authFetch(`/tasks/${t.id}`,{method:'DELETE'});
    onUpdated();
  };

  const pc = pColor(t.priority);

  const statusColors = {pendiente:['#8b7355','rgba(139,115,85,.12)','rgba(139,115,85,.3)'],en_proceso:['var(--gold)','rgba(201,150,58,.12)','rgba(201,150,58,.3)'],completado:['var(--done)','rgba(45,110,78,.1)','rgba(45,110,78,.3)']};
  const [sc,sbg,sborder] = statusColors[t.status]||statusColors.pendiente;

  return (
    <div className="dm-overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="dm-sheet">
        <div className="dm-handle"/>

        {/* HERO */}
        <div className="dm-hero">
          <div className="dm-hero-top">
            <div className="dm-crumb">
              <span style={{color:'var(--gold)'}}>{uname(t.unitId)}</span>
              <span className="dm-crumb-sep">›</span>
              <span>{t.level}</span>
              {t.category&&<><span className="dm-crumb-sep">›</span><span style={{textTransform:'capitalize'}}>{t.category}</span></>}
            </div>
            <button className="dm-close" onClick={onClose}><Ic d={D.x} sz={13}/></button>
          </div>
          <div className="dm-title">{t.title}</div>
          {t.description&&<div className="dm-desc">{t.description}</div>}
          <div className="dm-badges">
            <div className="dm-badge" style={{color:sc,background:sbg,borderColor:sborder}}>
              {t.status==='completado'?'✓ ':t.status==='en_proceso'?'⟳ ':'○ '}{STATS.find(s=>s.id===t.status)?.label}
            </div>
            <div className="dm-badge" style={{color:pc,background:`${pc}14`,borderColor:`${pc}40`}}>
              {PRIOS.find(p=>p.id===t.priority)?.label}
            </div>
            {t.assignee&&<div className="dm-badge" style={{color:'rgba(255,255,255,.5)',background:'rgba(255,255,255,.06)',borderColor:'rgba(255,255,255,.1)'}}>
              👤 {t.assignee}
            </div>}
            {t.dueDate&&<div className="dm-badge" style={{color:'rgba(255,255,255,.4)',background:'rgba(255,255,255,.05)',borderColor:'rgba(255,255,255,.08)'}}>
              📅 {t.dueDate}
            </div>}
          </div>
        </div>

        {/* BODY */}
        <div className="dm-body">

          {/* ESTADO */}
          <div className="dm-section">
            <div className="dm-section-title">Estado</div>
            <div className="dm-chips">
              {STATS.map(s=><button key={s.id} className={`dm-chip ${t.status===s.id?'dm-sel':''}`} onClick={()=>upd({status:s.id})}>{s.label}</button>)}
            </div>
          </div>

          {/* PRIORIDAD */}
          <div className="dm-section">
            <div className="dm-section-title">Prioridad</div>
            <div className="dm-chips">
              {PRIOS.map(p=><button key={p.id} className={`dm-chip ${t.priority===p.id?'dm-sel':''}`} onClick={()=>upd({priority:p.id})}>{p.label}</button>)}
            </div>
          </div>

          {/* HISTORIAL */}
          <div className="dm-section">
            <div className="dm-section-title">Historial</div>
            <div className="dm-timeline">
              {(t.history||[]).map((h,i)=>(
                <div key={i} className="dm-titem">
                  <div className="dm-tdot"><Ic d={D.check} sz={12} col="var(--gold)" sw={2.5}/></div>
                  <div className="dm-ttext">
                    <div className="dm-taction">{(h.action||'').replace(' [foto adjunta]','')}</div>
                    {h.photo&&<img src={h.photo} onClick={()=>setLightbox(h.photo)} style={{width:'100%',maxHeight:140,objectFit:'cover',borderRadius:8,marginTop:5,cursor:'zoom-in'}}/>}
                    <div className="dm-tmeta">
                      <span className="dm-tdate">{h.date}</span>
                      <span className="dm-tuser">{h.user}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {notePhoto&&(
              <div style={{position:'relative',marginBottom:6}}>
                <img src={notePhoto} style={{width:'100%',maxHeight:120,objectFit:'cover',borderRadius:8}}/>
                <button onClick={()=>setNotePhoto(null)} style={{position:'absolute',top:4,right:4,background:'rgba(0,0,0,.6)',border:'none',color:'#fff',width:22,height:22,borderRadius:'50%',fontSize:12,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>×</button>
              </div>
            )}
            <div className="dm-note-wrap">
              <input className="dm-note-inp" value={note} onChange={e=>setNote(e.target.value)} placeholder="Agregar nota..." onKeyDown={e=>e.key==='Enter'&&addNote()}/>
              <label style={{display:'flex',alignItems:'center',justifyContent:'center',width:34,height:34,cursor:'pointer',color:'var(--muted)',flexShrink:0}}>
                <span style={{fontSize:16}}>&#128247;</span>
                <input type="file" accept="image/*" style={{display:'none'}} onChange={e=>{
                  const file=e.target.files[0]; if(!file) return;
                  const rd=new FileReader();
                  rd.onload=ev=>setNotePhoto(ev.target.result);
                  rd.readAsDataURL(file);
                }}/>
              </label>
              <button className="dm-note-btn" onClick={addNote} disabled={(!note.trim()&&!notePhoto)||busy}>
                {busy?<div className="spinner" style={{width:12,height:12,borderWidth:2,margin:0}}/>:<Ic d={D.send} sz={13}/>}
              </button>
            </div>
          </div>

          {/* FOTOS */}
          <div className="dm-section">
            <div className="dm-section-title">Fotos</div>
            {[['start','📷','Inicio'],['complete','✓','Final']].map(([type,icon,lbl])=>{
              const uploading  = photoUploading===type;
              const arrField   = type==='start' ? 'photosStart' : 'photosComplete';
              const photos     = (t[arrField] && t[arrField].length > 0)
                ? t[arrField]
                : (type==='start' ? (t.photoStart ? [t.photoStart] : []) : (t.photoComplete ? [t.photoComplete] : []));

              const uploadPhoto = async file => {
                if (photoUploading) return;
                setPhotoUploading(type);
                const rd = new FileReader();
                rd.onload = async ev => {
                  try {
                    const r = await authFetch(`/tasks/${t.id}/photo?type=${type}`,{method:'POST',body:JSON.stringify({data:ev.target.result})});
                    if (r.ok) {
                      const updated = await r.json();
                      console.log('Photo upload response:', JSON.stringify({photosStart: updated.photosStart, photosComplete: updated.photosComplete, photoStart: updated.photoStart, photoComplete: updated.photoComplete}));
                      setT(updated);
                    }
                  } finally {
                    setPhotoUploading(null);
                  }
                };
                rd.readAsDataURL(file);
              };

              const deletePhoto = async (idx) => {
                const newArr = photos.filter((_,i)=>i!==idx);
                const patch = {
                  [arrField]: newArr,
                  ...(type==='start'    ? {photoStart:    newArr[0]||null} : {}),
                  ...(type==='complete' ? {photoComplete: newArr[0]||null} : {}),
                };
                const r = await authFetch(`/tasks/${t.id}`,{method:'PATCH',body:JSON.stringify(patch)});
                if (r.ok) setT(await r.json());
                else setT(prev=>({...prev,...patch}));
              };

              return (
                <div key={type} style={{marginBottom:14}}>
                  <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:1,fontWeight:800,marginBottom:7,display:'flex',alignItems:'center',gap:6}}>
                    {icon} {lbl}
                    {photos.length>0&&<span style={{fontWeight:400,letterSpacing:0}}>· {photos.length} foto{photos.length!==1?'s':''}</span>}
                  </div>
                  {photos.length>0&&(
                    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:7}}>
                      {photos.map((src,idx)=>(
                        <div key={idx} style={{position:'relative',borderRadius:10,overflow:'hidden',border:'1px solid var(--border)',background:'var(--surface)'}}>
                          <img src={src} onClick={()=>setLightbox(src)}
                            style={{width:'100%',aspectRatio:'1',objectFit:'cover',display:'block',cursor:'zoom-in'}}/>
                          <button onClick={e=>{e.stopPropagation();deletePhoto(idx);}}
                            style={{position:'absolute',top:4,right:4,width:22,height:22,borderRadius:'50%',
                              background:'rgba(184,50,50,.9)',border:'none',color:'#fff',fontSize:15,
                              display:'flex',alignItems:'center',justifyContent:'center',
                              cursor:'pointer',fontWeight:700,lineHeight:1,zIndex:10}}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <label style={{display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'9px',
                    borderRadius:10,border:'1.5px dashed var(--border)',cursor:uploading?'default':'pointer',
                    background:'transparent',opacity:uploading?0.5:1}}>
                    {uploading
                      ? <><div className="spinner" style={{width:14,height:14,borderWidth:2,margin:0}}/><span style={{fontSize:11,color:'var(--muted)'}}>Subiendo...</span></>
                      : <><span style={{fontSize:18,opacity:.4,lineHeight:1}}>+</span><span style={{fontSize:11,color:'var(--muted)',fontWeight:600}}>Agregar foto</span></>
                    }
                    <input type="file" accept="image/*" style={{display:'none'}} disabled={!!uploading}
                      onChange={e=>{ const f=e.target.files[0]; if(f) uploadPhoto(f); e.target.value=''; }}/>
                  </label>
                </div>
              );
            })}
          </div>

          {/* DELETE */}
          <button className="dm-del" onClick={del}>
            <Ic d={D.trash} sz={13} col="var(--urgent)"/> Eliminar esta tarea
          </button>

        </div>
      </div>

      {lightbox&&(
        <div onClick={()=>setLightbox(null)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.93)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
          <img src={lightbox} style={{maxWidth:'100%',maxHeight:'90vh',borderRadius:12,objectFit:'contain'}}/>
          <button onClick={()=>setLightbox(null)} style={{position:'absolute',top:16,right:16,background:'rgba(255,255,255,.1)',border:'1px solid rgba(255,255,255,.15)',color:'#fff',width:36,height:36,borderRadius:50,fontSize:20,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>×</button>
        </div>
      )}
    </div>
  );
}

/* BIO REGISTER BUTTON */
function BioRegisterBtn() {
  const { registerBiometric, hasBiometric } = useAuth();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(hasBiometric());

  const reg = async () => {
    setBusy(true);
    try {
      await registerBiometric();
      setDone(true);
      alert('¡Huella registrada! La próxima vez podés ingresar sin contraseña.');
    } catch(e) {
      alert('Error: ' + (e.message||'No se pudo registrar la huella'));
    }
    setBusy(false);
  };

  if (!window.PublicKeyCredential) return null;

  return (
    <button
      className="hbtn"
      onClick={reg}
      disabled={busy}
      title={done ? 'Huella registrada' : 'Registrar huella dactilar'}
      style={done ? {color:'var(--done)',borderColor:'rgba(45,110,78,.3)'} : {}}
    >
      {busy ? <div className="spinner" style={{width:12,height:12,borderWidth:2,margin:0}}/> : <span style={{fontSize:14}}>{done?'🔒':'☝'}</span>}
    </button>
  );
}

/* TASKS SCREEN */
function TasksScreen({ isDark, onThemeToggle }) {
  const { user, authFetch, logout, tasks:allTasks, tasksFetching, fetchTasks, reloadTasks, setTasks } = useAuth();
  const tasks = allTasks || [];
  const loading = allTasks === null;
  const isAdmin = user?.username === 'admin';
  const [statusF,  setStatusF]  = useState('all');
  const [prioF,    setPrioF]    = useState('all');
  const [search,   setSearch]   = useState('');
  const [showNew,  setShowNew]  = useState(false);
  const [sel,      setSel]      = useState(null);
  const [assigneeF,setAssigneeF]= useState('all');

  useEffect(() => { fetchTasks(); }, []);

  const load = useCallback(() => { reloadTasks(); }, [reloadTasks]);

  const filtered = tasks.filter(t => {
    if (t.status === 'completado') return false;
    if (statusF !== 'all' && t.status !== statusF) return false;
    if (prioF   !== 'all' && t.priority !== prioF)  return false;
    if (assigneeF !== 'all' && (t.assignee||'') !== assigneeF) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (t.title||'').toLowerCase().includes(q)||
             (t.description||'').toLowerCase().includes(q)||
             uname(t.unitId).toLowerCase().includes(q)||
             (t.assignee||'').toLowerCase().includes(q)||
             (t.category||'').toLowerCase().includes(q);
    }
    return true;
  });

  const assignees = tasks.length>0?[...new Set(tasks.filter(t=>t.assignee&&t.status!=='completado').map(t=>t.assignee))].sort():[];

  const counts = {
    urgente:    tasks.filter(t=>t.priority==='urgente'&&t.status!=='completado').length,
    pendiente:  tasks.filter(t=>t.status==='pendiente').length,
    en_proceso: tasks.filter(t=>t.status==='en_proceso').length,
    completado: tasks.filter(t=>t.status==='completado').length,
  };

  const toggleDone = task => {
    const ns = task.status==='completado'?'pendiente':'completado';
    setTasks(prev=>(prev||[]).map(t=>t.id===task.id?{...t,status:ns}:t));
    authFetch(`/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify({status:ns})});
  };

  const delTask = task => {
    if (!confirm('Eliminar tarea?')) return;
    setTasks(prev=>(prev||[]).filter(t=>t.id!==task.id));
    authFetch(`/tasks/${task.id}`,{method:'DELETE'});
  };

  const exportCSV = () => {
    const rows=[['ID','Unidad','Nivel','Categoría','Título','Prioridad','Estado','Asignado','Fecha creación','Fecha límite']];
    tasks.forEach(t=>rows.push([t.id,uname(t.unitId),t.level||'',t.category||'',t.title||'',t.priority||'',t.status||'',t.assignee||'',t.createdAt||'',t.dueDate||'']));
    const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download='tareas-'+new Date().toISOString().split('T')[0]+'.csv';a.click();
  };

  const [showArchivePicker, setShowArchivePicker] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  const exportMonthlyArchive = async (year, month) => {
    setArchiveBusy(true);
    const mStart = new Date(year, month, 1);
    const mEnd   = new Date(year, month+1, 0, 23, 59, 59);
    const MONTHS_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const monthLabel = `${MONTHS_FULL[month]} ${year}`;

    const mTasks = tasks.filter(t => {
      const d = new Date(t.createdAt);
      return d >= mStart && d <= mEnd;
    }).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Fetch image as base64
    const toBase64 = async url => {
      if (!url) return null;
      try {
        const r = await fetch(url);
        const blob = await r.blob();
        return await new Promise(res => {
          const rd = new FileReader();
          rd.onload = () => res(rd.result);
          rd.readAsDataURL(blob);
        });
      } catch { return null; }
    };

    // Embed all photos
    const enriched = await Promise.all(mTasks.map(async t => {
      const startUrls    = t.photosStart?.length    ? t.photosStart    : (t.photoStart    ? [t.photoStart]    : []);
      const completeUrls = t.photosComplete?.length ? t.photosComplete : (t.photoComplete ? [t.photoComplete] : []);      const [b64Starts, b64Completes] = await Promise.all([
        Promise.all(startUrls.map(toBase64)),
        Promise.all(completeUrls.map(toBase64)),
      ]);
      const history = await Promise.all((t.history||[]).map(async h => {
        const b64 = h.photo ? await toBase64(h.photo) : null;
        return {...h, photoB64: b64};
      }));
      return {...t, b64Starts: b64Starts.filter(Boolean), b64Completes: b64Completes.filter(Boolean), history};
    }));

    const pBadge = p => p==='urgente'?'#b83232':p==='normal'?'#c9963a':'#2d6e4e';
    const sBadge = s => s==='completado'?'#2d6e4e':s==='en_proceso'?'#2471a3':'#8b7355';
    const sLabel = s => s==='completado'?'Completado':s==='en_proceso'?'En Proceso':'Pendiente';

    const taskBlocks = enriched.map(t => `
      <div class="card">
        <div class="card-header">
          <div>
            <span class="badge" style="background:${pBadge(t.priority)}22;color:${pBadge(t.priority)};border:1px solid ${pBadge(t.priority)}44">${t.priority||''}</span>
            <span class="badge" style="background:${sBadge(t.status)}22;color:${sBadge(t.status)};border:1px solid ${sBadge(t.status)}44">${sLabel(t.status)}</span>
            ${t.type?`<span class="badge" style="background:#8b735522;color:#8b7355;border:1px solid #8b735544">${t.type}</span>`:''}
          </div>
          <div class="meta">${uname(t.unitId)} ${t.level?'· '+t.level:''} ${t.category?'· '+t.category:''}</div>
        </div>
        <div class="title">${t.title||''}</div>
        ${t.description?`<div class="desc">${t.description}</div>`:''}
        <div class="info-row">
          ${t.assignee?`<span>👤 ${t.assignee}</span>`:''}
          ${t.createdAt?`<span>📅 Creada: ${t.createdAt}</span>`:''}
          ${t.dueDate?`<span>⏰ Límite: ${t.dueDate}</span>`:''}
        </div>
        ${(t.b64Starts?.length||t.b64Completes?.length)?`
        <div class="photos-section">
          ${t.b64Starts?.length?`<div class="photo-group-lbl">📷 Inicio (${t.b64Starts.length})</div><div class="photos">${t.b64Starts.map(s=>`<div class="photo-wrap"><img src="${s}"/></div>`).join('')}</div>`:''}
          ${t.b64Completes?.length?`<div class="photo-group-lbl">✓ Final (${t.b64Completes.length})</div><div class="photos">${t.b64Completes.map(s=>`<div class="photo-wrap"><img src="${s}"/></div>`).join('')}</div>`:''}
        </div>`:''}
        ${t.history&&t.history.length>0?`
        <div class="timeline-title">Historial</div>
        <div class="timeline">
          ${t.history.map(h=>`
            <div class="titem">
              <div class="tdot"></div>
              <div class="ttext">
                <div class="taction">${h.action||''}</div>
                <div class="tmeta">${h.date||''} ${h.user?'· '+h.user:''}</div>
                ${h.note?`<div class="tnote">${h.note}</div>`:''}
                ${h.photoB64?`<img src="${h.photoB64}" class="tnote-img"/>`:''}
              </div>
            </div>`).join('')}
        </div>`:''}
      </div>`).join('');

    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Archivo Tareas — ${monthLabel}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Georgia,serif;background:#f7f2eb;color:#1a1208;padding:32px;max-width:860px;margin:0 auto}
  h1{font-size:28px;font-weight:700;color:#1a1208;margin-bottom:4px}
  .sub{font-size:11px;color:#8b7355;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}
  .summary{display:flex;gap:12px;margin:20px 0 28px;flex-wrap:wrap}
  .stat{background:#fff;border:1px solid #e4d9c8;border-radius:10px;padding:12px 18px;text-align:center;flex:1;min-width:80px}
  .stat-n{font-size:26px;font-weight:800;color:#c9963a;font-family:Georgia,serif}
  .stat-l{font-size:9px;color:#8b7355;text-transform:uppercase;letter-spacing:1px;margin-top:3px}
  .card{background:#fff;border:1px solid #e4d9c8;border-radius:12px;padding:18px 20px;margin-bottom:18px;page-break-inside:avoid}
  .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:8px;flex-wrap:wrap}
  .badge{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:4px;margin-right:4px;display:inline-block}
  .meta{font-size:10px;color:#8b7355;font-weight:700;letter-spacing:.3px}
  .title{font-size:16px;font-weight:700;color:#1a1208;margin-bottom:5px}
  .desc{font-size:12px;color:#555;line-height:1.5;margin-bottom:8px}
  .info-row{display:flex;gap:16px;font-size:10px;color:#8b7355;margin-bottom:10px;flex-wrap:wrap}
  .photos{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
  .photo-wrap img{width:100%;border-radius:8px;object-fit:cover;aspect-ratio:1;display:block}
  .photo-group-lbl{font-size:9px;color:#8b7355;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 5px}
  .photos-section{margin:10px 0}
  .timeline-title{font-size:9px;color:#c9963a;text-transform:uppercase;letter-spacing:1.5px;font-weight:800;margin:12px 0 6px;border-top:1px solid #e4d9c8;padding-top:10px}
  .timeline{display:flex;flex-direction:column;gap:0}
  .titem{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid #f0e8d8}
  .titem:last-child{border-bottom:none}
  .tdot{width:8px;height:8px;border-radius:50%;background:#c9963a;flex-shrink:0;margin-top:5px}
  .ttext{flex:1}
  .taction{font-size:12px;font-weight:600;color:#1a1208}
  .tmeta{font-size:10px;color:#8b7355;margin-top:1px}
  .tnote{font-size:11px;color:#555;margin-top:4px;line-height:1.4;background:#f7f2eb;padding:6px 8px;border-radius:6px}
  .tnote-img{width:100%;max-height:160px;object-fit:cover;border-radius:8px;margin-top:6px;display:block}
  .footer{margin-top:28px;padding-top:14px;border-top:1px solid #e4d9c8;font-size:10px;color:#bbb;display:flex;justify-content:space-between}
  @media print{body{padding:16px;background:#fff}.card{break-inside:avoid}@page{margin:1.2cm}}
</style></head><body>
<div class="sub">Porta Al Sole · Archivo de Mantenimiento</div>
<h1>${monthLabel}</h1>
<div class="summary">
  <div class="stat"><div class="stat-n">${mTasks.length}</div><div class="stat-l">Total tareas</div></div>
  <div class="stat"><div class="stat-n">${mTasks.filter(t=>t.status==='completado').length}</div><div class="stat-l">Completadas</div></div>
  <div class="stat"><div class="stat-n">${mTasks.filter(t=>t.priority==='urgente').length}</div><div class="stat-l">Urgentes</div></div>
  <div class="stat"><div class="stat-n">${[...new Set(mTasks.map(t=>t.assignee).filter(Boolean))].length}</div><div class="stat-l">Técnicos</div></div>
</div>
${taskBlocks||'<p style="color:#8b7355;font-style:italic">No hay tareas registradas este mes.</p>'}
<div class="footer">
  <span>Porta Al Sole Condos · Sistema de Mantenimiento</span>
  <span>Generado el ${new Date().toLocaleDateString('es-VE',{day:'2-digit',month:'long',year:'numeric'})}</span>
</div>
<script>window.onload=()=>window.print()<\/script>
</body></html>`;

    const blob = new Blob([html], {type:'text/html'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `archivo-tareas-${monthLabel.replace(/\s/g,'-')}.html`;
    a.click();
    setArchiveBusy(false);
    setShowArchivePicker(false);
  };

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',overflow:'hidden'}}>
      <div className="tasks-hd">
        <div className="tasks-topbar">
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <img src="customcolor_text-logoname_transparent_background.png" alt="Porta Al Sole" className="tasks-logo"
              onError={e=>{e.target.style.display='none';document.querySelector('.tasks-logo-fb').style.display='block'}}/>
            <div className="tasks-logo-fb">Porta Al Sole</div>
          </div>
          <div className="tasks-user">
            <span>{user.displayName||user.username}</span>
            {isAdmin&&<button className="hbtn hbtn-g" onClick={exportCSV}><Ic d={D.dl} sz={14}/></button>}
            {isAdmin&&<button className="hbtn hbtn-g" title="Archivo mensual con fotos" onClick={()=>setShowArchivePicker(true)} style={{fontSize:13}}>📦</button>}
            <BioRegisterBtn/>
            <button className="hbtn" onClick={onThemeToggle} title="Cambiar tema" style={{fontSize:15}}>{isDark?'☀':'🌙'}</button>
            <button className="hbtn" onClick={logout}><Ic d={D.logout} sz={14}/></button>
          </div>
        </div>
        <div className="stats-row">
          {[
            {lbl:'Urgente',  val:counts.urgente,    cls:'sc-u'},
            {lbl:'Pendiente',val:counts.pendiente,  cls:'sc-p'},
            {lbl:'Proceso',  val:counts.en_proceso, cls:'sc-e'},
            {lbl:'Listas',   val:counts.completado, cls:'sc-d'},
          ].map(s=>(
            <div key={s.lbl} className={`scell ${s.cls}`}>
              <div className="snum">{s.val}</div>
              <div className="slbl">{s.lbl}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="page">
        <div className="search-bar">
          <div className="search-wrap">
            <Ic d={D.search} sz={15} col="var(--muted)"/>
            <input className="sinput" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar tareas, unidades, asignados..."/>
            {search&&<button className="sclear" onClick={()=>setSearch('')}><Ic d={D.x} sz={13}/></button>}
          </div>
        </div>

        <div className="filters">
          <div className="frow">
            <span className="flbl">Estado</span>
            {[['all','Todos'],['pendiente','Pend.'],['en_proceso','Proceso']].map(([id,lbl])=>(
              <button key={id} className={`fchip ${statusF===id?'on':''}`} onClick={()=>setStatusF(id)}>{lbl}</button>
            ))}
            <div className="fsep"/>
            <span className="flbl">Prior.</span>
            {[['all','·'],['urgente','U'],['normal','N'],['programado','P']].map(([id,lbl])=>(
              <button key={id} className={`fchip ${prioF===id?(id==='all'?'on':id==='urgente'?'on-u':id==='normal'?'on-n':'on-p'):''}`} onClick={()=>setPrioF(id)}>{lbl}</button>
            ))}
          </div>
          {assignees.length>0&&<div className="frow" style={{marginTop:4}}>
            <span className="flbl">&#128100;</span>
            <select value={assigneeF} onChange={e=>setAssigneeF(e.target.value)}
              style={{background:'var(--surface)',border:'1.5px solid',borderColor:assigneeF!=='all'?'var(--gold)':'var(--border)',borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,color:assigneeF!=='all'?'var(--gold)':'var(--muted)',cursor:'pointer',outline:'none'}}>
              <option value="all">Todos</option>
              {assignees.map(a=><option key={a} value={a}>{a}</option>)}
            </select>
          </div>}
        </div>

        <div className="rcount">{filtered.length} tarea{filtered.length!==1?'s':''} activa{filtered.length!==1?'s':''}</div>

        {loading ? <div className="spinner"/> : filtered.length===0 ? (
          <div className="empty">
            <div className="empty-icon"><Ic d={D.check} sz={22} col="var(--done)"/></div>
            <div className="empty-t">{search?'Sin resultados':'Todo al día'}</div>
            <div className="empty-s">{search?`No hay tareas que coincidan con "${search}"`:'No hay tareas activas pendientes.'}</div>
          </div>
        ) : (
          <div className="tlist">
            {filtered.map(task=>{
              const pc = pColor(task.priority);
              const od = task.dueDate&&new Date(task.dueDate)<new Date()&&task.status!=='completado';
              return (
                <div key={task.id} className={`tcard ${task.status==='completado'?'tdone':''}`}>
                  <div className="tbar" style={{background:pc}}/>
                  <div className="tbody" onClick={()=>setSel(task)}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                      <div className="tcrumb">
                        <span className="tcrumb-u" style={{color:pc}}>{uname(task.unitId)}</span>
                        <span className="tchev">›</span>
                        <span>{task.level}</span>
                        {task.category&&<><span className="tchev">›</span><span style={{textTransform:'capitalize'}}>{task.category}</span></>}
                      </div>
                      <span className="tprio" style={{color:pc}}>{PRIOS.find(p=>p.id===task.priority)?.label}</span>
                    </div>
                    <div className={`ttitle ${task.status==='completado'?'struck':''}`}>{task.title}</div>
                    {task.description&&<div className="tdesc">{task.description}</div>}
                    <div className="tmeta">
                      {task.assignee&&<span className="mchip">👤 {task.assignee}</span>}
                      {od&&<span className="mchip mchip-od">⚠ Vencida</span>}
                      {task.dueDate&&!od&&<span className="mchip">📅 {task.dueDate}</span>}
                      {task.photoStart&&<span className="mchip mchip-ph">📷</span>}
                      <span style={{flex:1}}/>
                      <span className={`sbadge sb-${task.status}`}>{STATS.find(s=>s.id===task.status)?.label}</span>
                    </div>
                  </div>
                  <div className="tactions">
                    <button className="tact" onClick={e=>{e.stopPropagation();toggleDone(task);}}>
                      {task.status==='completado'
                        ? <Ic d={D.undo} sz={13} col="var(--done)"/>
                        : <Ic d={D.check} sz={15} col="var(--done)" sw={2.5}/>}
                    </button>
                    <button className="tact" onClick={e=>{e.stopPropagation();delTask(task);}}>
                      <Ic d={D.trash} sz={13} col="var(--urgent)"/>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button className="fab" onClick={()=>setShowNew(true)}>
        <Ic d={D.plus} sz={16}/> Nueva tarea
      </button>
      {showNew&&<NewTaskModal onClose={()=>setShowNew(false)} onSaved={()=>{setShowNew(false);reloadTasks();}}/>}
      {sel&&<TaskDetailModal task={sel} onClose={()=>setSel(null)} onUpdated={()=>{setSel(null);reloadTasks();}}/>}

      {/* MONTHLY ARCHIVE PICKER */}
      {showArchivePicker&&(()=>{
        const now2 = new Date();
        const MONTHS_S = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const MONTHS_F = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
        // Build available months from tasks
        const available = [...new Set(tasks.map(t=>{
          const d = new Date(t.createdAt);
          return isNaN(d)?null:`${d.getFullYear()}-${d.getMonth()}`;
        }).filter(Boolean))].sort((a,b)=>b.localeCompare(a)).map(s=>{
          const [y,m] = s.split('-').map(Number);
          return {year:y, month:m, label:`${MONTHS_F[m]} ${y}`};
        });
        return (
          <div className="overlay" onClick={()=>!archiveBusy&&setShowArchivePicker(false)}>
            <div className="modal" onClick={e=>e.stopPropagation()}>
              <div className="mhandle"/>
              <div className="mtitle">📦 Archivo mensual</div>
              <div style={{fontSize:12,color:'var(--muted)',marginBottom:16,lineHeight:1.5}}>
                Descarga un archivo HTML con todas las tareas del mes seleccionado, incluyendo las fotos embebidas. Ideal para guardar en disco y limpiar Cloudinary.
              </div>
              {archiveBusy?(
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:12,padding:'24px 0'}}>
                  <div className="spinner"/>
                  <div style={{fontSize:12,color:'var(--muted)'}}>Descargando fotos y generando archivo...</div>
                </div>
              ):(
                <div style={{display:'flex',flexDirection:'column',gap:7,maxHeight:'55vh',overflowY:'auto'}} className="hide-scroll">
                  {available.length===0
                    ? <div style={{fontSize:12,color:'var(--muted)',textAlign:'center',padding:'20px 0'}}>No hay tareas registradas aún.</div>
                    : available.map((item,i)=>{
                        const count = tasks.filter(t=>{
                          const d=new Date(t.createdAt);
                          return d.getFullYear()===item.year&&d.getMonth()===item.month;
                        }).length;
                        return (
                          <button key={i} onClick={()=>exportMonthlyArchive(item.year, item.month)}
                            style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                              background:'var(--bg)',border:'1.5px solid var(--border)',borderRadius:10,
                              padding:'12px 14px',cursor:'pointer',transition:'border-color .15s',textAlign:'left'}}
                            onMouseOver={e=>e.currentTarget.style.borderColor='var(--gold)'}
                            onMouseOut={e=>e.currentTarget.style.borderColor='var(--border)'}>
                            <div>
                              <div style={{fontSize:14,fontWeight:700,color:'var(--text)'}}>{item.label}</div>
                              <div style={{fontSize:10,color:'var(--muted)',marginTop:2}}>{count} tarea{count!==1?'s':''}</div>
                            </div>
                            <div style={{fontSize:11,color:'var(--gold)',fontWeight:700,display:'flex',alignItems:'center',gap:4}}>
                              <Ic d={D.dl} sz={13} col="var(--gold)"/> Descargar
                            </div>
                          </button>
                        );
                      })
                  }
                </div>
              )}
              {!archiveBusy&&<button className="mcancel" style={{marginTop:16,width:'100%'}} onClick={()=>setShowArchivePicker(false)}>Cerrar</button>}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* UNITS SCREEN */
function UnitsScreen() {
  const { user, authFetch, tasks:allTasks, fetchTasks, setTasks, reservations, setReservations, saveReservations, setCancellations, saveCancellations } = useAuth();
  const tasks = allTasks || [];
  const loading = allTasks === null;
  const isAdmin = user?.username === 'admin';
  const [selU,      setSelU]      = useState(UNIT_IDS[0]);
  const [lvl,       setLvl]       = useState('all');
  const [editT,     setEditT]     = useState(null);
  const [search,    setSearch]    = useState('');
  const [showDone,  setShowDone]  = useState(false);
  const [showNew,   setShowNew]   = useState(false);
  const [uTab,      setUTab]      = useState('tasks'); // 'tasks' | 'photos' | 'availability'
  const [lightbox,  setLightbox]  = useState(null);

  useEffect(()=>{ fetchTasks(); },[]);
  const reloadTasks = useCallback(()=>{ fetchTasks(true); },[fetchTasks]);

  const getAlert = uid => {
    const ut=tasks.filter(t=>t.unitId===uid&&t.status!=='completado');
    if(ut.some(t=>t.priority==='urgente')) return 'urgent';
    if(ut.length>0) return 'active';
    return 'ok';
  };

  const filteredUnits = search.trim()
    ? UNIT_IDS.filter(uid => uname(uid).toLowerCase().includes(search.toLowerCase()) ||
        tasks.some(t=>t.unitId===uid&&(t.title||'').toLowerCase().includes(search.toLowerCase())))
    : UNIT_IDS;

  const unitActive = tasks.filter(t=>t.unitId===selU&&t.status!=='completado'&&(lvl==='all'||t.level===lvl));
  const unitDone   = tasks.filter(t=>t.unitId===selU&&t.status==='completado'&&(lvl==='all'||t.level===lvl));

  // Category summary for header
  const catCounts = unitActive.reduce((acc,t)=>{
    const c=t.category||'otro'; acc[c]=(acc[c]||0)+1; return acc;
  },{});

  const toggleDone = task => {
    const ns=task.status==='completado'?'pendiente':'completado';
    setTasks(prev=>(prev||[]).map(t=>t.id===task.id?{...t,status:ns}:t));
    authFetch(`/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify({status:ns})});
  };
  const delTask = task => {
    if(!confirm('Eliminar tarea?')) return;
    setTasks(prev=>(prev||[]).filter(t=>t.id!==task.id));
    authFetch(`/tasks/${task.id}`,{method:'DELETE'});
  };

  const exportUnitPDF = () => {
    const allTasksUnit = tasks.filter(t=>t.unitId===selU);
    const active = allTasksUnit.filter(t=>t.status!=='completado');
    const done   = allTasksUnit.filter(t=>t.status==='completado');
    const name   = uname(selU);
    const today  = new Date().toLocaleDateString('es-VE',{year:'numeric',month:'long',day:'numeric'});

    const pColor = p => p==='urgente'?'#b83232':p==='normal'?'#c9963a':'#2d6e4e';
    const sLabel = s => s==='completado'?'Completado':s==='en_proceso'?'En Proceso':'Pendiente';
    const sColor = s => s==='completado'?'#2d6e4e':s==='en_proceso'?'#2471a3':'#8b7355';

    const taskRow = t => `
      <div style="border:1px solid #e8e0d0;border-radius:8px;padding:12px;margin-bottom:8px;background:#fff">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div>
            <span style="font-size:10px;font-weight:800;color:${pColor(t.priority)};background:${pColor(t.priority)}18;padding:2px 7px;border-radius:4px;text-transform:uppercase">${t.priority}</span>
            <span style="font-size:10px;color:#999;margin-left:6px">${t.level}${t.category?' · '+t.category:''}</span>
          </div>
          <span style="font-size:10px;font-weight:700;color:${sColor(t.status)};border:1px solid ${sColor(t.status)}40;padding:2px 8px;border-radius:10px">${sLabel(t.status)}</span>
        </div>
        <div style="font-size:14px;font-weight:700;color:#1a1208;margin-bottom:4px">${t.title}</div>
        ${t.description?`<div style="font-size:11px;color:#666;margin-bottom:6px">${t.description}</div>`:''}
        <div style="font-size:10px;color:#999;display:flex;gap:12px">
          ${t.assignee?`<span>👤 ${t.assignee}</span>`:''}
          ${t.dueDate?`<span>📅 ${t.dueDate}</span>`:''}
          ${t.createdAt?`<span>Creada: ${t.createdAt}</span>`:''}
        </div>
        ${t.history?.length>1?`<div style="margin-top:8px;padding-top:8px;border-top:1px solid #f0e8d8">
          <div style="font-size:9px;font-weight:800;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Historial</div>
          ${t.history.map(h=>`<div style="font-size:10px;color:#666;margin-bottom:2px">${h.date} · <strong>${h.user}</strong> · ${h.action}</div>`).join('')}
        </div>`:''}
      </div>`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Reporte ${name}</title>
    <style>
      body{font-family:Georgia,serif;max-width:800px;margin:0 auto;padding:32px;color:#1a1208;background:#fdf8f0}
      h1{font-size:28px;color:#1a1208;margin:0 0 4px}
      .sub{font-size:13px;color:#999;margin-bottom:24px}
      .section-title{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#c9963a;margin:20px 0 10px;padding-bottom:6px;border-bottom:2px solid #c9963a40}
      .stats{display:flex;gap:12px;margin-bottom:24px}
      .stat{background:#fff;border:1px solid #e8e0d0;border-radius:8px;padding:12px 16px;text-align:center;flex:1}
      .stat-n{font-size:24px;font-weight:800;color:#c9963a}
      .stat-l{font-size:9px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
      @media print{body{padding:16px}}
    </style></head><body>
    <h1>${name}</h1>
    <div class="sub">Reporte generado el ${today} · Porta Al Sole Condos</div>
    <div class="stats">
      <div class="stat"><div class="stat-n">${allTasksUnit.length}</div><div class="stat-l">Total</div></div>
      <div class="stat"><div class="stat-n" style="color:#b83232">${active.filter(t=>t.priority==='urgente').length}</div><div class="stat-l">Urgentes</div></div>
      <div class="stat"><div class="stat-n" style="color:#c9963a">${active.length}</div><div class="stat-l">Activas</div></div>
      <div class="stat"><div class="stat-n" style="color:#2d6e4e">${done.length}</div><div class="stat-l">Completadas</div></div>
    </div>
    ${active.length>0?`<div class="section-title">Tareas Activas (${active.length})</div>${active.map(taskRow).join('')}`:''}
    ${done.length>0?`<div class="section-title">Completadas (${done.length})</div>${done.map(taskRow).join('')}`:''}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e8e0d0;font-size:10px;color:#ccc;text-align:center">
      Porta Al Sole Condos · Sistema de Mantenimiento
    </div>
    </body></html>`;

    const w = window.open('','_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(()=>w.print(), 500);
  };

  const alertColor = {urgent:'var(--urgent)',active:'var(--gold)',ok:'var(--done)'};
  const LEVEL_COLORS = {N1:['#2d6e4e','rgba(45,110,78,.14)'],N2:['#2471a3','rgba(36,113,163,.14)'],N3:['#c9963a','rgba(201,150,58,.14)']};

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',overflow:'hidden'}}>
      <div className="header">
        <div className="header-title">Unidades</div>
        <div style={{fontSize:11,color:'rgba(255,255,255,.32)'}}>{UNIT_IDS.length} unidades</div>
      </div>
      <div className="ulayout">

        {/* SIDEBAR */}
        <div className="usidebar" style={{display:'flex',flexDirection:'column'}}>
          {/* Search */}
          <div style={{padding:'8px 8px 6px',borderBottom:'1px solid rgba(255,255,255,.07)',flexShrink:0}}>
            <div style={{display:'flex',alignItems:'center',gap:5,background:'rgba(255,255,255,.05)',borderRadius:7,padding:'5px 8px'}}>
              <Ic d={D.search} sz={11} col="rgba(255,255,255,.3)"/>
              <input value={search} onChange={e=>setSearch(e.target.value)}
                placeholder="Buscar..." style={{flex:1,background:'none',border:'none',fontSize:11,color:'#fff',outline:'none'}}/>
              {search&&<button onClick={()=>setSearch('')} style={{background:'none',border:'none',color:'rgba(255,255,255,.3)',cursor:'pointer',padding:0,fontSize:12}}>×</button>}
            </div>
          </div>
          {/* Unit list - vertical scroll */}
          <div style={{overflowY:'auto',flex:1,scrollbarWidth:'none',msOverflowStyle:'none'}} className="hide-scroll">
            {filteredUnits.map(uid=>{
              const alert=getAlert(uid);
              const pend=tasks.filter(t=>t.unitId===uid&&t.status!=='completado');
              const done=tasks.filter(t=>t.unitId===uid&&t.status==='completado');
              const total=pend.length+done.length;
              return (
                <div key={uid} onClick={()=>{setSelU(uid);setShowDone(false);setUTab('tasks');}}
                  className={`utile ${selU===uid?'usel':''}`}
                  style={{position:'relative',borderLeft:`2.5px solid ${selU===uid?'var(--gold)':'transparent'}`}}>
                  {/* Alert dot */}
                  <div style={{position:'absolute',top:8,right:8,width:7,height:7,borderRadius:'50%',background:alertColor[alert]}}/>
                  {SPECIAL[uid]
                    ? <div className="utile-n" style={{fontSize:10,paddingTop:2}}>{SPECIAL[uid].split(' ')[0]}</div>
                    : <div className="utile-n">{uid}</div>}
                  <div className="utile-l">{SPECIAL[uid]?'Esp.':'PAS'}</div>
                  {/* Progress bar */}
                  {total>0&&(
                    <div style={{height:2,borderRadius:1,background:'rgba(255,255,255,.08)',overflow:'hidden',marginTop:4}}>
                      <div style={{height:'100%',borderRadius:1,background:alertColor[alert],width:`${Math.round(done.length/total*100)}%`}}/>
                    </div>
                  )}
                  {pend.length>0&&<div style={{fontSize:8,color:'var(--muted)',marginTop:2}}>{pend.length} tarea{pend.length!==1?'s':''}</div>}
                  {(()=>{
                    const now=new Date();
                    const occ=reservations.some(r=>r.unitId===uid&&r.checkIn<=now&&r.checkOut>=now);
                    const soon=!occ&&reservations.some(r=>r.unitId===uid&&r.checkIn>now&&Math.ceil((r.checkIn-now)/(1000*60*60*24))<=3);
                    if(occ) return <div style={{fontSize:7,color:'var(--urgent)',fontWeight:800,marginTop:1}}>OCUP.</div>;
                    if(soon) return <div style={{fontSize:7,color:'var(--gold)',fontWeight:800,marginTop:1}}>PROX.</div>;
                    return null;
                  })()}
                </div>
              );
            })}
            {filteredUnits.length===0&&<div style={{textAlign:'center',padding:'20px 8px',fontSize:11,color:'var(--muted)'}}>Sin resultados</div>}
          </div>
        </div>

        {/* CONTENT */}
        <div className="ucontent">
          {/* Unit header */}
          <div style={{background:'var(--dark2)',margin:'-0px',padding:'14px 16px 12px',borderBottom:'1px solid var(--border)',marginBottom:12}}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:6}}>
              <div style={{flex:1}}>
                <div style={{fontFamily:'var(--serif)',fontSize:20,fontWeight:700,color:'#fff',lineHeight:1.1}}>{uname(selU)}</div>
                <div style={{fontSize:11,color:'rgba(255,255,255,.4)',marginTop:2}}>
                  {unitActive.length>0?`${unitActive.length} tarea${unitActive.length!==1?'s':''} activa${unitActive.length!==1?'s':''}`:'Sin tareas activas'}
                  {unitDone.length>0&&` · ${unitDone.length} completada${unitDone.length!==1?'s':''}`}
                </div>
                {reservations.length>0&&(()=>{
                  const now=new Date();
                  const mStart=new Date(now.getFullYear(),now.getMonth(),1);
                  const mEnd=new Date(now.getFullYear(),now.getMonth()+1,0);
                  const daysInMonth=mEnd.getDate();
                  let occ=0;
                  reservations.filter(r=>r.unitId===selU).forEach(r=>{
                    const s=r.checkIn<mStart?mStart:r.checkIn;
                    const e=r.checkOut>mEnd?mEnd:r.checkOut;
                    if(s<e) occ+=(e-s)/(1000*60*60*24);
                  });
                  const pct=Math.round(occ/daysInMonth*100);
                  const isOccNow=reservations.some(r=>r.unitId===selU&&r.checkIn<=now&&r.checkOut>=now);
                  return (
                    <div style={{marginTop:6,display:'flex',alignItems:'center',gap:8}}>
                      <div style={{flex:1,height:3,borderRadius:2,background:'rgba(255,255,255,.1)',overflow:'hidden'}}>
                        <div style={{height:'100%',borderRadius:2,background:pct>70?'var(--done)':pct>40?'var(--gold)':'var(--urgent)',width:pct+'%'}}/>
                      </div>
                      <div style={{fontSize:10,fontWeight:800,color:'rgba(255,255,255,.5)',whiteSpace:'nowrap'}}>{pct}% mes</div>
                      {isOccNow&&<div style={{fontSize:9,fontWeight:800,color:'var(--urgent)',background:'rgba(184,50,50,.2)',padding:'1px 6px',borderRadius:6}}>OCUPADA</div>}
                    </div>
                  );
                })()}
              </div>
              <div style={{display:'flex',gap:6}}>
                {isAdmin&&<button onClick={exportUnitPDF} style={{background:'rgba(201,150,58,.15)',color:'var(--gold)',border:'1px solid rgba(201,150,58,.3)',borderRadius:8,padding:'7px 10px',fontSize:10,fontWeight:800,cursor:'pointer',flexShrink:0}}>PDF</button>}
                <button onClick={()=>setShowNew(true)} style={{background:'var(--gold)',color:'#1a1208',border:'none',borderRadius:8,padding:'7px 11px',fontSize:11,fontWeight:800,cursor:'pointer',display:'flex',alignItems:'center',gap:4,flexShrink:0}}>
                  <span style={{fontSize:14,lineHeight:1}}>+</span> Tarea
                </button>
              </div>
            </div>
            {/* Category pills */}
            {Object.keys(catCounts).length>0&&(
              <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                {Object.entries(catCounts).map(([cat,n])=>(
                  <div key={cat} style={{fontSize:9,fontWeight:700,color:'rgba(255,255,255,.5)',background:'rgba(255,255,255,.07)',padding:'2px 7px',borderRadius:10,letterSpacing:.3,textTransform:'capitalize'}}>
                    {cat} ({n})
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tabs: Tareas / Fotos / Disponibilidad */}
          <div style={{display:'flex',borderBottom:'1px solid var(--border)',marginBottom:12}}>
            {[['tasks','Tareas'],['photos','Fotos'],['availability','Reservas']].map(([id,lbl])=>(
              <button key={id} onClick={()=>setUTab(id)} style={{
                flex:1,padding:'8px 4px',fontSize:12,fontWeight:700,border:'none',background:'none',
                color:uTab===id?'var(--gold)':'var(--muted)',cursor:'pointer',
                borderBottom:uTab===id?'2px solid var(--gold)':'2px solid transparent',
                transition:'all .15s'
              }}>{lbl}</button>
            ))}
          </div>

          {/* Level filters - only in tasks tab */}
          {uTab==='tasks'&&<div style={{display:'flex',gap:5,marginBottom:12,paddingLeft:2,flexWrap:'wrap'}}>
            {[['all','Todos'],['N1','N1'],['N2','N2'],['N3','N3']].map(([id,lbl])=>{
              const [c,bg]=id==='all'?['var(--muted)','transparent']:(LEVEL_COLORS[id]||['var(--muted)','transparent']);
              return (
                <button key={id} style={{padding:'5px 12px',borderRadius:7,fontSize:11,fontWeight:700,border:'1.5px solid',cursor:'pointer',transition:'all .12s',
                  background:lvl===id?bg:'transparent',borderColor:lvl===id?c:'var(--border)',color:lvl===id?c:'var(--muted)'
                }} onClick={()=>setLvl(id)}>{lbl}</button>
              );
            })}
          </div>}

          {uTab==='availability'?(
            /* AVAILABILITY TAB */
            (()=>{
              const now = new Date();
              const unitRes = reservations.filter(r=>r.unitId===selU).sort((a,b)=>a.checkIn-b.checkIn);
              const current = unitRes.filter(r=>r.checkIn<=now&&r.checkOut>=now);
              const upcoming = unitRes.filter(r=>r.checkIn>now);
              const daysUntil = d => Math.ceil((d-now)/(1000*60*60*24));
              const fmt = d => d.toLocaleDateString('es-VE',{day:'numeric',month:'short',year:'numeric'});
              const urgentTasks = tasks.filter(t=>t.unitId===selU&&t.status!=='completado'&&t.priority==='urgente');

              return (
                <div style={{display:'flex',flexDirection:'column',gap:12}}>
                  {reservations.length===0&&(
                    <div>
                      <div className="empty" style={{padding:'20px 0'}}>
                        <div style={{fontSize:32,marginBottom:8}}>📅</div>
                        <div className="empty-t" style={{fontSize:16}}>Sin datos de reservas</div>
                        <div className="empty-s">Subí el CSV de Hostaway para ver disponibilidad</div>
                      </div>
                      <label style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,background:'var(--gold)',color:'#1a1208',border:'none',borderRadius:10,padding:'11px',fontSize:12,fontWeight:800,cursor:'pointer',width:'100%'}}>
                        <span>&#128196;</span> Subir CSV de Hostaway
                        <input type="file" accept=".csv" style={{display:'none'}} onChange={e=>{
                          const file=e.target.files[0]; if(!file) return;
                          const rd=new FileReader();
                          rd.onload=ev=>{
                            const text=ev.target.result;
                            const res=parseHostawayCSV(text);
                            const canc=parseHostawayCancellationsCSV(text);
                            setReservations(res); saveReservations(res);
                            setCancellations(canc); saveCancellations(canc);
                          };
                          rd.readAsText(file);
                        }}/>
                      </label>
                    </div>
                  )}

                  {reservations.length>0&&(
                    <>
                      {/* Upload new CSV button */}
                      <label style={{display:'flex',alignItems:'center',gap:6,fontSize:10,color:'var(--muted)',cursor:'pointer',justifyContent:'flex-end'}}>
                        <span>&#8635; Actualizar CSV</span>
                        <input type="file" accept=".csv" style={{display:'none'}} onChange={e=>{
                          const file=e.target.files[0]; if(!file) return;
                          const rd=new FileReader();
                          rd.onload=ev=>{
                            const text=ev.target.result;
                            const res=parseHostawayCSV(text);
                            const canc=parseHostawayCancellationsCSV(text);
                            setReservations(res); saveReservations(res);
                            setCancellations(canc); saveCancellations(canc);
                          };
                          rd.readAsText(file);
                        }}/>
                      </label>

                      {/* Urgent task warning */}
                      {urgentTasks.length>0&&upcoming.length>0&&daysUntil(upcoming[0].checkIn)<=3&&(
                        <div style={{background:'rgba(184,50,50,.1)',border:'1.5px solid rgba(184,50,50,.3)',borderRadius:10,padding:'10px 12px',display:'flex',gap:8,alignItems:'center'}}>
                          <span style={{fontSize:18}}>⚠️</span>
                          <div>
                            <div style={{fontSize:12,fontWeight:700,color:'var(--urgent)'}}>Check-in en {daysUntil(upcoming[0].checkIn)} día{daysUntil(upcoming[0].checkIn)!==1?'s':''}</div>
                            <div style={{fontSize:10,color:'var(--muted)'}}>{urgentTasks.length} tarea{urgentTasks.length!==1?'s':''} urgente{urgentTasks.length!==1?'s':''} sin resolver</div>
                          </div>
                        </div>
                      )}

                      {/* Current occupancy */}
                      <div style={{background:current.length>0?'rgba(184,50,50,.08)':'rgba(45,110,78,.08)',border:`1.5px solid ${current.length>0?'rgba(184,50,50,.25)':'rgba(45,110,78,.25)'}`,borderRadius:10,padding:'12px 14px'}}>
                        <div style={{fontSize:11,fontWeight:800,color:current.length>0?'var(--urgent)':'var(--done)',textTransform:'uppercase',letterSpacing:.5,marginBottom:4}}>
                          {current.length>0?'🔴 Ocupada ahora':'🟢 Disponible ahora'}
                        </div>
                        {current.map((r,i)=>(
                          <div key={i}>
                            <div style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>{r.guest}</div>
                            <div style={{fontSize:10,color:'var(--muted)',marginTop:2}}>{fmt(r.checkIn)} → {fmt(r.checkOut)} · {daysUntil(r.checkOut)} días restantes</div>
                          </div>
                        ))}
                      </div>

                      {/* Upcoming */}
                      {upcoming.length>0&&(
                        <div>
                          <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:1.5,fontWeight:800,marginBottom:8}}>Próximas reservas</div>
                          <div style={{display:'flex',flexDirection:'column',gap:6}}>
                            {upcoming.slice(0,5).map((r,i)=>{
                              const days = daysUntil(r.checkIn);
                              const urgent = tasks.filter(t=>t.unitId===selU&&t.status!=='completado'&&t.priority==='urgente').length>0&&days<=3;
                              return (
                                <div key={i} style={{background:'var(--surface)',border:`1px solid ${urgent?'rgba(184,50,50,.3)':'var(--border)'}`,borderRadius:10,padding:'10px 12px'}}>
                                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                                    <div style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>{r.guest}</div>
                                    <div style={{fontSize:10,fontWeight:800,color:days<=3?'var(--urgent)':days<=7?'var(--gold)':'var(--done)',background:days<=3?'rgba(184,50,50,.1)':days<=7?'rgba(201,150,58,.1)':'rgba(45,110,78,.1)',padding:'2px 8px',borderRadius:10}}>
                                      {days===0?'Hoy':days===1?'Mañana':`En ${days}d`}
                                    </div>
                                  </div>
                                  <div style={{fontSize:10,color:'var(--muted)',marginTop:3}}>{fmt(r.checkIn)} → {fmt(r.checkOut)}</div>
                                  {r.income&&<div style={{fontSize:10,color:'var(--done)',marginTop:2,fontWeight:600}}>{r.income}</div>}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {current.length===0&&upcoming.length===0&&(
                        <div className="empty" style={{padding:'20px 0'}}>
                          <div style={{fontSize:28,marginBottom:6}}>✅</div>
                          <div className="empty-t" style={{fontSize:16}}>Sin reservas próximas</div>
                          <div className="empty-s">Esta unidad no tiene reservas futuras</div>
                        </div>
                      )}

                      {/* Historical reservations */}
                      {(()=>{
                        const past = unitRes.filter(r=>r.checkOut<now).sort((a,b)=>b.checkOut-a.checkOut);
                        if (past.length===0) return null;
                        return (
                          <div style={{marginTop:8}}>
                            <details>
                              <summary style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:1.5,fontWeight:800,cursor:'pointer',listStyle:'none',display:'flex',alignItems:'center',gap:6,padding:'6px 0'}}>
                                <span style={{flex:1,height:1,background:'var(--border)',display:'inline-block'}}/>
                                <span>Historial ({past.length})</span>
                                <span style={{flex:1,height:1,background:'var(--border)',display:'inline-block'}}/>
                              </summary>
                              <div style={{display:'flex',flexDirection:'column',gap:6,marginTop:8}}>
                                {past.map((r,i)=>{
                                  const nights = Math.round((r.checkOut-r.checkIn)/(1000*60*60*24));
                                  return (
                                    <div key={i} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',opacity:.75}}>
                                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                                        <div style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>{r.guest}</div>
                                        <div style={{fontSize:10,color:'var(--muted)'}}>{nights} noche{nights!==1?'s':''}</div>
                                      </div>
                                      <div style={{fontSize:10,color:'var(--muted)',marginTop:2}}>{fmt(r.checkIn)} → {fmt(r.checkOut)}</div>
                                      {r.income&&<div style={{fontSize:10,color:'var(--done)',marginTop:2,fontWeight:600}}>{r.income}</div>}
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              );
            })()
          ):uTab==='photos'?(
            /* PHOTOS GALLERY */
            (()=>{
              const allPhotos = tasks.filter(t=>t.unitId===selU).flatMap(t=>{
                const starts    = t.photosStart?.length    ? t.photosStart    : (t.photoStart    ? [t.photoStart]    : []);
                const completes = t.photosComplete?.length ? t.photosComplete : (t.photoComplete ? [t.photoComplete] : []);
                return [
                  ...starts.map(src=>({src, label:'Inicio', task:t})),
                  ...completes.map(src=>({src, label:'Final', task:t})),
                ];
              });
              return allPhotos.length===0
                ? <div className="empty" style={{padding:'28px 0'}}><div className="empty-icon">📷</div><div className="empty-t" style={{fontSize:18}}>Sin fotos</div><div className="empty-s">No hay fotos en las tareas de esta unidad.</div></div>
                : <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>{allPhotos.map((p,i)=>(
                    <div key={i} style={{borderRadius:10,overflow:'hidden',border:'1px solid var(--border)',cursor:'zoom-in'}} onClick={()=>setLightbox(p)}>
                      <img src={p.src} style={{width:'100%',aspectRatio:'1',objectFit:'cover',display:'block'}}/>
                      <div style={{padding:'5px 7px',background:'var(--surface)'}}>
                        <div style={{fontSize:9,fontWeight:700,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.5}}>{p.label}</div>
                        <div style={{fontSize:10,color:'var(--text)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.task.title}</div>
                      </div>
                    </div>
                  ))}
                </div>;
            })()
          ):loading?<div className="spinner"/>:(
            <>
              {unitActive.length===0&&unitDone.length===0&&(
                <div className="empty" style={{padding:'28px 0'}}>
                  <div className="empty-icon"><Ic d={D.check} sz={20} col="var(--done)"/></div>
                  <div className="empty-t" style={{fontSize:18}}>Sin tareas</div>
                  <div className="empty-s">Esta unidad no tiene tareas.</div>
                </div>
              )}
              <div style={{display:'flex',flexDirection:'column',gap:7}}>
                {unitActive.map(task=>{
                  const pc=pColor(task.priority);
                  return (
                    <div key={task.id} className="tcard">
                      <div className="tbar" style={{background:pc}}/>
                      <div className="tbody" onClick={()=>setEditT(task)}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                          <div style={{display:'flex',gap:4,alignItems:'center'}}>
                            <span style={{fontSize:9,color:pc,fontWeight:800,background:`${pc}18`,padding:'2px 6px',borderRadius:4}}>{task.level}</span>
                            {task.category&&<span style={{fontSize:9,color:'var(--muted)',textTransform:'capitalize'}}>{task.category}</span>}
                          </div>
                          <span className="tprio" style={{color:pc}}>{PRIOS.find(p=>p.id===task.priority)?.label}</span>
                        </div>
                        <div className="ttitle">{task.title}</div>
                        {task.description&&<div className="tdesc">{task.description}</div>}
                        <div className="tmeta">
                          {task.assignee&&<span className="mchip">👤 {task.assignee}</span>}
                          {task.dueDate&&new Date(task.dueDate)<new Date()&&<span className="mchip mchip-od">⚠ Vencida</span>}
                          <span style={{flex:1}}/>
                          <span className={`sbadge sb-${task.status}`}>{STATS.find(s=>s.id===task.status)?.label}</span>
                        </div>
                      </div>
                      <div className="tactions">
                        <button className="tact" onClick={e=>{e.stopPropagation();toggleDone(task);}}><Ic d={D.check} sz={14} col="var(--done)" sw={2.5}/></button>
                        <button className="tact" onClick={e=>{e.stopPropagation();delTask(task);}}><Ic d={D.trash} sz={13} col="var(--urgent)"/></button>
                      </div>
                    </div>
                  );
                })}

                {/* Completadas colapsables */}
                {unitDone.length>0&&(
                  <button onClick={()=>setShowDone(p=>!p)} style={{display:'flex',alignItems:'center',gap:6,background:'none',border:'none',cursor:'pointer',padding:'8px 2px',color:'var(--muted)'}}>
                    <div style={{flex:1,height:1,background:'var(--border)'}}/>
                    <span style={{fontSize:9,fontWeight:800,textTransform:'uppercase',letterSpacing:1,whiteSpace:'nowrap'}}>
                      {showDone?'▲':'▼'} Completadas ({unitDone.length})
                    </span>
                    <div style={{flex:1,height:1,background:'var(--border)'}}/>
                  </button>
                )}
                {showDone&&unitDone.map(task=>(
                  <div key={task.id} className="tcard tdone">
                    <div className="tbar" style={{background:'var(--done)'}}/>
                    <div className="tbody" onClick={()=>setEditT(task)}>
                      <div style={{fontSize:13,fontWeight:600,textDecoration:'line-through',color:'var(--muted)'}}>{task.title}</div>
                      {task.category&&<div style={{fontSize:10,color:'var(--muted)',marginTop:2,textTransform:'capitalize'}}>{task.level} · {task.category}</div>}
                    </div>
                    <div className="tactions">
                      <button className="tact" onClick={e=>{e.stopPropagation();toggleDone(task);}}><Ic d={D.undo} sz={13} col="var(--muted)"/></button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {lightbox&&(
        <div onClick={()=>setLightbox(null)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,.93)',zIndex:200,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:16}}>
          <img src={lightbox.src} style={{maxWidth:'100%',maxHeight:'80vh',borderRadius:12,objectFit:'contain'}}/>
          <div style={{marginTop:12,textAlign:'center'}}>
            <div style={{fontSize:12,color:'rgba(255,255,255,.7)',fontWeight:600}}>{lightbox.task.title}</div>
            <div style={{fontSize:10,color:'rgba(255,255,255,.4)',marginTop:3}}>{lightbox.label} · {lightbox.task.level} · {lightbox.task.category}</div>
          </div>
          <button onClick={()=>setLightbox(null)} style={{position:'absolute',top:16,right:16,background:'rgba(255,255,255,.1)',border:'1px solid rgba(255,255,255,.15)',color:'#fff',width:36,height:36,borderRadius:50,fontSize:20,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>×</button>
        </div>
      )}
      {showNew&&<NewTaskModal onClose={()=>setShowNew(false)} onSaved={()=>{setShowNew(false);reloadTasks();}} defaultUnitId={selU}/>}
      {editT&&<TaskDetailModal task={editT} onClose={()=>setEditT(null)} onUpdated={()=>{setEditT(null);reloadTasks();}}/>}
    </div>
  );
}

/* MEASUREMENT DETAIL MODAL */
function MeasDetailModal({ meas, type, unit2, measurements, uname, authFetch, onClose, onUpdated }) {
  const [editVal, setEditVal] = useState(String(meas.value));
  const [busy, setBusy] = useState(false);

  const histAll = measurements
    .filter(m=>m.unitId===meas.unitId && m.type===type)
    .sort((a,b)=>a.week.localeCompare(b.week));
  const hist = histAll.map((m,idx)=>{
    const prev = idx>0 ? histAll[idx-1] : null;
    const cons = prev ? m.value - prev.value : null;
    return { ...m, cons };
  }).reverse();

  const guardar = async () => {
    const v = parseFloat(editVal);
    if (isNaN(v)) return;
    setBusy(true);
    const r = await authFetch(`/measurements/${meas.id}`,{method:'PATCH',body:JSON.stringify({value:v})});
    if (r.ok) onUpdated();
    setBusy(false);
  };

  const borrar = async () => {
    if (!confirm(`¿Borrar la medición de ${uname(meas.unitId)} (${meas.value} ${unit2})?`)) return;
    setBusy(true);
    const r = await authFetch(`/measurements/${meas.id}`,{method:'DELETE'});
    if (r.ok || r.status===204) onUpdated();
    setBusy(false);
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{maxWidth:380}}>
        <div className="mhandle"/>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
          <div className="mtitle" style={{marginBottom:0}}>{uname(meas.unitId)}</div>
          <span style={{fontSize:11,color:'var(--muted)',background:'var(--bg)',borderRadius:6,padding:'3px 8px'}}>{type==='agua'?'💧 Agua':'⚡ Luz'}</span>
        </div>
        <div style={{fontSize:11,color:'var(--muted)',marginBottom:14}}>Semana {meas.week?.split('-W')[1]} · {meas.week?.split('-W')[0]}</div>

        <div style={{marginBottom:8}}>
          <div style={{fontSize:11,fontWeight:600,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.5,marginBottom:5}}>Lectura ({unit2})</div>
          <input className="minp" type="number" inputMode="decimal" value={editVal} onChange={e=>setEditVal(e.target.value)} style={{fontSize:18,fontWeight:700}}/>
        </div>

        <div style={{display:'flex',gap:8,marginBottom:18}}>
          <button onClick={borrar} disabled={busy} style={{flex:1,background:'var(--urgent-bg)',color:'var(--urgent)',border:'1px solid var(--urgent)',borderRadius:9,padding:'11px',fontWeight:700,fontSize:13,cursor:'pointer'}}>
            Borrar
          </button>
          <button onClick={guardar} disabled={busy||editVal===String(meas.value)} style={{flex:2,background:editVal!==String(meas.value)?'var(--gold)':'var(--border)',color:'#fff',border:'none',borderRadius:9,padding:'11px',fontWeight:700,fontSize:14,cursor:'pointer'}}>
            {busy?'Guardando...':'Guardar cambios'}
          </button>
        </div>

        <div style={{fontSize:11,fontWeight:700,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.6,marginBottom:8}}>Historial de {uname(meas.unitId)}</div>
        <div style={{maxHeight:240,overflowY:'auto',background:'var(--bg)',borderRadius:10,padding:'4px 0'}}>
          {hist.length===0?(
            <div style={{fontSize:12,color:'var(--muted)',textAlign:'center',padding:'16px'}}>Sin historial</div>
          ):hist.map((h,k)=>(
            <div key={h.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 14px',borderBottom:k<hist.length-1?'1px solid var(--border)':'none',background:h.id===meas.id?'rgba(201,150,58,.08)':'transparent'}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>Sem. {h.week?.split('-W')[1]}</div>
                <div style={{fontSize:10,color:'var(--muted)'}}>{h.week?.split('-W')[0]}</div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>{h.value} <span style={{fontSize:9,fontWeight:400,color:'var(--muted)'}}>{unit2}</span></div>
                {h.cons!=null&&(
                  <div style={{fontSize:10,fontWeight:700,color:h.cons<0?'var(--urgent)':h.cons>0?'var(--done)':'var(--muted)'}}>
                    {h.cons>=0?'+':''}{h.cons.toFixed(1)} {unit2}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* RECORDS SCREEN */
function RecordsScreen() {
  const { user, authFetch, measurements:globalM, measFetching, fetchMeasurements, reloadMeasurements, setMeasurements } = useAuth();
  const isAdmin = user?.username === 'admin';
  const measurements = globalM || [];
  const loading = globalM === null;
  const setM = setMeasurements;
  const [type,      setType]     = useState('agua');
  const [viewMode,  setViewMode] = useState('week'); // 'week' | 'month' | 'year'
  const [offset,    setOffset]   = useState(0);      // weeks/months/years back
  const [showAdd,   setShowAdd]  = useState(false);
  const [saveAlert, setSaveAlert] = useState(null);
  const [nm, setNm] = useState({unitId:1,type:'agua',value:''});
  const [showScan,  setShowScan]  = useState(false);
  const [scanIdx,   setScanIdx]   = useState(0);
  const [scanVal,   setScanVal]   = useState('');
  const [scanSaved, setScanSaved] = useState(false);
  const [scanDone,  setScanDone]  = useState(false);
  const [scanResults, setScanResults] = useState([]);
  const [showCompare, setShowCompare] = useState(false);
  const [selMeas, setSelMeas] = useState(null); // medición seleccionada para ver/editar
  const scanUnits = UNIT_IDS.filter(id=>id!==100&&id!==101);

  // ── ISO week helpers ──────────────────────────────────────────
  const getISOWeek = (offsetWeeks) => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() - offsetWeeks * 7);
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wn = Math.ceil((((d - ys) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(wn).padStart(2,'0')}`;
  };

  const weeksInMonth = (year, month) => {
    const weeks = new Set();
    const d = new Date(year, month, 1);
    while (d.getMonth() === month) {
      weeks.add(getISOWeekFromDate(new Date(d)));
      d.setDate(d.getDate() + 1);
    }
    return [...weeks];
  };

  const getISOWeekFromDate = (date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wn = Math.ceil((((d - ys) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(wn).padStart(2,'0')}`;
  };

  const weekLabelShort = (ws) => {
    const [yr, wn] = ws.split('-W');
    return `Sem. ${wn}`;
  };

  // ── Period navigation ─────────────────────────────────────────
  const now = new Date();

  const currentWeek  = getISOWeek(0);
  const currentMonth = { year: now.getFullYear(), month: now.getMonth() };
  const currentYear  = now.getFullYear();

  const periodLabel = () => {
    const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    if (viewMode === 'week') {
      const ws = getISOWeek(offset);
      return `Semana ${ws.split('-W')[1]} · ${ws.split('-W')[0]}`;
    }
    if (viewMode === 'month') {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    }
    return `${now.getFullYear() - offset}`;
  };

  const periodSub = () => {
    if (viewMode === 'week') return getISOWeek(offset);
    if (viewMode === 'month') {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const wks = weeksInMonth(d.getFullYear(), d.getMonth());
      return `${wks.length} semanas`;
    }
    return `${now.getFullYear() - offset}`;
  };

  useEffect(()=>{ fetchMeasurements(); },[]);
  const load = useCallback(()=>{ reloadMeasurements(); },[reloadMeasurements]);

  // ── Derived data by view mode ─────────────────────────────────
  const getWeekData = () => {
    const ws = getISOWeek(offset);
    const prevWs = getISOWeek(offset + 1);
    const prev2Ws = getISOWeek(offset + 2);
    const rows = measurements.filter(m => m.type===type && m.week===ws);
    return rows.map(m => {
      const prev  = measurements.find(p=>p.unitId===m.unitId&&p.type===type&&p.week===prevWs);
      const prev2 = measurements.find(p=>p.unitId===m.unitId&&p.type===type&&p.week===prev2Ws);
      const consumption = prev != null ? m.value - prev.value : null;
      let alert = null;
      if (prev && prev2) {
        const cC = m.value - prev.value;
        const cP = prev.value - prev2.value;
        if (cP > 0 && cC >= 0) {
          const pct = ((cC - cP) / cP) * 100;
          if (Math.abs(pct) >= 20) alert = { pct: Math.round(pct), direction: pct > 0 ? 'up' : 'down' };
        }
      }
      return { ...m, consumption, alert, label: uname(m.unitId), sub: null };
    });
  };

  // ── Per-unit grouped data for month/year views ───────────────
  const getPrevWeekOf = (ws) => {
    // Parse YYYY-Www and subtract 7 days to get previous week string
    const [yr, wn] = ws.split('-W').map(Number);
    // Find the Monday of that ISO week
    const jan4 = new Date(Date.UTC(yr, 0, 4)); // Jan 4 is always in week 1
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay()||7) - 1) + (wn - 1) * 7);
    // Subtract 7 days → previous week Monday
    monday.setUTCDate(monday.getUTCDate() - 7);
    const day = monday.getUTCDay() || 7;
    const thu = new Date(monday); thu.setUTCDate(monday.getUTCDate() + 4 - day);
    const ys = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
    const pwn = Math.ceil((((thu - ys) / 86400000) + 1) / 7);
    return `${thu.getUTCFullYear()}-W${String(pwn).padStart(2,'0')}`;
  };

  const getMonthUnits = () => {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const wks = weeksInMonth(d.getFullYear(), d.getMonth());
    return UNIT_IDS.map(uid => {
      const periods = wks.map(ws => {
        const cur  = measurements.find(m=>m.unitId===uid&&m.type===type&&m.week===ws);
        const prevWs = getPrevWeekOf(ws);
        const prev = prevWs ? measurements.find(m=>m.unitId===uid&&m.type===type&&m.week===prevWs) : null;
        const consumption = cur && prev!=null ? cur.value - prev.value : null;
        return { label: weekLabelShort(ws), value: cur?.value??null, consumption };
      }).filter(p => p.value !== null);
      if (!periods.length) return null;
      const total = periods.reduce((s,p)=>p.consumption!=null?s+(p.consumption):s, 0);
      const hasTotal = periods.some(p=>p.consumption!=null);
      return { uid, unitLabel: uname(uid), periods, total: hasTotal?total:null };
    }).filter(Boolean);
  };

  const getYearUnits = () => {
    const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const year = now.getFullYear() - offset;
    return UNIT_IDS.map(uid => {
      const periods = Array.from({length:12},(_,mi)=>{
        const wks = weeksInMonth(year, mi);
        const thisMs = measurements.filter(m=>m.unitId===uid&&m.type===type&&wks.includes(m.week));
        let monthConsumption = null;
        thisMs.forEach(m => {
          const prevWk = getPrevWeekOf(m.week);
          const prev = prevWk ? measurements.find(p=>p.unitId===uid&&p.type===type&&p.week===prevWk) : null;
          if (prev!=null) monthConsumption = (monthConsumption||0) + (m.value - prev.value);
        });
        return { label: MONTHS[mi], consumption: monthConsumption, hasData: thisMs.length > 0 };
      }).filter(p => p.hasData);
      if (!periods.length) return null;
      const total = periods.reduce((s,p)=>p.consumption!=null?s+p.consumption:s, 0);
      const hasTotal = periods.some(p=>p.consumption!=null);
      return { uid, unitLabel: uname(uid), periods, total: hasTotal?total:null };
    }).filter(Boolean);
  };

  const rows = viewMode==='week' ? getWeekData() : [];
  const unitGroups = viewMode==='month' ? getMonthUnits() : viewMode==='year' ? getYearUnits() : [];
  const unit2 = type==='agua'?'m³':'kWh';

  // ── Ranking comparativo: total de consumo por unidad en el período ──
  const compareData = (() => {
    const groups = viewMode==='week'
      ? rows.filter(r=>r.consumption!=null).map(r=>({uid:r.unitId,label:r.label,total:r.consumption}))
      : unitGroups.filter(g=>g.total!=null).map(g=>({uid:g.uid,label:g.unitLabel,total:g.total}));
    return groups.sort((a,b)=>b.total-a.total);
  })();
  const maxCompare = compareData.length ? Math.max(...compareData.map(d=>Math.abs(d.total))) : 0;

  // ── Save ──────────────────────────────────────────────────────
  const currentWeekStr = getISOWeek(viewMode==='week'?offset:0);
  const prevWeekStr    = getISOWeek(viewMode==='week'?offset+1:1);
  const unitN = parseInt(nm.unitId);
  const previewPrev = measurements.find(m=>m.unitId===unitN&&m.type===nm.type&&m.week===prevWeekStr);
  const previewC = nm.value && previewPrev ? Number(nm.value) - previewPrev.value : null;

  const getAlertForSave = (unitId, t, allM) => {
    const ws  = getISOWeek(0);
    const pw  = getISOWeek(1);
    const p2w = getISOWeek(2);
    const cur  = allM.find(m=>m.unitId===unitId&&m.type===t&&m.week===ws);
    const prev = allM.find(m=>m.unitId===unitId&&m.type===t&&m.week===pw);
    const p2   = allM.find(m=>m.unitId===unitId&&m.type===t&&m.week===p2w);
    if(!cur||!prev||!p2) return null;
    const cC=cur.value-prev.value, cP=prev.value-p2.value;
    if(cP<=0||cC<0) return null;
    const pct=((cC-cP)/cP)*100;
    if(Math.abs(pct)<20) return null;
    return {pct:Math.round(pct),direction:pct>0?'up':'down'};
  };

  const save = async () => {
    const r = await authFetch('/measurements',{method:'POST',body:JSON.stringify({
      unitId:Number(nm.unitId), type:nm.type, value:Number(nm.value), week:currentWeekStr
    })});
    if (r.ok) {
      setShowAdd(false);
      const allM = await authFetch('/measurements').then(r2=>r2.ok?r2.json():[]);
      setM(allM);
      const alert = getAlertForSave(Number(nm.unitId), nm.type, allM);
      if (alert) setSaveAlert({unitId:Number(nm.unitId), type:nm.type, ...alert});
    }
  };

  // ── Downloads (mes completo) ────────────────────────────────
  const getMonthExportData = () => {
    // Always export the current visible month, week by week, all units
    const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const d = new Date(now.getFullYear(), now.getMonth() - (viewMode==='month'?offset:0), 1);
    const monthLabel = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const wks = weeksInMonth(d.getFullYear(), d.getMonth());
    const unit = type==='agua'?'m³':'kWh';

    // Build rows: one per unit per week
    const exportRows = [];
    for (const ws of wks) {
      const prevWs = (() => { for(let i=1;i<54;i++){if(getISOWeek(i)===ws)return getISOWeek(i+1);} return null; })();
      const prev2Ws = prevWs ? (() => { for(let i=1;i<54;i++){if(getISOWeek(i)===prevWs)return getISOWeek(i+1);} return null; })() : null;
      const wkMeasurements = measurements.filter(m=>m.type===type&&m.week===ws);
      for (const m of wkMeasurements) {
        const prev  = prevWs  ? measurements.find(p=>p.unitId===m.unitId&&p.type===type&&p.week===prevWs)  : null;
        const prev2 = prev2Ws ? measurements.find(p=>p.unitId===m.unitId&&p.type===type&&p.week===prev2Ws) : null;
        const consumption = prev!=null ? m.value - prev.value : null;
        let alert = null;
        if (prev && prev2) {
          const cC = m.value - prev.value, cP = prev.value - prev2.value;
          if (cP > 0 && cC >= 0) {
            const pct = ((cC-cP)/cP)*100;
            if (Math.abs(pct)>=20) alert = {pct:Math.round(pct), direction:pct>0?'up':'down'};
          }
        }
        exportRows.push({ week: ws, unitLabel: uname(m.unitId), value: m.value, consumption, alert, unit });
      }
    }
    return { monthLabel, exportRows, unit, wks };
  };

  const downloadCSV = () => {
    const { monthLabel, exportRows, unit } = getMonthExportData();
    const header = `Semana,Unidad,Lectura (${unit}),Consumo (${unit}),Alerta`;
    const body = exportRows.map(r =>
      `"${r.week}","${r.unitLabel}",${r.value},${r.consumption!=null?r.consumption.toFixed(1):''},${r.alert?(r.alert.direction==='up'?'+':'')+r.alert.pct+'%':''}`
    ).join('\n');
    const csv = `Porta Al Sole - Registros de ${type}\nMes: ${monthLabel}\nTipo: ${type==='agua'?'Agua (m³)':'Luz (kWh)'}\n\n${header}\n${body}`;
    const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `registros-${type}-${monthLabel.replace(/\s/g,'-')}.csv`;
    a.click();
  };

  const downloadPDF = () => {
    const { monthLabel, exportRows, unit, wks } = getMonthExportData();
    const th = (txt, align='left') => `<th style="padding:7px 10px;text-align:${align};font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#8b7355;border-bottom:2px solid #c9963a;white-space:nowrap">${txt}</th>`;
    const headers = `${th('Semana')}${th('Unidad')}${th('Lectura',  'right')}${th('Consumo','right')}${th('Alerta','center')}`;

    // Group rows by week for visual separation
    let tableRows = '';
    let lastWeek = '';
    for (const r of exportRows) {
      const weekHeader = r.week !== lastWeek
        ? `<tr><td colspan="5" style="padding:10px 10px 4px;font-size:10px;font-weight:700;color:#c9963a;letter-spacing:1px;text-transform:uppercase;background:#faf5ec;border-bottom:1px solid #e4d9c8">${r.week}</td></tr>`
        : '';
      lastWeek = r.week;
      const cColor = r.consumption!=null ? (r.consumption>0?'#2d6e4e':r.consumption<0?'#b83232':'#8b7355') : '#8b7355';
      const alertCell = r.alert
        ? `<span style="color:${r.alert.direction==='up'?'#b83232':'#2d6e4e'};font-weight:700;font-size:11px">${r.alert.direction==='up'?'▲':'▼'} ${Math.abs(r.alert.pct)}%</span>`
        : '<span style="color:#ccc">—</span>';
      tableRows += `${weekHeader}<tr style="background:#fff">
        <td style="padding:6px 10px;border-bottom:1px solid #f0e8da;font-size:11px;color:#8b7355">${r.week}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0e8da;font-weight:600;font-size:12px">${r.unitLabel}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0e8da;text-align:right;font-size:12px">${r.value} ${r.unit}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0e8da;text-align:right;color:${cColor};font-weight:700;font-size:12px">${r.consumption!=null?(r.consumption>=0?'+':'')+r.consumption.toFixed(1)+' '+r.unit:'Sin ref.'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0e8da;text-align:center">${alertCell}</td>
      </tr>`;
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Registros ${type} - ${monthLabel}</title>
    <style>
      body{font-family:'Georgia',serif;background:#f7f2eb;color:#1a1208;padding:28px;max-width:720px;margin:0 auto}
      .logo{font-size:26px;font-weight:700;color:#c9963a;letter-spacing:-0.5px}
      .sub{font-size:10px;color:#8b7355;letter-spacing:3px;text-transform:uppercase;margin:2px 0 20px}
      .meta{display:flex;align-items:center;gap:12px;margin-bottom:20px}
      .badge{padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px}
      .agua{background:rgba(36,113,163,.1);color:#2471a3}.luz{background:rgba(201,150,58,.1);color:#c9963a}
      .period{font-size:16px;font-weight:600}
      table{width:100%;border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #e4d9c8}
      .footer{margin-top:18px;font-size:10px;color:#8b7355;display:flex;justify-content:space-between}
      @media print{body{background:#fff;padding:12px}@page{margin:1cm}}
    </style></head>
    <body>
    <div class="logo">Porta Al Sole</div>
    <div class="sub">Reporte mensual de registros</div>
    <div class="meta">
      <span class="badge ${type}">${type==='agua'?'💧 Agua':'⚡ Luz'}</span>
      <span class="period">${monthLabel}</span>
      <span style="font-size:11px;color:#8b7355">${exportRows.length} registros · ${wks.length} semanas</span>
    </div>
    <table><thead><tr style="background:#f7f2eb">${headers}</tr></thead><tbody>${tableRows}</tbody></table>
    <div class="footer">
      <span>Porta Al Sole · Sistema de Mantenimiento</span>
      <span>Generado el ${new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'long',year:'numeric'})}</span>
    </div>
    <script>window.onload=()=>window.print()<\/script>
    </body></html>`;

    const blob = new Blob([html], {type:'text/html'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `registros-${type}-${monthLabel.replace(/\s/g,'-')}.html`;
    a.click();
  };

  // ── Render ────────────────────────────────────────────────────
  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',overflow:'hidden'}}>
      <div className="rhead">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
          <div className="header-title">Registros</div>
          <div style={{display:'flex',gap:5}}>
            {isAdmin&&<button className="hbtn" title="Descargar CSV" onClick={downloadCSV}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              <span style={{fontSize:9,letterSpacing:.5,marginLeft:2}}>CSV</span>
            </button>}
            {isAdmin&&<button className="hbtn" title="Descargar PDF" onClick={downloadPDF}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              <span style={{fontSize:9,letterSpacing:.5,marginLeft:2}}>PDF</span>
            </button>}
            {viewMode==='week'&&<button className="hbtn" style={{background:'rgba(201,150,58,.15)',border:'1px solid rgba(201,150,58,.3)',color:'var(--gold2)',padding:'5px 10px',borderRadius:8,fontSize:11,fontWeight:700,display:'flex',alignItems:'center',gap:5}} onClick={()=>{setScanIdx(0);setScanVal('');setScanDone(false);setScanResults([]);setShowScan(true);}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
              Toma rápida
            </button>}
            {viewMode==='week'&&<button className="hbtn hbtn-g" onClick={()=>setShowAdd(true)}><Ic d={D.plus} sz={14}/></button>}
          </div>
        </div>

        {/* Type selector */}
        <div className="rtype-row">
          <button className={`rtbtn ${type==='agua'?'rt-agua':''}`} style={{opacity:type==='agua'?1:.45}} onClick={()=>setType('agua')}>💧 Agua</button>
          <button className={`rtbtn ${type==='luz'?'rt-luz':''}`}  style={{opacity:type==='luz'?1:.45}}  onClick={()=>setType('luz')}>⚡ Luz</button>
        </div>

        {/* View mode selector */}
        <div style={{display:'flex',gap:4,marginBottom:8}}>
          {['week','month','year'].map(m=>(
            <button key={m} onClick={()=>{setViewMode(m);setOffset(0);}} style={{
              flex:1,padding:'5px 4px',borderRadius:7,border:'1.5px solid',fontFamily:'var(--sans)',
              fontSize:11,fontWeight:700,cursor:'pointer',transition:'all .12s',
              background:viewMode===m?'rgba(201,150,58,.18)':'rgba(255,255,255,.04)',
              borderColor:viewMode===m?'rgba(201,150,58,.45)':'rgba(255,255,255,.08)',
              color:viewMode===m?'var(--gold2)':'rgba(255,255,255,.35)',
            }}>
              {m==='week'?'Semana':m==='month'?'Mes':'Año'}
            </button>
          ))}
        </div>

        {/* Period nav */}
        <div className="rweek-row">
          <button className="rwbtn" onClick={()=>setOffset(o=>o+1)}>‹</button>
          <div className="rwlbl">{periodLabel()}</div>
          <button className="rwbtn" onClick={()=>setOffset(o=>Math.max(0,o-1))} disabled={offset===0} style={{opacity:offset===0?.3:1}}>›</button>
        </div>
        <div style={{fontSize:10,color:'rgba(255,255,255,.3)',textAlign:'center',marginTop:2}}>{periodSub()}</div>
        {/* Toggle vista comparativa */}
        <button onClick={()=>setShowCompare(c=>!c)} style={{
          width:'100%',marginTop:8,padding:'6px',borderRadius:7,border:'1.5px solid',
          fontSize:11,fontWeight:700,cursor:'pointer',transition:'all .12s',
          display:'flex',alignItems:'center',justifyContent:'center',gap:6,
          background:showCompare?'rgba(201,150,58,.18)':'rgba(255,255,255,.04)',
          borderColor:showCompare?'rgba(201,150,58,.45)':'rgba(255,255,255,.08)',
          color:showCompare?'var(--gold2)':'rgba(255,255,255,.4)',
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
          {showCompare?'Ver detalle':'Comparar unidades'}
        </button>
      </div>

      {/* Alert banner */}
      {saveAlert&&(
        <div style={{background:saveAlert.direction==='up'?'rgba(184,50,50,.12)':'rgba(45,110,78,.12)',borderBottom:`2px solid ${saveAlert.direction==='up'?'var(--urgent)':'var(--done)'}`,padding:'9px 14px',display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
          <span style={{fontSize:18}}>{saveAlert.direction==='up'?'⚠️':'📉'}</span>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:700,color:saveAlert.direction==='up'?'var(--urgent)':'var(--done)'}}>
              {saveAlert.direction==='up'?'Consumo elevado':'Consumo reducido'} — {uname(saveAlert.unitId)}
            </div>
            <div style={{fontSize:11,color:'var(--muted)',marginTop:1}}>
              El consumo de {saveAlert.type} {saveAlert.direction==='up'?'subió':'bajó'} un <strong>{Math.abs(saveAlert.pct)}%</strong> vs semana anterior
            </div>
          </div>
          <button onClick={()=>setSaveAlert(null)} style={{color:'var(--muted)',padding:4,fontSize:16,background:'none',border:'none',cursor:'pointer'}}>×</button>
        </div>
      )}

      <div className="page">
        {loading?<div className="spinner"/>:(

          showCompare ? (
            compareData.length===0 ? (
              <div className="empty">
                <div className="empty-icon"><span style={{fontSize:22}}>📊</span></div>
                <div className="empty-t">Sin datos para comparar</div>
                <div className="empty-s">No hay consumo calculable de {type} en este período.</div>
              </div>
            ) : (
              <div style={{padding:'12px 13px',paddingBottom:80}}>
                <div style={{fontSize:11,color:'var(--muted)',marginBottom:12,textTransform:'uppercase',letterSpacing:.6,fontWeight:700}}>
                  Ranking de consumo · {type==='agua'?'Agua':'Luz'}
                </div>
                {compareData.map((d,i)=>{
                  const pct = maxCompare>0 ? Math.abs(d.total)/maxCompare*100 : 0;
                  const isNeg = d.total<0;
                  return (
                    <div key={d.uid} style={{marginBottom:11}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:3}}>
                        <span style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>
                          <span style={{color:'var(--muted)',fontSize:11,marginRight:6}}>{i+1}.</span>{d.label}
                        </span>
                        <span style={{fontSize:13,fontWeight:700,color:isNeg?'var(--urgent)':'var(--gold)'}}>
                          {d.total>=0?'+':''}{d.total.toFixed(1)} <span style={{fontSize:10,fontWeight:400,color:'var(--muted)'}}>{unit2}</span>
                        </span>
                      </div>
                      <div style={{height:8,background:'var(--border)',borderRadius:4,overflow:'hidden'}}>
                        <div style={{height:'100%',width:pct+'%',borderRadius:4,background:isNeg?'var(--urgent)':'var(--gold)',transition:'width .4s'}}/>
                      </div>
                    </div>
                  );
                })}
                <div style={{fontSize:10,color:'var(--muted)',marginTop:14,textAlign:'center',fontStyle:'italic'}}>
                  Ordenado de mayor a menor consumo en el período seleccionado.
                </div>
              </div>
            )
          ) :

          viewMode==='week' ? (
            rows.length===0 ? (
              <div className="empty">
                <div className="empty-icon"><span style={{fontSize:22}}>{type==='agua'?'💧':'⚡'}</span></div>
                <div className="empty-t">Sin registros</div>
                <div className="empty-s">No hay mediciones de {type} para esta semana.</div>
              </div>
            ) : (
              <>
                <div style={{display:'flex',padding:'7px 13px 3px',fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.8,fontWeight:700}}>
                  <span style={{minWidth:52,flexShrink:0}}>Unidad</span>
                  <span style={{flex:1,paddingLeft:8}}>Consumo</span>
                  <span style={{textAlign:'right'}}>Lectura</span>
                </div>
                {rows.map((row,i)=>{
                  const isUp = row.alert?.direction==='up';
                  return (
                    <div key={i} className="rrec" onClick={()=>setSelMeas(row)} style={{cursor:'pointer'}}>
                      <div className="rrec-row">
                        <div className="rrec-name">{row.label}</div>
                        <div className="rrec-consumo">
                          {row.consumption!=null?(
                            <span style={{fontSize:12,fontWeight:700,color:row.consumption<0?'var(--urgent)':row.consumption>0?'var(--done)':'var(--muted)'}}>
                              {row.consumption>=0?'+':''}{row.consumption.toFixed(1)}{' '}
                              <span style={{fontSize:10,fontWeight:400,color:'var(--muted)'}}>{unit2}</span>
                            </span>
                          ):(
                            <span style={{fontSize:10,color:'var(--muted)',fontStyle:'italic'}}>sin ref.</span>
                          )}
                        </div>
                        <div className="rrec-val">{row.value} <span style={{fontSize:10,fontWeight:400,color:'var(--muted)'}}>{unit2}</span></div>
                      </div>
                      {row.alert&&(
                        <div className="rrec-alert" style={{background:isUp?'var(--urgent-bg)':'rgba(45,110,78,.08)',color:isUp?'var(--urgent)':'var(--done)'}}>
                          <span>{isUp?'▲':'▼'}</span>
                          <span>{isUp?'+':''}{row.alert.pct}% consumo vs semana anterior</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )
          ) : (
            unitGroups.length===0 ? (
              <div className="empty">
                <div className="empty-icon"><span style={{fontSize:22}}>{type==='agua'?'💧':'⚡'}</span></div>
                <div className="empty-t">Sin registros</div>
                <div className="empty-s">No hay mediciones de {type} para este período.</div>
              </div>
            ) : (
              <div style={{padding:'8px 11px',display:'flex',flexDirection:'column',gap:8,paddingBottom:80}}>
                {unitGroups.map((grp,i)=>(
                  <div key={i} style={{background:'var(--surface)',borderRadius:'var(--radius)',border:'1px solid var(--border)',overflow:'hidden'}}>
                    {/* Unit header */}
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'9px 13px',borderBottom:'1px solid var(--border)',background:'rgba(0,0,0,.02)'}}>
                      <div style={{fontSize:13,fontWeight:700,color:'var(--text)'}}>{grp.unitLabel}</div>
                      <div style={{textAlign:'right'}}>
                        {grp.total!=null?(
                          <span style={{fontSize:13,fontWeight:700,color:grp.total>0?'var(--done)':grp.total<0?'var(--urgent)':'var(--muted)'}}>
                            {grp.total>=0?'+':''}{grp.total.toFixed(1)}{' '}
                            <span style={{fontSize:10,fontWeight:400,color:'var(--muted)'}}>{unit2}</span>
                          </span>
                        ):<span style={{fontSize:10,color:'var(--muted)',fontStyle:'italic'}}>sin ref.</span>}
                        <div style={{fontSize:9,color:'var(--muted)',textAlign:'right',marginTop:1,textTransform:'uppercase',letterSpacing:.5}}>total</div>
                      </div>
                    </div>
                    {/* Mini gráfico de barras de tendencia */}
                    {(() => {
                      const bars = grp.periods.filter(p=>p.consumption!=null);
                      if (bars.length < 2) return null;
                      const maxBar = Math.max(...bars.map(p=>Math.abs(p.consumption)), 0.1);
                      return (
                        <div style={{display:'flex',alignItems:'flex-end',gap:3,padding:'10px 13px 8px',height:54,borderBottom:'1px solid var(--border)'}}>
                          {bars.map((p,k)=>{
                            const h = Math.max(3, Math.abs(p.consumption)/maxBar*38);
                            const neg = p.consumption<0;
                            return (
                              <div key={k} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                                <div style={{width:'100%',maxWidth:18,height:h,borderRadius:3,background:neg?'var(--urgent)':'var(--gold)',opacity:.85}} title={`${p.label}: ${p.consumption.toFixed(1)} ${unit2}`}/>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                    {/* Period rows */}
                    {grp.periods.map((p,j)=>(
                      <div key={j} style={{display:'flex',alignItems:'center',padding:'7px 13px',borderBottom:j<grp.periods.length-1?'1px solid var(--border)':'none',gap:0}}>
                        <div style={{minWidth:52,flexShrink:0,fontSize:11,color:'var(--muted)',fontWeight:600}}>{p.label}</div>
                        <div style={{flex:1,paddingLeft:8}}>
                          {p.consumption!=null?(
                            <span style={{fontSize:12,fontWeight:700,color:p.consumption<0?'var(--urgent)':p.consumption>0?'var(--done)':'var(--muted)'}}>
                              {p.consumption>=0?'+':''}{p.consumption.toFixed(1)}{' '}
                              <span style={{fontSize:10,fontWeight:400,color:'var(--muted)'}}>{unit2}</span>
                            </span>
                          ):(
                            <span style={{fontSize:10,color:'var(--muted)',fontStyle:'italic'}}>sin ref.</span>
                          )}
                        </div>
                        {viewMode==='month'&&p.value!=null&&(
                          <div style={{fontSize:13,fontWeight:700,color:'var(--text)',textAlign:'right',whiteSpace:'nowrap'}}>
                            {p.value} <span style={{fontSize:10,fontWeight:400,color:'var(--muted)'}}>{unit2}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
          )
        )}
      </div>

      {/* ── Modal detalle de medición ── */}
      {selMeas&&<MeasDetailModal
        meas={selMeas}
        type={type}
        unit2={unit2}
        measurements={measurements}
        uname={uname}
        authFetch={authFetch}
        onClose={()=>setSelMeas(null)}
        onUpdated={async()=>{ const allM=await authFetch('/measurements').then(r=>r.ok?r.json():null); if(allM)setM(allM); setSelMeas(null); }}
      />}

      {/* Add modal */}
      {showAdd&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowAdd(false)}>
          <div className="modal">
            <div className="mhandle"/>
            <div className="mtitle">Nuevo Registro</div>
            <div className="msec"><span className="mlbl">Tipo</span>
              <div className="cgrid">
                {['agua','luz'].map(t=><button key={t} className={`cchip ${nm.type===t?'csel':''}`} onClick={()=>setNm(p=>({...p,type:t}))}>{t==='agua'?'💧 Agua':'⚡ Luz'}</button>)}
              </div></div>
            <div className="msec"><span className="mlbl">Unidad</span>
              <select className="minp msel" value={nm.unitId} onChange={e=>setNm(p=>({...p,unitId:e.target.value}))}>
                {UNIT_IDS.map(id=><option key={id} value={id}>{uname(id)}</option>)}
              </select></div>
            <div className="msec"><span className="mlbl">Lectura actual ({nm.type==='agua'?'m³':'kWh'})</span>
              <input className="minp" type="number" value={nm.value} onChange={e=>setNm(p=>({...p,value:e.target.value}))} placeholder="0.00"/></div>
            {nm.value&&(
              <div style={{borderRadius:9,marginBottom:12}}>
                {previewPrev?(
                  <div style={{background:'var(--gold-dim)',border:'1px solid var(--border2)',borderRadius:9,padding:'10px 13px'}}>
                    <div style={{fontSize:9,color:'var(--gold)',textTransform:'uppercase',letterSpacing:1,fontWeight:700,marginBottom:6}}>Consumo calculado</div>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                      <div>
                        <div style={{fontSize:11,color:'var(--muted)'}}>Semana anterior: <strong style={{color:'var(--text)'}}>{previewPrev.value} {nm.type==='agua'?'m³':'kWh'}</strong></div>
                        <div style={{fontSize:11,color:'var(--muted)',marginTop:2}}>Semana actual: <strong style={{color:'var(--text)'}}>{nm.value} {nm.type==='agua'?'m³':'kWh'}</strong></div>
                      </div>
                      <div style={{textAlign:'right'}}>
                        <div style={{fontSize:22,fontWeight:700,color:previewC>=0?'var(--dark)':'var(--urgent)',fontFamily:'var(--serif)'}}>
                          {previewC>=0?'+':''}{previewC!=null?previewC.toFixed(1):'—'}
                        </div>
                        <div style={{fontSize:10,color:'var(--muted)'}}>{nm.type==='agua'?'m³':'kWh'} consumidos</div>
                      </div>
                    </div>
                  </div>
                ):(
                  <div style={{background:'rgba(0,0,0,.04)',borderRadius:9,padding:'9px 13px',fontSize:11,color:'var(--muted)'}}>
                    ℹ️ No hay lectura de la semana anterior para calcular consumo.
                  </div>
                )}
              </div>
            )}
            <div style={{fontSize:11,color:'var(--muted)',background:'var(--gold-dim)',borderRadius:8,padding:'8px 12px',marginBottom:4}}>
              📅 Se registrará para: <strong>{currentWeekStr}</strong>
            </div>
            <div className="macts">
              <button className="mcancel" onClick={()=>setShowAdd(false)}>Cancelar</button>
              <button className="msave" onClick={save} disabled={!nm.value}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scan Modal ─────────────────────────────────────────── */}
      {showScan&&(()=>{
        const currentWk = getISOWeek(0);
        const uid = scanUnits[scanIdx];
        const unitName = uid ? uname(uid) : '';
        const prevM = uid ? measurements.find(m=>m.unitId===uid&&m.type==='agua'&&m.week===getISOWeek(1)) : null;

        const saveScan = async () => {
          if (!scanVal || !uid) return;
          setScanSaved(true);
          const r = await authFetch('/measurements',{method:'POST',body:JSON.stringify({
            unitId:uid, type:'agua', value:Number(scanVal), week:currentWk
          })});
          if (r.ok) {
            const allM = await authFetch('/measurements').then(r2=>r2.ok?r2.json():[]);
            setM(allM);
            setScanResults(prev=>[...prev,{uid,name:unitName,value:Number(scanVal)}]);
            setScanVal('');
            setScanSaved(false);
            if (scanIdx + 1 >= scanUnits.length) {
              setScanDone(true);
            } else {
              setScanIdx(i=>i+1);
            }
          } else {
            setScanSaved(false);
          }
        };

        const skip = () => {
          setScanVal('');
          if (scanIdx + 1 >= scanUnits.length) setScanDone(true);
          else setScanIdx(i=>i+1);
        };

        return (
          <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowScan(false)}>
            <div className="modal" style={{maxWidth:360}}>
              <div className="mhandle"/>
              {scanDone ? (
                <div style={{textAlign:'center',padding:'8px 0 12px'}}>
                  <div style={{fontSize:36,marginBottom:8}}>✅</div>
                  <div style={{fontSize:17,fontWeight:700,fontFamily:'var(--serif)',marginBottom:4}}>Toma completada</div>
                  <div style={{fontSize:12,color:'var(--muted)',marginBottom:16}}>{scanResults.length} de {scanUnits.length} unidades registradas — {currentWk}</div>
                  <div style={{background:'var(--bg)',borderRadius:10,padding:'10px 12px',marginBottom:16,maxHeight:220,overflowY:'auto',textAlign:'left'}}>
                    {scanResults.map((r,i)=>(
                      <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:'1px solid var(--border)',fontSize:13}}>
                        <span style={{fontWeight:600}}>{r.name}</span>
                        <span style={{color:'var(--gold)'}}>{r.value} m³</span>
                      </div>
                    ))}
                  </div>
                  <button onClick={()=>setShowScan(false)} style={{width:'100%',background:'var(--gold)',color:'#fff',border:'none',borderRadius:9,padding:'11px',fontWeight:700,fontSize:14,cursor:'pointer'}}>
                    Cerrar
                  </button>
                </div>
              ) : (
                <>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                    <div style={{fontSize:11,color:'var(--muted)',fontWeight:600}}>💧 AGUA — {currentWk}</div>
                    <div style={{fontSize:11,color:'var(--muted)'}}>{scanIdx+1} / {scanUnits.length}</div>
                  </div>
                  {/* Progress bar */}
                  <div style={{height:4,background:'var(--border)',borderRadius:4,marginBottom:14,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${((scanIdx)/scanUnits.length)*100}%`,background:'var(--gold)',borderRadius:4,transition:'width .3s'}}/>
                  </div>
                  <div style={{fontSize:24,fontWeight:700,fontFamily:'var(--serif)',marginBottom:2}}>{unitName}</div>
                  {prevM ? (
                    <div style={{fontSize:12,color:'var(--muted)',marginBottom:14}}>Semana anterior: <strong>{prevM.value} m³</strong></div>
                  ) : (
                    <div style={{fontSize:12,color:'var(--muted)',marginBottom:14}}>Sin lectura anterior</div>
                  )}
                  <input
                    autoFocus
                    type="number"
                    inputMode="decimal"
                    className="minp"
                    style={{fontSize:26,textAlign:'center',fontWeight:700,padding:'14px',marginBottom:12}}
                    placeholder="0.00"
                    value={scanVal}
                    onChange={e=>setScanVal(e.target.value)}
                    onKeyDown={e=>{ if(e.key==='Enter'&&scanVal) saveScan(); }}
                  />
                  <div style={{display:'flex',gap:8}}>
                    <button onClick={skip} style={{flex:1,background:'var(--surface)',color:'var(--muted)',border:'1px solid var(--border)',borderRadius:9,padding:'11px',fontWeight:600,fontSize:13,cursor:'pointer'}}>
                      Omitir
                    </button>
                    <button onClick={saveScan} disabled={!scanVal||scanSaved} style={{flex:2,background:scanVal?'var(--gold)':'var(--border)',color:'#fff',border:'none',borderRadius:9,padding:'11px',fontWeight:700,fontSize:14,cursor:scanVal?'pointer':'default',transition:'background .15s'}}>
                      {scanSaved?'Guardando...':'Siguiente →'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* USERS SCREEN */
function UsersScreen() {
  const { authFetch, user } = useAuth();
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editU,   setEditU]   = useState(null);

  const load = useCallback(()=>{
    authFetch('/users').then(r=>r.ok?r.json():[]).then(u=>{setUsers(u);setLoading(false);});
  },[authFetch]);
  useEffect(()=>{load();},[load]);

  const del = async u => {
    if(!confirm('Eliminar usuario?')) return;
    await authFetch(`/users/${u.id}`,{method:'DELETE'});
    load();
  };

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',overflow:'hidden'}}>
      <div className="header">
        <div className="header-title">Usuarios</div>
        <div style={{fontSize:11,color:'rgba(255,255,255,.32)'}}>{users.length} registrados</div>
      </div>
      <div className="page">
        {loading?<div className="spinner"/>:(
          <div className="sec-pad" style={{paddingBottom:84}}>
            {users.map(u=>(
              <div key={u.id} className="uucard">
                <div className="uuav">{u.displayName[0].toUpperCase()}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:14,fontWeight:700}}>{u.displayName}</div>
                  <div style={{fontSize:11,color:'var(--muted)'}}>@{u.username}</div>
                </div>
                <div style={{display:'flex',gap:6}}>
                  <button className="ibtn" onClick={()=>setEditU(u)}><Ic d={D.edit} sz={13}/></button>
                  {u.username!==user.username&&<button className="ibtn danger" onClick={()=>del(u)}><Ic d={D.trash} sz={13}/></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <button className="fab" onClick={()=>setShowAdd(true)}><Ic d={D.uplus} sz={16}/> Agregar</button>
      {showAdd&&<UserModal onClose={()=>setShowAdd(false)} onSaved={()=>{setShowAdd(false);load();}}/>}
      {editU&&<UserModal user={editU} onClose={()=>setEditU(null)} onSaved={()=>{setEditU(null);load();}}/>}
    </div>
  );
}

function UserModal({ user, onClose, onSaved }) {
  const { authFetch } = useAuth();
  const [dn, setDn] = useState(user?.displayName||'');
  const [un, setUn] = useState(user?.username||'');
  const [pw, setPw] = useState('');
  const [busy,setBusy]=useState(false);

  const save = async () => {
    setBusy(true);
    if(user){
      const b={};
      if(dn) b.displayName=dn;
      if(pw) b.password=pw;
      await authFetch(`/users/${user.id}`,{method:'PATCH',body:JSON.stringify(b)});
    } else {
      await authFetch('/users',{method:'POST',body:JSON.stringify({username:un,password:pw,displayName:dn})});
    }
    setBusy(false); onSaved();
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="mhandle"/>
        <div className="mtitle">{user?'Editar Usuario':'Nuevo Usuario'}</div>
        {!user&&(
          <div className="msec"><span className="mlbl">Nombre de usuario</span>
            <input className="minp" value={un} onChange={e=>setUn(e.target.value)} placeholder="usuario" autoCapitalize="none"/></div>
        )}
        <div className="msec"><span className="mlbl">Nombre completo</span>
          <input className="minp" value={dn} onChange={e=>setDn(e.target.value)} placeholder="Nombre visible"/></div>
        <div className="msec"><span className="mlbl">{user?'Nueva contraseña (opcional)':'Contraseña'}</span>
          <input className="minp" type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••"/></div>
        <div className="macts">
          <button className="mcancel" onClick={onClose}>Cancelar</button>
          <button className="msave" onClick={save} disabled={busy||(!user&&(!un||!pw||!dn))}>
            {busy?'Guardando...':user?'Guardar':'Crear'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* WAKE MESSAGE */
function WakeMessage() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs(s => s+1), 1000);
    return () => clearInterval(t);
  }, []);
  if (secs < 4) return null;
  return (
    <div style={{fontSize:11,color:'rgba(255,255,255,.3)',textAlign:'center',maxWidth:220,lineHeight:1.6}}>
      {secs < 10 ? 'Conectando con el servidor...' : 'El servidor esta despertando, puede tardar hasta 30 segundos...'}
    </div>
  );
}

/* DASHBOARD SCREEN */
function DashboardScreen({ onNavigate }) {
  const { user, tasks:allTasks, measurements, loadDemoData, reservations } = useAuth();
  const tasks = allTasks || [];
  const now = new Date();

  // ── Occupancy calculations ────────────────────────────────────
  const rentableUnits = UNIT_IDS.filter(id=>id!==100&&id!==101); // exclude Recepcion/Areas Comunes
  const occupiedNow   = rentableUnits.filter(uid=>reservations.some(r=>r.unitId===uid&&r.checkIn<=now&&r.checkOut>=now));
  const checkinsToday = reservations.filter(r=>r.checkIn.toDateString()===now.toDateString());
  const checkoutsToday= reservations.filter(r=>r.checkOut.toDateString()===now.toDateString());

  // Monthly occupancy % for current month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd   = new Date(now.getFullYear(), now.getMonth()+1, 0);
  const daysInMonth= monthEnd.getDate();
  const monthOccRate = reservations.length>0 ? (() => {
    let totalOccDays = 0;
    rentableUnits.forEach(uid => {
      reservations.filter(r=>r.unitId===uid).forEach(r => {
        const start = r.checkIn < monthStart ? monthStart : r.checkIn;
        const end   = r.checkOut > monthEnd  ? monthEnd  : r.checkOut;
        if (start < end) totalOccDays += (end-start)/(1000*60*60*24);
      });
    });
    return Math.round(totalOccDays / (rentableUnits.length * daysInMonth) * 100);
  })() : null;

  // Checkins next 7 days
  const next7 = new Date(now); next7.setDate(now.getDate()+7);
  const upcomingCheckins = reservations.filter(r=>r.checkIn>now&&r.checkIn<=next7)
    .sort((a,b)=>a.checkIn-b.checkIn);

  // ── Notificaciones ───────────────────────────────────────────
  useEffect(() => {
    if (!('Notification' in window) || !allTasks || !allTasks.length) return;
    const overdue = tasks.filter(t=>t.dueDate&&new Date(t.dueDate)<now&&t.status!=='completado');
    const urgent  = tasks.filter(t=>t.priority==='urgente'&&t.status!=='completado');
    const notify = () => {
      if (overdue.length > 0) {
        new Notification('Porta Al Sole', {
          body: overdue.length + ' tarea(s) vencida(s): ' + overdue.slice(0,2).map(t=>t.title).join(', '),
          icon: 'apple-touch-icon.png', tag: 'overdue',
        });
      } else if (urgent.length > 0) {
        new Notification('Porta Al Sole', {
          body: urgent.length + ' tarea(s) urgente(s) pendiente(s)',
          icon: 'apple-touch-icon.png', tag: 'urgent',
        });
      }
    };
    if (Notification.permission === 'granted') notify();
    else if (Notification.permission === 'default') Notification.requestPermission().then(p=>{ if(p==='granted') notify(); });
  }, [allTasks]);

  // ── Notificación diaria de movimientos (check-in/out) ─────────
  useEffect(() => {
    if (!('Notification' in window) || !reservations.length) return;
    if (checkinsToday.length === 0 && checkoutsToday.length === 0) return;

    const hoyStr = now.toDateString();
    // Evitar repetir el aviso el mismo día
    if (localStorage.getItem('pas_movimientos_aviso') === hoyStr) return;

    const avisar = () => {
      const partes = [];
      if (checkinsToday.length>0)  partes.push(`${checkinsToday.length} entrada(s)`);
      if (checkoutsToday.length>0) partes.push(`${checkoutsToday.length} salida(s)`);
      const unidadesIn  = checkinsToday.map(r=>uname(r.unitId)).join(', ');
      const unidadesOut = checkoutsToday.map(r=>uname(r.unitId)).join(', ');
      let body = `Hoy: ${partes.join(' y ')}.`;
      if (unidadesIn)  body += `\n✈ Entran: ${unidadesIn}`;
      if (unidadesOut) body += `\n🚪 Salen: ${unidadesOut}`;
      new Notification('🏠 Movimientos de hoy — Porta Al Sole', {
        body, icon: 'apple-touch-icon.png', tag: 'movimientos-dia',
      });
      localStorage.setItem('pas_movimientos_aviso', hoyStr);
    };

    if (Notification.permission === 'granted') avisar();
    else if (Notification.permission === 'default') Notification.requestPermission().then(p=>{ if(p==='granted') avisar(); });
  }, [reservations]);

  const greeting = () => {
    const h = now.getHours();
    if (h < 12) return 'Buenos días';
    if (h < 18) return 'Buenas tardes';
    return 'Buenas noches';
  };

  // KPIs
  const urgentes   = tasks.filter(t=>t.priority==='urgente'&&t.status!=='completado');
  const pendientes = tasks.filter(t=>t.status==='pendiente');
  const enProceso  = tasks.filter(t=>t.status==='en_proceso');
  const completadas= tasks.filter(t=>t.status==='completado');
  const vencidas   = tasks.filter(t=>t.dueDate&&new Date(t.dueDate)<now&&t.status!=='completado');

  // Recent activity (last 8 history entries across all tasks)
  const recentActivity = tasks
    .flatMap(t=>(t.history||[]).map(h=>({...h,taskTitle:t.title,taskId:t.id,unitId:t.unitId})))
    .sort((a,b)=>new Date(b.date)-new Date(a.date))
    .slice(0,6);

  // Tasks per unit (top 5)
  const unitCounts = UNIT_IDS.map(uid=>({
    uid, count: tasks.filter(t=>t.unitId===uid&&t.status!=='completado').length
  })).filter(u=>u.count>0).sort((a,b)=>b.count-a.count).slice(0,5);
  const maxCount = unitCounts[0]?.count || 1;

  return (
    <div className="dash">
      {/* HEADER */}
      <div className="dash-hd">
        <div className="dash-greeting">{greeting()}</div>
        <div className="dash-name">{user?.displayName||user?.username} 👋</div>
        <div className="dash-kpis">
          <div className="dash-kpi">
            <div className="dash-kpi-n" style={{color:'var(--urgent)'}}>{urgentes.length}</div>
            <div className="dash-kpi-l">Urgente</div>
          </div>
          <div className="dash-kpi">
            <div className="dash-kpi-n" style={{color:'var(--gold)'}}>{pendientes.length}</div>
            <div className="dash-kpi-l">Pendiente</div>
          </div>
          <div className="dash-kpi">
            <div className="dash-kpi-n" style={{color:'#2471a3'}}>{enProceso.length}</div>
            <div className="dash-kpi-l">Proceso</div>
          </div>
          <div className="dash-kpi">
            <div className="dash-kpi-n" style={{color:'var(--done)'}}>{completadas.length}</div>
            <div className="dash-kpi-l">Listas</div>
          </div>
        </div>
      </div>

      <div className="dash-body">

        {/* VENCIDAS */}
        {vencidas.length>0&&(
          <div>
            <div className="dash-section-title">⚠ Tareas vencidas</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {vencidas.slice(0,3).map(t=>(
                <div key={t.id} className="dash-overdue" onClick={()=>onNavigate('tasks')}>
                  <div style={{fontSize:18}}>⚠️</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:700,color:'var(--gold)'}}>{t.title}</div>
                    <div style={{fontSize:10,color:'var(--muted)'}}>{uname(t.unitId)} · Venció {t.dueDate}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* URGENTES */}
        {urgentes.length>0&&(
          <div>
            <div className="dash-section-title">🔴 Urgentes</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {urgentes.slice(0,3).map(t=>(
                <div key={t.id} className="dash-urgent-card" onClick={()=>onNavigate('tasks')}>
                  <div className="dash-urgent-title">{t.title}</div>
                  <div className="dash-urgent-meta">
                    <span>{uname(t.unitId)}</span>
                    <span>·</span>
                    <span>{t.level}</span>
                    {t.assignee&&<><span>·</span><span>👤 {t.assignee}</span></>}
                  </div>
                </div>
              ))}
              {urgentes.length>3&&<div style={{fontSize:11,color:'var(--muted)',textAlign:'center',padding:'4px 0'}}
                onClick={()=>onNavigate('tasks')}>+{urgentes.length-3} más →</div>}
            </div>
          </div>
        )}

        {/* UNIDADES CON MÁS TAREAS */}
        {unitCounts.length>0&&(
          <div>
            <div className="dash-section-title">📊 Tareas por unidad</div>
            <div className="dash-bar-wrap">
              {unitCounts.map(({uid,count})=>(
                <div key={uid} className="dash-bar-row" onClick={()=>onNavigate('units')}>
                  <div className="dash-bar-label">{SPECIAL[uid]?SPECIAL[uid].split(' ')[0]:uid}</div>
                  <div className="dash-bar-track">
                    <div className="dash-bar-fill" style={{width:`${Math.round(count/maxCount*100)}%`,background: tasks.filter(t=>t.unitId===uid&&t.priority==='urgente'&&t.status!=='completado').length>0?'var(--urgent)':'var(--gold)'}}/>
                  </div>
                  <div className="dash-bar-val">{count}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ACTIVIDAD RECIENTE */}
        {recentActivity.length>0&&(
          <div>
            <div className="dash-section-title">🕐 Actividad reciente</div>
            <div className="dash-activity">
              {recentActivity.map((h,i)=>(
                <div key={i} className="dash-act-item">
                  <div className="dash-act-dot" style={{background:'var(--gold)'}}/>
                  <div style={{flex:1}}>
                    <div className="dash-act-text">{h.taskTitle}</div>
                    <div className="dash-act-meta">{h.action} · <span style={{color:'var(--gold)',fontWeight:600}}>{h.user}</span> · {h.date}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* OCCUPANCY SECTION - only if reservations loaded */}
        {reservations.length>0&&(
          <div>
            <div className="dash-section-title">🏠 Ocupación</div>

            {/* Occupancy KPIs */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
              <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 14px'}}>
                <div style={{fontSize:28,fontWeight:800,fontFamily:'var(--serif)',color:occupiedNow.length>0?'var(--urgent)':'var(--done)',lineHeight:1}}>
                  {occupiedNow.length}<span style={{fontSize:14,color:'var(--muted)'}}>/{rentableUnits.length}</span>
                </div>
                <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.5,marginTop:3,fontWeight:700}}>Ocupadas ahora</div>
              </div>
              <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 14px'}}>
                <div style={{fontSize:28,fontWeight:800,fontFamily:'var(--serif)',color:'var(--gold)',lineHeight:1}}>
                  {monthOccRate!==null?monthOccRate+'%':'—'}
                </div>
                <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.5,marginTop:3,fontWeight:700}}>Ocupación del mes</div>
                {monthOccRate!==null&&<div style={{height:3,borderRadius:2,background:'var(--border)',overflow:'hidden',marginTop:6}}>
                  <div style={{height:'100%',borderRadius:2,background:'var(--gold)',width:monthOccRate+'%'}}/>
                </div>}
              </div>
            </div>

            {/* Today's checkins/checkouts */}
            {(checkinsToday.length>0||checkoutsToday.length>0)&&(
              <div onClick={()=>onNavigate('units')} style={{display:'flex',gap:8,marginBottom:10,cursor:'pointer'}}>
                {checkinsToday.length>0&&<div style={{flex:1,background:'rgba(45,110,78,.08)',border:'1px solid rgba(45,110,78,.2)',borderRadius:10,padding:'8px 10px'}}>
                  <div style={{fontSize:10,fontWeight:800,color:'var(--done)',marginBottom:4}}>✈ Check-in hoy ({checkinsToday.length})</div>
                  {checkinsToday.map((r,i)=><div key={i} style={{fontSize:10,color:'var(--text)'}}>{uname(r.unitId)} · {r.guest}</div>)}
                </div>}
                {checkoutsToday.length>0&&<div style={{flex:1,background:'rgba(184,50,50,.06)',border:'1px solid rgba(184,50,50,.15)',borderRadius:10,padding:'8px 10px'}}>
                  <div style={{fontSize:10,fontWeight:800,color:'var(--urgent)',marginBottom:4}}>🚪 Check-out hoy ({checkoutsToday.length})</div>
                  {checkoutsToday.map((r,i)=><div key={i} style={{fontSize:10,color:'var(--text)'}}>{uname(r.unitId)} · {r.guest}</div>)}
                </div>}
              </div>
            )}

            {/* Occupied units list */}
            {occupiedNow.length>0&&(
              <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:8}}>
                {occupiedNow.map(uid=>(
                  <div key={uid} onClick={()=>onNavigate('units')} style={{background:'rgba(184,50,50,.08)',border:'1px solid rgba(184,50,50,.2)',borderRadius:8,padding:'4px 10px',fontSize:11,fontWeight:700,color:'var(--urgent)',cursor:'pointer'}}>
                    {uname(uid)}
                  </div>
                ))}
              </div>
            )}

            {/* Upcoming checkins next 7 days */}
            {upcomingCheckins.length>0&&(
              <div>
                <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:1,fontWeight:800,marginBottom:6}}>Próximos 7 días</div>
                {upcomingCheckins.slice(0,4).map((r,i)=>{
                  const days=Math.ceil((r.checkIn-now)/(1000*60*60*24));
                  const hasUrgent=tasks.some(t=>t.unitId===r.unitId&&t.status!=='completado'&&t.priority==='urgente');
                  return (
                    <div key={i} onClick={()=>onNavigate('units')} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:'var(--surface)',border:`1px solid ${hasUrgent?'rgba(184,50,50,.3)':'var(--border)'}`,borderRadius:10,marginBottom:6,cursor:'pointer'}}>
                      <div style={{width:36,height:36,borderRadius:8,background:hasUrgent?'rgba(184,50,50,.1)':'rgba(201,150,58,.1)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                        <span style={{fontSize:14}}>{hasUrgent?'⚠️':'🔑'}</span>
                      </div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>{uname(r.unitId)} · {r.guest}</div>
                        <div style={{fontSize:10,color:'var(--muted)',marginTop:1}}>{r.checkIn.toLocaleDateString('es-VE',{day:'numeric',month:'short'})}</div>
                      </div>
                      <div style={{fontSize:11,fontWeight:800,color:days<=2?'var(--urgent)':days<=4?'var(--gold)':'var(--muted)',background:days<=2?'rgba(184,50,50,.1)':days<=4?'rgba(201,150,58,.1)':'rgba(0,0,0,.04)',padding:'3px 8px',borderRadius:8}}>
                        {days===1?'Mañana':`${days}d`}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {reservations.length===0&&user?.username==='admin'&&(
          <div style={{background:'rgba(201,150,58,.06)',border:'1px dashed rgba(201,150,58,.3)',borderRadius:12,padding:'14px',textAlign:'center'}}>
            <div style={{fontSize:11,color:'var(--muted)',marginBottom:8}}>📅 Subí el CSV de Hostaway para ver ocupación</div>
            <button onClick={()=>onNavigate('units')} style={{background:'none',border:'1px solid var(--gold)',color:'var(--gold)',borderRadius:8,padding:'6px 14px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
              Ir a Unidades → Reservas
            </button>
          </div>
        )}

        {tasks.length===0&&(
          <div className="empty" style={{marginTop:40}}>
            <div className="empty-icon"><Ic d={D.check} sz={22} col="var(--done)"/></div>
            <div className="empty-t">Sin datos aún</div>
            <div className="empty-s">No hay tareas registradas todavía.</div>
            {user?.username==='admin'&&<button onClick={loadDemoData} style={{marginTop:16,background:'var(--gold)',color:'#1a1208',border:'none',borderRadius:10,padding:'10px 20px',fontSize:12,fontWeight:800,cursor:'pointer',letterSpacing:.5}}>
              Ver datos de ejemplo
            </button>}
          </div>
        )}
      </div>
    </div>
  );
}


/* RESERVATIONS SCREEN */
function ReservationsScreen() {
  const { user, reservations, setReservations, saveReservations, cancellations, setCancellations, saveCancellations, tasks:allTasks } = useAuth();
  const tasks = allTasks || [];
  const now = new Date();
  const isAdmin = user?.username === 'admin';
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [selYear2, setSelYear2] = useState(null); // comparison year
  const [selMonth, setSelMonth] = useState(null);
  const [selUnit, setSelUnit] = useState('all');
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'calendar' | 'ingresos'
  const [viewDay, setViewDay] = useState(()=>{ const d=new Date(); d.setHours(0,0,0,0); return d; });
  const addDays = (d, n) => { const r=new Date(d); r.setDate(r.getDate()+n); return r; };
  const fmtDay = d => d.toLocaleDateString('es-ES',{weekday:'short',day:'numeric',month:'short'});
  const isToday = viewDay.toDateString() === (new Date()).toDateString();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth());
  const [incYear, setIncYear] = useState(now.getFullYear());
  const [incMonth, setIncMonth] = useState(null); // null = año completo
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // {stats, ok, error}
  const rentableUnits = UNIT_IDS.filter(id=>id!==100&&id!==101);
  const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const MONTHS_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  // Parse income string → number
  const parseIncome = str => {
    if (!str) return 0;
    const n = parseFloat(String(str).replace(/[^0-9.-]/g,''));
    return isNaN(n) ? 0 : n;
  };
  const fmtMoney = n => '$'+n.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});

  // Occupied units right now
  const occupiedNow = rentableUnits.filter(uid=>
    reservations.some(r=>r.unitId===uid&&r.checkIn<=now&&r.checkOut>=now)
  );

  // Get occupancy % for a unit in a given month
  const getMonthOcc = (uid, year, month) => {
    const mStart = new Date(year, month, 1);
    const mEnd   = new Date(year, month+1, 0, 23, 59, 59);
    const days   = mEnd.getDate();
    let occ = 0;
    reservations.filter(r=>uid==='all'?true:r.unitId===uid).forEach(r=>{
      const s = r.checkIn < mStart ? mStart : r.checkIn;
      const e = r.checkOut > mEnd  ? mEnd   : r.checkOut;
      if (s < e) occ += (e-s)/(1000*60*60*24);
    });
    const divisor = uid==='all' ? days*rentableUnits.length : days;
    return Math.min(100, Math.round(occ/divisor*100));
  };

  // Monthly data for selected year
  const monthlyData = MONTHS.map((lbl,i)=>({
    month: i, lbl,
    occ: getMonthOcc(selUnit==='all'?'all':parseInt(selUnit), selYear, i),
    res: reservations.filter(r=>{
      const inMonth = r.checkIn.getFullYear()===selYear&&r.checkIn.getMonth()===i ||
                      r.checkOut.getFullYear()===selYear&&r.checkOut.getMonth()===i ||
                      (r.checkIn<=new Date(selYear,i,1)&&r.checkOut>=new Date(selYear,i+1,0));
      return inMonth && (selUnit==='all'||r.unitId===parseInt(selUnit));
    }).length,
  }));

  // Top units filtered by selected year (or all)
  const unitStats = rentableUnits.map(uid=>{
    const filtered = selYear==='all'
      ? reservations.filter(r=>r.unitId===uid)
      : reservations.filter(r=>r.unitId===uid&&(
          r.checkIn.getFullYear()===selYear || r.checkOut.getFullYear()===selYear ||
          (r.checkIn.getFullYear()<selYear && r.checkOut.getFullYear()>selYear)
        ));
    const nights = filtered.reduce((s,r)=>{
      if (selYear==='all') return s + Math.max(0, Math.round((r.checkOut-r.checkIn)/(1000*60*60*24)));
      const yStart = new Date(selYear,0,1);
      const yEnd   = new Date(selYear,11,31,23,59,59);
      const start  = r.checkIn  < yStart ? yStart : r.checkIn;
      const end    = r.checkOut > yEnd   ? yEnd   : r.checkOut;
      return s + Math.max(0, Math.round((end-start)/(1000*60*60*24)));
    },0);
    return { uid, nights, yearRes:filtered.length };
  }).filter(u=>u.yearRes>0).sort((a,b)=>b.nights-a.nights);

  // Checkins/checkouts this week
  const weekEnd = new Date(now); weekEnd.setDate(now.getDate()+7);
  const thisWeek = reservations.filter(r=>
    (r.checkIn>=now&&r.checkIn<=weekEnd)||(r.checkOut>=now&&r.checkOut<=weekEnd)
  ).sort((a,b)=>a.checkIn-b.checkIn);

  const fmt = d => d.toLocaleDateString('es-VE',{day:'numeric',month:'short'});
  const maxOcc = Math.max(...monthlyData.map(m=>m.occ), 1);

  const years = [...new Set(reservations.map(r=>r.checkIn.getFullYear()))].sort((a,b)=>b-a);
  if (selYear!=='all' && !years.includes(selYear) && years.length>0) setSelYear(years[0]);

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',overflow:'hidden'}}>
      {/* HEADER - solid block, content scrolls below */}
      <div style={{flexShrink:0,background:'var(--dark2)',borderBottom:'1px solid rgba(201,150,58,.15)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 16px 10px'}}>
          <div style={{fontFamily:'var(--serif)',fontSize:22,fontWeight:700,color:'#fff'}}>Reservas</div>
          <label style={{display:'flex',alignItems:'center',gap:5,background:'rgba(201,150,58,.15)',color:'var(--gold)',border:'1px solid rgba(201,150,58,.3)',borderRadius:8,padding:'6px 10px',fontSize:10,fontWeight:800,cursor:'pointer',flexShrink:0}}>
            &#8635; {reservations.length>0?'Actualizar CSV':'Subir CSV'}
            <input type="file" accept=".csv" style={{display:'none'}} onChange={e=>{
              const file=e.target.files[0]; if(!file) return;
              const rd=new FileReader();
              rd.onload=async ev=>{
                const text=ev.target.result;
                setImporting(true);
                setImportResult(null);
                try {
                  const stats = parseHostawayWithStats(text);
                  const res = parseHostawayCSV(text);
                  const canc = parseHostawayCancellationsCSV(text);

                  // Calcular ingresos del año actual del CSV nuevo (snapshot)
                  const calcYearIncome = (rlist, yr) => rlist
                    .filter(r=>r.checkOut.getFullYear()===yr)
                    .reduce((s,r)=>s+parseIncome(r.income),0);
                  const thisYr = new Date().getFullYear();
                  const newTotal = calcYearIncome(res, thisYr);

                  // Desglose por unidad del año actual (para comparación detallada)
                  const calcByUnit = (rlist, yr) => {
                    const map = {};
                    rlist.filter(r=>r.checkOut.getFullYear()===yr).forEach(r=>{
                      map[r.unitId] = (map[r.unitId]||0) + parseIncome(r.income);
                    });
                    return map;
                  };
                  const newByUnit = calcByUnit(res, thisYr);

                  // Leer snapshot anterior (si existe)
                  let snapshotDiff = null;
                  let unitChanges = null;
                  try {
                    const prev = JSON.parse(localStorage.getItem('pas_income_snapshot'));
                    if (prev && prev.year===thisYr && typeof prev.total==='number') {
                      snapshotDiff = { prevTotal: prev.total, diff: newTotal - prev.total, date: prev.date };
                      // Comparar unidad por unidad (solo si el snapshot anterior tiene desglose)
                      if (prev.byUnit && typeof prev.byUnit==='object') {
                        const allUids = new Set([...Object.keys(prev.byUnit), ...Object.keys(newByUnit)]);
                        const changes = [];
                        allUids.forEach(uid=>{
                          const before = prev.byUnit[uid]||0;
                          const after  = newByUnit[uid]||0;
                          const d = after - before;
                          if (Math.abs(d) >= 1) changes.push({ uid:Number(uid), before, after, diff:d });
                        });
                        changes.sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
                        if (changes.length>0) unitChanges = changes;
                      }
                    }
                  } catch(e) {}

                  // Guardar y verificar resultado
                  const r1 = await saveReservations(res);
                  const r2 = await saveCancellations(canc);
                  if (r1.ok && r2.ok) {
                    setReservations(res);
                    setCancellations(canc);
                    // Guardar nuevo snapshot (con desglose por unidad)
                    localStorage.setItem('pas_income_snapshot', JSON.stringify({
                      year: thisYr, total: newTotal, byUnit: newByUnit, date: new Date().toLocaleDateString('es-VE')
                    }));
                    setImportResult({ ok:true, stats, imported:res.length, importedCanc:canc.length, snapshotDiff, unitChanges, newTotal });
                  } else {
                    setImportResult({ ok:false, error:(r1.error||r2.error||'Error desconocido') });
                  }
                } catch(err) {
                  setImportResult({ ok:false, error:'El archivo no se pudo leer. ¿Es un CSV de Hostaway?' });
                }
                setImporting(false);
                e.target.value=''; // permitir resubir el mismo archivo
              };
              rd.readAsText(file);
            }}/>
          </label>
        </div>
        {reservations.length>0&&<>
        <div style={{display:'flex',borderBottom:'1px solid rgba(255,255,255,.08)',margin:'0 16px'}}>
          {[['overview','Resumen'],['calendar','Calendario'],...(isAdmin?[['ingresos','Ingresos']]:[]  )].map(([id,lbl])=>(
            <button key={id} onClick={()=>setActiveTab(id)} style={{
              flex:1,padding:'8px 4px',fontSize:11,fontWeight:700,border:'none',background:'none',
              color:activeTab===id?'var(--gold)':'rgba(255,255,255,.35)',cursor:'pointer',
              borderBottom:activeTab===id?'2px solid var(--gold)':'2px solid transparent',
            }}>{lbl}</button>
          ))}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,padding:'10px 16px 14px'}}>
          {[
            {n:occupiedNow.length+'/'+rentableUnits.length, l:'Ocupadas', c:'var(--urgent)'},
            {n:getMonthOcc('all',now.getFullYear(),now.getMonth())+'%', l:'Este mes', c:'var(--gold)'},
            {n:reservations.filter(r=>r.checkIn>=new Date(now.getFullYear(),0,1)).length, l:''+now.getFullYear(), c:'var(--gold2)'},
            {n:thisWeek.length, l:'Sem. actual', c:'var(--done)'},
          ].map((k,i)=>(
            <div key={i} style={{background:'rgba(255,255,255,.06)',border:'1px solid rgba(255,255,255,.08)',borderRadius:10,padding:'9px 6px',textAlign:'center'}}>
              <div style={{fontSize:18,fontWeight:800,fontFamily:'var(--serif)',color:k.c,lineHeight:1}}>{k.n}</div>
              <div style={{fontSize:8,color:'rgba(255,255,255,.4)',textTransform:'uppercase',letterSpacing:.4,marginTop:4,fontWeight:700,lineHeight:1}}>{k.l}</div>
            </div>
          ))}
        </div>
        </>}
      </div>

      {reservations.length===0?(
        <div className="empty" style={{marginTop:60}}>
          <div style={{fontSize:48,marginBottom:12}}>📅</div>
          <div className="empty-t">Sin datos de reservas</div>
          <div className="empty-s">Subí el CSV exportado de Hostaway para ver el análisis de ocupación</div>
        </div>
      ):activeTab==='calendar'?(
        /* ── CALENDAR VIEW ── */
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px 80px'}} className="hide-scroll">
          {(()=>{
            const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
            const days = Array.from({length:daysInMonth},(_,i)=>i+1);
            const getResByDay = (uid, day) => {
              const d = new Date(calYear, calMonth, day);
              const next = new Date(calYear, calMonth, day+1);
              return reservations.find(r=>r.unitId===uid&&r.checkIn<next&&r.checkOut>d);
            };
            const sameDay = (d,day) => d.getDate()===day&&d.getMonth()===calMonth&&d.getFullYear()===calYear;
            const getCheckIn  = (uid,day) => reservations.find(r=>r.unitId===uid&&sameDay(r.checkIn,day));
            const getCheckOut = (uid,day) => reservations.find(r=>r.unitId===uid&&sameDay(r.checkOut,day));
            const isCheckIn  = (uid,day) => !!getCheckIn(uid,day);
            const isCheckOut = (uid,day) => !!getCheckOut(uid,day);
            return (
              <div>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,background:'var(--dark2)',borderRadius:12,padding:'10px 14px'}}>
                  <button onClick={()=>{ let m=calMonth-1,y=calYear; if(m<0){m=11;y--;} setCalMonth(m);setCalYear(y);}} style={{background:'rgba(255,255,255,.08)',border:'none',color:'rgba(255,255,255,.7)',fontSize:16,cursor:'pointer',padding:'4px 10px',borderRadius:8,fontWeight:700}}>‹</button>
                  <div>
                    <div style={{fontFamily:'var(--serif)',fontSize:18,fontWeight:700,color:'#fff',textAlign:'center',lineHeight:1.1}}>{MONTHS_FULL[calMonth]}</div>
                    <div style={{fontSize:10,color:'rgba(255,255,255,.35)',textAlign:'center',marginTop:2,fontWeight:600}}>{calYear}</div>
                  </div>
                  <button onClick={()=>{ let m=calMonth+1,y=calYear; if(m>11){m=0;y++;} setCalMonth(m);setCalYear(y);}} style={{background:'rgba(255,255,255,.08)',border:'none',color:'rgba(255,255,255,.7)',fontSize:16,cursor:'pointer',padding:'4px 10px',borderRadius:8,fontWeight:700}}>›</button>
                </div>
                <div style={{overflowX:'auto',borderRadius:12,border:'1px solid var(--border)',background:'var(--surface)'}} className="hide-scroll">
                  <table style={{borderCollapse:'separate',borderSpacing:'2px',fontSize:9,width:'100%',padding:'8px'}}>
                    <thead>
                      <tr>
                        <th style={{textAlign:'left',padding:'4px 8px',color:'var(--muted)',fontWeight:800,fontSize:8,letterSpacing:.5,textTransform:'uppercase',position:'sticky',left:0,background:'var(--surface)',zIndex:2,width:52}}>Unidad</th>
                        {days.map(d=>{
                          const isToday=d===now.getDate()&&calMonth===now.getMonth()&&calYear===now.getFullYear();
                          const dow=new Date(calYear,calMonth,d).getDay();
                          const isWknd=dow===0||dow===6;
                          return <th key={d} style={{padding:'2px 1px',textAlign:'center',color:isToday?'var(--gold)':isWknd?'var(--text)':'var(--muted)',fontWeight:isToday?900:isWknd?700:400,fontSize:8,width:18}}>
                            {d}
                          </th>;
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {rentableUnits.map((uid,ri)=>(
                        <tr key={uid}>
                          <td style={{padding:'2px 8px',fontWeight:800,fontSize:9,color:'var(--gold)',position:'sticky',left:0,background:'var(--surface)',zIndex:1,whiteSpace:'nowrap',letterSpacing:.2}}>{uname(uid)}</td>
                          {days.map(d=>{
                            const res  = getResByDay(uid,d);
                            const cinRes  = getCheckIn(uid,d);
                            const coutRes = getCheckOut(uid,d);
                            const cin  = !!cinRes;
                            const cout = !!coutRes;
                            const both = cin && cout; // mismo día: sale uno, entra otro
                            const isToday=d===now.getDate()&&calMonth===now.getMonth()&&calYear===now.getFullYear();
                            const dow=new Date(calYear,calMonth,d).getDay();
                            const isWknd=dow===0||dow===6;
                            let bg,border='none',title='';
                            const OUT='rgba(184,50,50,.55)', IN='#2d6e4e', BUSY='rgba(45,110,78,.25)';
                            if (both)      { bg=`linear-gradient(90deg, ${OUT} 0 50%, ${IN} 50% 100%)`; title=`Sale: ${coutRes.guest} · Entra: ${cinRes.guest}`; }
                            else if (cin)  { bg=IN; title=`Entra: ${cinRes.guest}`; }
                            else if (cout) { bg=OUT; title=`Sale: ${coutRes.guest}`; }
                            else if (res)  { bg=BUSY; title=res.guest; }
                            else           { bg=isWknd?'rgba(201,150,58,.06)':'transparent'; }
                            if (isToday)   { border='1.5px solid var(--gold)'; }
                            return (
                              <td key={d} title={title} style={{padding:'1px'}}>
                                <div style={{
                                  height:18,
                                  borderRadius: cin||cout?4:2,
                                  background:bg,
                                  border,
                                  display:'flex',alignItems:'center',justifyContent:'center',
                                  transition:'opacity .1s',
                                  cursor:res?'pointer':'default',
                                }}>
                                  {both&&<span style={{fontSize:6,color:'#fff',fontWeight:900}}>⇄</span>}
                                  {!both&&cin&&<span style={{fontSize:6,color:'#fff',fontWeight:900,letterSpacing:.3}}>IN</span>}
                                  {!both&&cout&&<span style={{fontSize:6,color:'rgba(255,255,255,.85)',fontWeight:900,letterSpacing:.3}}>OUT</span>}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{display:'flex',gap:14,marginTop:10,flexWrap:'wrap',padding:'0 2px'}}>
                  {[['#2d6e4e','Check-in'],['rgba(45,110,78,.25)','Ocupada'],['rgba(184,50,50,.55)','Check-out'],['linear-gradient(90deg, rgba(184,50,50,.55) 0 50%, #2d6e4e 50% 100%)','Sale/Entra'],['transparent','Libre']].map(([c,l])=>(
                    <div key={l} style={{display:'flex',alignItems:'center',gap:6}}>
                      <div style={{width:16,height:12,borderRadius:3,background:c,border:'1px solid var(--border)'}}/>
                      <span style={{fontSize:10,color:'var(--muted)',fontWeight:600}}>{l}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      ):activeTab==='ingresos'&&isAdmin?(
        /* ── INGRESOS VIEW ── */
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px 80px',display:'flex',flexDirection:'column',gap:16}} className="hide-scroll">
          {(()=>{
            const allYears = [...new Set(reservations.map(r=>r.checkOut.getFullYear()))].sort((a,b)=>b-a);

            // Filter reservations by selected year (and optionally month) — based on checkOut
            const filtered = reservations.filter(r=>{
              if (r.checkOut.getFullYear()!==incYear) return false;
              if (incMonth!==null && r.checkOut.getMonth()!==incMonth) return false;
              return true;
            });

            const totalIncome = filtered.reduce((s,r)=>s+parseIncome(r.income),0);

            // Monthly breakdown for selected year — based on checkOut
            const monthlyIncome = MONTHS.map((lbl,i)=>{
              const mRes = reservations.filter(r=>r.checkOut.getFullYear()===incYear&&r.checkOut.getMonth()===i);
              const total = mRes.reduce((s,r)=>s+parseIncome(r.income),0);
              return {lbl, total, count:mRes.length, month:i};
            });
            const maxMonthly = Math.max(...monthlyIncome.map(m=>m.total),1);

            // Per-unit breakdown
            const byUnit = rentableUnits.map(uid=>{
              const uRes = filtered.filter(r=>r.unitId===uid);
              const total = uRes.reduce((s,r)=>s+parseIncome(r.income),0);
              return {uid, total, count:uRes.length};
            }).filter(u=>u.count>0).sort((a,b)=>b.total-a.total);
            const maxUnit = byUnit.length>0 ? byUnit[0].total : 1;

            // Year comparison: previous year — based on checkOut
            const prevYear = incYear-1;
            const prevTotal = reservations.filter(r=>r.checkOut.getFullYear()===prevYear)
              .reduce((s,r)=>s+parseIncome(r.income),0);
            const diffPct = prevTotal>0 ? Math.round((totalIncome-prevTotal)/prevTotal*100) : null;

            return (
              <>
                {/* Year selector */}
                <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
                  {allYears.map(y=>(
                    <button key={y} onClick={()=>{setIncYear(y);setIncMonth(null);}} style={{
                      padding:'5px 13px',borderRadius:8,fontSize:12,fontWeight:700,border:'1.5px solid',cursor:'pointer',
                      background:incYear===y?'rgba(201,150,58,.15)':'transparent',
                      borderColor:incYear===y?'var(--gold)':'var(--border)',
                      color:incYear===y?'var(--gold)':'var(--muted)',
                    }}>{y}</button>
                  ))}
                </div>

                {/* KPI Cards */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                  <div style={{background:'var(--dark2)',border:'1px solid rgba(201,150,58,.2)',borderRadius:14,padding:'14px 16px',gridColumn:'1/-1'}}>
                    <div style={{fontSize:9,color:'rgba(201,150,58,.6)',textTransform:'uppercase',letterSpacing:2,fontWeight:800,marginBottom:4}}>
                      {incMonth!==null?MONTHS_FULL[incMonth]+' '+incYear:'Total '+incYear}
                    </div>
                    <div style={{fontFamily:'var(--serif)',fontSize:36,fontWeight:700,color:'var(--gold)',lineHeight:1}}>{fmtMoney(totalIncome)}</div>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginTop:6}}>
                      <span style={{fontSize:11,color:'rgba(255,255,255,.35)'}}>{filtered.length} reservas</span>
                      {diffPct!==null&&incMonth===null&&(
                        <span style={{fontSize:11,fontWeight:700,color:diffPct>=0?'var(--done)':'var(--urgent)',background:diffPct>=0?'rgba(45,110,78,.15)':'rgba(184,50,50,.12)',padding:'1px 8px',borderRadius:6}}>
                          {diffPct>=0?'▲':'▼'} {Math.abs(diffPct)}% vs {prevYear}
                        </span>
                      )}
                    </div>
                  </div>
                  {(()=>{
                    const totalNights = filtered.reduce((s,r)=>s+Math.max(0,Math.round((r.checkOut-r.checkIn)/(1000*60*60*24))),0);

                    // Ocupación del mes seleccionado
                    let mejorMesKpi;
                    if (incMonth===null) {
                      mejorMesKpi = {l:'Mejor mes', v:(()=>{const best=monthlyIncome.reduce((a,b)=>b.total>a.total?b:a,monthlyIncome[0]);return best&&best.total>0?MONTHS[best.month]:'—';})(), c:'var(--done)'};
                    } else {
                      // Calcular % de ocupación del mes
                      const mStart = new Date(incYear, incMonth, 1);
                      const mEnd   = new Date(incYear, incMonth+1, 0);
                      const daysInMonth = mEnd.getDate();
                      let occDays = 0;
                      rentableUnits.forEach(uid=>{
                        reservations.filter(r=>r.unitId===uid).forEach(r=>{
                          const s = r.checkIn < mStart ? mStart : r.checkIn;
                          const e = r.checkOut > mEnd ? mEnd : r.checkOut;
                          if (s < e) occDays += (e-s)/(1000*60*60*24);
                        });
                      });
                      const occRate = Math.round(occDays / (rentableUnits.length * daysInMonth) * 100);
                      mejorMesKpi = {l:'Ocupación', v:occRate+'%', c:'var(--done)'};
                    }

                    return [
                      {l:'Promedio/reserva', v:filtered.length>0?fmtMoney(Math.round(totalIncome/filtered.length)):'—', c:'var(--gold2)'},
                      {l:'Promedio/noche',   v:totalNights>0?fmtMoney(Math.round(totalIncome/totalNights)):'—',         c:'var(--gold2)'},
                      mejorMesKpi,
                    ];
                  })().map((k,i)=>(
                    <div key={i} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 14px'}}>
                      <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:1.5,fontWeight:800,marginBottom:5}}>{k.l}</div>
                      <div style={{fontFamily:'var(--serif)',fontSize:20,fontWeight:700,color:k.c}}>{k.v}</div>
                    </div>
                  ))}
                </div>

                {/* Monthly bar chart */}
                {incMonth===null&&(
                  <div>
                    <div className="dash-section-title">📈 Ingresos por mes — {incYear}</div>
                    <div style={{display:'flex',gap:3,alignItems:'flex-end',height:110,padding:'0 2px'}}>
                      {monthlyIncome.map((m,i)=>{
                        const isCurrent = i===now.getMonth()&&incYear===now.getFullYear();
                        const barH = maxMonthly>0?Math.round(m.total/maxMonthly*100):0;
                        return (
                          <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2,cursor:'pointer'}}
                            onClick={()=>setIncMonth(incMonth===i?null:i)}>
                            <div style={{fontSize:6,color:m.total>0?'var(--gold)':'transparent',fontWeight:700,lineHeight:1,whiteSpace:'nowrap'}}>
                              {m.total>0?'$'+Math.round(m.total/1000)+'k':''}
                            </div>
                            <div style={{width:'100%',height:80,display:'flex',alignItems:'flex-end'}}>
                              <div style={{
                                width:'100%',height:barH+'%',minHeight:m.total>0?3:0,
                                background:isCurrent?'var(--gold)':incMonth===i?'var(--gold2)':m.total>0?'rgba(201,150,58,.65)':'var(--border)',
                                borderRadius:'3px 3px 0 0',transition:'height .3s',
                              }}/>
                            </div>
                            <div style={{fontSize:7,color:isCurrent?'var(--gold)':incMonth===i?'var(--gold)':'var(--muted)',fontWeight:isCurrent||incMonth===i?800:400}}>{m.lbl}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{fontSize:9,color:'var(--muted)',textAlign:'center',marginTop:4}}>Toca un mes para ver detalle</div>
                  </div>
                )}

                {/* Month detail panel */}
                {incMonth!==null&&(
                  <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 14px'}}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                      <div style={{fontSize:12,fontWeight:800,color:'var(--gold)'}}>{MONTHS_FULL[incMonth]} {incYear}</div>
                      <button onClick={()=>setIncMonth(null)} style={{fontSize:10,color:'var(--muted)',background:'var(--border)',border:'none',borderRadius:6,padding:'3px 9px',cursor:'pointer',fontWeight:700}}>Ver año ↩</button>
                    </div>
                    {/* Comparación vs mismo mes año anterior */}
                    {(()=>{
                      const prevMonthTotal = reservations.filter(r=>r.checkOut.getFullYear()===incYear-1&&r.checkOut.getMonth()===incMonth)
                        .reduce((s,r)=>s+parseIncome(r.income),0);
                      if (prevMonthTotal<=0) return null;
                      const diff = totalIncome - prevMonthTotal;
                      const pct = Math.round(diff/prevMonthTotal*100);
                      const up = diff>=0;
                      return (
                        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,padding:'8px 10px',background:up?'rgba(45,110,78,.08)':'rgba(184,50,50,.06)',borderRadius:9,border:`1px solid ${up?'rgba(45,110,78,.2)':'rgba(184,50,50,.15)'}`}}>
                          <span style={{fontSize:18}}>{up?'📈':'📉'}</span>
                          <div style={{flex:1}}>
                            <div style={{fontSize:12,fontWeight:800,color:up?'var(--done)':'var(--urgent)'}}>
                              {up?'+':''}{fmtMoney(diff)} <span style={{fontSize:11}}>({up?'+':''}{pct}%)</span>
                            </div>
                            <div style={{fontSize:10,color:'var(--muted)'}}>vs {MONTHS[incMonth]} {incYear-1} ({fmtMoney(prevMonthTotal)})</div>
                          </div>
                        </div>
                      );
                    })()}
                    {filtered.length===0
                      ? <div style={{fontSize:11,color:'var(--muted)'}}>Sin ingresos este mes</div>
                      : filtered.sort((a,b)=>a.checkIn-b.checkIn).map((r,i)=>(
                        <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'7px 0',borderBottom:i<filtered.length-1?'1px solid var(--border)':'none'}}>
                          <div>
                            <div style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>{uname(r.unitId)} · {r.guest}</div>
                            <div style={{fontSize:10,color:'var(--muted)',marginTop:1}}>
                              {r.checkIn.toLocaleDateString('es-VE',{day:'numeric',month:'short'})} → {r.checkOut.toLocaleDateString('es-VE',{day:'numeric',month:'short'})}
                              {' · '}{Math.round((r.checkOut-r.checkIn)/(1000*60*60*24))} noches
                            </div>
                          </div>
                          <div style={{fontSize:13,fontWeight:800,color:'var(--done)',flexShrink:0,marginLeft:8}}>{r.income||'—'}</div>
                        </div>
                      ))
                    }
                    {/* Month total */}
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0 0',marginTop:6,borderTop:'1.5px solid var(--border)'}}>
                      <div style={{fontSize:10,fontWeight:800,color:'var(--gold)',textTransform:'uppercase',letterSpacing:.5}}>Total {MONTHS[incMonth]}</div>
                      <div style={{fontFamily:'var(--serif)',fontSize:16,fontWeight:700,color:'var(--gold)'}}>{fmtMoney(totalIncome)}</div>
                    </div>
                  </div>
                )}

                {/* Per-unit breakdown */}
                {byUnit.length>0&&(
                  <div>
                    <div className="dash-section-title">🏠 Por unidad — {incMonth!==null?MONTHS[incMonth]+' '+incYear:incYear}</div>
                    <div style={{display:'flex',flexDirection:'column',gap:7}}>
                      {byUnit.map((u,i)=>(
                        <div key={u.uid} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px'}}>
                          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:5}}>
                            <div style={{fontSize:10,fontWeight:800,color:'var(--muted)',width:18,textAlign:'right',flexShrink:0}}>{i+1}</div>
                            <div style={{fontSize:12,fontWeight:700,color:'var(--text)',flex:1}}>{uname(u.uid)}</div>
                            <div style={{fontSize:14,fontWeight:800,color:'var(--done)',flexShrink:0}}>{fmtMoney(u.total)}</div>
                          </div>
                          <div style={{display:'flex',alignItems:'center',gap:8}}>
                            <div style={{width:18,flexShrink:0}}/>
                            <div style={{flex:1,height:5,background:'var(--border)',borderRadius:3,overflow:'hidden'}}>
                              <div style={{height:'100%',background:'var(--gold)',borderRadius:3,width:Math.round(u.total/maxUnit*100)+'%',transition:'width .4s'}}/>
                            </div>
                            <div style={{fontSize:9,color:'var(--muted)',flexShrink:0,width:60,textAlign:'right'}}>{u.count} res · {totalIncome>0?Math.round(u.total/totalIncome*100):0}%</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',marginTop:4,background:'rgba(201,150,58,.08)',border:'1.5px solid rgba(201,150,58,.2)',borderRadius:10}}>
                      <div style={{fontSize:11,fontWeight:800,color:'var(--gold)',textTransform:'uppercase',letterSpacing:.5}}>TOTAL {incMonth!==null?MONTHS[incMonth]:incYear}</div>
                      <div style={{fontFamily:'var(--serif)',fontSize:18,fontWeight:700,color:'var(--gold)'}}>{fmtMoney(totalIncome)}</div>
                    </div>
                  </div>
                )}

              </>
            );
          })()}
        </div>
      ):(
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px 80px',display:'flex',flexDirection:'column',gap:16}} className="hide-scroll">

          {/* MONTHLY PDF REPORT */}
          {isAdmin&&<div style={{display:'flex',gap:8,alignItems:'center'}}>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>Reporte mensual</div>
              <div style={{fontSize:10,color:'var(--muted)',marginTop:2}}>PDF completo de ocupación, reservas y mantenimiento</div>
            </div>
            <button onClick={()=>{
              const y = typeof selYear==='number'?selYear:now.getFullYear();
              const m = selMonth!==null?selMonth:now.getMonth();
              const mStart = new Date(y,m,1);
              const mEnd   = new Date(y,m+1,0);
              const mRes   = reservations.filter(r=>r.checkIn<=mEnd&&r.checkOut>=mStart).sort((a,b)=>a.checkIn-b.checkIn);
              const mCanc  = cancellations.filter(r=>r.checkIn.getMonth()===m&&r.checkIn.getFullYear()===y);
              const mTasks = (tasks||[]).filter(t=>new Date(t.createdAt)>=mStart&&new Date(t.createdAt)<=mEnd);
              const occ    = getMonthOcc('all',y,m);
              const fmt    = d=>d.toLocaleDateString('es-VE',{day:'numeric',month:'short',year:'numeric'});
              const cancelRate = mRes.length+mCanc.length>0?Math.round(mCanc.length/(mRes.length+mCanc.length)*100):0;
              const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte ${MONTHS_FULL[m]} ${y}</title>
              <style>body{font-family:Georgia,serif;max-width:800px;margin:0 auto;padding:32px;color:#1a1208;background:#fdf8f0}
              h1{font-size:28px;margin:0 0 4px}h2{font-size:16px;color:#c9963a;border-bottom:2px solid #c9963a40;padding-bottom:6px;margin:24px 0 12px}
              .sub{font-size:13px;color:#999;margin-bottom:24px}.stats{display:flex;gap:12px;margin-bottom:8px}
              .stat{background:#fff;border:1px solid #e8e0d0;border-radius:8px;padding:12px 16px;text-align:center;flex:1}
              .stat-n{font-size:24px;font-weight:800;color:#c9963a}.stat-l{font-size:9px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
              table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:7px 10px;border-bottom:1px solid #e8e0d0;text-align:left}th{background:#f5ede0;font-weight:700;font-size:11px}
              .tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700}
              @media print{body{padding:16px}}</style></head><body>
              <h1>Reporte ${MONTHS_FULL[m]} ${y}</h1>
              <div class="sub">Porta Al Sole Condos · Generado el ${fmt(now)}</div>
              <h2>Resumen de ocupación</h2>
              <div class="stats">
                <div class="stat"><div class="stat-n">${occ}%</div><div class="stat-l">Ocupación</div></div>
                <div class="stat"><div class="stat-n">${mRes.length}</div><div class="stat-l">Reservas</div></div>
                <div class="stat"><div class="stat-n">${mCanc.length}</div><div class="stat-l">Cancelaciones</div></div>
                <div class="stat"><div class="stat-n" style="color:${cancelRate>20?'#b83232':'#2d6e4e'}">${cancelRate}%</div><div class="stat-l">Tasa cancel.</div></div>
              </div>
              <h2>Reservas del mes (${mRes.length})</h2>
              <table><tr><th>Unidad</th><th>Huésped</th><th>Check-in</th><th>Check-out</th><th>Noches</th><th>Ingreso</th></tr>
              ${mRes.map(r=>`<tr><td>${uname(r.unitId)}</td><td>${r.guest}</td><td>${fmt(r.checkIn)}</td><td>${fmt(r.checkOut)}</td><td>${Math.round((r.checkOut-r.checkIn)/(1000*60*60*24))}</td><td>${r.income||'—'}</td></tr>`).join('')}
              </table>
              ${mCanc.length>0?`<h2>Cancelaciones (${mCanc.length})</h2>
              <table><tr><th>Unidad</th><th>Huésped</th><th>Fechas</th></tr>
              ${mCanc.map(r=>`<tr><td>${uname(r.unitId)}</td><td>${r.guest}</td><td>${fmt(r.checkIn)} → ${fmt(r.checkOut)}</td></tr>`).join('')}
              </table>`:''}
              ${mTasks.length>0?`<h2>Tareas de mantenimiento (${mTasks.length})</h2>
              <table><tr><th>Unidad</th><th>Tarea</th><th>Prioridad</th><th>Estado</th><th>Asignado</th></tr>
              ${mTasks.map(t=>`<tr><td>${uname(t.unitId)}</td><td>${t.title}</td><td>${t.priority}</td><td>${t.status}</td><td>${t.assignee||'—'}</td></tr>`).join('')}
              </table>`:''}
              <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e8e0d0;font-size:10px;color:#ccc;text-align:center">Porta Al Sole Condos · Sistema de Mantenimiento</div>
              </body></html>`;
              const w=window.open('','_blank'); w.document.write(html); w.document.close(); setTimeout(()=>w.print(),500);
            }} style={{background:'var(--gold)',color:'#1a1208',border:'none',borderRadius:9,padding:'9px 14px',fontSize:11,fontWeight:800,cursor:'pointer',flexShrink:0,whiteSpace:'nowrap'}}>
              PDF {MONTHS[selMonth!==null?selMonth:now.getMonth()]} {typeof selYear==='number'?selYear:now.getFullYear()}
            </button>
          </div>}
          <div style={{height:1,background:'var(--border)'}}/>

          {/* CURRENT OCCUPANCY */}
          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
              <div className="dash-section-title" style={{marginBottom:0}}>🏠 Ocupación</div>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <button onClick={()=>setViewDay(d=>addDays(d,-1))} style={{width:28,height:28,borderRadius:7,border:'1px solid var(--border)',background:'var(--surface)',color:'var(--text)',fontSize:14,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>‹</button>
                <div onClick={()=>setViewDay(()=>{const d=new Date();d.setHours(0,0,0,0);return d;})} style={{fontSize:11,fontWeight:700,color:isToday?'var(--gold)':'var(--text)',background:isToday?'rgba(201,150,58,.1)':'var(--surface)',border:`1px solid ${isToday?'rgba(201,150,58,.3)':'var(--border)'}`,borderRadius:8,padding:'4px 10px',cursor:'pointer',whiteSpace:'nowrap',minWidth:110,textAlign:'center'}}>
                  {isToday?'Hoy — '+fmtDay(viewDay):fmtDay(viewDay)}
                </div>
                <button onClick={()=>setViewDay(d=>addDays(d,1))} style={{width:28,height:28,borderRadius:7,border:'1px solid var(--border)',background:'var(--surface)',color:'var(--text)',fontSize:14,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>›</button>
              </div>
            </div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              {rentableUnits.map(uid=>{
                const occ = reservations.some(r=>r.unitId===uid&&r.checkIn<=viewDay&&r.checkOut>=viewDay);
                const soon = !occ&&reservations.some(r=>r.unitId===uid&&r.checkIn>viewDay&&Math.ceil((r.checkIn-viewDay)/(1000*60*60*24))<=3);
                const res = occ ? reservations.find(r=>r.unitId===uid&&r.checkIn<=viewDay&&r.checkOut>=viewDay) : null;
                return (
                  <div key={uid} style={{
                    background:occ?'rgba(184,50,50,.1)':soon?'rgba(201,150,58,.08)':'rgba(45,110,78,.08)',
                    border:`1.5px solid ${occ?'rgba(184,50,50,.3)':soon?'rgba(201,150,58,.25)':'rgba(45,110,78,.2)'}`,
                    borderRadius:10,padding:'8px 10px',minWidth:72,
                  }}>
                    <div style={{fontSize:13,fontWeight:800,color:occ?'var(--urgent)':soon?'var(--gold)':'var(--done)',fontFamily:'var(--serif)'}}>{uname(uid)}</div>
                    <div style={{fontSize:9,fontWeight:700,color:occ?'var(--urgent)':soon?'var(--gold)':'var(--done)',textTransform:'uppercase',letterSpacing:.5,marginTop:2}}>
                      {occ?'OCUPADA':soon?'PRÓX.':'LIBRE'}
                    </div>
                    {res&&<div style={{fontSize:9,color:'var(--muted)',marginTop:3,maxWidth:90,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{res.guest}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* THIS WEEK */}
          {thisWeek.length>0&&<div>
            <div className="dash-section-title">📆 Esta semana</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {thisWeek.map((r,i)=>{
                const isIn = r.checkIn>=now&&r.checkIn<=weekEnd;
                const days = Math.ceil((r.checkIn-now)/(1000*60*60*24));
                return (
                  <div key={i} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',display:'flex',gap:10,alignItems:'center'}}>
                    <div style={{width:34,height:34,borderRadius:8,background:isIn?'rgba(45,110,78,.12)':'rgba(184,50,50,.08)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>
                      {isIn?'✈':'🚪'}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>{uname(r.unitId)} · {r.guest}</div>
                      <div style={{fontSize:10,color:'var(--muted)',marginTop:1}}>{isIn?'Check-in':'Check-out'} {fmt(isIn?r.checkIn:r.checkOut)}</div>
                    </div>
                    {isIn&&<div style={{fontSize:11,fontWeight:800,color:days<=1?'var(--urgent)':days<=3?'var(--gold)':'var(--muted)',background:days<=1?'rgba(184,50,50,.1)':days<=3?'rgba(201,150,58,.1)':'transparent',padding:'3px 8px',borderRadius:8}}>
                      {days===0?'Hoy':days===1?'Mañana':`${days}d`}
                    </div>}
                  </div>
                );
              })}
            </div>
          </div>}

          {/* OCCUPANCY CHART */}
          <div>
            <div className="dash-section-title">📊 Ocupación mensual</div>
            {/* Controls */}
            <div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center'}}>
              <div style={{display:'flex',gap:4}}>
                <button onClick={()=>setSelYear('all')} style={{padding:'4px 10px',borderRadius:7,fontSize:11,fontWeight:700,border:'1.5px solid',cursor:'pointer',background:selYear==='all'?'rgba(201,150,58,.15)':'transparent',borderColor:selYear==='all'?'var(--gold)':'var(--border)',color:selYear==='all'?'var(--gold)':'var(--muted)'}}>
                    Todo
                  </button>
              {years.map(y=>(
                  <button key={y} onClick={()=>setSelYear(y)} style={{padding:'4px 10px',borderRadius:7,fontSize:11,fontWeight:700,border:'1.5px solid',cursor:'pointer',background:selYear===y?'rgba(201,150,58,.15)':'transparent',borderColor:selYear===y?'var(--gold)':'var(--border)',color:selYear===y?'var(--gold)':'var(--muted)'}}>
                    {y}
                  </button>
                ))}
              </div>
              <div style={{display:'flex',gap:4,alignItems:'center',marginLeft:'auto'}}>
                <select value={selYear2||''} onChange={e=>setSelYear2(e.target.value?parseInt(e.target.value):null)}
                  style={{background:'var(--surface)',border:`1px solid ${selYear2?'rgba(36,113,163,.5)':'var(--border)'}`,borderRadius:7,padding:'4px 8px',fontSize:10,color:selYear2?'#2471a3':'var(--muted)',outline:'none'}}>
                  <option value="">vs año...</option>
                  {years.filter(y=>y!==selYear&&y!=='all').map(y=><option key={y} value={y}>{y}</option>)}
                </select>
                <select value={selUnit} onChange={e=>setSelUnit(e.target.value)}
                  style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:7,padding:'4px 8px',fontSize:11,color:'var(--muted)',outline:'none'}}>
                  <option value="all">Todas</option>
                  {rentableUnits.map(uid=><option key={uid} value={uid}>{uname(uid)}</option>)}
                </select>
              </div>
            </div>
            {/* Bar chart with optional comparison */}
            <div style={{display:'flex',gap:3,alignItems:'flex-end',height:120,padding:'0 4px'}}>
              {monthlyData.map((m,i)=>{
                const isCurrent = selYear!=='all'&&i===now.getMonth()&&selYear===now.getFullYear();
                const occ2 = selYear2&&selYear!=='all' ? getMonthOcc(selUnit==='all'?'all':parseInt(selUnit), selYear2, i) : null;
                return (
                  <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3,cursor:'pointer'}} onClick={()=>setSelMonth(selMonth===i?null:i)}>
                    <div style={{fontSize:7,color:m.occ>0?'var(--gold)':'transparent',fontWeight:700,lineHeight:1}}>{m.occ>0?m.occ+'%':''}</div>
                    <div style={{width:'100%',height:80,display:'flex',alignItems:'flex-end',gap:1,position:'relative'}}>
                      {/* Main year bar */}
                      <div style={{flex:1,background:'var(--border)',borderRadius:3,height:'100%',display:'flex',alignItems:'flex-end',overflow:'hidden'}}>
                        <div style={{width:'100%',height:m.occ+'%',background:isCurrent?'var(--gold)':selMonth===i?'var(--gold2)':m.occ>70?'var(--done)':m.occ>40?'rgba(201,150,58,.7)':'rgba(201,150,58,.35)',borderRadius:'2px 2px 0 0',transition:'height .3s',minHeight:m.occ>0?2:0}}/>
                      </div>
                      {/* Comparison year bar */}
                      {occ2!==null&&<div style={{flex:1,background:'var(--border)',borderRadius:3,height:'100%',display:'flex',alignItems:'flex-end',overflow:'hidden'}}>
                        <div style={{width:'100%',height:occ2+'%',background:'rgba(36,113,163,.6)',borderRadius:'2px 2px 0 0',transition:'height .3s',minHeight:occ2>0?2:0}}/>
                      </div>}
                    </div>
                    <div style={{fontSize:7,color:isCurrent?'var(--gold)':selMonth===i?'var(--gold)':'var(--muted)',fontWeight:isCurrent||selMonth===i?800:400}}>{m.lbl}</div>
                  </div>
                );
              })}
            </div>
            {selYear2&&selYear!=='all'&&<div style={{display:'flex',gap:12,marginTop:4,justifyContent:'center'}}>
              <div style={{display:'flex',alignItems:'center',gap:4}}><div style={{width:10,height:10,borderRadius:2,background:'rgba(201,150,58,.7)'}}/><span style={{fontSize:9,color:'var(--muted)'}}>{selYear}</span></div>
              <div style={{display:'flex',alignItems:'center',gap:4}}><div style={{width:10,height:10,borderRadius:2,background:'rgba(36,113,163,.6)'}}/><span style={{fontSize:9,color:'var(--muted)'}}>{selYear2}</span></div>
            </div>}

            {/* Selected month detail */}
            {selMonth!==null&&(()=>{
              const mRes = selYear==='all'
                ? reservations.filter(r=>(selUnit==='all'||r.unitId===parseInt(selUnit))&&r.checkIn.getFullYear()===selMonth).sort((a,b)=>a.checkIn-b.checkIn)
                : reservations.filter(r=>{
                    const inM = r.checkIn.getFullYear()===selYear&&r.checkIn.getMonth()===selMonth ||
                                r.checkOut.getFullYear()===selYear&&r.checkOut.getMonth()===selMonth ||
                                (r.checkIn<=new Date(selYear,selMonth,1)&&r.checkOut>=new Date(selYear,selMonth+1,0));
                    return inM && (selUnit==='all'||r.unitId===parseInt(selUnit));
                  }).sort((a,b)=>a.checkIn-b.checkIn);
              return (
                <div style={{marginTop:12,background:'var(--surface)',border:'1px solid var(--border)',borderRadius:12,padding:'12px 14px'}}>
                  <div style={{fontSize:11,fontWeight:800,color:'var(--gold)',marginBottom:8}}>{selYear==='all'?selMonth:MONTHS[selMonth]+' '+selYear} · {mRes.length} reserva{mRes.length!==1?'s':''}</div>
                  {mRes.length===0?<div style={{fontSize:11,color:'var(--muted)'}}>Sin reservas este mes</div>:
                  mRes.map((r,i)=>(
                    <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:i<mRes.length-1?'1px solid var(--border)':'none'}}>
                      <div>
                        <div style={{fontSize:12,fontWeight:600,color:'var(--text)'}}>{uname(r.unitId)} · {r.guest}</div>
                        <div style={{fontSize:10,color:'var(--muted)'}}>{fmt(r.checkIn)} → {fmt(r.checkOut)}</div>
                      </div>
                      {r.income&&<div style={{fontSize:11,fontWeight:700,color:'var(--done)'}}>{r.income}</div>}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* CANCELLATIONS ANALYSIS */}
          {cancellations.length>0&&(
            <div>
              <div className="dash-section-title">❌ Análisis de cancelaciones</div>
              {(()=>{
                const filtCancels = selYear==='all' ? cancellations
                  : cancellations.filter(r=>r.checkIn.getFullYear()===selYear||r.checkOut.getFullYear()===selYear);
                const filtRes = selYear==='all' ? reservations
                  : reservations.filter(r=>r.checkIn.getFullYear()===selYear||r.checkOut.getFullYear()===selYear);
                const totalDemand = filtRes.length + filtCancels.length;
                const cancelRate = totalDemand>0 ? Math.round(filtCancels.length/totalDemand*100) : 0;
                const cancelNights = filtCancels.reduce((s,r)=>s+Math.max(0,Math.round((r.checkOut-r.checkIn)/(1000*60*60*24))),0);

                // Cancellations by unit
                const byUnit = rentableUnits.map(uid=>{
                  const uc = filtCancels.filter(r=>r.unitId===uid).length;
                  const ur = filtRes.filter(r=>r.unitId===uid).length;
                  const rate = (uc+ur)>0?Math.round(uc/(uc+ur)*100):0;
                  return {uid,cancels:uc,total:uc+ur,rate};
                }).filter(u=>u.cancels>0).sort((a,b)=>b.rate-a.rate);

                // Cancellations by month
                const byMonth = MONTHS.map((lbl,i)=>{
                  const mc = selYear==='all'?filtCancels.filter(r=>r.checkIn.getMonth()===i).length
                    :filtCancels.filter(r=>r.checkIn.getFullYear()===selYear&&r.checkIn.getMonth()===i).length;
                  return {lbl,count:mc};
                });
                const maxMC = Math.max(...byMonth.map(m=>m.count),1);

                return (
                  <div style={{display:'flex',flexDirection:'column',gap:12}}>
                    {/* KPIs */}
                    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
                      {[
                        {n:filtCancels.length, l:'Cancelaciones', c:'var(--urgent)'},
                        {n:cancelRate+'%', l:'Tasa cancel.', c:cancelRate>20?'var(--urgent)':cancelRate>10?'var(--gold)':'var(--done)'},
                        {n:cancelNights+'n', l:'Noches perdidas', c:'var(--muted)'},
                      ].map((k,i)=>(
                        <div key={i} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:10,padding:'10px 8px',textAlign:'center'}}>
                          <div style={{fontSize:18,fontWeight:800,fontFamily:'var(--serif)',color:k.c}}>{k.n}</div>
                          <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.4,marginTop:3,fontWeight:700}}>{k.l}</div>
                        </div>
                      ))}
                    </div>

                    {/* Monthly cancellations bar */}
                    {selYear!=='all'&&<div>
                      <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:1,fontWeight:800,marginBottom:6}}>Por mes</div>
                      <div style={{display:'flex',gap:3,alignItems:'flex-end',height:50}}>
                        {byMonth.map((m,i)=>(
                          <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                            <div style={{width:'100%',background:'var(--border)',borderRadius:3,height:36,display:'flex',alignItems:'flex-end'}}>
                              <div style={{width:'100%',height:m.count>0?Math.round(m.count/maxMC*100)+'%':'0',background:'rgba(184,50,50,.6)',borderRadius:'2px 2px 0 0',minHeight:m.count>0?3:0}}/>
                            </div>
                            <div style={{fontSize:7,color:'var(--muted)'}}>{m.lbl}</div>
                          </div>
                        ))}
                      </div>
                    </div>}

                    {/* By unit */}
                    <div>
                      <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:1,fontWeight:800,marginBottom:6}}>Tasa por unidad</div>
                      {byUnit.slice(0,6).map((u,i)=>(
                        <div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
                          <div style={{fontSize:10,fontWeight:700,color:'var(--text)',width:52,flexShrink:0}}>{uname(u.uid)}</div>
                          <div style={{flex:1,height:5,background:'var(--border)',borderRadius:3,overflow:'hidden'}}>
                            <div style={{height:'100%',borderRadius:3,background:u.rate>30?'var(--urgent)':u.rate>15?'var(--gold)':'rgba(184,50,50,.4)',width:u.rate+'%'}}/>
                          </div>
                          <div style={{fontSize:9,color:u.rate>30?'var(--urgent)':u.rate>15?'var(--gold)':'var(--muted)',fontWeight:700,width:36,textAlign:'right',flexShrink:0}}>{u.rate}% ({u.cancels})</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* TOP UNITS */}
          <div>
            <div className="dash-section-title">🏆 Unidades más activas ({selYear==='all'?'histórico':selYear})</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {unitStats.filter(u=>u.yearRes>0).slice(0,8).map((u,i)=>{
                const maxN = unitStats[0].nights||1;
                return (
                  <div key={u.uid} style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{fontSize:10,fontWeight:800,color:'var(--muted)',width:14,textAlign:'right'}}>{i+1}</div>
                    <div style={{fontSize:11,fontWeight:700,color:'var(--text)',width:72,flexShrink:0}}>{uname(u.uid)}</div>
                    <div style={{flex:1,height:6,background:'var(--border)',borderRadius:3,overflow:'hidden'}}>
                      <div style={{height:'100%',borderRadius:3,background:'var(--gold)',width:Math.round(u.nights/maxN*100)+'%'}}/>
                    </div>
                    <div style={{fontSize:9,color:'var(--muted)',width:60,textAlign:'right',flexShrink:0,lineHeight:1.4}}><div>{u.yearRes} res</div><div>{u.nights} noch</div></div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      )}

      {/* ── Overlay mientras importa ── */}
      {importing&&(
        <div className="overlay" style={{alignItems:'center'}}>
          <div style={{background:'var(--surface)',borderRadius:14,padding:'28px 32px',textAlign:'center',maxWidth:280}}>
            <div className="spinner" style={{margin:'0 auto 14px'}}/>
            <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Importando reservas…</div>
            <div style={{fontSize:11,color:'var(--muted)'}}>Si el servidor estaba dormido, puede tardar unos segundos.</div>
          </div>
        </div>
      )}

      {/* ── Resumen de importación ── */}
      {importResult&&(
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setImportResult(null)} style={{alignItems:'center'}}>
          <div style={{background:'var(--surface)',borderRadius:14,padding:'22px 20px',maxWidth:330,width:'90%'}}>
            {importResult.ok ? (
              <>
                <div style={{fontSize:34,textAlign:'center',marginBottom:6}}>✅</div>
                <div style={{fontSize:17,fontWeight:700,fontFamily:'var(--serif)',textAlign:'center',marginBottom:14}}>Importación completa</div>

                {/* Comparación de ingresos vs última carga */}
                {importResult.snapshotDiff ? (
                  <div style={{background:importResult.snapshotDiff.diff>=0?'rgba(45,110,78,.1)':'rgba(184,50,50,.08)',border:`1px solid ${importResult.snapshotDiff.diff>=0?'rgba(45,110,78,.25)':'rgba(184,50,50,.2)'}`,borderRadius:10,padding:'12px 14px',marginBottom:12,textAlign:'center'}}>
                    <div style={{fontSize:10,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.5,fontWeight:700,marginBottom:4}}>Ingresos {new Date().getFullYear()} vs última carga</div>
                    <div style={{fontSize:22,fontWeight:800,fontFamily:'var(--serif)',color:importResult.snapshotDiff.diff>=0?'var(--done)':'var(--urgent)',lineHeight:1.1}}>
                      {importResult.snapshotDiff.diff>=0?'▲ +':'▼ '}{fmtMoney(Math.abs(importResult.snapshotDiff.diff))}
                    </div>
                    <div style={{fontSize:10,color:'var(--muted)',marginTop:4}}>
                      Antes: {fmtMoney(importResult.snapshotDiff.prevTotal)} · Ahora: {fmtMoney(importResult.newTotal)}
                    </div>
                    <div style={{fontSize:9,color:'var(--muted)',marginTop:2,fontStyle:'italic'}}>Última carga: {importResult.snapshotDiff.date}</div>
                  </div>
                ) : importResult.newTotal>0 ? (
                  <div style={{background:'rgba(201,150,58,.08)',border:'1px solid rgba(201,150,58,.2)',borderRadius:10,padding:'10px 14px',marginBottom:12,textAlign:'center'}}>
                    <div style={{fontSize:11,color:'var(--muted)'}}>Ingresos {new Date().getFullYear()}: <strong style={{color:'var(--gold)'}}>{fmtMoney(importResult.newTotal)}</strong></div>
                    <div style={{fontSize:9,color:'var(--muted)',marginTop:3,fontStyle:'italic'}}>Guardado como referencia. La próxima carga mostrará el cambio.</div>
                  </div>
                ) : null}

                {/* Detalle de cambios por unidad */}
                {importResult.unitChanges && importResult.unitChanges.length>0 && (
                  <div style={{background:'var(--bg)',borderRadius:10,padding:'10px 12px',marginBottom:12}}>
                    <div style={{fontSize:10,color:'var(--muted)',textTransform:'uppercase',letterSpacing:.5,fontWeight:700,marginBottom:8}}>Cambios por unidad</div>
                    <div style={{maxHeight:180,overflowY:'auto'}} className="hide-scroll">
                      {importResult.unitChanges.map((c,i)=>{
                        const up = c.diff>=0;
                        return (
                          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i<importResult.unitChanges.length-1?'1px solid var(--border)':'none'}}>
                            <div>
                              <div style={{fontSize:12,fontWeight:700,color:'var(--text)'}}>{uname(c.uid)}</div>
                              <div style={{fontSize:9,color:'var(--muted)',marginTop:1}}>{fmtMoney(c.before)} → {fmtMoney(c.after)}</div>
                            </div>
                            <div style={{fontSize:13,fontWeight:800,color:up?'var(--done)':'var(--urgent)',flexShrink:0,marginLeft:8}}>
                              {up?'▲ +':'▼ '}{fmtMoney(Math.abs(c.diff))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div style={{background:'var(--bg)',borderRadius:10,padding:'12px 14px',marginBottom:12}}>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontSize:13}}>
                    <span style={{color:'var(--muted)'}}>Reservas activas</span>
                    <span style={{fontWeight:700,color:'var(--done)'}}>{importResult.imported}</span>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontSize:13}}>
                    <span style={{color:'var(--muted)'}}>Cancelaciones</span>
                    <span style={{fontWeight:700}}>{importResult.importedCanc}</span>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontSize:13,borderTop:'1px solid var(--border)',marginTop:4,paddingTop:8}}>
                    <span style={{color:'var(--muted)'}}>Bloqueos del dueño (ignorados)</span>
                    <span style={{color:'var(--muted)'}}>{importResult.stats.skippedOwner}</span>
                  </div>
                  {importResult.stats.skippedUnknownUnit>0&&(
                    <div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontSize:13}}>
                      <span style={{color:'var(--urgent)'}}>Unidad desconocida</span>
                      <span style={{color:'var(--urgent)',fontWeight:700}}>{importResult.stats.skippedUnknownUnit}</span>
                    </div>
                  )}
                  {importResult.stats.skippedBadDate>0&&(
                    <div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontSize:13}}>
                      <span style={{color:'var(--urgent)'}}>Fecha inválida</span>
                      <span style={{color:'var(--urgent)',fontWeight:700}}>{importResult.stats.skippedBadDate}</span>
                    </div>
                  )}
                </div>
                {importResult.stats.unknownUnits.length>0&&(
                  <div style={{background:'var(--urgent-bg)',border:'1px solid var(--urgent)',borderRadius:8,padding:'8px 10px',fontSize:11,color:'var(--urgent)',marginBottom:12}}>
                    ⚠️ Unidades no reconocidas: {importResult.stats.unknownUnits.join(', ')}. Estas reservas no se importaron.
                  </div>
                )}
                <button onClick={()=>setImportResult(null)} style={{width:'100%',background:'var(--gold)',color:'#fff',border:'none',borderRadius:9,padding:'11px',fontWeight:700,fontSize:14,cursor:'pointer'}}>
                  Listo
                </button>
              </>
            ) : (
              <>
                <div style={{fontSize:34,textAlign:'center',marginBottom:6}}>❌</div>
                <div style={{fontSize:17,fontWeight:700,fontFamily:'var(--serif)',textAlign:'center',marginBottom:8}}>No se pudo importar</div>
                <div style={{fontSize:13,color:'var(--muted)',textAlign:'center',marginBottom:16}}>{importResult.error}</div>
                <button onClick={()=>setImportResult(null)} style={{width:'100%',background:'var(--surface)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:9,padding:'11px',fontWeight:700,fontSize:14,cursor:'pointer'}}>
                  Cerrar
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* APP */
function App() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [dark, setDark] = useState(() => localStorage.getItem('ps_theme')==='dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('ps_theme', dark ? 'dark' : 'light');
  }, [dark]);

  if (loading) return (
    <div style={{height:'100%',background:'#1a1208',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:14}}>
      <img src="customcolor_text-logoname_transparent_background.png" style={{width:'52%',maxWidth:190,opacity:.85}} onError={e=>e.target.style.display='none'}/>
      <div style={{width:26,height:2,background:'rgba(201,150,58,.25)',borderRadius:1,overflow:'hidden'}}><div style={{width:'100%',height:'100%',background:'#c9963a',animation:'ld 1.1s ease-in-out infinite'}}/></div>
      <WakeMessage/>
    </div>
  );
  if (!user) return <LoginScreen/>;

  const isAdmin = user.username==='admin';
  const tabs = [
    {id:'dashboard',label:'Inicio'},
    {id:'tasks',   label:'Tareas'},
    {id:'units',   label:'Unidades'},
    {id:'records', label:'Registros'},
    {id:'reservations', label:'Reservas'},
    ...(isAdmin?[{id:'users',label:'Usuarios'}]:[]),
  ];

  const screens = {
    dashboard: <DashboardScreen onNavigate={setTab}/>,
    tasks:   <TasksScreen isDark={dark} onThemeToggle={()=>setDark(d=>!d)}/>,
    units:   <UnitsScreen/>,
    records: <RecordsScreen/>,
    reservations: <ReservationsScreen/>,
    users:   <UsersScreen/>,
  };

  return (
    <div className="app">
      <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column'}}>
        {screens[tab]||screens.tasks}
      </div>
      <nav className="nav">
        {tabs.map(t=>(
          <button key={t.id} className={`nav-item ${tab===t.id?'active':''}`} onClick={()=>setTab(t.id)}>
            {t.id==='dashboard'&&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>}
            {t.id==='tasks'   &&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>}
            {t.id==='units'   &&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>}
            {t.id==='records' &&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>}
            {t.id==='reservations'&&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>}
            {t.id==='users'   &&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>}
            <span>{t.label}</span>
            <div className="nav-dot"/>
          </button>
        ))}
      </nav>
    </div>
  );
}

export { AuthProvider };
export default App;
