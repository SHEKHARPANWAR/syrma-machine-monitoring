/* ====================================================================
   SYRMA SGS — MACHINE BREAKDOWN MONITORING SYSTEM
   Core Application Logic
   ==================================================================== */

/* ---------------- Storage Keys ---------------- */
const LS_KEYS = {
  machines: 'sgs_machines',
  events: 'sgs_breakdown_events',
  masters: 'sgs_master_lists',
  theme: 'sgs_theme'
};

/* ====================================================================
   SUPABASE CLOUD SYNC
   Project: vazgyadhfwvyfsxkwrv

   Data is stored in 3 proper relational tables (not one JSON blob):
     - machines           one row per machine (master data)
     - breakdown_events   one row per failure/repair event
     - master_list_items  one row per Area/Line/Customer dropdown value

   Run the SQL in supabase-schema.sql ONCE in your Supabase project's
   SQL Editor before using this app. After that, every Failure/Repair/
   Add Machine action in the UI writes straight into these tables, and
   Supabase Realtime pushes changes to every other open tab/device.
   ==================================================================== */
const SUPABASE_URL = 'https://uibkmjsvrxueqehyjihx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_MyGXfwgVpUPo6sBi_FGWXQ_5NNOkvI7';

let supabaseClient = null;
let sgsRealtimeChannels = [];
let supabaseSyncTimer = null;
let isApplyingRemoteState = false;
let supabaseReady = false;

function initSupabase(){
  try{
    if(typeof window.supabase === 'undefined' || !window.supabase.createClient){
      console.warn('Supabase JS SDK failed to load; running in local-only mode.');
      return;
    }
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    supabaseReady = true;
  }catch(e){
    console.error('Supabase init failed', e);
    supabaseReady = false;
  }
}

/* ====================================================================
   AUTHENTICATION (Supabase Auth)
   Login is mandatory before any part of the app is usable. We use
   Supabase's built-in Auth system (proper bcrypt password hashing,
   secure session tokens, automatic session persistence/refresh) rather
   than storing passwords ourselves. The human-friendly "User ID" the
   person types (e.g. "Shekharpanwar") is mapped to an internal email-
   shaped identifier ("shekharpanwar@syrmasgs.local") that Supabase Auth
   requires, via the public.profiles table (user_id -> auth user).
   ==================================================================== */
const AUTH_EMAIL_DOMAIN = '@syrmasgs.local';
let CURRENT_USER = null; // { id (uuid), userId, fullName, role }

function userIdToEmail(userId){
  return userId.trim().toLowerCase().replace(/\s+/g,'') + AUTH_EMAIL_DOMAIN;
}

async function loadCurrentProfile(authUser){
  try{
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', authUser.id)
      .maybeSingle();
    if(error){ console.error('Profile load error', error); return null; }
    if(!data){
      // First-ever login for this auth user and no profile row yet (e.g. freshly
      // created in the Supabase dashboard) — create a default operator profile
      // so the app has somewhere to read/write role info.
      const fallbackUserId = (authUser.email || '').split('@')[0];
      const { data: created, error: createErr } = await supabaseClient
        .from('profiles')
        .insert({ id: authUser.id, user_id: fallbackUserId, full_name: fallbackUserId, role: 'operator' })
        .select()
        .single();
      if(createErr){ console.error('Profile bootstrap error', createErr); return null; }
      return created;
    }
    return data;
  }catch(e){
    console.error('Profile load exception', e);
    return null;
  }
}

async function doLogin(userId, password){
  if(!supabaseReady){
    showLoginError('Cloud connection is not ready yet. Please wait a moment and try again.');
    return;
  }
  if(!userId || !password){
    showLoginError('Please enter both a User ID and password.');
    return;
  }
  const email = userIdToEmail(userId);
  const btn = document.getElementById('loginSubmitBtn');
  btn.disabled = true; btn.textContent = 'Signing In…';
  try{
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error){
      showLoginError('Incorrect User ID or password.');
      return;
    }
    const profile = await loadCurrentProfile(data.user);
    if(!profile){
      showLoginError('Login succeeded but your profile could not be loaded. Contact your administrator.');
      await supabaseClient.auth.signOut();
      return;
    }
    CURRENT_USER = { id: data.user.id, userId: profile.user_id, fullName: profile.full_name, role: profile.role };
    await logAudit('login', { userId: profile.user_id });
    await enterApp();
  }catch(e){
    console.error('Login exception', e);
    showLoginError('Something went wrong while signing in. Please try again.');
  }finally{
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

function showLoginError(msg){
  document.getElementById('loginError').textContent = msg;
}

async function doLogout(){
  if(CURRENT_USER){ await logAudit('logout', { userId: CURRENT_USER.userId }); }
  try{ await supabaseClient.auth.signOut(); }catch(e){ console.error('Sign out error', e); }
  CURRENT_USER = null;
  STATE.machines = []; STATE.events = []; STATE.masters = {areas:[],lines:[],customers:[]};
  sgsRealtimeChannels.forEach(ch => { try{ supabaseClient.removeChannel(ch); }catch(e){} });
  sgsRealtimeChannels = [];
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginUserId').value = '';
  document.getElementById('loginPassword').value = '';
  showLoginError('');
}

/* Reveal the app shell, apply role-based UI, and bootstrap data + realtime. */
async function enterApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display = 'flex';
  applyRoleUI();

  loadAll();
  const savedTheme = localStorage.getItem(LS_KEYS.theme) || 'dark';
  applyTheme(savedTheme);

  updateCloudStatus('syncing');
  const gotCloud = await loadFromSupabase();
  if(gotCloud){ renderAll(); }
  subscribeSupabaseRealtime();
  if(CURRENT_USER.role === 'admin'){
    refreshRequestsBadge();
  }

  renderAll();
}

function applyRoleUI(){
  const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el=>{ el.style.display = isAdmin ? 'flex' : 'none'; });
  document.getElementById('sidebarUserName').textContent = CURRENT_USER ? CURRENT_USER.userId : '—';
  document.getElementById('sidebarUserRole').textContent = CURRENT_USER ? CURRENT_USER.role : '—';
}

/* On page load, check if Supabase already has a persisted session (so the
   user stays logged in across browser refreshes/restarts until they log out). */
async function checkExistingSession(){
  if(!supabaseReady) return false;
  try{
    const { data, error } = await supabaseClient.auth.getSession();
    if(error || !data || !data.session) return false;
    const profile = await loadCurrentProfile(data.session.user);
    if(!profile) return false;
    CURRENT_USER = { id: data.session.user.id, userId: profile.user_id, fullName: profile.full_name, role: profile.role };
    return true;
  }catch(e){
    console.error('Session check failed', e);
    return false;
  }
}

/* React to background session changes (e.g. token refreshed automatically,
   or the session was revoked/expired) so the UI never gets stuck showing
   a logged-in shell with no valid session underneath it. */
function wireAuthStateListener(){
  if(!supabaseReady) return;
  supabaseClient.auth.onAuthStateChange((event, session)=>{
    if(event === 'SIGNED_OUT' && CURRENT_USER){
      CURRENT_USER = null;
      document.getElementById('appShell').style.display = 'none';
      document.getElementById('loginScreen').style.display = 'flex';
    }
  });
}
function machineRowToApp(r){
  return { id: r.id, area: r.area, line: r.line, customer: r.customer, machine: r.machine,
           assetNo: r.asset_no, serialNo: r.serial_no, installDate: r.install_date,
           status: r.status, qrPayload: r.qr_payload,
           createdBy: r.created_by, updatedBy: r.updated_by };
}
function machineAppToRow(m){
  return { id: m.id, area: m.area, line: m.line, customer: m.customer, machine: m.machine,
           asset_no: m.assetNo, serial_no: m.serialNo || null, install_date: m.installDate || null,
           status: m.status, qr_payload: m.qrPayload,
           created_by: m.createdBy || (CURRENT_USER && CURRENT_USER.id) || null,
           updated_by: (CURRENT_USER && CURRENT_USER.id) || null,
           updated_at: new Date().toISOString() };
}
function eventRowToApp(r){
  return { id: r.id, machineId: r.machine_id, failTs: Number(r.fail_ts),
           repairTs: r.repair_ts != null ? Number(r.repair_ts) : null, status: r.status,
           createdBy: r.created_by, updatedBy: r.updated_by };
}
function eventAppToRow(ev){
  return { id: ev.id, machine_id: ev.machineId, fail_ts: ev.failTs,
           repair_ts: ev.repairTs, status: ev.status,
           created_by: ev.createdBy || (CURRENT_USER && CURRENT_USER.id) || null,
           updated_by: (CURRENT_USER && CURRENT_USER.id) || null,
           updated_at: new Date().toISOString() };
}

/* Pull the latest cloud state once at startup. Returns true if cloud data was applied. */
async function loadFromSupabase(){
  if(!supabaseReady) return false;
  try{
    const [machinesRes, eventsRes, mastersRes] = await Promise.all([
      supabaseClient.from('machines').select('*'),
      supabaseClient.from('breakdown_events').select('*'),
      supabaseClient.from('master_list_items').select('*')
    ]);
    if(machinesRes.error){ console.error('Supabase machines load error', machinesRes.error); return false; }
    if(eventsRes.error){ console.error('Supabase events load error', eventsRes.error); return false; }
    if(mastersRes.error){ console.error('Supabase masters load error', mastersRes.error); return false; }

    isApplyingRemoteState = true;
    STATE.machines = (machinesRes.data || []).map(machineRowToApp);
    STATE.events = (eventsRes.data || []).map(eventRowToApp);
    const masters = {areas:[],lines:[],customers:[]};
    (mastersRes.data || []).forEach(r=>{
      if(masters[r.list_key]) masters[r.list_key].push(r.value);
    });
    STATE.masters = masters;
    isApplyingRemoteState = false;

    // Mirror into localStorage as offline cache
    localStorage.setItem(LS_KEYS.machines, JSON.stringify(STATE.machines));
    localStorage.setItem(LS_KEYS.events, JSON.stringify(STATE.events));
    localStorage.setItem(LS_KEYS.masters, JSON.stringify(STATE.masters));
    return true;
  }catch(e){
    console.error('Supabase load exception', e);
    return false;
  }
}

/* Push current STATE up to Supabase (debounced so rapid local edits batch into one write).
   Uses upsert (insert-or-update) on primary keys for machines/events, and
   upsert-on-conflict for master list values.

   IMPORTANT (multi-user safety): this NEVER deletes rows by "what's missing
   from local STATE". In a multi-user app, another signed-in user's browser
   may simply not have received a brand-new row yet (e.g. a realtime event
   in flight), and a blanket "delete anything not in my local list" sync
   would wipe out other people's freshly-added machines/breakdowns. Deletes
   only ever happen explicitly, via deleteMachine() calling deleteMachineRemote()
   directly — never as a side-effect of a routine save. */
