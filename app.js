import {loadSettings, saveSettings, openDatabase, listRecords, addRecord, acknowledgeRecord, csvText} from './storage.js';
import {GoogleBridge, normalizeEndpoint} from './transport.js';

const $ = id => document.getElementById(id);
let settings = loadSettings();
let records = [];
let bridge;
let syncing = false;
let recording = false;
let testing = false;
let storageReady = false;
let scanSession = 0;
let scannerControls;
let cameraActive = false;
let torchOn = false;
let installPrompt;
let lastVerified;
let retryTimer;
let retryDelay = 15000;
const timeFormat = new Intl.DateTimeFormat('it-IT', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'});

const configured = () => Boolean(settings.operator && settings.endpoint && settings.accessKey);

function feedback(text, type = 'success', element = $('feedback')) {
  element.textContent = text;
  element.className = 'feedback ' + type;
  element.hidden = false;
}

function resetBridge() {
  bridge?.destroy();
  bridge = null;
}

function getBridge(endpoint) {
  if (!bridge || bridge.endpoint !== endpoint) {
    resetBridge();
    bridge = new GoogleBridge(endpoint);
  }
  return bridge;
}

function renderConfiguration() {
  $('operator-label').textContent = settings.operator || 'Da impostare';
  $('destination-label').textContent = settings.destinationLabel || (settings.endpoint ? 'Collegamento impostato · da verificare' : 'Da configurare');
  $('setup-notice').hidden = configured();
  $('submit-record').disabled = !storageReady || !configured() || recording;
  $('network').textContent = navigator.onLine ? 'Online' : 'Senza rete';
  $('network').classList.toggle('offline', !navigator.onLine);
}

async function renderRecords() {
  records = await listRecords();
  const pending = records.filter(r => r.status === 'pending').length;
  if (records.length && $('sync-message').textContent === 'Le registrazioni compariranno qui.') {
    $('sync-message').textContent = pending ? 'Registrazioni in attesa di invio.' : 'Le registrazioni locali risultano salvate su Google.';
  }
  $('pending-count').textContent = pending + ' da inviare';
  $('pending-count').classList.toggle('waiting', pending > 0);
  $('sync-now').disabled = pending === 0 || syncing || !navigator.onLine || !configured();
  $('sync-now').textContent = syncing ? 'Invio in corso…' : 'Invia registrazioni in attesa';
  $('export').disabled = records.length === 0;
  $('empty-state').hidden = records.length > 0;
  const nodes = records.slice(-10).reverse().map(record => {
    const li = document.createElement('li');
    li.className = 'record';
    const top = document.createElement('div'); top.className = 'record-top';
    const code = document.createElement('strong'); code.className = 'record-code'; code.textContent = record.barcode;
    const qty = document.createElement('span'); qty.className = 'record-qty'; qty.textContent = 'Qtà ' + new Intl.NumberFormat('it-IT').format(record.quantity);
    top.append(code, qty);
    const bottom = document.createElement('div'); bottom.className = 'record-bottom';
    const meta = document.createElement('span'); meta.className = 'record-meta'; meta.textContent = timeFormat.format(new Date(record.scannedAt)) + ' · ' + record.operator;
    const status = document.createElement('span'); status.className = 'record-state ' + record.status;
    status.textContent = record.status === 'sent' ? 'Salvato' : 'Da inviare';
    bottom.append(meta, status); li.append(top, bottom); return li;
  });
  $('records').replaceChildren(...nodes);
}

function openSettings() {
  stopCamera();
  $('operator').value = settings.operator || '';
  $('endpoint').value = settings.endpoint || '';
  $('access-key').value = settings.accessKey || '';
  $('settings-result').hidden = true;
  lastVerified = null;
  $('settings-dialog').showModal();
}

function settingsFromForm() {
  const operator = $('operator').value.trim();
  const accessKey = $('access-key').value.trim();
  if (!operator || operator.length > 80 || /[\x00-\x1f\x7f]/.test(operator)) throw new Error('Inserisci un nome operatore valido, fino a 80 caratteri.');
  if (accessKey.length < 32 || accessKey.length > 256 || /\s/.test(accessKey)) throw new Error('La chiave deve contenere almeno 32 caratteri, senza spazi. Copiala dalle proprietà dello script.');
  return {operator, endpoint: normalizeEndpoint($('endpoint').value), accessKey};
}

function setSettingsBusy(value) {
  testing = value;
  for (const control of $('settings-form').querySelectorAll('button,input')) control.disabled = value;
}

async function testConnection() {
  if (syncing) return feedback('Attendi il completamento dell’invio in corso.', 'waiting', $('settings-result'));
  if (!navigator.onLine) return feedback('Serve una connessione per verificare Google.', 'waiting', $('settings-result'));
  try {
    const candidate = settingsFromForm();
    setSettingsBusy(true);
    feedback('Verifica in corso…', 'waiting', $('settings-result'));
    const response = await getBridge(candidate.endpoint).request('ping', candidate.accessKey);
    lastVerified = {...candidate, destinationLabel: response.destinationLabel};
    feedback('Collegato a ' + response.destinationLabel + '. Puoi salvare le impostazioni.', 'success', $('settings-result'));
  } catch (error) {
    resetBridge();
    feedback(error.message, 'error', $('settings-result'));
  } finally { setSettingsBusy(false); }
}

async function commitSettings(event) {
  event.preventDefault();
  if (testing) return;
  try {
    if (syncing) throw new Error('Attendi il completamento dell’invio in corso.');
    const candidate = settingsFromForm();
    const currentRecords = await listRecords();
    if (currentRecords.some(r => r.status === 'pending' && r.endpoint !== candidate.endpoint)) {
      throw new Error('Invia prima le registrazioni in attesa al loro foglio. Il cambio di destinazione è bloccato per evitare invii al registro sbagliato.');
    }
    const verified = lastVerified?.endpoint === candidate.endpoint && lastVerified?.accessKey === candidate.accessKey;
    const sameDestination = settings.endpoint === candidate.endpoint && settings.accessKey === candidate.accessKey;
    const next = {...candidate, destinationLabel: verified ? lastVerified.destinationLabel : (sameDestination ? settings.destinationLabel : '')};
    saveSettings(next); // Commit before changing in-memory state.
    settings = next;
    resetBridge();
    $('settings-dialog').close();
    renderConfiguration();
    await renderRecords();
    feedback('Impostazioni salvate. Puoi registrare il primo codice.');
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    scheduleSync(0);
  } catch (error) { feedback(error.message, 'error', $('settings-result')); }
}

function stopCamera() {
  scanSession++;
  cameraActive = false;
  scannerControls?.stop();
  scannerControls = null;
  const video = $('video');
  video.srcObject?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
  $('camera-panel').hidden = true;
  $('torch').hidden = true;
  torchOn = false;
  $('scan').disabled = false;
}

async function startCamera() {
  stopCamera();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('camera-message').textContent = 'La fotocamera richiede HTTPS. Apri il sito pubblicato su GitHub Pages; puoi comunque inserire il codice a mano.';
    return;
  }
  if (!window.ZXingBrowser) {
    $('camera-message').textContent = 'Lettore non caricato. Riapri l’app con una connessione, oppure inserisci il codice a mano.';
    return;
  }
  cameraActive = true;
  const session = ++scanSession;
  $('scan').disabled = true;
  $('camera-panel').hidden = false;
  $('camera-message').textContent = 'Consenti l’accesso alla fotocamera e inquadra il codice con buona luce.';
  try {
    const reader = new ZXingBrowser.BrowserMultiFormatReader(undefined, {delayBetweenScanAttempts: 250, delayBetweenScanSuccess: 1000});
    const controls = await reader.decodeFromConstraints({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}}}, $('video'), (result, error, controls) => {
      if (!cameraActive || session !== scanSession || !result) return;
      const value = result.getText();
      if (!value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
        controls.stop(); stopCamera();
        $('camera-message').textContent = 'Il codice contiene dati non supportati. Inseriscilo manualmente.';
        return;
      }
      controls.stop(); stopCamera();
      $('barcode').value = value;
      $('camera-message').textContent = 'Codice letto. Controlla la quantità e premi Registra.';
      if (navigator.vibrate) navigator.vibrate(70);
      $('quantity').focus({preventScroll:true});
    });
    if (!cameraActive || session !== scanSession) { controls.stop(); return; }
    scannerControls = controls;
    const track = $('video').srcObject?.getVideoTracks()[0];
    $('torch').hidden = !track?.getCapabilities?.().torch;
    $('torch').textContent = 'Torcia';
    $('camera-message').textContent = 'Tieni il codice fermo, interamente dentro l’inquadratura.';
  } catch (error) {
    if (session !== scanSession) return;
    stopCamera();
    const messages = {NotAllowedError: 'Accesso alla fotocamera negato. Abilitalo nelle impostazioni del browser oppure inserisci il codice a mano.', NotFoundError: 'Nessuna fotocamera disponibile. Inserisci il codice a mano.', NotReadableError: 'Fotocamera occupata. Chiudi le altre app che la usano e riprova.'};
    $('camera-message').textContent = messages[error.name] || 'Non riesco ad avviare la fotocamera. Riprova o inserisci il codice a mano.';
  }
}

