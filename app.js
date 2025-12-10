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
// PREPROCESAMIENTO DE IMAGEN
// ============================================

function preprocessImage(imageElement) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Aumentar resolución para mejor OCR
    const scaleFactor = 2;
    canvas.width = imageElement.width * scaleFactor;
    canvas.height = imageElement.height * scaleFactor;
    
    // Dibujar imagen escalada
    ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
    
    // Obtener datos de píxeles
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    // PASO 1: Convertir a escala de grises
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
    }
    
    // PASO 2: Aumentar contraste (ajuste de histograma)
    const contrastFactor = 1.5;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, Math.max(0, (data[i] - 128) * contrastFactor + 128));
      data[i + 1] = data[i];
      data[i + 2] = data[i];
    }
    
    // PASO 3: Umbralización (binarización) - texto negro sobre fondo blanco
    const threshold = 128;
    for (let i = 0; i < data.length; i += 4) {
      const value = data[i] > threshold ? 255 : 0;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
    
    // PASO 4: Aplicar nitidez (sharpening)
    const sharpenKernel = [
      0, -1, 0,
      -1, 5, -1,
      0, -1, 0
    ];
    
    const tempData = new Uint8ClampedArray(data);
    const width = canvas.width;
    
    for (let y = 1; y < canvas.height - 1; y++) {
      for (let x = 1; x < canvas.width - 1; x++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * width + (x + kx)) * 4;
            const kernelIdx = (ky + 1) * 3 + (kx + 1);
            sum += tempData[idx] * sharpenKernel[kernelIdx];
          }
        }
        const idx = (y * width + x) * 4;
        const sharpened = Math.min(255, Math.max(0, sum));
        data[idx] = sharpened;
        data[idx + 1] = sharpened;
        data[idx + 2] = sharpened;
      }
    }
    
    // Aplicar cambios
    ctx.putImageData(imageData, 0, 0);
    
    console.log('✓ Imagen preprocesada: escala de grises + contraste + umbralización + nitidez');
    
    // Convertir canvas a blob
    canvas.toBlob((blob) => {
      resolve(blob);
    }, 'image/png');
  });
}

// ============================================
// CÁMARA Y OCR CON PREPROCESAMIENTO
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
    document.getElementById('ocrStatus').innerHTML =
      '<div class="spinner"></div><span>Preparando imagen...</span>';

    // Esperar a que la imagen se cargue completamente
    img.onload = async () => {
      await processOCR(img);
    };
  };
  reader.readAsDataURL(file);
}

async function processOCR(imageElement) {
  try {
    console.log('=== INICIANDO OCR CON PREPROCESAMIENTO ===');
    console.log('Tesseract cargado:', typeof Tesseract);
    
    if (typeof Tesseract === 'undefined') {
      throw new Error('Tesseract no está cargado. Verifica que esté en index.html');
    }
    
    document.getElementById('ocrStatus').innerHTML =
      '<div class="spinner"></div><span>Mejorando calidad de imagen...</span>';
    
    // Preprocesar imagen para mejorar calidad
    const preprocessedBlob = await preprocessImage(imageElement);
    
    console.log('✓ Imagen preprocesada exitosamente');
    
    document.getElementById('ocrStatus').innerHTML =
      '<div class="spinner"></div><span>Extrayendo texto...</span>';
    
    // Ejecutar OCR con imagen preprocesada
    const result = await Tesseract.recognize(preprocessedBlob, 'spa', {
      logger: m => {
        if (m.status === 'recognizing text') {
          const progress = Math.round(m.progress * 100);
          console.log(`OCR: ${progress}%`);
          document.getElementById('ocrStatus').innerHTML = 
            `<div class="spinner"></div><span>Leyendo texto... ${progress}%</span>`;
        }
      }
    });
    
    console.log('✓ OCR completado');
    
    let text = '';
    
    if (result.data && result.data.text) {
      text = result.data.text;
    } else if (result.text) {
      text = result.text;
    }
    
    console.log('Texto OCR extraído:');
    console.log(text);
    console.log('Longitud:', text.length, 'caracteres');
    console.log('Confianza:', result.data?.confidence || 'N/A');

    if (!text || text.trim().length === 0) {
      throw new Error('No se pudo extraer texto de la imagen');
    }

    const extracted = extractInvoiceData(text);
    fillForm(extracted);

    document.getElementById('ocrStatus').innerHTML =
      '<span style="color: #10b981;">✓ Datos extraídos exitosamente</span>';
    
    setTimeout(() => {
      document.getElementById('ocrStatus').style.display = 'none';
      document.getElementById('dataForm').style.display = 'block';
    }, 1500);
    
  } catch (error) {
    console.error('❌ Error en OCR:', error);
    console.error('Stack:', error.stack);
    
    document.getElementById('ocrStatus').innerHTML =
      '<span style="color: #ef4444;">⚠️ No se pudo leer la imagen. Complete manualmente.</span>';
    
    setTimeout(() => {
      document.getElementById('ocrStatus').style.display = 'none';
      document.getElementById('dataForm').style.display = 'block';
    }, 3000);
  }
}