function syncToSupabase(){
  if(!supabaseReady || isApplyingRemoteState) return;
  clearTimeout(supabaseSyncTimer);
  supabaseSyncTimer = setTimeout(async ()=>{
    try{
      updateCloudStatus('syncing');

      const machineRows = STATE.machines.map(machineAppToRow);
      const eventRows = STATE.events.map(eventAppToRow);
      const masterRows = [];
      Object.keys(STATE.masters || {}).forEach(key=>{
        (STATE.masters[key] || []).forEach(value=>{
          masterRows.push({ list_key: key, value });
        });
      });

      const tasks = [];
      if(machineRows.length) tasks.push(supabaseClient.from('machines').upsert(machineRows));
      if(eventRows.length) tasks.push(supabaseClient.from('breakdown_events').upsert(eventRows));
      if(masterRows.length) tasks.push(supabaseClient.from('master_list_items').upsert(masterRows, {onConflict:'list_key,value'}));

      const results = await Promise.all(tasks);
      const failed = results.find(r=>r && r.error);
      if(failed){
        console.error('Supabase sync error', failed.error);
        updateCloudStatus('error');
      } else {
        updateCloudStatus('synced');
      }
    }catch(e){
      console.error('Supabase sync exception', e);
      updateCloudStatus('error');
    }
  }, 600);
}

/* Explicit, targeted delete — called only from deleteMachine() and
   removeMasterValue(), never inferred from "what's missing locally". */
async function deleteMachineRemote(machineId){
  if(!supabaseReady) return;
  try{
    // breakdown_events has ON DELETE CASCADE on machine_id, so deleting the
    // machine row also removes its events server-side; we still clear the
    // event rows from local STATE/cache immediately for a snappy UI.
    const { error } = await supabaseClient.from('machines').delete().eq('id', machineId);
    if(error) console.error('Remote machine delete error', error);
  }catch(e){
    console.error('Remote machine delete exception', e);
  }
}
async function deleteMasterValueRemote(listKey, value){
  if(!supabaseReady) return;
  try{
    const { error } = await supabaseClient.from('master_list_items').delete().match({ list_key: listKey, value });
    if(error) console.error('Remote master delete error', error);
  }catch(e){
    console.error('Remote master delete exception', e);
  }
}

/* Subscribe to realtime changes so other devices/tabs editing the same
   Supabase tables update this dashboard live without a manual refresh. */
function subscribeSupabaseRealtime(){
  if(!supabaseReady) return;
  const onRemoteChange = async ()=>{
    const ok = await loadFromSupabase();
    if(ok){ renderAll(); updateCloudStatus('synced'); }
  };
  ['machines','breakdown_events','master_list_items'].forEach(table=>{
    const ch = supabaseClient
      .channel('sgs_' + table + '_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table }, onRemoteChange)
      .subscribe();
    sgsRealtimeChannels.push(ch);
  });
}

/* Small visual indicator (uses #liveStatusDot / live-pill text if present, else no-ops safely) */
function updateCloudStatus(state){
  const dot = document.getElementById('liveStatusDot');
  const label = document.getElementById('liveStatusLabel');
  if(!dot && !label) return;
  if(state === 'synced'){
    if(dot) dot.style.background = 'var(--status-run)';
    if(label) label.textContent = 'Cloud Synced';
  } else if(state === 'error'){
    if(dot) dot.style.background = 'var(--status-down)';
    if(label) label.textContent = 'Sync Error';
  } else {
    if(dot) dot.style.background = 'var(--status-warn)';
    if(label) label.textContent = 'Syncing…';
  }
}

/* ====================================================================
   AUDIT TRAIL
   Every significant action (login, logout, machine added/updated/deleted,
   breakdown opened/closed, master data changed, password change requests)
   is written to public.audit_logs with username, timestamp, browser/device
   info, and free-form details. Failures here never block the UI action
   itself — auditing is best-effort.
   ==================================================================== */
async function logAudit(action, details){
  if(!supabaseReady || !CURRENT_USER) return;
  try{
    await supabaseClient.from('audit_logs').insert({
      user_id: CURRENT_USER.id,
      username: CURRENT_USER.userId,
      action,
      details: details || {},
      device_info: navigator.userAgent
    });
  }catch(e){
    console.error('Audit log write failed', e);
  }
}

async function refreshRequestsBadge(){
  if(!supabaseReady || !CURRENT_USER || CURRENT_USER.role !== 'admin') return;
  try{
    const { count, error } = await supabaseClient
      .from('password_change_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    if(error) return;
    const badge = document.getElementById('requestsBadge');
    if(badge){
      badge.textContent = count || 0;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  }catch(e){ /* non-critical */ }
}

/* ---------------- Global State ---------------- */
let STATE = {
  machines: [],   // {id, area, line, customer, machine, assetNo, status, qrPayload}
  events: [],     // {id, machineId, failTs, repairTs, status:'open'|'closed'}
  masters: { areas: [], lines: [], customers: [] },
  dashboardRange: { mode: 'today', from: null, to: null },
  historyRange: { mode: 'all', from: null, to: null },
  sortMachine: { key: null, dir: 1 },
  sortHistory: { key: 'failTs', dir: -1 },
  currentScanMachine: null,
  scannerStream: null,
  scannerRAF: null,
  charts: {}
};

/* ---------------- Utility: IDs & Time ---------------- */
function uid(prefix){ return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8); }
function now(){ return Date.now(); }

function pad2(n){ return String(n).padStart(2,'0'); }
function fmtDate(ts){
  if(!ts) return '—';
  const d = new Date(ts);
  return `${pad2(d.getDate())}-${pad2(d.getMonth()+1)}-${d.getFullYear()}`;
}
function fmtTime(ts){
  if(!ts) return '—';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtDuration(ms){
  if(ms == null || ms < 0) return '—';
  const totalSec = Math.floor(ms/1000);
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const s = totalSec%60;
  if(h>0) return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  return `${m}m ${pad2(s)}s`;
}
function minutesBetween(a,b){ return (b-a)/60000; }

/* Day boundaries */
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x.getTime(); }
function endOfDay(d){ const x=new Date(d); x.setHours(23,59,59,999); return x.getTime(); }
function startOfWeek(d){
  const x=new Date(d); const day=x.getDay(); const diff=(day===0?-6:1)-day; // Monday start
  x.setDate(x.getDate()+diff); return startOfDay(x);
}
function startOfMonth(d){ const x=new Date(d); x.setDate(1); return startOfDay(x); }
function endOfMonth(d){ const x=new Date(d); x.setMonth(x.getMonth()+1); x.setDate(0); return endOfDay(x); }

function getRangeBounds(mode, customFrom, customTo){
  const n = new Date();
  switch(mode){
    case 'today': return [startOfDay(n), endOfDay(n)];
    case 'week': return [startOfWeek(n), endOfDay(n)];
    case 'month': return [startOfMonth(n), endOfDay(n)];
    case 'custom':
      if(customFrom && customTo) return [startOfDay(new Date(customFrom)), endOfDay(new Date(customTo))];
      return [startOfDay(n), endOfDay(n)];
    case 'all': default: return [0, Infinity];
  }
}

/* ---------------- Persistence ---------------- */
function saveAll(){
  try{
    localStorage.setItem(LS_KEYS.machines, JSON.stringify(STATE.machines));
    localStorage.setItem(LS_KEYS.events, JSON.stringify(STATE.events));
    localStorage.setItem(LS_KEYS.masters, JSON.stringify(STATE.masters));
  }catch(e){
    console.error('Storage save failed', e);
    showToast('error','Storage Error','Could not save data. Browser storage may be full.');
  }
  // Push the same state to Supabase (no-op if Supabase isn't reachable/configured)
  if(!isApplyingRemoteState) syncToSupabase();
}
function loadAll(){
  try{
    const m = localStorage.getItem(LS_KEYS.machines);
    const e = localStorage.getItem(LS_KEYS.events);
    const ml = localStorage.getItem(LS_KEYS.masters);
    if(m) STATE.machines = JSON.parse(m);
    if(e) STATE.events = JSON.parse(e);
    if(ml) STATE.masters = JSON.parse(ml);
  }catch(e){
    console.error('Storage load failed', e);
  }
  if(!STATE.masters || !STATE.masters.areas) STATE.masters = {areas:[],lines:[],customers:[]};
}

/* ---------------- Toasts ---------------- */
function showToast(type, title, msg){
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  el.innerHTML = `<div class="t-icon">${icons[type]||icons.info}</div><div><strong>${escapeHtml(title)}</strong>${msg?escapeHtml(msg):''}</div>`;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.transition='opacity 0.3s, transform 0.3s'; el.style.opacity='0'; el.style.transform='translateX(24px)'; setTimeout(()=>el.remove(),320); }, 3600);
}

