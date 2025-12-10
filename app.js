// ============================================
// CONFIGURACIÓN Y VARIABLES GLOBALES
// ============================================

const SPREADSHEET_ID = '19Dn2iYHZr9wrPYdNEI2t6QMLMSK-Ljshu_bpCyzgY78';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbygjGRZEFjwOPQhS1nuF9wyX8fHUYyUssLgeeRaJ2GVLohD8jGx7YBO4KxNUF120J53/exec'; // ACTUALIZA ESTO

const DB_NAME = 'ReintegrosDB';
const DB_VERSION = 1;
const STORE_NAME = 'pending_invoices';

let db;
let currentImageData = null;
let isOnline = navigator.onLine;

// ============================================
// INICIALIZACIÓN
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
});

async function initializeApp() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker registrado:', reg.scope);
    } catch (err) {
      console.error('Error registrando Service Worker:', err);
    }
  }

  try {
    await initDB();
  } catch (err) {
    console.error('Error inicializando DB:', err);
    alert('Error inicializando base de datos local');
    return;
  }

  setupEventListeners();
  updateConnectionStatus();
  await updatePendingCount();
  await updateDashboard();

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  if (isOnline) {
    setTimeout(() => syncPendingData(), 1000);
  }
}

// ============================================
// INDEXEDDB
// ============================================

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = event => {
      const dbUpgrade = event.target.result;
      if (!dbUpgrade.objectStoreNames.contains(STORE_NAME)) {
        const store = dbUpgrade.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('synced', 'synced', { unique: false });
      }
    };
  });
}

function saveToIndexedDB(data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const payload = {
      ...data,
      timestamp: Date.now(),
      synced: false
    };
    const req = store.add(payload);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllData() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function getPendingData() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      const pending = all.filter(item => !item.synced);
      resolve(pending);
    };
    req.onerror = () => reject(req.error);
  });
}

function markAsSynced(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => {
      const data = req.result;
      if (!data) {
        resolve();
        return;
      }
      data.synced = true;
      data.syncedAt = Date.now();
      const updateReq = store.put(data);
      updateReq.onsuccess = () => resolve();
      updateReq.onerror = () => reject(updateReq.error);
    };

    req.onerror = () => reject(req.error);
  });
}

// ============================================
// EVENT LISTENERS
// ============================================

function setupEventListeners() {
  document.getElementById('openCamera').addEventListener('click', openCamera);
  document.getElementById('cameraInput').addEventListener('change', handleImageCapture);
  document.getElementById('closePreview').addEventListener('click', closePreview);
  document.getElementById('proyecto').addEventListener('change', handleProyectoChange);
  document.getElementById('cancelForm').addEventListener('click', resetForm);
  document.getElementById('dataForm').addEventListener('submit', handleFormSubmit);
  document.getElementById('viewPending').addEventListener('click', showPendingModal);
  document.getElementById('closePendingModal').addEventListener('click', closePendingModal);
  document.getElementById('syncAll').addEventListener('click', () => syncPendingData(true));
  document.getElementById('btnSyncNow').addEventListener('click', () => syncPendingData(true));
}

// ============================================
// CÁMARA Y OCR MEJORADO
// ============================================

function openCamera() {
  document.getElementById('cameraInput').click();
}

function handleImageCapture(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async ev => {
    currentImageData = ev.target.result;
    const img = document.getElementById('previewImage');
    img.src = currentImageData;

    document.getElementById('imagePreview').style.display = 'block';
    document.querySelector('.capture-section').style.display = 'none';
    document.getElementById('ocrStatus').style.display = 'flex';

    await processOCR(file);
  };
  reader.readAsDataURL(file);
}