// ============================================
// EXTRACCIÓN DE DATOS OPTIMIZADA
// ============================================

function extractInvoiceData(text) {
  const data = { fecha: '', docNo: '', valor: '' };
  const cleanText = text.replace(/[\r\n]+/g, '\n');
  const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  console.log('=== EXTRAYENDO DATOS ===');
  console.log('Total de líneas:', lines.length);

  // 1. EXTRAER NÚMERO DE AUTORIZACIÓN
  let dteFound = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Buscar "NO. AUTORIZACIÓN" o variantes
    if (/NO\.?\s*AUTORIZACI[OÓ]N/i.test(line)) {
      console.log('✓ Línea con NO. AUTORIZACIÓN encontrada:', line);
      
      // Buscar UUID en las próximas 3 líneas
      for (let j = i; j < Math.min(i + 4, lines.length); j++) {
        const checkLine = lines[j];
        
        // UUID formato: XXXXXXXX-XXXX-XXXX-XXXX-XXXX/XXX
        const uuidMatch = checkLine.match(/([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]+(?:\/\d+)?)/i);
        if (uuidMatch) {
          dteFound = uuidMatch[1];
          console.log('✓ UUID encontrado:', dteFound);
          break;
        }
        
        // Buscar formato alternativo con guiones y letras
        const altMatch = checkLine.match(/([A-Z0-9]{4,}-[A-Z0-9]{4,}-[A-Z0-9]{4,}(?:-[A-Z0-9]+)?(?:\/\d+)?)/i);
        if (altMatch) {
          dteFound = altMatch[1];
          console.log('✓ Código alternativo encontrado:', dteFound);
          break;
        }
      }
      
      if (dteFound) break;
    }
    
    // Buscar SERIE
    if (/SERIE:/i.test(line) && !dteFound) {
      const serieMatch = line.match(/SERIE:\s*([A-Z0-9\-]+)/i);
      if (serieMatch) {
        dteFound = serieMatch[1];
        console.log('✓ SERIE encontrada:', dteFound);
      }
    }
    
    // Buscar NUMERO
    if (/N[UÚ]MERO:/i.test(line) && !dteFound) {
      const numMatch = line.match(/N[UÚ]MERO:\s*(\d{6,}(?:\/\d+)?)/i);
      if (numMatch) {
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

  // 2. EXTRAER TOTAL
  let valorFound = '';
  const allMoneyMatches = [];
  
  for (const line of lines) {
    // Buscar línea con "TOTAL"
    if (/TOTAL/i.test(line)) {
      console.log('Línea con TOTAL:', line);
      
      // Extraer monto con Q
      const totalMatch = line.match(/Q\s*(\d+(?:[.,]\d+)?)/i);
      if (totalMatch) {
        let valor = totalMatch[1].replace(',', '.');
        valor = parseFloat(valor);
        if (valor > 0 && !isNaN(valor)) {
          valorFound = valor.toFixed(2);
          console.log('✓ TOTAL encontrado:', valorFound);
          break;
        }
      }
    }
    
    // Recolectar todos los montos encontrados
    const moneyMatches = line.match(/Q\s*(\d+(?:[.,]\d{2})?)/gi);
    if (moneyMatches) {
      moneyMatches.forEach(m => {
        let num = m.replace(/Q\s*/i, '').replace(',', '.');
        num = parseFloat(num);
        if (!isNaN(num) && num > 0) {
          allMoneyMatches.push(num);
        }
      });
    }
  }
  
  // Si no se encontró en TOTAL, usar el monto más grande
  if (!valorFound && allMoneyMatches.length > 0) {
    valorFound = Math.max(...allMoneyMatches).toFixed(2);
    console.log('✓ TOTAL encontrado (máximo de todos):', valorFound);
  }

  if (valorFound) {
    data.valor = valorFound;
  } else {
    console.log('✗ No se encontró el total');
  }

  // 3. EXTRAER FECHA
  let fechaFound = '';
  
  for (const line of lines) {
    // Buscar "FECHA DE EMISIÓN"
    if (/FECHA\s+(?:DE\s+)?EMISI[OÓ]N/i.test(line)) {
      console.log('✓ Línea con FECHA DE EMISIÓN:', line);
      
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
  
  // Fallback: buscar cualquier fecha válida
  if (!fechaFound) {
    for (const line of lines) {
      const fechaMatch = line.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (fechaMatch) {
        const day = parseInt(fechaMatch[1]);
        const month = parseInt(fechaMatch[2]);
        const year = fechaMatch[3];
        
        // Validar fecha
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          fechaFound = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
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
  console.log('========================');

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