function escapeHtml(s){
  if(s==null) return '';
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ====================================================================
   CALCULATION ENGINE — MTTR / MTBF
   MTTR = Total Downtime / Number of Failures (closed events with repair)
   MTBF = Total Operating Time / Number of Failures
   Operating Time = time between a repair completion and the next failure
   ==================================================================== */

/* Returns closed events (have both failTs and repairTs) for a machine, optionally bounded by range */
function getClosedEventsForMachine(machineId, from, to){
  return STATE.events.filter(ev => ev.machineId === machineId && ev.status === 'closed' && ev.repairTs != null
    && ev.failTs >= from && ev.failTs <= to);
}
function getAllEventsForMachine(machineId, from, to){
  return STATE.events.filter(ev => ev.machineId === machineId && ev.failTs >= from && ev.failTs <= to);
}

/* MTTR for a single machine over a date range (in minutes) */
function calcMTTR(machineId, from, to){
  const closed = getClosedEventsForMachine(machineId, from, to);
  if(closed.length === 0) return {mttrMin:0, totalDowntimeMin:0, failureCount:0};
  let totalDown = 0;
  closed.forEach(ev => totalDown += minutesBetween(ev.failTs, ev.repairTs));
  return {
    mttrMin: totalDown / closed.length,
    totalDowntimeMin: totalDown,
    failureCount: closed.length
  };
}

/* MTBF for a single machine over a date range (in minutes)
   Operating time accumulated between consecutive repair->next failure pairs,
   sorted chronologically by failure time. */
function calcMTBF(machineId, from, to){
  const closed = getClosedEventsForMachine(machineId, from, to).slice().sort((a,b)=>a.failTs-b.failTs);
  if(closed.length === 0) return {mtbfMin:0, totalOperatingMin:0, failureCount:0};
  if(closed.length === 1){
    // Not enough data points for a gap; MTBF undefined with only 1 failure & no prior repair reference.
    return {mtbfMin:0, totalOperatingMin:0, failureCount:1};
  }
  let totalOperating = 0;
  let gaps = 0;
  for(let i=1;i<closed.length;i++){
    const prevRepair = closed[i-1].repairTs;
    const thisFailure = closed[i].failTs;
    if(thisFailure > prevRepair){
      totalOperating += minutesBetween(prevRepair, thisFailure);
      gaps++;
    }
  }
  return {
    mtbfMin: gaps > 0 ? totalOperating / gaps : 0,
    totalOperatingMin: totalOperating,
    failureCount: closed.length
  };
}

/* ====================================================================
   GROUP-LEVEL MTTR / MTBF — Area-wise and Line-wise
   A group (Area or Line) typically spans several machines. We pool every
   closed breakdown event from all machines belonging to that group, sort
   them chronologically as one combined timeline, and apply the same
   MTTR/MTBF formulas used for a single machine:
     MTTR = Total Downtime (group) / Number of Failures (group)
     MTBF = Total Operating Time (group) / Number of Failures (group)
   This mirrors standard plant engineering practice of treating a line or
   area as one production system rather than averaging per-machine ratios,
   which would under/over-weight machines with different failure counts.
   ==================================================================== */
function calcGroupMTTR(machineIds, from, to){
  const closed = [];
  machineIds.forEach(id => closed.push(...getClosedEventsForMachine(id, from, to)));
  if(closed.length === 0) return {mttrMin:0, totalDowntimeMin:0, failureCount:0};
  let totalDown = 0;
  closed.forEach(ev => totalDown += minutesBetween(ev.failTs, ev.repairTs));
  return {
    mttrMin: totalDown / closed.length,
    totalDowntimeMin: totalDown,
    failureCount: closed.length
  };
}

function calcGroupMTBF(machineIds, from, to){
  const closed = [];
  machineIds.forEach(id => closed.push(...getClosedEventsForMachine(id, from, to)));
  closed.sort((a,b)=>a.failTs-b.failTs);
  if(closed.length <= 1) return {mtbfMin:0, totalOperatingMin:0, failureCount:closed.length};
  let totalOperating = 0, gaps = 0;
  for(let i=1;i<closed.length;i++){
    const prevRepair = closed[i-1].repairTs;
    const thisFailure = closed[i].failTs;
    if(thisFailure > prevRepair){
      totalOperating += minutesBetween(prevRepair, thisFailure);
      gaps++;
    }
  }
  return {
    mtbfMin: gaps > 0 ? totalOperating / gaps : 0,
    totalOperatingMin: totalOperating,
    failureCount: closed.length
  };
}

/* Returns [{label, machineIds}] grouped by Area or Line, in first-seen order */
function groupMachinesBy(field){
  const order = [];
  const map = {};
  STATE.machines.forEach(m=>{
    const key = m[field] || '—';
    if(!map[key]){ map[key] = []; order.push(key); }
    map[key].push(m.id);
  });
  return order.map(key => ({ label: key, machineIds: map[key] }));
}


/* Aggregate stats across all machines for a date range */
function calcOverallStats(from, to){
  let totalFailures = 0, totalRepairs = 0, totalDowntimeMin = 0, mttrSum = 0, mttrCount = 0, mtbfSum = 0, mtbfCount = 0;
  STATE.machines.forEach(m=>{
    const allEv = getAllEventsForMachine(m.id, from, to);
    totalFailures += allEv.length;
    const closedEv = allEv.filter(e=>e.status==='closed');
    totalRepairs += closedEv.length;
    const mttr = calcMTTR(m.id, from, to);
    totalDowntimeMin += mttr.totalDowntimeMin;
    if(mttr.failureCount > 0){ mttrSum += mttr.mttrMin; mttrCount++; }
    const mtbf = calcMTBF(m.id, from, to);
    if(mtbf.totalOperatingMin > 0){ mtbfSum += mtbf.mtbfMin; mtbfCount++; }
  });
  const runningCount = STATE.machines.filter(m=>m.status==='running').length;
  const breakdownCount = STATE.machines.filter(m=>m.status==='breakdown').length;
  return {
    totalMachines: STATE.machines.length,
    runningMachines: runningCount,
    breakdownMachines: breakdownCount,
    totalFailures,
    totalRepairs,
    totalDowntimeMin,
    avgMTTR: mttrCount > 0 ? mttrSum/mttrCount : 0,
    avgMTBF: mtbfCount > 0 ? mtbfSum/mtbfCount : 0
  };
}

/* ====================================================================
   MACHINE / EVENT DATA HELPERS
   ==================================================================== */
function findMachine(id){ return STATE.machines.find(m=>m.id===id); }
function findMachineByQr(payload){
  // payload could be JSON {machineId, machineName} or a plain assetNo/id string
  let parsed = null;
  try{ parsed = JSON.parse(payload); }catch(e){ /* not JSON */ }
  if(parsed && parsed.machineId){
    return findMachine(parsed.machineId) || STATE.machines.find(m=>m.assetNo===parsed.machineId);
  }
  // fallback: try matching assetNo or id directly against raw string
  return STATE.machines.find(m => m.id === payload || m.assetNo === payload);
}
function getOpenEventForMachine(machineId){
  return STATE.events.find(ev => ev.machineId === machineId && ev.status === 'open');
}

function createMachine({area, line, customer, machine, assetNo, serialNo, installDate}){
  const m = {
    id: uid('mc'),
    area: area.trim(), line: line.trim(), customer: customer.trim(),
    machine: machine.trim(), assetNo: (assetNo||'').trim(),
    serialNo: (serialNo||'').trim(), installDate: installDate || null,
    status: 'running',
    createdBy: CURRENT_USER ? CURRENT_USER.id : null,
    qrPayload: JSON.stringify({machineId: null, machineName: machine.trim()}) // placeholder, set after id known
  };
  m.qrPayload = JSON.stringify({machineId: m.id, machineName: m.machine, assetNo: m.assetNo});
  STATE.machines.push(m);
  registerMasterValue('areas', m.area);
  registerMasterValue('lines', m.line);
  registerMasterValue('customers', m.customer);
  saveAll();
  logAudit('machine_added', { machineId: m.id, machine: m.machine, assetNo: m.assetNo });
  return m;
}

function recordFailure(machineId){
  const m = findMachine(machineId);
  if(!m) return null;
  if(getOpenEventForMachine(machineId)){
    showToast('error','Already in Breakdown','This machine already has an active breakdown event.');
    return null;
  }
  const ev = { id: uid('ev'), machineId, failTs: now(), repairTs: null, status: 'open',
               createdBy: CURRENT_USER ? CURRENT_USER.id : null };
  STATE.events.push(ev);
  m.status = 'breakdown';
  saveAll();
  logAudit('breakdown_added', { machineId, machine: m.machine, eventId: ev.id });
  return ev;
}

function recordRepair(machineId){
  const ev = getOpenEventForMachine(machineId);
  const m = findMachine(machineId);
  if(!ev || !m) return null;
  ev.repairTs = now();
  ev.status = 'closed';
  m.status = 'running';
  saveAll();
  logAudit('breakdown_closed', { machineId, machine: m.machine, eventId: ev.id, downtimeMin: Math.round(minutesBetween(ev.failTs, ev.repairTs)) });
  return ev;
}

function registerMasterValue(listKey, value){
  if(!value) return;
  if(!STATE.masters[listKey].some(v => v.toLowerCase() === value.toLowerCase())){
    STATE.masters[listKey].push(value);
  }
}

/* NOTE: "Load Sample Data" and "Reset All Data" have been permanently
   removed from this application per requirement #3. There is intentionally
   no function here to bulk-generate or bulk-wipe data — all data now lives
   in the shared Supabase database and is managed only through the normal
   Add Machine / Record Failure / Record Repair / Delete Machine actions,
   each of which is audit-logged. */

/* ====================================================================
   RENDERING — DASHBOARD VIEW
   ==================================================================== */
function getActiveDashboardRange(){
  const {mode, from, to} = STATE.dashboardRange;
  return getRangeBounds(mode, from, to);
}

function kpiCardHtml({label, value, sub, tone, icon}){
  return `
  <div class="kpi-card glass tone-${tone}">
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

const ICONS = {
  machine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
  run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12A10 10 0 1 1 12 2"/><path d="M22 2L12 12"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  failure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  repair: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/></svg>'
};

function renderKpis(){
  const [from, to] = getActiveDashboardRange();
  const stats = calcOverallStats(from, to);
  const grid = document.getElementById('kpiGrid');
  grid.innerHTML = [
    kpiCardHtml({label:'Total Machines', value:stats.totalMachines, tone:'info', icon:ICONS.machine}),
    kpiCardHtml({label:'Running Machines', value:stats.runningMachines, tone:'run', icon:ICONS.run, sub:`${stats.totalMachines? Math.round(stats.runningMachines/stats.totalMachines*100):0}% of fleet`}),
    kpiCardHtml({label:'Breakdown Machines', value:stats.breakdownMachines, tone:'down', icon:ICONS.down}),
    kpiCardHtml({label:'Total Failures', value:stats.totalFailures, tone:'warn', icon:ICONS.failure}),
    kpiCardHtml({label:'Total Repairs', value:stats.totalRepairs, tone:'run', icon:ICONS.repair}),
    kpiCardHtml({label:'Total Downtime', value:fmtDuration(stats.totalDowntimeMin*60000), tone:'down', icon:ICONS.clock}),
    kpiCardHtml({label:'Average MTTR', value: stats.avgMTTR.toFixed(1)+' min', sub:(stats.avgMTTR/60).toFixed(2)+' hrs', tone:'info', icon:ICONS.trend}),
    kpiCardHtml({label:'Average MTBF', value: stats.avgMTBF.toFixed(1)+' min', sub:(stats.avgMTBF/60).toFixed(2)+' hrs', tone:'run', icon:ICONS.trend})
  ].join('');
}

function statusChipHtml(status){
  if(status === 'running') return `<span class="status-chip run"><span class="dot"></span>Running</span>`;
  return `<span class="status-chip down"><span class="dot"></span>Breakdown</span>`;
}

function renderMachineTable(){
  const [from, to] = getActiveDashboardRange();
  const search = (document.getElementById('machineSearch').value || '').toLowerCase();
  let rows = STATE.machines.map(m=>{
    const mttr = calcMTTR(m.id, from, to);
    const mtbf = calcMTBF(m.id, from, to);
    return {
      id: m.id, area:m.area, line:m.line, customer:m.customer, machine:m.machine, assetNo:m.assetNo,
      status:m.status, mttr: mttr.mttrMin, mtbf: mtbf.mtbfMin, failures: mttr.failureCount
    };
  });
  if(search){
    rows = rows.filter(r => [r.area,r.line,r.customer,r.machine,r.assetNo].join(' ').toLowerCase().includes(search));
  }
  const {key, dir} = STATE.sortMachine;
  if(key){
    rows.sort((a,b)=>{
      let av=a[key], bv=b[key];
      if(typeof av === 'string'){ av=av.toLowerCase(); bv=bv.toLowerCase(); }
      if(av<bv) return -1*dir; if(av>bv) return 1*dir; return 0;
    });
  }
  const tbody = document.getElementById('machineTableBody');
  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty">No machines match your filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.area)}</td>
      <td>${escapeHtml(r.line)}</td>
      <td>${escapeHtml(r.customer)}</td>
      <td>${escapeHtml(r.machine)}</td>
      <td class="mono">${escapeHtml(r.assetNo)}</td>
      <td>${statusChipHtml(r.status)}</td>
      <td class="mono">${r.mttr.toFixed(1)}</td>
      <td class="mono">${r.mtbf.toFixed(1)}</td>
      <td class="mono">${r.failures}</td>
    </tr>`).join('');
}