async function toggleTorch() {
  const track = $('video').srcObject?.getVideoTracks()[0];
  try {
    await track.applyConstraints({advanced:[{torch: !torchOn}]});
    torchOn = !torchOn;
    $('torch').textContent = torchOn ? 'Spegni torcia' : 'Torcia';
  } catch { $('camera-message').textContent = 'La torcia non è disponibile su questo dispositivo.'; }
}

async function recordScan(event) {
  event.preventDefault();
  if (recording || !storageReady) return;
  if (!configured()) { openSettings(); return; }
  const barcode = $('barcode').value.trim();
  const rawQuantity = $('quantity').value.trim();
  const quantity = Number(rawQuantity.replace(',', '.'));
  if (!barcode || barcode.length > 512 || /[\x00-\x1f\x7f]/.test(barcode)) return feedback('Inserisci un codice valido, senza interruzioni di riga.', 'error');
  if (!rawQuantity || !Number.isFinite(quantity) || quantity < 0 || quantity > 1e9) return feedback('Inserisci una quantità da 0 a 1.000.000.000.', 'error');
  recording = true;
  renderConfiguration();
  stopCamera();
  try {
    await addRecord({id: crypto.randomUUID(), scannedAt: new Date().toISOString(), barcode, quantity,
      operator: settings.operator, endpoint: settings.endpoint, status:'pending'});
    $('barcode').value = '';
    $('quantity').value = '1';
    $('camera-message').textContent = 'Puoi scansionare il prossimo codice.';
    await renderRecords().catch(() => {});
    feedback(navigator.onLine ? 'Registrazione conservata sul telefono. Invio a Google in corso…' : 'Registrazione conservata sul telefono. Sarà inviata quando torni online con l’app aperta.', 'waiting');
    scheduleSync(0);
  } catch {
    feedback('Non è stato possibile salvare sul telefono. I campi sono rimasti compilati: riprova prima di passare al prossimo codice.', 'error');
  } finally { recording = false; renderConfiguration(); }
}

