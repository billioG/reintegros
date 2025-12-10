// ============================================
// CONFIGURACIÓN Y VARIABLES GLOBALES
// ============================================

const SPREADSHEET_ID = '19Dn2iYHZr9wrPYdNEI2t6QMLMSK-Ljshu_bpCyzgY78';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyUJqcZ9RFXhDI-9L4V89EeYCLmwGxz5w_OWlBvS2uprNrj_xUAB5Z3YCM-X2aj9DDK/exec';

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
// CÁMARA Y OCR
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
    console.log('Tesseract cargado:', typeof Tesseract);
    
    // Verificar que Tesseract esté disponible
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract no está cargado');
    }
    
    const result = await Tesseract.recognize(imageFile, 'spa', {
      logger: m => {
        if (m.status === 'recognizing text') {
          const progress = Math.round(m.progress * 100);
          console.log(`OCR: ${progress}%`);
          document.getElementById('ocrStatus').innerHTML = 
            `<div class="spinner"></div><span>Extrayendo datos... ${progress}%</span>`;
        }
      }
    });
    
    console.log('Resultado OCR completo:', result);
    
    let text = '';
    
    // Compatibilidad con diferentes versiones de Tesseract
    if (result.data && result.data.text) {
      text = result.data.text;
    } else if (result.text) {
      text = result.text;
    }
    
    console.log('Texto OCR extraído:', text);
    console.log('Longitud del texto:', text.length);

    if (!text || text.trim().length === 0) {
      throw new Error('No se pudo extraer texto de la imagen');
    }

    const extracted = extractInvoiceData(text);
    fillForm(extracted);

    document.getElementById('ocrStatus').style.display = 'none';
    document.getElementById('dataForm').style.display = 'block';
    
  } catch (error) {
    console.error('Error en OCR:', error);
    console.error('Stack:', error.stack);
    
    document.getElementById('ocrStatus').innerHTML =
      '<span>⚠️ No se pudo leer la imagen. Complete manualmente.</span>';
    
    setTimeout(() => {
      document.getElementById('ocrStatus').style.display = 'none';
      document.getElementById('dataForm').style.display = 'block';
    }, 2500);
  }
}