function renderDashboard(){
  renderKpis();
  renderMachineTable();
}

/* ====================================================================
   RENDERING — LIVE BREAKDOWN VIEW
   ==================================================================== */
function renderLiveView(){
  const openEvents = STATE.events.filter(ev => ev.status === 'open');
  const grid = document.getElementById('liveGrid');
  const badge = document.getElementById('liveBadge');
  badge.textContent = openEvents.length;
  badge.style.display = openEvents.length > 0 ? 'inline-flex' : 'none';

  if(openEvents.length === 0){
    grid.innerHTML = `<div class="empty-state glass" style="grid-column:1/-1;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12A10 10 0 1 1 12 2"/><path d="M22 2L12 12"/></svg>
      <div>All machines are currently running. No active breakdowns.</div>
    </div>`;
    return;
  }
  grid.innerHTML = openEvents.map(ev=>{
    const m = findMachine(ev.machineId);
    if(!m) return '';
    return `
    <div class="live-card glass" data-fail-ts="${ev.failTs}" data-ev-id="${ev.id}">
      <div class="live-card-top">
        <div>
          <h4>${escapeHtml(m.machine)}</h4>
          <div class="meta">${escapeHtml(m.area)} · ${escapeHtml(m.line)}<br>${escapeHtml(m.customer)} · ${escapeHtml(m.assetNo)}</div>
        </div>
        <span class="status-chip down"><span class="dot"></span>Down</span>
      </div>
      <div class="timer-label">Failure started ${fmtTime(ev.failTs)} on ${fmtDate(ev.failTs)}</div>
      <div class="timer-display live-timer" data-start="${ev.failTs}">00:00:00</div>
      <button class="btn btn-success btn-block mt16" onclick="quickRepair('${m.id}')">Mark Repaired</button>
    </div>`;
  }).join('');
}

function quickRepair(machineId){
  const ev = recordRepair(machineId);
  if(ev){
    const m = findMachine(machineId);
    showToast('success','Machine Repaired', `${m.machine} is back to running.`);
    renderAll();
  }
}

function tickLiveTimers(){
  document.querySelectorAll('.live-timer').forEach(el=>{
    const start = parseInt(el.dataset.start,10);
    const elapsed = now() - start;
    el.textContent = fmtDuration(elapsed).replace(/^(\d+)m/, m=>m).length ? formatHMS(elapsed) : '00:00:00';
  });
}
function formatHMS(ms){
  const totalSec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const s = totalSec%60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/* ====================================================================
   RENDERING — BREAKDOWN HISTORY VIEW
   ==================================================================== */
function getActiveHistoryRange(){
  const {mode, from, to} = STATE.historyRange;
  return getRangeBounds(mode, from, to);
}

function renderHistoryTable(){
  const [from, to] = getActiveHistoryRange();
  const search = (document.getElementById('historySearch').value || '').toLowerCase();
  let rows = STATE.events
    .filter(ev => ev.failTs >= from && ev.failTs <= to)
    .map(ev=>{
      const m = findMachine(ev.machineId) || {};
      return {
        failTs: ev.failTs, repairTs: ev.repairTs,
        duration: ev.repairTs ? ev.repairTs - ev.failTs : (now() - ev.failTs),
        open: !ev.repairTs,
        area: m.area||'—', line: m.line||'—', machine: m.machine||'—', customer: m.customer||'—'
      };
    });
  if(search){
    rows = rows.filter(r => [r.area,r.line,r.machine,r.customer].join(' ').toLowerCase().includes(search));
  }
  const {key, dir} = STATE.sortHistory;
  if(key){
    rows.sort((a,b)=>{
      const map = {failDate:'failTs', failTime:'failTs', repairDate:'repairTs', repairTime:'repairTs', duration:'duration', area:'area', line:'line', machine:'machine', customer:'customer'};
      let realKey = map[key] || key;
      let av=a[realKey], bv=b[realKey];
      if(av==null) av = -Infinity;
      if(bv==null) bv = -Infinity;
      if(typeof av === 'string'){ av=av.toLowerCase(); bv=(bv||'').toLowerCase(); }
      if(av<bv) return -1*dir; if(av>bv) return 1*dir; return 0;
    });
  }
  const tbody = document.getElementById('historyTableBody');
  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty">No breakdown history for this period.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r=>`
    <tr>
      <td>${fmtDate(r.failTs)}</td>
      <td class="mono">${fmtTime(r.failTs)}</td>
      <td>${r.repairTs ? fmtDate(r.repairTs) : '<span class="status-chip down"><span class="dot"></span>Ongoing</span>'}</td>
      <td class="mono">${r.repairTs ? fmtTime(r.repairTs) : '—'}</td>
      <td class="mono">${fmtDuration(r.duration)}</td>
      <td>${escapeHtml(r.area)}</td>
      <td>${escapeHtml(r.line)}</td>
      <td>${escapeHtml(r.machine)}</td>
      <td>${escapeHtml(r.customer)}</td>
    </tr>`).join('');
}

/* ====================================================================
   RENDERING — MACHINES MASTER VIEW
   ==================================================================== */
function populateMachineFilters(){
  const fill = (selId, listKey) => {
    const sel = document.getElementById(selId);
    if(!sel) return;
    const current = sel.value;
    const opts = (STATE.masters[listKey]||[]).slice().sort();
    sel.innerHTML = `<option value="">All ${listKey.charAt(0).toUpperCase()+listKey.slice(1)}</option>` +
      opts.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if(opts.includes(current)) sel.value = current;
  };
  fill('filterArea','areas');
  fill('filterLine','lines');
  fill('filterCustomer','customers');
}

function renderMachinesMaster(){
  populateMachineFilters();
  const search = (document.getElementById('machinesMasterSearch').value || '').toLowerCase();
  const fArea = document.getElementById('filterArea').value;
  const fLine = document.getElementById('filterLine').value;
  const fCustomer = document.getElementById('filterCustomer').value;
  const fStatus = document.getElementById('filterStatus').value;
  let rows = STATE.machines.slice();
  if(fArea) rows = rows.filter(m=>m.area===fArea);
  if(fLine) rows = rows.filter(m=>m.line===fLine);
  if(fCustomer) rows = rows.filter(m=>m.customer===fCustomer);
  if(fStatus) rows = rows.filter(m=>m.status===fStatus);
  if(search){
    rows = rows.filter(m => [m.area,m.line,m.customer,m.machine,m.assetNo,m.serialNo].join(' ').toLowerCase().includes(search));
  }
  const tbody = document.getElementById('machinesMasterBody');
  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty">No machines match your filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(m=>`
    <tr>
      <td>${escapeHtml(m.area)}</td>
      <td>${escapeHtml(m.line)}</td>
      <td>${escapeHtml(m.customer)}</td>
      <td>${escapeHtml(m.machine)}</td>
      <td class="mono">${escapeHtml(m.assetNo||'—')}</td>
      <td class="mono">${escapeHtml(m.serialNo||'—')}</td>
      <td class="mono">${m.installDate ? fmtDate(new Date(m.installDate).getTime()) : '—'}</td>
      <td>${statusChipHtml(m.status)}</td>
      <td><button class="btn btn-sm" onclick="showQrModal('${m.id}')">View QR</button></td>
      <td style="display:flex;gap:6px;">
        <button class="btn btn-sm" onclick="openEditMachineModal('${m.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteMachine('${m.id}')">Delete</button>
      </td>
    </tr>`).join('');
}

function deleteMachine(id){
  const m = findMachine(id);
  openConfirmModal('Delete Machine?', 'This will permanently remove the machine and all its breakdown history. This cannot be undone.', async ()=>{
    STATE.machines = STATE.machines.filter(m=>m.id!==id);
    STATE.events = STATE.events.filter(ev=>ev.machineId!==id);
    localStorage.setItem(LS_KEYS.machines, JSON.stringify(STATE.machines));
    localStorage.setItem(LS_KEYS.events, JSON.stringify(STATE.events));
    await deleteMachineRemote(id);
    renderAll();
    logAudit('machine_deleted', { machineId: id, machine: m ? m.machine : null });
    showToast('success','Machine Deleted','The machine and its history were removed.');
  });
}

/* ====================================================================
   RENDERING — SETTINGS / MASTER LISTS
   ==================================================================== */
function renderMasterLists(){
  const render = (listKey, containerId) => {
    const container = document.getElementById(containerId);
    const items = STATE.masters[listKey] || [];
    if(items.length === 0){ container.innerHTML = '<span class="text-muted">No entries yet.</span>'; return; }
    container.innerHTML = items.map(v => `<span class="status-chip" style="background:rgba(255,255,255,0.08);color:var(--text-1);margin:3px 4px 0 0;">${escapeHtml(v)} <span style="cursor:pointer;margin-left:4px;color:var(--status-down);" onclick="removeMasterValue('${listKey}','${escapeHtml(v).replace(/'/g,"\\'")}')">&times;</span></span>`).join('');
  };
  render('areas','areaList');
  render('lines','lineList');
  render('customers','customerList');
}
async function removeMasterValue(listKey, value){
  STATE.masters[listKey] = STATE.masters[listKey].filter(v=>v!==value);
  localStorage.setItem(LS_KEYS.masters, JSON.stringify(STATE.masters));
  await deleteMasterValueRemote(listKey, value);
  renderMasterLists();
  populateDropdowns();
  logAudit('master_data_changed', { listKey, action: 'removed', value });
}

/* ====================================================================
   MODAL SYSTEM
   ==================================================================== */
function openModal(html){
  document.getElementById('modalBox').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('open');
}
function closeModal(){
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('modalBox').innerHTML = '';
}
document.getElementById('modalOverlay').addEventListener('click', (e)=>{
  if(e.target.id === 'modalOverlay') closeModal();
});

function openConfirmModal(title, message, onConfirm){
  openModal(`
    <div class="modal-head"><h3>${escapeHtml(title)}</h3><div class="modal-close" onclick="closeModal()">&times;</div></div>
    <p class="text-sm" style="color:var(--text-2);">${escapeHtml(message)}</p>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" id="confirmModalBtn">Confirm</button>
    </div>
  `);
  document.getElementById('confirmModalBtn').onclick = () => { onConfirm(); closeModal(); };
}

/* ---------------- Add Machine Modal ---------------- */
function dropdownOptionsHtml(listKey, selected){
  const opts = (STATE.masters[listKey]||[]).map(v=>`<option value="${escapeHtml(v)}" ${v===selected?'selected':''}>${escapeHtml(v)}</option>`).join('');
  return `<option value="">-- Select or type custom below --</option>` + opts;
}