function scheduleSync(delay = 0) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { void synchronize(); }, delay);
}

async function synchronize() {
  if (syncing || testing || !storageReady || !configured() || !navigator.onLine || document.hidden) return;
  syncing = true;
  let count = 0;
  let failed = false;
  try {
    await renderRecords();
    let todo = records.filter(r => r.status === 'pending');
    if (!todo.length) return;
    $('sync-message').textContent = 'Invio delle registrazioni in corso…';
    while (todo.length && navigator.onLine && !document.hidden) {
      const record = todo[0];
      if (record.endpoint !== settings.endpoint) throw new Error('Una registrazione appartiene a un altro collegamento Google. Ripristina la destinazione originale nelle impostazioni.');
      const payload = {id: record.id, scannedAt: record.scannedAt, barcode: record.barcode, quantity: record.quantity, operator: record.operator};
      const response = await getBridge(settings.endpoint).request('append', settings.accessKey, payload);
      if (response.id !== record.id || !response.savedAt || !Number.isFinite(Date.parse(response.savedAt))) throw new Error('Conferma Google non valida. La registrazione resta in attesa.');
      await acknowledgeRecord(record.id, response.savedAt);
      count++;
      if (response.destinationLabel && settings.destinationLabel !== response.destinationLabel) {
        settings.destinationLabel = response.destinationLabel;
        try { saveSettings(settings); } catch { /* The committed record remains safe in IndexedDB. */ }
        renderConfiguration();
      }
      await renderRecords();
      todo = records.filter(r => r.status === 'pending');
    }
    retryDelay = 15000;
    if (count) feedback(count === 1 ? 'Registrazione salvata su Google Sheets.' : count + ' registrazioni salvate su Google Sheets.');
    $('sync-message').textContent = todo.length ? 'Invio sospeso. Riapri l’app con una connessione per continuare.' : 'Tutte le registrazioni sono state confermate da Google.';
  } catch (error) {
    failed = true;
    resetBridge();
    $('sync-message').textContent = error.message;
    feedback('Invio non confermato. I dati restano sul telefono; puoi riprovare dal registro.', 'waiting');
    retryDelay = Math.min(retryDelay * 2, 120000);
  } finally {
    syncing = false;
    await renderRecords().catch(() => {});
    if (records.some(r => r.status === 'pending')) scheduleSync(failed ? retryDelay : 15000);
  }
}