// ============================================
// EXTRACCIÓN DE DATOS OPTIMIZADA
// ============================================
function extractInvoiceData(text) {
  const data = { fecha: '', docNo: '', valor: '' };
  const cleanText = text.replace(/[\r\n]+/g, '\n');
  const lines = cleanText.split('\n').map(l => l.trim());

  console.log('=== EXTRAYENDO DATOS ===');
  console.log('Total de líneas:', lines.length);

  // 1. EXTRAER NÚMERO DE AUTORIZACIÓN (NO. AUTORIZACIÓN)
  let dteFound = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Buscar "NO. AUTORIZACIÓN:" seguido del número
    if (/NO\.?\s*AUTORIZACI[OÓ]N/i.test(line)) {
      console.log('✓ Línea con NO. AUTORIZACIÓN encontrada:', line);
      
      // El número puede estar en la misma línea o en las siguientes
      // Formato: B4681B5E-3614-4ADD-9CCC-E0F5/131 o similar
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const checkLine = lines[j];
        
        // Buscar UUID formato: XXXXXXXX-XXXX-XXXX-XXXX-XXXX/XXX
        const uuidMatch = checkLine.match(/([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]+(?:\/\d+)?)/i);
        if (uuidMatch) {
          dteFound = uuidMatch[1];
          console.log('✓ UUID encontrado:', dteFound);
          break;
        }
      }
      
      if (dteFound) break;
    }
    
    // Buscar "SERIE:" seguido de código
    if (/SERIE:/i.test(line)) {
      const serieMatch = line.match(/SERIE:\s*([A-Z0-9\-]+)/i);
      if (serieMatch && !dteFound) {
        dteFound = serieMatch[1];
        console.log('✓ SERIE encontrada:', dteFound);
      }
    }
    
    // Buscar "NUMERO:" con número largo
    if (/N[UÚ]MERO:/i.test(line)) {
      const numMatch = line.match(/N[UÚ]MERO:\s*(\d{8,})/i);
      if (numMatch && !dteFound) {
        dteFound = numMatch[1];
        console.log('✓ NUMERO encontrado:', dteFound);
      }
    }
  }

  if (dteFound) {
    data.docNo = dteFound;
  } else {
    console.log('✗ No se encontró número de autorización/factura');
  }

  // 2. EXTRAER TOTAL (puede aparecer como "TOTAL Q 150.00" o "Q 150.00")
  let valorFound = '';
  
  for (const line of lines) {
    // Buscar "TOTAL" seguido de Q y número
    if (/TOTAL/i.test(line)) {
      const totalMatch = line.match(/Q\s*(\d+\.?\d*)/i);
      if (totalMatch) {
        const valor = parseFloat(totalMatch[1]);
        if (valor > 0 && !isNaN(valor)) {
          valorFound = valor.toFixed(2);
          console.log('✓ TOTAL encontrado en línea TOTAL:', valorFound, '→', line);
          break;
        }
      }
    }
  }
  
  // Si no se encontró en TOTAL, buscar cualquier monto con Q
  if (!valorFound) {
    const allMoneyMatches = [];
    
    for (const line of lines) {
      const matches = line.match(/Q\s*(\d+\.\d{2})/gi);
      if (matches) {
        matches.forEach(m => {
          const num = parseFloat(m.replace(/Q\s*/i, ''));
          if (!isNaN(num) && num > 0) {
            allMoneyMatches.push(num);
          }
        });
      }
    }
    
    if (allMoneyMatches.length > 0) {
      // Tomar el valor más grande (usualmente es el total)
      valorFound = Math.max(...allMoneyMatches).toFixed(2);
      console.log('✓ TOTAL encontrado (máximo):', valorFound);
    }
  }

  if (valorFound) {
    data.valor = valorFound;
  } else {
    console.log('✗ No se encontró el total');
  }

  // 3. EXTRAER FECHA (puede aparecer como "FECHA DE EMISIÓN: 22-11-2025")
  let fechaFound = '';
  
  for (const line of lines) {
    if (/FECHA\s+DE\s+EMISI[OÓ]N/i.test(line)) {
      console.log('✓ Línea con FECHA DE EMISIÓN:', line);
      
      // Buscar formato: DD-MM-YYYY o DD/MM/YYYY
      const fechaMatch = line.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (fechaMatch) {
        const day = fechaMatch[1].padStart(2, '0');
        const month = fechaMatch[2].padStart(2, '0');
        const year = fechaMatch[3];
        fechaFound = `${year}-${month}-${day}`;
        console.log('✓ Fecha encontrada:', fechaFound);
        break;
      }
    }
  }
  
  // Fallback: buscar cualquier fecha en formato DD-MM-YYYY o DD/MM/YYYY
  if (!fechaFound) {
    for (const line of lines) {
      const fechaMatch = line.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (fechaMatch) {
        const day = fechaMatch[1].padStart(2, '0');
        const month = fechaMatch[2].padStart(2, '0');
        const year = fechaMatch[3];
        
        // Validar que sea una fecha válida
        const monthNum = parseInt(month);
        const dayNum = parseInt(day);
        if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
          fechaFound = `${year}-${month}-${day}`;
          console.log('✓ Fecha encontrada (fallback):', fechaFound);
          break;
        }
      }
    }
  }

  if (fechaFound) {
    data.fecha = fechaFound;
  } else {
    console.log('✗ No se encontró la fecha');
  }

  console.log('=== RESULTADO FINAL ===');
  console.log('📅 Fecha:', data.fecha || 'NO ENCONTRADA');
  console.log('🔢 Autorización/Factura:', data.docNo || 'NO ENCONTRADA');
  console.log('💰 Total:', data.valor ? 'Q ' + data.valor : 'NO ENCONTRADO');

  return data;
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
  // Ya no usamos Drive, retornamos el Base64 directamente
  console.log('📷 Imagen preparada para Sheets:', filename);
  return base64Image;
}


async function saveToGoogleSheets(data) {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'https://script.google.com/macros/s/AKfycbyUJqcZ9RFXhDI-9L4V89EeYCLmwGxz5w_OWlBvS2uprNrj_xUAB5Z3YCM-X2aj9DDK/exec') {
    console.error('⚠️ Apps Script URL no configurada');
    return;
  }

  try {
    console.log('📝 Guardando en Sheets con imagen...');
    
    const response = await fetch(`${APPS_SCRIPT_URL}?action=addRow`, {
      method: 'POST',
      body: JSON.stringify(data)
    });

    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Datos guardados correctamente');
      console.log('📸 Imagen guardada en hoja:', result.imageSheet);
    } else {
      console.error('❌ Error al guardar:', result.error);
      throw new Error(result.error);
    }
    
  } catch (error) {
    console.error('❌ Error guardando en Sheets:', error);
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