function openAddMachineModal(){
  openModal(`
    <div class="modal-head"><h3>Add New Machine</h3><div class="modal-close" onclick="closeModal()">&times;</div></div>
    <div class="field-row" style="flex-direction:column;gap:14px;">
      <div class="field">
        <label>Area</label>
        <select class="field-input" id="newMachineAreaSelect">${dropdownOptionsHtml('areas')}</select>
        <input class="field-input mt8" id="newMachineAreaCustom" placeholder="Or type a new area...">
      </div>
      <div class="field">
        <label>Production Line</label>
        <select class="field-input" id="newMachineLineSelect">${dropdownOptionsHtml('lines')}</select>
        <input class="field-input mt8" id="newMachineLineCustom" placeholder="Or type a new line...">
      </div>
      <div class="field">
        <label>Customer Name</label>
        <select class="field-input" id="newMachineCustomerSelect">${dropdownOptionsHtml('customers')}</select>
        <input class="field-input mt8" id="newMachineCustomerCustom" placeholder="Or type a new customer...">
      </div>
      <div class="field">
        <label>Machine Name</label>
        <input class="field-input" id="newMachineName" placeholder="e.g. CNC Lathe MX-200">
      </div>
      <div class="field">
        <label>Asset Number</label>
        <input class="field-input" id="newMachineAsset" placeholder="e.g. AST-1009">
      </div>
      <div class="field">
        <label>Serial Number</label>
        <input class="field-input" id="newMachineSerial" placeholder="e.g. SN-552190">
      </div>
      <div class="field">
        <label>Installation Date</label>
        <input class="field-input" id="newMachineInstallDate" type="date">
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="saveNewMachineBtn">Save Machine</button>
    </div>
  `);
  document.getElementById('saveNewMachineBtn').onclick = submitNewMachine;
}

function submitNewMachine(){
  const area = document.getElementById('newMachineAreaCustom').value.trim() || document.getElementById('newMachineAreaSelect').value;
  const line = document.getElementById('newMachineLineCustom').value.trim() || document.getElementById('newMachineLineSelect').value;
  const customer = document.getElementById('newMachineCustomerCustom').value.trim() || document.getElementById('newMachineCustomerSelect').value;
  const machine = document.getElementById('newMachineName').value.trim();
  const assetNo = document.getElementById('newMachineAsset').value.trim();
  const serialNo = document.getElementById('newMachineSerial').value.trim();
  const installDate = document.getElementById('newMachineInstallDate').value;

  if(!area || !line || !customer || !machine){
    showToast('error','Missing Fields','Please fill in Area, Line, Customer, and Machine Name before saving.');
    return;
  }
  // Prevent duplicate machine entries: same machine name + asset/serial combo,
  // or a clashing non-empty asset/serial number already in use.
  const dupAsset = assetNo && STATE.machines.some(m=>(m.assetNo||'').toLowerCase() === assetNo.toLowerCase());
  const dupSerial = serialNo && STATE.machines.some(m=>(m.serialNo||'').toLowerCase() === serialNo.toLowerCase());
  if(dupAsset){ showToast('error','Duplicate Asset Number','A machine with this Asset Number already exists.'); return; }
  if(dupSerial){ showToast('error','Duplicate Serial Number','A machine with this Serial Number already exists.'); return; }
  if(!assetNo && !serialNo){
    const dupExact = STATE.machines.some(m=>
      m.machine.toLowerCase()===machine.toLowerCase() && m.area.toLowerCase()===area.toLowerCase() && m.line.toLowerCase()===line.toLowerCase());
    if(dupExact){ showToast('error','Duplicate Machine','A machine with this name already exists on this Area/Line. Add an Asset or Serial Number to tell them apart.'); return; }
  }

  createMachine({area, line, customer, machine, assetNo, serialNo, installDate});
  closeModal();
  renderAll();
  showToast('success','Machine Added', `${machine} has been added to the master list.`);
}

/* ---------------- Edit Machine Modal ---------------- */
function openEditMachineModal(id){
  const m = findMachine(id);
  if(!m) return;
  openModal(`
    <div class="modal-head"><h3>Edit Machine</h3><div class="modal-close" onclick="closeModal()">&times;</div></div>
    <div class="field-row" style="flex-direction:column;gap:14px;">
      <div class="field">
        <label>Area</label>
        <select class="field-input" id="editMachineAreaSelect">${dropdownOptionsHtml('areas', m.area)}</select>
        <input class="field-input mt8" id="editMachineAreaCustom" placeholder="Or type a new area...">
      </div>
      <div class="field">
        <label>Production Line</label>
        <select class="field-input" id="editMachineLineSelect">${dropdownOptionsHtml('lines', m.line)}</select>
        <input class="field-input mt8" id="editMachineLineCustom" placeholder="Or type a new line...">
      </div>
      <div class="field">
        <label>Customer Name</label>
        <select class="field-input" id="editMachineCustomerSelect">${dropdownOptionsHtml('customers', m.customer)}</select>
        <input class="field-input mt8" id="editMachineCustomerCustom" placeholder="Or type a new customer...">
      </div>
      <div class="field">
        <label>Machine Name</label>
        <input class="field-input" id="editMachineName" value="${escapeHtml(m.machine)}">
      </div>
      <div class="field">
        <label>Asset Number</label>
        <input class="field-input" id="editMachineAsset" value="${escapeHtml(m.assetNo||'')}">
      </div>
      <div class="field">
        <label>Serial Number</label>
        <input class="field-input" id="editMachineSerial" value="${escapeHtml(m.serialNo||'')}">
      </div>
      <div class="field">
        <label>Installation Date</label>
        <input class="field-input" id="editMachineInstallDate" type="date" value="${m.installDate||''}">
      </div>
      <div class="field">
        <label>Status</label>
        <select class="field-input" id="editMachineStatus">
          <option value="running" ${m.status==='running'?'selected':''}>Running</option>
          <option value="breakdown" ${m.status==='breakdown'?'selected':''}>Breakdown</option>
        </select>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="saveEditMachineBtn">Save Changes</button>
    </div>
  `);
  document.getElementById('saveEditMachineBtn').onclick = ()=>submitEditMachine(id);
}

function submitEditMachine(id){
  const m = findMachine(id);
  if(!m) return;
  const area = document.getElementById('editMachineAreaCustom').value.trim() || document.getElementById('editMachineAreaSelect').value;
  const line = document.getElementById('editMachineLineCustom').value.trim() || document.getElementById('editMachineLineSelect').value;
  const customer = document.getElementById('editMachineCustomerCustom').value.trim() || document.getElementById('editMachineCustomerSelect').value;
  const machine = document.getElementById('editMachineName').value.trim();
  const assetNo = document.getElementById('editMachineAsset').value.trim();
  const serialNo = document.getElementById('editMachineSerial').value.trim();
  const installDate = document.getElementById('editMachineInstallDate').value;
  const status = document.getElementById('editMachineStatus').value;

  if(!area || !line || !customer || !machine){
    showToast('error','Missing Fields','Please fill in Area, Line, Customer, and Machine Name.');
    return;
  }
  const dupAsset = assetNo && STATE.machines.some(o=>o.id!==id && (o.assetNo||'').toLowerCase() === assetNo.toLowerCase());
  const dupSerial = serialNo && STATE.machines.some(o=>o.id!==id && (o.serialNo||'').toLowerCase() === serialNo.toLowerCase());
  if(dupAsset){ showToast('error','Duplicate Asset Number','Another machine already uses this Asset Number.'); return; }
  if(dupSerial){ showToast('error','Duplicate Serial Number','Another machine already uses this Serial Number.'); return; }

  m.area = area; m.line = line; m.customer = customer; m.machine = machine;
  m.assetNo = assetNo; m.serialNo = serialNo; m.installDate = installDate || null;
  m.status = status;
  m.qrPayload = JSON.stringify({machineId: m.id, machineName: m.machine, assetNo: m.assetNo});
  registerMasterValue('areas', area);
  registerMasterValue('lines', line);
  registerMasterValue('customers', customer);
  saveAll();
  closeModal();
  renderAll();
  logAudit('machine_updated', { machineId: id, machine });
  showToast('success','Machine Updated', `${machine} has been updated.`);
}

/* ---------------- QR Code Display Modal ---------------- */
/* Lightweight QR rendering via QR Server-free canvas matrix using a minimal embedded encoder
   (we leverage the jsQR library's absence of an encoder by drawing a simple data-matrix style
   placeholder is not acceptable, so instead we generate a true QR using the 'qrcode-generator'-style
   algorithm implemented inline below). */
function showQrModal(machineId){
  const m = findMachine(machineId);
  if(!m) return;
  openModal(`
    <div class="modal-head"><h3>${escapeHtml(m.machine)} — QR Code</h3><div class="modal-close" onclick="closeModal()">&times;</div></div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:14px;">
      <div id="qrCanvasHolder" style="background:#fff;padding:16px;border-radius:14px;"></div>
      <div class="text-sm text-muted" style="text-align:center;">
        ${escapeHtml(m.machine)}<br>Asset No: ${escapeHtml(m.assetNo)}
      </div>
      <button class="btn btn-sm" id="printQrBtn">Print QR Label</button>
    </div>
  `);
  renderQrToElement(m.qrPayload, document.getElementById('qrCanvasHolder'));
  document.getElementById('printQrBtn').onclick = () => window.print();
}

/* ====================================================================
   QR CODE RENDERING — uses the qrcode-generator library (Kazuhiko Arase)
   loaded via CDN. Renders the machine's QR payload to a canvas.
   ==================================================================== */
function renderQrToElement(payload, container){
  container.innerHTML = '';
  try{
    // Auto-pick the smallest QR version that fits the payload, ECC level L
    let qr = null;
    for(let typeNumber = 1; typeNumber <= 20; typeNumber++){
      try{
        const candidate = qrcode(typeNumber, 'L');
        candidate.addData(payload);
        candidate.make();
        qr = candidate;
        break;
      }catch(e){ continue; }
    }
    if(!qr) throw new Error('Payload too long to encode as QR');

    const count = qr.getModuleCount();
    const cell = 6; // px per module
    const margin = 4;
    const size = (count + margin*2) * cell;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for(let r=0; r<count; r++){
      for(let c=0; c<count; c++){
        if(qr.isDark(r,c)){ ctx.fillRect((c+margin)*cell, (r+margin)*cell, cell, cell); }
      }
    }
    container.appendChild(canvas);
  }catch(e){
    console.error('QR render failed', e);
    container.innerHTML = `<div style="color:#b91c1c;padding:20px;font-size:13px;">Could not render QR (payload too long).</div>`;
  }
}


/* ====================================================================
   QR CAMERA SCANNER (jsQR-based, continuous scanning)
   ==================================================================== */
let scannerCanvas = null, scannerCtx = null, scannerActive = false, lastScanPayload = null, lastScanTime = 0;