async function exportRecords() {
  try {
    const data = await listRecords();
    const url = URL.createObjectURL(new Blob([csvText(data)], {type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url; link.download = 'scan-sheet-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { feedback('Esportazione non riuscita. Riprova.', 'error'); }
}

$('settings-open').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('cancel', event => { if (testing) event.preventDefault(); });
$('settings-form').addEventListener('submit', commitSettings);
$('test-connection').addEventListener('click', testConnection);
$('record-form').addEventListener('submit', recordScan);
$('scan').addEventListener('click', startCamera);
$('stop-scan').addEventListener('click', () => { stopCamera(); $('camera-message').textContent = 'Fotocamera chiusa. Puoi inserire il codice manualmente.'; });
$('torch').addEventListener('click', toggleTorch);
$('sync-now').addEventListener('click', () => scheduleSync(0));
$('export').addEventListener('click', exportRecords);
for (const [id, delta] of [['minus',-1], ['plus',1]]) $(id).addEventListener('click', () => {
  const old = Number($('quantity').value.replace(',','.')) || 0;
  $('quantity').value = String(Math.min(1e9, Math.max(0, Math.round((old + delta) * 1e6) / 1e6)));
});
window.addEventListener('online', () => { renderConfiguration(); scheduleSync(0); });
window.addEventListener('offline', () => { renderConfiguration(); void renderRecords(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera(); else { void renderRecords(); scheduleSync(0); }
});
window.addEventListener('pagehide', stopCamera);
window.addEventListener('storage', () => { settings = loadSettings(); renderConfiguration(); });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('install').hidden = true; });
$('install').addEventListener('click', async () => {
  if (installPrompt) { await installPrompt.prompt(); installPrompt = null; $('install').hidden = true; }
  else $('install-dialog').showModal();
});
$('install-help').addEventListener('click', () => $('install-dialog').showModal());

try {
  if (!crypto.randomUUID) throw new Error('Apri l’app da un indirizzo HTTPS usando un browser aggiornato.');
  await openDatabase();
  storageReady = true;
  renderConfiguration();
  await renderRecords();
  scheduleSync(0);
} catch (error) {
  $('boot-error').hidden = false;
  $('boot-error').textContent = 'Archivio locale non disponibile. Usa un browser aggiornato, fuori dalla navigazione privata. ' + error.message;
}
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    $('sync-message').textContent = 'Avvio offline non disponibile. Riapri l’app online per completare la preparazione.';
  });
}
