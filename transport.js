// A Google-hosted HTML bridge uses google.script.run and returns explicit acknowledgements.
// No no-cors fetch and no secret in URLs or public source files.
export function normalizeEndpoint(value) {
  const url = new URL(value.trim());
  if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || url.username || url.password) {
    throw new Error('Inserisci l’indirizzo Google Apps Script che termina con /exec.');
  }
  return url.origin + url.pathname;
}

function isGoogleOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port &&
      (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com' ||
       /^[a-z0-9-]+-script\.googleusercontent\.com$/.test(url.hostname));
  } catch { return false; }
}

export class GoogleBridge {
  constructor(endpoint) {
    this.endpoint = normalizeEndpoint(endpoint);
    this.channel = crypto.randomUUID();
    this.pending = new Map();
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener('message', this.onMessage);
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = setTimeout(() => reject(new Error('Google non risponde. Controlla URL /exec, pubblicazione per “Chiunque” e ALLOWED_ORIGIN nella guida.')), 25000);
    });
    this.frame = document.createElement('iframe');
    this.frame.hidden = true;
    this.frame.title = 'Collegamento a Google Sheets';
    this.frame.referrerPolicy = 'no-referrer';
    const url = new URL(this.endpoint);
    url.searchParams.set('origin', location.origin);
    url.searchParams.set('channel', this.channel);
    this.frame.src = url.href;
    document.body.append(this.frame);
  }

  onMessage(event) {
    const data = event.data;
    if (!data || data.channel !== this.channel || !isGoogleOrigin(event.origin)) return;
    if (data.type === 'scan-sheet:ready' && !this.remote) {
      if (!event.source) return;
      this.remote = event.source;
      this.remoteOrigin = event.origin;
      clearTimeout(this.readyTimer);
      this.resolveReady();
      return;
    }
    if (event.source !== this.remote || event.origin !== this.remoteOrigin || data.type !== 'scan-sheet:response') return;
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(data.requestId);
    if (data.result?.ok === true) pending.resolve(data.result);
    else pending.reject(new Error(data.result?.error || 'Google non ha confermato la registrazione.'));
  }

  async request(action, accessKey, record = null) {
    await this.ready;
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Conferma non ricevuta. La registrazione resta in attesa; riprovare non crea doppioni.'));
      }, 45000);
      this.pending.set(requestId, {resolve, reject, timer});
      this.remote.postMessage({type: 'scan-sheet:request', channel: this.channel, requestId, action, accessKey, record}, this.remoteOrigin);
    });
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    clearTimeout(this.readyTimer);
    this.frame.remove();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Collegamento interrotto. Riprova.'));
    }
    this.pending.clear();
  }
}