async function startCamera(){
  const video = document.getElementById('qrVideo');
  const statusEl = document.getElementById('scannerStatus');
  try{
    statusEl.textContent = 'Requesting camera access...';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    STATE.scannerStream = stream;
    video.srcObject = stream;
    await video.play();
    document.getElementById('startCameraBtn').classList.add('hide');
    document.getElementById('stopCameraBtn').classList.remove('hide');
    statusEl.textContent = 'Scanning... point camera at a machine QR code.';
    scannerCanvas = document.createElement('canvas');
    scannerCtx = scannerCanvas.getContext('2d', { willReadFrequently: true });
    scannerActive = true;
    requestAnimationFrame(scanLoop);
  }catch(err){
    console.error('Camera error', err);
    statusEl.textContent = 'Could not access camera. Check permissions, or use Manual Entry below.';
    showToast('error','Camera Unavailable', 'Please allow camera access or use manual entry.');
  }
}

function stopCamera(){
  scannerActive = false;
  if(STATE.scannerStream){
    STATE.scannerStream.getTracks().forEach(t=>t.stop());
    STATE.scannerStream = null;
  }
  const video = document.getElementById('qrVideo');
  video.srcObject = null;
  document.getElementById('startCameraBtn').classList.remove('hide');
  document.getElementById('stopCameraBtn').classList.add('hide');
  document.getElementById('scannerStatus').textContent = 'Camera idle. Tap "Start Camera" to begin scanning.';
}

function scanLoop(){
  if(!scannerActive) return;
  const video = document.getElementById('qrVideo');
  if(video.readyState === video.HAVE_ENOUGH_DATA && typeof jsQR === 'function'){
    scannerCanvas.width = video.videoWidth;
    scannerCanvas.height = video.videoHeight;
    scannerCtx.drawImage(video, 0, 0, scannerCanvas.width, scannerCanvas.height);
    const imageData = scannerCtx.getImageData(0,0,scannerCanvas.width, scannerCanvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if(code && code.data){
      const isDuplicateRecent = (code.data === lastScanPayload) && (now() - lastScanTime < 2500);
      if(!isDuplicateRecent){
        lastScanPayload = code.data;
        lastScanTime = now();
        handleScannedPayload(code.data);
      }
    }
  }
  if(scannerActive) requestAnimationFrame(scanLoop);
}

function handleScannedPayload(payload){
  const m = findMachineByQr(payload);
  if(!m){
    showToast('error','Unknown QR Code', 'This QR code does not match any registered machine.');
    return;
  }
  showScanResult(m);
}

function showScanResult(m){
  const area = document.getElementById('scanResultArea');
  const isRunning = m.status === 'running';
  area.innerHTML = `
    <div class="machine-result-card glass">
      <div class="machine-result-head">
        <div>
          <h4>${escapeHtml(m.machine)}</h4>
          <div class="machine-result-meta">
            ${escapeHtml(m.area)} · ${escapeHtml(m.line)}<br>
            Customer: ${escapeHtml(m.customer)}<br>
            Asset No: ${escapeHtml(m.assetNo)}
          </div>
        </div>
        ${statusChipHtml(m.status)}
      </div>
      ${isRunning ? `
        <div class="action-btn-row">
          <button class="action-btn failure" onclick="handleFailureAction('${m.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            Failure
          </button>
          <button class="action-btn repaired" disabled style="opacity:0.4;cursor:not-allowed;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
            Repaired
          </button>
        </div>
        <div class="text-sm text-muted" style="text-align:center;">Machine is currently running normally.</div>
      ` : `
        <div class="action-btn-row">
          <button class="action-btn failure" disabled style="opacity:0.4;cursor:not-allowed;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            Failure
          </button>
          <button class="action-btn repaired" onclick="handleRepairAction('${m.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
            Repaired
          </button>
        </div>
        <div class="text-sm text-muted" style="text-align:center;">Machine is currently in breakdown. Mark as repaired when fixed.</div>
      `}
    </div>
  `;
}

function handleFailureAction(machineId){
  const ev = recordFailure(machineId);
  if(ev){
    const m = findMachine(machineId);
    showToast('error','Breakdown Recorded', `${m.machine} marked as breakdown at ${fmtTime(ev.failTs)}.`);
    showScanResult(m);
    renderAll();
  }
}
function handleRepairAction(machineId){
  const ev = recordRepair(machineId);
  if(ev){
    const m = findMachine(machineId);
    const downtime = fmtDuration(ev.repairTs - ev.failTs);
    showToast('success','Repair Recorded', `${m.machine} repaired. Downtime: ${downtime}.`);
    showScanResult(m);
    renderAll();
  }
}

/* ---------------- Manual Entry / Lookup Modal ---------------- */
function openManualLookupModal(){
  const options = STATE.machines.map(m => `<option value="${m.id}">${escapeHtml(m.machine)} (${escapeHtml(m.assetNo)}) — ${escapeHtml(m.area)}/${escapeHtml(m.line)}</option>`).join('');
  openModal(`
    <div class="modal-head"><h3>Manual Machine Lookup</h3><div class="modal-close" onclick="closeModal()">&times;</div></div>
    <div class="field">
      <label>Select Machine</label>
      <select class="field-input" id="manualMachineSelect">
        <option value="">-- Choose a machine --</option>
        ${options}
      </select>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="manualLookupConfirm">Look Up</button>
    </div>
  `);
  document.getElementById('manualLookupConfirm').onclick = () => {
    const id = document.getElementById('manualMachineSelect').value;
    if(!id){ showToast('error','No Machine Selected','Please choose a machine from the list.'); return; }
    const m = findMachine(id);
    closeModal();
    showScanResult(m);
  };
}

/* ====================================================================
   ANALYTICS — CHART.JS VISUALIZATIONS
   ==================================================================== */
function destroyChart(key){
  if(STATE.charts[key]){ STATE.charts[key].destroy(); delete STATE.charts[key]; }
}

function getChartColors(){
  const isLight = document.body.getAttribute('data-theme') === 'light';
  return {
    text: isLight ? '#454e63' : '#aab4c8',
    grid: isLight ? 'rgba(20,30,60,0.08)' : 'rgba(255,255,255,0.08)',
    cyan: '#22d3ee', blue:'#3b82f6', indigo:'#6366f1', red:'#ef4444', green:'#22c55e', amber:'#f59e0b'
  };
}

function renderAnalytics(){
  if(typeof Chart === 'undefined') return;
  const colors = getChartColors();
  Chart.defaults.color = colors.text;
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";

  const [from, to] = [0, Infinity]; // analytics uses all-time data for full picture

  // --- Area-wise MTTR & MTBF ---
  const areaGroups = groupMachinesBy('area');
  const areaLabels = areaGroups.map(g=>g.label);
  const areaMttrData = areaGroups.map(g => +calcGroupMTTR(g.machineIds, from, to).mttrMin.toFixed(1));
  const areaMtbfData = areaGroups.map(g => +calcGroupMTBF(g.machineIds, from, to).mtbfMin.toFixed(1));

  destroyChart('mttrArea');
  STATE.charts.mttrArea = new Chart(document.getElementById('chartMttrArea'), {
    type:'bar',
    data:{ labels:areaLabels, datasets:[{ label:'MTTR (min)', data:areaMttrData, backgroundColor:colors.blue, borderRadius:6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}} } }
  });
  destroyChart('mtbfArea');
  STATE.charts.mtbfArea = new Chart(document.getElementById('chartMtbfArea'), {
    type:'bar',
    data:{ labels:areaLabels, datasets:[{ label:'MTBF (min)', data:areaMtbfData, backgroundColor:colors.green, borderRadius:6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}} } }
  });

  // --- Line-wise MTTR & MTBF ---
  const lineGroups = groupMachinesBy('line');
  const lineLabels = lineGroups.map(g=>g.label);
  const lineMttrData = lineGroups.map(g => +calcGroupMTTR(g.machineIds, from, to).mttrMin.toFixed(1));
  const lineMtbfData = lineGroups.map(g => +calcGroupMTBF(g.machineIds, from, to).mtbfMin.toFixed(1));

  destroyChart('mttrLine');
  STATE.charts.mttrLine = new Chart(document.getElementById('chartMttrLine'), {
    type:'bar',
    data:{ labels:lineLabels, datasets:[{ label:'MTTR (min)', data:lineMttrData, backgroundColor:colors.indigo, borderRadius:6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}} } }
  });
  destroyChart('mtbfLine');
  STATE.charts.mtbfLine = new Chart(document.getElementById('chartMtbfLine'), {
    type:'bar',
    data:{ labels:lineLabels, datasets:[{ label:'MTBF (min)', data:lineMtbfData, backgroundColor:colors.cyan, borderRadius:6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}} } }
  });

  // --- MTTR by machine ---
  const mttrLabels = [], mttrData = [];
  STATE.machines.forEach(m=>{
    const r = calcMTTR(m.id, from, to);
    mttrLabels.push(m.machine);
    mttrData.push(+r.mttrMin.toFixed(1));
  });
  destroyChart('mttr');
  STATE.charts.mttr = new Chart(document.getElementById('chartMttr'), {
    type:'bar',
    data:{ labels:mttrLabels, datasets:[{ label:'MTTR (min)', data:mttrData, backgroundColor:colors.blue, borderRadius:6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}} } }
  });

  // --- MTBF by machine ---
  const mtbfLabels = [], mtbfData = [];
  STATE.machines.forEach(m=>{
    const r = calcMTBF(m.id, from, to);
    mtbfLabels.push(m.machine);
    mtbfData.push(+r.mtbfMin.toFixed(1));
  });
  destroyChart('mtbf');
  STATE.charts.mtbf = new Chart(document.getElementById('chartMtbf'), {
    type:'bar',
    data:{ labels:mtbfLabels, datasets:[{ label:'MTBF (min)', data:mtbfData, backgroundColor:colors.green, borderRadius:6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}} } }
  });

  // --- Breakdown count by line ---
  const lineMap = {};
  STATE.machines.forEach(m=>{
    const count = getAllEventsForMachine(m.id, from, to).length;
    lineMap[m.line] = (lineMap[m.line]||0) + count;
  });
  destroyChart('lineBreak');
  STATE.charts.lineBreak = new Chart(document.getElementById('chartLineBreak'), {
    type:'doughnut',
    data:{ labels:Object.keys(lineMap), datasets:[{ data:Object.values(lineMap), backgroundColor:[colors.blue,colors.indigo,colors.cyan,colors.amber,colors.red,colors.green] }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:14}}} }
  });

  // --- Downtime trend, last 14 days ---
  const days = [];
  const dayMs = 86400000;
  for(let i=13;i>=0;i--){ days.push(startOfDay(now() - i*dayMs)); }
  const downtimeByDay = days.map(dayStart=>{
    const dayEnd = endOfDay(dayStart);
    let totalMin = 0;
    STATE.events.forEach(ev=>{
      if(ev.failTs >= dayStart && ev.failTs <= dayEnd && ev.repairTs){
        totalMin += minutesBetween(ev.failTs, ev.repairTs);
      }
    });
    return +totalMin.toFixed(1);
  });
  destroyChart('downtimeTrend');
  STATE.charts.downtimeTrend = new Chart(document.getElementById('chartDowntimeTrend'), {
    type:'line',
    data:{ labels: days.map(d=>fmtDate(d).slice(0,5)), datasets:[{ label:'Downtime (min)', data:downtimeByDay, borderColor:colors.red, backgroundColor:'rgba(239,68,68,0.15)', fill:true, tension:0.35, pointRadius:3 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}} } }
  });

  // --- Monthly failure trend, last 6 months ---
  const months = [];
  const baseMonth = new Date(); baseMonth.setDate(1);
  for(let i=5;i>=0;i--){ const d=new Date(baseMonth); d.setMonth(d.getMonth()-i); months.push(d); }
  const monthlyFailures = months.map(mDate=>{
    const from_ = startOfMonth(mDate), to_ = endOfMonth(mDate);
    return STATE.events.filter(ev=>ev.failTs>=from_ && ev.failTs<=to_).length;
  });
  destroyChart('monthlyFailures');
  STATE.charts.monthlyFailures = new Chart(document.getElementById('chartMonthlyFailures'), {
    type:'bar',
    data:{ labels: months.map(d=>d.toLocaleString('en',{month:'short',year:'2-digit'})), datasets:[{ label:'Failures', data:monthlyFailures, backgroundColor:colors.indigo, borderRadius:8, maxBarThickness:50 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:colors.grid}, ticks:{precision:0}} } }
  });
}

