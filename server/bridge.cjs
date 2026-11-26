const crypto = require('crypto');
const fs = require('fs');
const {atomic} = require('./store.cjs');
function allowedPath(value) {
  return typeof value === 'string' && /^\/api\/v1\/tenders(?:\?[^\s#]*|\/[a-f0-9-]{36})$/i.test(value);
}
function createBridge({ timeout = 120000, pace = 2400, pairingFile, now = Date.now } = {}) {
  let client, heartbeat = 0, verified = false, error = null, lastRequest = 0, authBlocked = false, lastResponse = null;
  if(pairingFile&&fs.existsSync(pairingFile))try{const saved=JSON.parse(fs.readFileSync(pairingFile,'utf8'));if(/^[a-f0-9]{64}$/.test(saved.token))client={token:saved.token};}catch{}
  const pending = new Map();
  function auth(token) { if (!client || token !== client.token) throw Object.assign(new Error('Reconnect the Tenderkart browser'), { status: 401 }); }
  return {
    pair() {
      // Repeated Connect clicks must not cancel work or invalidate another tab.
      client ||= { token: crypto.randomBytes(32).toString('hex') };
      authBlocked=false;error=null;
      if(pairingFile)atomic(pairingFile,client);
      return client;
    },
    authenticate: auth,
    status() { const present=heartbeat>0&&now()-heartbeat<90000;return { connected: verified&&!authBlocked&&present, browserPresent:present, error,reason:!present?'browser_unavailable':authBlocked?'tenderkart_auth_required':!verified?'tenderkart_tab_signed_out':'connected',lastHeartbeatAt:heartbeat?new Date(heartbeat).toISOString():null,inFlight:pending.size,lastResponse }; },
    poll(token, session, runningIds = []) {
      if(!Array.isArray(runningIds))runningIds=[];
      auth(token); heartbeat = now(); verified = session === true;
      if(!authBlocked)error=verified?null:'Sign into Tenderkart and leave its tab open.';
      return [...pending.values()].filter(task => !task.sent||now()-task.sentAt>45000&&!runningIds.includes(task.id)).slice(0, 1).map(task => { task.sent = true;task.sentAt=now();return { id: task.id, path: task.path, url: task.url, kind: task.kind }; });
    },
    reply(token, id, response) {
      auth(token); const task = pending.get(id); if (!task) return;
      pending.delete(id); clearTimeout(task.timer);
      lastResponse={status:response?.status||502,at:new Date(now()).toISOString(),kind:response?.reason||null};
      if ([401, 403].includes(response?.status)||response?.reason==='verification') { authBlocked=true;error=response.error||'Tenderkart needs login, permission or security verification in its tab.'; }
      if (!response || response.status < 200 || response.status >= 300 || response.error) {
        const seconds = Number(response?.retryAfter);
        const date = Date.parse(response?.retryAfter);
        task.reject(Object.assign(new Error(response?.error || response?.data?.message || `Tenderkart returned HTTP ${response?.status || 502}`), {
          status: response?.status || 502, retryAfterMs: Math.max(60000, Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 60000),
        }));
      } else {authBlocked=false;error=null;task.resolve(response.data);}
    },
    async request(request) {
      const task = typeof request === 'string' ? { kind: 'json', path: request } : request;
      if (task.kind === 'json' && !allowedPath(task.path)) throw new Error('Unsupported Tenderkart API request');
      if (!this.status().connected) throw Object.assign(new Error('Connect a signed-in Tenderkart browser to continue'), { status: 401 });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, pace - (Date.now() - lastRequest)))); lastRequest = Date.now();
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Tenderkart browser timed out; check its tab and connector')); }, timeout);
        pending.set(id, { ...task, id, resolve, reject, timer });
      });
    },
    close() { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Server stopping')); } pending.clear(); },
  };
}
module.exports = { allowedPath, createBridge };