async function processOCR(imageFile) {
  try {
    console.log('Iniciando OCR...');
    
    const result = await Tesseract.recognize(imageFile, 'spa', {
      logger: m => {
        if (m.status === 'recognizing text') {
          const progress = Math.round(m.progress * 100);
          console.log(`OCR: ${progress}%`);
        }
      }
    });
    
    const text = result && result.data && result.data.text ? result.data.text : '';
    console.log('Texto OCR extraído:', text);

    if (!text || text.trim() === '') {
      throw new Error('No se pudo extraer texto de la imagen');
    }

    const extracted = extractInvoiceData(text);
    fillForm(extracted);

    document.getElementById('ocrStatus').style.display = 'none';
    document.getElementById('dataForm').style.display = 'block';
  } catch (error) {
    console.error('Error en OCR:', error);
    document.getElementById('ocrStatus').innerHTML =
      '<span>⚠️ No se pudo leer la imagen. Complete manualmente.</span>';
    setTimeout(() => {
      document.getElementById('ocrStatus').style.display = 'none';
      document.getElementById('dataForm').style.display = 'block';
    }, 2500);
  }
}

// ============================================
// EXTRACCIÓN DE DATOS MEJORADA
// ============================================

function extractInvoiceData(text) {
  const data = { fecha: '', docNo: '', valor: '' };
  const cleanText = text.replace(/[\r\n]+/g, '\n');
  const lines = cleanText.split('\n');

  // 1. EXTRAER FECHA
  const fechaPatterns = [
    /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/,
    /fecha[:\s]+(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/i
  ];
  
  for (const pattern of fechaPatterns) {
    const match = cleanText.match(pattern);
    if (match) {
      const [_, a, b, c] = match;
      let year = c.length === 2 ? '20' + c : c;
      let month, day;
      
      if (parseInt(b, 10) <= 12) {
        day = a.padStart(2, '0');
        month = b.padStart(2, '0');
      } else {
        day = b.padStart(2, '0');
        month = a.padStart(2, '0');
      }
      
      data.fecha = `${year}-${month}-${day}`;
      break;
    }
  }

  // 2. EXTRAER NÚMERO DE FACTURA/DTE (MEJORADO)
  let dteFound = '';
  const uuidRegex = /\b[A-F0-9]{8,}(?:-[A-F0-9]{4,})?\b/i;
  const simpleNumRegex = /\b\d{6,15}\b/;
  const keywordRegex = /(?:DTE\s?No\.?|N[uú]mero\s?(?:de)?\s?DTE|Factura|Serie|Documento|Doc\.?)/i;

  // Buscar por palabras clave primero
  for (let i = 0; i < lines.length; i++) {
    if (keywordRegex.test(lines[i])) {
      console.log('Palabra clave encontrada en línea:', lines[i]);
      
      // Buscar UUID o número en la misma línea
      let match = lines[i].match(uuidRegex) || lines[i].match(simpleNumRegex);
      
      // Si no se encuentra, buscar en la siguiente línea
      if (!match && i + 1 < lines.length) {
        match = lines[i + 1].match(uuidRegex) || lines[i + 1].match(simpleNumRegex);
      }
      
      if (match) {
        dteFound = match[0];
        console.log('DTE/Factura encontrado:', dteFound);
        break;
      }
    }
  }

  // Fallback: buscar cualquier UUID o número largo
  if (!dteFound) {
    const matchB = cleanText.match(uuidRegex) || cleanText.match(simpleNumRegex);
    if (matchB) dteFound = matchB[0];
  }

  if (dteFound) {
    data.docNo = dteFound;
  }

  // 3. EXTRAER VALOR/TOTAL (MEJORADO PARA GUATEMALA)
  const moneyMatches = cleanText.match(/(?:Q\s?)?([0-9]{1,3}(?:[,.][0-9]{3})*[.,][0-9]{2})/g);
  if (moneyMatches) {
    const values = moneyMatches.map(v => {
      let raw = v.replace(/[Q\s]/g, '');
      
      // Si tiene coma como decimal (Q123,45)
      if (raw.indexOf(',') > -1 && raw.indexOf('.') === -1) {
        raw = raw.replace(',', '.');
      } else {
        // Si tiene punto como miles (Q1.234,56)
        raw = raw.replace(/\./g, '').replace(',', '.');
      }
      
      return parseFloat(raw);
    });
    
    const maxVal = Math.max(...values.filter(v => !isNaN(v)));
    if (maxVal > 0) {
      data.valor = maxVal.toFixed(2);
    }
  }

  return data;
}

function fillForm(data) {
  const fechaInput = document.getElementById('fecha');
  const docInput = document.getElementById('docNo');
  const valorInput = document.getElementById('valor');

  if (data.fecha) {
    fechaInput.value = data.fecha;
  } else {
    const today = new Date().toISOString().split('T')[0];
    fechaInput.value = today;
  }
  
  if (data.docNo) docInput.value = data.docNo;
  if (data.valor) valorInput.value = data.valor;
}

// ============================================
// FORMULARIO
// ============================================

function handleProyectoChange(e) {
  const otroGroup = document.getElementById('otroProyectoGroup');
  const otroInput = document.getElementById('otroProyecto');
  if (e.target.value === 'otro') {
    otroGroup.style.display = 'block';
    otroInput.required = true;
  } else {
    otroGroup.style.display = 'none';
    otroInput.required = false;
  }
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const proyectoSelect = document.getElementById('proyecto');
  const proyecto =
    proyectoSelect.value === 'otro'
      ? document.getElementById('otroProyecto').value
      : proyectoSelect.value;

  const formData = {
    fecha: document.getElementById('fecha').value,
    descripcion: document.getElementById('descripcion').value,
    docNo: document.getElementById('docNo').value,
    proyecto,
    valor: document.getElementById('valor').value,
    solicitante: document.getElementById('solicitante').value,
    foto: currentImageData
  };

  try {
    await saveToIndexedDB(formData);
    await updatePendingCount();
    await updateDashboard();
    showNotification('✅ Datos guardados localmente');

    if (isOnline) {
      await syncPendingData();
    }

    resetForm();
  } catch (err) {
    console.error('Error guardando datos:', err);
    showNotification('❌ Error al guardar datos');
  }
}

function resetForm() {
  document.getElementById('dataForm').reset();
  document.getElementById('dataForm').style.display = 'none';
  document.getElementById('imagePreview').style.display = 'none';
  document.querySelector('.capture-section').style.display = 'block';
  document.getElementById('ocrStatus').style.display = 'flex';
  document.getElementById('ocrStatus').innerHTML =
    '<div class="spinner"></div><span>Extrayendo datos...</span>';
  currentImageData = null;
}

function closePreview() {
  if (confirm('¿Descartar esta imagen?')) {
    resetForm();
  }
}

// ============================================
// SINCRONIZACIÓN CON GOOGLE SHEETS
// ============================================

async function uploadToGoogleDrive(base64Image, filename) {
  if (!APPS_SCRIPT_URL) {
    console.warn('Apps Script URL no configurada');
    return base64Image;
  }

  try {
    await fetch(`${APPS_SCRIPT_URL}?action=uploadImage`, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        imageData: base64Image,
        filename: filename
      })
    });

    console.log('Imagen enviada a Google Drive');
    return `https://drive.google.com/drive/folders/1YiBTEkCqbYrqXFDHi5dUUdN0Gg2EqP5Y`;
    
  } catch (error) {
    console.error('Error subiendo a Drive:', error);
    throw error;
  }
}