/* ====================================================================
   EXPORT FUNCTIONS — CSV / EXCEL / PRINT / MONTHLY REPORT
   ==================================================================== */
function arrayToCsv(rows){
  return rows.map(row => row.map(cell=>{
    const s = String(cell ?? '');
    if(s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  }).join(',')).join('\r\n');
}
function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getMachineTableRows(){
  const [from, to] = getActiveDashboardRange();
  const rows = [['Area','Line','Customer','Machine','Asset No','Status','MTTR (min)','MTBF (min)','Failures']];
  STATE.machines.forEach(m=>{
    const mttr = calcMTTR(m.id, from, to);
    const mtbf = calcMTBF(m.id, from, to);
    rows.push([m.area, m.line, m.customer, m.machine, m.assetNo, m.status, mttr.mttrMin.toFixed(1), mtbf.mtbfMin.toFixed(1), mttr.failureCount]);
  });
  return rows;
}
function getHistoryTableRows(){
  const [from, to] = getActiveHistoryRange();
  const rows = [['Failure Date','Failure Time','Repair Date','Repair Time','Downtime','Area','Line','Machine','Customer']];
  STATE.events.filter(ev=>ev.failTs>=from && ev.failTs<=to).forEach(ev=>{
    const m = findMachine(ev.machineId) || {};
    rows.push([
      fmtDate(ev.failTs), fmtTime(ev.failTs),
      ev.repairTs?fmtDate(ev.repairTs):'Ongoing', ev.repairTs?fmtTime(ev.repairTs):'—',
      fmtDuration(ev.repairTs ? ev.repairTs-ev.failTs : now()-ev.failTs),
      m.area||'—', m.line||'—', m.machine||'—', m.customer||'—'
    ]);
  });
  return rows;
}

function exportMachinesCsv(){
  downloadFile('syrma_sgs_machine_dashboard.csv', arrayToCsv(getMachineTableRows()), 'text/csv');
  showToast('success','Exported','Machine dashboard exported as CSV.');
}
function exportMachinesXlsx(){
  const ws = XLSX.utils.aoa_to_sheet(getMachineTableRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Machine Dashboard');
  XLSX.writeFile(wb, 'syrma_sgs_machine_dashboard.xlsx');
  showToast('success','Exported','Machine dashboard exported as Excel file.');
}
function exportHistoryCsv(){
  downloadFile('syrma_sgs_breakdown_history.csv', arrayToCsv(getHistoryTableRows()), 'text/csv');
  showToast('success','Exported','Breakdown history exported as CSV.');
}
function exportHistoryXlsx(){
  const ws = XLSX.utils.aoa_to_sheet(getHistoryTableRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Breakdown History');
  XLSX.writeFile(wb, 'syrma_sgs_breakdown_history.xlsx');
  showToast('success','Exported','Breakdown history exported as Excel file.');
}
function downloadMonthlyReport(){
  const from = startOfMonth(new Date()), to = endOfMonth(new Date());
  const stats = calcOverallStats(from, to);
  const rows = [
    ['Syrma SGS — Monthly Breakdown Report'],
    ['Period', `${fmtDate(from)} to ${fmtDate(to)}`],
    [],
    ['Metric','Value'],
    ['Total Machines', stats.totalMachines],
    ['Running Machines', stats.runningMachines],
    ['Breakdown Machines', stats.breakdownMachines],
    ['Total Failures', stats.totalFailures],
    ['Total Repairs', stats.totalRepairs],
    ['Total Downtime (min)', stats.totalDowntimeMin.toFixed(1)],
    ['Average MTTR (min)', stats.avgMTTR.toFixed(1)],
    ['Average MTBF (min)', stats.avgMTBF.toFixed(1)],
    []
  ];
  const machineRows = [['--- Machine-Wise Detail ---']];
  rows.push(...machineRows);
  const detail = getMachineTableRowsForRange(from, to);
  rows.push(...detail);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Monthly Report');
  const monthName = new Date().toLocaleString('en',{month:'long',year:'numeric'});
  XLSX.writeFile(wb, `syrma_sgs_monthly_report_${monthName.replace(' ','_')}.xlsx`);
  showToast('success','Report Generated', `Monthly report for ${monthName} downloaded.`);
}
function getMachineTableRowsForRange(from, to){
  const rows = [['Area','Line','Customer','Machine','Asset No','Status','MTTR (min)','MTBF (min)','Failures']];
  STATE.machines.forEach(m=>{
    const mttr = calcMTTR(m.id, from, to);
    const mtbf = calcMTBF(m.id, from, to);
    rows.push([m.area, m.line, m.customer, m.machine, m.assetNo, m.status, mttr.mttrMin.toFixed(1), mtbf.mtbfMin.toFixed(1), mttr.failureCount]);
  });
  return rows;
}

/* ====================================================================
   NAVIGATION / VIEW SWITCHING
   ==================================================================== */
const VIEW_TITLES = {
  dashboard: ['Dashboard','Real-time machine breakdown overview'],
  scan: ['Scan QR', 'Scan a machine QR code to log a failure or repair'],
  live: ['Live Breakdowns', 'Machines currently under breakdown'],
  machines: ['Machines', 'Manage machine master data'],
  history: ['Breakdown History', 'Full breakdown event log'],
  analytics: ['Analytics', 'MTTR, MTBF and downtime trends'],
  settings: ['Master Data', 'Manage dropdown lists and data'],
  requests: ['Requests', 'ID / password change requests'],
  audit: ['Audit Log', 'Full activity trail for every user']
};
const ADMIN_ONLY_VIEWS = ['requests','audit'];

function switchView(viewName){
  if(ADMIN_ONLY_VIEWS.includes(viewName) && (!CURRENT_USER || CURRENT_USER.role !== 'admin')){
    showToast('error','Admins Only','You do not have permission to view this section.');
    return;
  }
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+viewName).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.view===viewName));
  const [title, sub] = VIEW_TITLES[viewName] || ['',''];
  document.getElementById('topbarTitle').textContent = title;
  document.getElementById('topbarSub').textContent = sub;

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');

  // Stop camera if leaving scan view
  if(viewName !== 'scan' && STATE.scannerStream){ stopCamera(); }

  if(viewName === 'dashboard') renderDashboard();
  if(viewName === 'live') renderLiveView();
  if(viewName === 'machines') renderMachinesMaster();
  if(viewName === 'history') renderHistoryTable();
  if(viewName === 'analytics') renderAnalytics();
  if(viewName === 'settings') renderMasterLists();
  if(viewName === 'requests') renderRequestsTable();
  if(viewName === 'audit') renderAuditTable();
}

document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click', ()=> switchView(item.dataset.view));
});

document.getElementById('menuToggle').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarBackdrop').classList.toggle('show');
});
document.getElementById('sidebarBackdrop').addEventListener('click', ()=>{
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
});

/* ====================================================================
   THEME TOGGLE
   ==================================================================== */
function applyTheme(theme){
  document.body.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeIcon');
  if(theme === 'light'){
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  } else {
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
  localStorage.setItem(LS_KEYS.theme, theme);
  // Re-render active charts with new color scheme
  const activeView = document.querySelector('.view.active');
  if(activeView && activeView.id === 'view-analytics') renderAnalytics();
}
document.getElementById('themeToggle').addEventListener('click', ()=>{
  const current = document.body.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

/* ====================================================================
   DROPDOWN POPULATION (Area / Line / Customer used across modals)
   ==================================================================== */
function populateDropdowns(){
  // Dropdowns are rebuilt at modal-open time via dropdownOptionsHtml(), nothing persistent to refresh here.
}

/* ====================================================================
   EVENT WIRING — Dashboard
   ==================================================================== */
document.getElementById('machineSearch').addEventListener('input', renderMachineTable);
document.getElementById('exportMachinesCsv').addEventListener('click', exportMachinesCsv);
document.getElementById('exportMachinesXlsx').addEventListener('click', exportMachinesXlsx);
document.getElementById('printDashboard').addEventListener('click', ()=> window.print());

document.querySelectorAll('#dateRangeTabs .tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#dateRangeTabs .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const range = btn.dataset.range;
    document.getElementById('customRangeRow').style.display = range === 'custom' ? 'flex' : 'none';
    if(range !== 'custom'){
      STATE.dashboardRange = {mode:range, from:null, to:null};
      renderDashboard();
    }
  });
});
document.getElementById('applyCustomRange').addEventListener('click', ()=>{
  const from = document.getElementById('customFrom').value;
  const to = document.getElementById('customTo').value;
  if(!from || !to){ showToast('error','Select Dates','Please choose both a start and end date.'); return; }
  STATE.dashboardRange = {mode:'custom', from, to};
  renderDashboard();
});

document.querySelectorAll('#machineTable thead th').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.key;
    if(STATE.sortMachine.key === key){ STATE.sortMachine.dir *= -1; }
    else { STATE.sortMachine = {key, dir:1}; }
    renderMachineTable();
  });
});

/* ---------------- Scan view wiring ---------------- */
document.getElementById('startCameraBtn').addEventListener('click', startCamera);
document.getElementById('stopCameraBtn').addEventListener('click', stopCamera);
document.getElementById('manualLookupBtn').addEventListener('click', openManualLookupModal);

/* ---------------- Machines master wiring ---------------- */
document.getElementById('machinesMasterSearch').addEventListener('input', renderMachinesMaster);
document.getElementById('addMachineBtn').addEventListener('click', openAddMachineModal);
['filterArea','filterLine','filterCustomer','filterStatus'].forEach(id=>{
  document.getElementById(id).addEventListener('change', renderMachinesMaster);
});

