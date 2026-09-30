// A separate namespace prevents collisions with other projects on the same GitHub Pages domain.
const namespace = 'scan-sheet:' + new URL('./', import.meta.url).pathname;
const settingsKey = namespace + ':settings:v1';
let database;

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(settingsKey) || '{}'); }
  catch { return {}; }
}

export function saveSettings(settings) {
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

export function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(namespace + ':records', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('records', {keyPath: 'id'});
      store.createIndex('scannedAt', 'scannedAt');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Chiudi le altre finestre di Scan Sheet e riprova.'));
  });
  return database;
}

export async function listRecords() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt)));
    request.onerror = () => reject(request.error);
  });
}

export async function addRecord(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', 'readwrite');
    transaction.objectStore('records').add(record);
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Salvataggio locale non riuscito.'));
  });
}

export async function acknowledgeRecord(id, savedAt) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result) store.put({...request.result, status: 'sent', savedAt});
    };
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Conferma locale non riuscita.'));
  });
}

export function csvText(records) {
  // Prevent spreadsheet formulas when exporting user-entered text.
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows = [['Timestamp ISO','Codice','Quantità','Operatore','Stato','ID registrazione','Ricevuto ISO'],
    ...records.map(r => [r.scannedAt, r.barcode, r.quantity, r.operator, r.status === 'sent' ? 'Salvato' : 'Da inviare', r.id, r.savedAt || ''])];
  return '\ufeff' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}