async function saveToGoogleSheets(data) {
  if (!APPS_SCRIPT_URL) {
    console.warn('Apps Script URL no configurada');
    return;
  }

  try {
    await fetch(`${APPS_SCRIPT_URL}?action=addRow`, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    console.log('Datos enviados a Google Sheets');
    
  } catch (error) {
    console.error('Error guardando en Sheets:', error);
    throw error;
  }
}

async function syncPendingData(forceMessage = false) {
  if (!isOnline) {
    showNotification('⚠️ Sin conexión a internet');
    return;
  }

  const pending = await getPendingData();
  if (pending.length === 0) {
    if (forceMessage) showNotification('✓ No hay datos pendientes para sincronizar');
    return;
  }

  showSyncNotification();

  let successCount = 0;
  let errorCount = 0;

  for (const item of pending) {
    try {
      const fotoUrl = await uploadToGoogleDrive(
        item.foto,
        `factura_${item.proyecto}_${item.timestamp}.jpg`
      );

      await saveToGoogleSheets({
        fecha: item.fecha,
        descripcion: item.descripcion,
        docNo: item.docNo,
        proyecto: item.proyecto,
        valor: item.valor,
        solicitante: item.solicitante,
        foto: fotoUrl
      });

      await markAsSynced(item.id);
      successCount++;
      
    } catch (err) {
      console.error('Error sincronizando item:', err);
      errorCount++;
    }
  }

  hideSyncNotification();
  await updatePendingCount();
  await updateDashboard();
  
  if (successCount > 0) {
    showNotification(`✅ ${successCount} registro(s) sincronizados correctamente`);
    localStorage.setItem('lastSync', new Date().toISOString());
  }
  
  if (errorCount > 0) {
    showNotification(`⚠️ ${errorCount} registro(s) fallaron. Se reintentarán después.`);
  }
}

// ============================================
// UI / DASHBOARD / ESTADO
// ============================================

function updateConnectionStatus() {
  const indicator = document.getElementById('statusIndicator');
  const text = document.getElementById('statusText');
  if (isOnline) {
    indicator.classList.remove('offline');
    text.textContent = 'Conectado';
  } else {
    indicator.classList.add('offline');
    text.textContent = 'Sin conexión';
  }
}

async function updatePendingCount() {
  const pending = await getPendingData();
  const count = pending.length;
  
  document.getElementById('pendingCount').textContent = count;
  document.getElementById('viewPending').style.display =
    count > 0 ? 'flex' : 'none';
}

async function updateDashboard() {
  const all = await getAllData();
  const pending = all.filter(i => !i.synced).length;
  const synced = all.filter(i => i.synced).length;

  document.getElementById('dashPending').textContent = pending;
  document.getElementById('dashSynced').textContent = synced;

  const lastSync = localStorage.getItem('lastSync');
  if (lastSync) {
    const d = new Date(lastSync);
    const formatted = d.toLocaleString('es-GT', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    document.getElementById('dashLastSync').textContent = formatted;
  } else {
    document.getElementById('dashLastSync').textContent = '—';
  }
}

function showNotification(message) {
  const bar = document.createElement('div');
  bar.className = 'sync-notification show';
  bar.textContent = message;
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 3000);
}

function showSyncNotification() {
  document.getElementById('syncNotification').classList.add('show');
  const btn = document.getElementById('btnSyncNow');
  btn.classList.add('syncing');
  btn.disabled = true;
}

function hideSyncNotification() {
  document.getElementById('syncNotification').classList.remove('show');
  const btn = document.getElementById('btnSyncNow');
  btn.classList.remove('syncing');
  btn.disabled = false;
}

async function showPendingModal() {
  const list = document.getElementById('pendingList');
  const pending = await getPendingData();

  list.innerHTML = '';

  if (pending.length === 0) {
    list.innerHTML =
      '<p style="text-align:center;color:#7f8c8d;">No hay datos pendientes</p>';
  } else {
    pending.forEach(item => {
      const el = document.createElement('div');
      el.className = 'pending-item';
      el.innerHTML = `
        <div class="pending-item-header">
          <span>${item.proyecto}</span>
          <span>Q ${item.valor}</span>
        </div>
        <div class="pending-item-details">
          <div><strong>Fecha:</strong> ${item.fecha}</div>
          <div><strong>Doc:</strong> ${item.docNo || 'N/A'}</div>
          <div><strong>Solicitante:</strong> ${item.solicitante}</div>
          <div class="text-xs text-gray-400 mt-1">⏳ Esperando sincronización</div>
        </div>
      `;
      list.appendChild(el);
    });
  }

  document.getElementById('pendingModal').style.display = 'flex';
}

function closePendingModal() {
  document.getElementById('pendingModal').style.display = 'none';
}

function handleOnline() {
  isOnline = true;
  updateConnectionStatus();
  showNotification('🌐 Conexión restaurada. Sincronizando...');
  syncPendingData();
}

function handleOffline() {
  isOnline = false;
  updateConnectionStatus();
  showNotification('📡 Sin conexión. Los datos se guardarán localmente.');
}