/* ---------------- History view wiring ---------------- */
document.getElementById('historySearch').addEventListener('input', renderHistoryTable);
document.getElementById('exportHistoryCsv').addEventListener('click', exportHistoryCsv);
document.getElementById('exportHistoryXlsx').addEventListener('click', exportHistoryXlsx);
document.getElementById('downloadMonthlyReport').addEventListener('click', downloadMonthlyReport);
document.querySelectorAll('#historyRangeTabs .tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#historyRangeTabs .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    STATE.historyRange = {mode:btn.dataset.range, from:null, to:null};
    renderHistoryTable();
  });
});
document.querySelectorAll('#historyTable thead th').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.key;
    if(STATE.sortHistory.key === key){ STATE.sortHistory.dir *= -1; }
    else { STATE.sortHistory = {key, dir:1}; }
    renderHistoryTable();
  });
});

/* ---------------- Settings wiring ---------------- */
function wireMasterAdd(inputId, btnId, listKey, renderFn){
  document.getElementById(btnId).addEventListener('click', ()=>{
    const input = document.getElementById(inputId);
    const val = input.value.trim();
    if(!val) return;
    registerMasterValue(listKey, val);
    input.value = '';
    saveAll();
    renderMasterLists();
    logAudit('master_data_changed', { listKey, action: 'added', value: val });
  });
}
wireMasterAdd('newAreaInput','addAreaBtn','areas');
wireMasterAdd('newLineInput','addLineBtn','lines');
wireMasterAdd('newCustomerInput','addCustomerBtn','customers');

/* NOTE: "Load Sample Data" and "Reset All Data" controls have been
   permanently removed per requirement #3 — there is intentionally no
   wiring for them anywhere in the app. */

/* ====================================================================
   CLOCK + LIVE TIMER TICKER
   ==================================================================== */
function tickClock(){
  const d = new Date();
  document.getElementById('clockDisplay').textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ====================================================================
   GLOBAL RENDER + INIT
   ==================================================================== */
function renderAll(){
  const activeView = document.querySelector('.view.active');
  const viewName = activeView ? activeView.id.replace('view-','') : 'dashboard';
  if(viewName === 'dashboard') renderDashboard();
  if(viewName === 'live') renderLiveView();
  if(viewName === 'machines') renderMachinesMaster();
  if(viewName === 'history') renderHistoryTable();
  if(viewName === 'analytics') renderAnalytics();
  if(viewName === 'settings') renderMasterLists();
  if(viewName === 'requests') renderRequestsTable();
  if(viewName === 'audit') renderAuditTable();
  // Always refresh badge count regardless of view
  const openCount = STATE.events.filter(ev=>ev.status==='open').length;
  const badge = document.getElementById('liveBadge');
  badge.textContent = openCount;
  badge.style.display = openCount > 0 ? 'inline-flex' : 'none';
}

/* ====================================================================
   PASSWORD CHANGE REQUEST WORKFLOW
   Users never change their own credentials directly. They submit a
   request (current ID, name, email, reason, optional new ID) which is
   stored in public.password_change_requests for an admin to action.
   ==================================================================== */
function openPasswordRequestModal(){
  openModal(`
    <div class="modal-head"><h3>Request ID / Password Change</h3><div class="modal-close" onclick="closeModal()">&times;</div></div>
    <p class="text-sm" style="color:var(--text-2);">Submit this form and your administrator (Shekhar Panwar) will review it. This does not change your credentials immediately.</p>
    <div class="field-row mt16" style="flex-direction:column;gap:14px;">
      <div class="field">
        <label>Current User ID</label>
        <input class="field-input" id="pcrCurrentUserId" placeholder="Your current login ID">
      </div>
      <div class="field">
        <label>Full Name</label>
        <input class="field-input" id="pcrFullName" placeholder="Your full name">
      </div>
      <div class="field">
        <label>Email</label>
        <input class="field-input" id="pcrEmail" type="email" placeholder="you@syrmasgs.com">
      </div>
      <div class="field">
        <label>Reason for Change</label>
        <textarea class="field-input" id="pcrReason" rows="3" placeholder="e.g. Forgot password / need a new User ID"></textarea>
      </div>
      <div class="field">
        <label>Requested New User ID (optional)</label>
        <input class="field-input" id="pcrNewUserId" placeholder="Leave blank to keep your current ID">
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="submitPcrBtn">Submit Request</button>
    </div>
  `);
  document.getElementById('submitPcrBtn').onclick = submitPasswordChangeRequest;
}

async function submitPasswordChangeRequest(){
  const currentUserId = document.getElementById('pcrCurrentUserId').value.trim();
  const fullName = document.getElementById('pcrFullName').value.trim();
  const email = document.getElementById('pcrEmail').value.trim();
  const reason = document.getElementById('pcrReason').value.trim();
  const requestedUserId = document.getElementById('pcrNewUserId').value.trim();

  if(!currentUserId || !fullName || !email || !reason){
    showToast('error','Missing Fields','Please fill in Current User ID, Name, Email, and Reason.');
    return;
  }
  if(!supabaseReady){
    showToast('error','Not Connected','Cloud connection is not ready yet. Please try again shortly.');
    return;
  }
  try{
    const { error } = await supabaseClient.from('password_change_requests').insert({
      current_user_id: currentUserId,
      requested_user_id: requestedUserId || null,
      full_name: fullName,
      email,
      reason
    });
    if(error){ console.error('Password request insert error', error); showToast('error','Submission Failed','Could not submit your request. Please try again.'); return; }
    await logAudit('password_change_requested', { currentUserId, requestedUserId: requestedUserId || null });
    closeModal();
    showToast('success','Request Submitted','Your administrator has been notified and will review your request.');
  }catch(e){
    console.error('Password request exception', e);
    showToast('error','Submission Failed','Could not submit your request. Please try again.');
  }
}

async function renderRequestsTable(){
  const tbody = document.getElementById('requestsTableBody');
  if(!tbody || !supabaseReady) return;
  try{
    const { data, error } = await supabaseClient
      .from('password_change_requests')
      .select('*')
      .order('created_at', { ascending: false });
    if(error){ console.error('Requests load error', error); return; }
    if(!data || data.length === 0){
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">No requests submitted yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(r=>`
      <tr>
        <td class="mono">${fmtDate(new Date(r.created_at).getTime())}</td>
        <td>${escapeHtml(r.current_user_id)}</td>
        <td>${escapeHtml(r.full_name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.requested_user_id||'—')}</td>
        <td style="max-width:220px;">${escapeHtml(r.reason)}</td>
        <td><span class="status-chip ${r.status}">${escapeHtml(r.status)}</span></td>
        <td>${r.status === 'pending' ? `
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-success" onclick="resolvePasswordRequest(${r.id},'resolved')">Mark Resolved</button>
            <button class="btn btn-sm btn-danger" onclick="resolvePasswordRequest(${r.id},'rejected')">Reject</button>
          </div>` : '—'}</td>
      </tr>`).join('');
    refreshRequestsBadge();
  }catch(e){
    console.error('Requests render exception', e);
  }
}

async function resolvePasswordRequest(id, status){
  try{
    const { error } = await supabaseClient
      .from('password_change_requests')
      .update({ status, resolved_at: new Date().toISOString() })
      .eq('id', id);
    if(error){ console.error('Resolve request error', error); showToast('error','Update Failed','Could not update this request.'); return; }
    logAudit('password_change_request_resolved', { requestId: id, status });
    renderRequestsTable();
    showToast('success','Request Updated', `Marked as ${status}.`);
  }catch(e){
    console.error('Resolve request exception', e);
  }
}

/* ====================================================================
   AUDIT LOG VIEW (ADMIN)
   ==================================================================== */
async function renderAuditTable(){
  const tbody = document.getElementById('auditTableBody');
  if(!tbody || !supabaseReady) return;
  const search = (document.getElementById('auditSearch').value || '').toLowerCase();
  try{
    const { data, error } = await supabaseClient
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if(error){ console.error('Audit load error', error); return; }
    let rows = data || [];
    if(search){
      rows = rows.filter(r => [r.username, r.action, JSON.stringify(r.details||{})].join(' ').toLowerCase().includes(search));
    }
    if(rows.length === 0){
      tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No activity recorded yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r=>{
      const ts = new Date(r.created_at).getTime();
      return `<tr>
        <td class="mono">${fmtDate(ts)}</td>
        <td class="mono">${fmtTime(ts)}</td>
        <td>${escapeHtml(r.username||'—')}</td>
        <td>${escapeHtml(r.action)}</td>
        <td style="max-width:320px;font-size:12px;color:var(--text-3);">${escapeHtml(JSON.stringify(r.details||{}))}</td>
        <td style="max-width:200px;font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.device_info||'—')}</td>
      </tr>`;
    }).join('');
  }catch(e){
    console.error('Audit render exception', e);
  }
}

/* ====================================================================
   LOGIN / LOGOUT WIRING
   ==================================================================== */
document.getElementById('loginSubmitBtn').addEventListener('click', ()=>{
  doLogin(document.getElementById('loginUserId').value, document.getElementById('loginPassword').value);
});
document.getElementById('loginPassword').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter') doLogin(document.getElementById('loginUserId').value, document.getElementById('loginPassword').value);
});
document.getElementById('loginUserId').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter') document.getElementById('loginPassword').focus();
});
document.getElementById('openPasswordRequestBtn').addEventListener('click', openPasswordRequestModal);
document.getElementById('logoutBtn').addEventListener('click', ()=>{
  openConfirmModal('Log Out?', 'You will need to sign in again to access the dashboard.', doLogout);
});
document.getElementById('refreshAuditBtn').addEventListener('click', renderAuditTable);
document.getElementById('auditSearch').addEventListener('input', renderAuditTable);

async function init(){
  initSupabase();
  if(!supabaseReady){
    showLoginError('Cloud connection unavailable. Check your internet connection and reload.');
    return;
  }
  wireAuthStateListener();
  const hasSession = await checkExistingSession();
  if(hasSession){
    await enterApp();
  }
  // If no session, the login screen (visible by default) simply waits for input.

  tickClock();
  setInterval(tickClock, 1000);
  setInterval(()=>{
    tickLiveTimers();
    if(CURRENT_USER){
      const openCount = STATE.events.filter(ev=>ev.status==='open').length;
      const badge = document.getElementById('liveBadge');
      badge.textContent = openCount;
      badge.style.display = openCount > 0 ? 'inline-flex' : 'none';
    }
  }, 1000);

  // Keep live view fresh if currently open (re-render every 30s to catch new breakdowns from elsewhere)
  setInterval(()=>{
    if(!CURRENT_USER) return;
    const activeView = document.querySelector('.view.active');
    if(activeView && activeView.id === 'view-live'){ renderLiveView(); }
  }, 30000);

  // Keep the admin "pending requests" badge fresh
  setInterval(()=>{
    if(CURRENT_USER && CURRENT_USER.role === 'admin') refreshRequestsBadge();
  }, 20000);
}

window.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', ()=>{
  if(STATE.scannerStream){ STATE.scannerStream.getTracks().forEach(t=>t.stop()); }
});