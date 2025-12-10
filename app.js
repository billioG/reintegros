// ============================================
// CONFIGURACIÓN Y VARIABLES GLOBALES
// ============================================

const SPREADSHEET_ID = '19Dn2iYHZr9wrPYdNEI2t6QMLMSK-Ljshu_bpCyzgY78';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx3L9bCM4alugbNwpwnq9jY2YE_FRUBJGA8D3NH816XHjItLmagmqXj0v_gBJBfW90u/exec'; // LO CONFIGURAREMOS MÁS ADELANTE
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
    // Registrar Service Worker
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('sw.js');
            console.log('Service Worker registrado');
        } catch (error) {
            console.error('Error registrando Service Worker:', error);
        }
    }

    // Inicializar IndexedDB
    await initDB();

    // Configurar event listeners
    setupEventListeners();

    // Actualizar UI
    updateConnectionStatus();
    updatePendingCount();

    // Escuchar cambios de conexión
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Intentar sincronizar al inicio si hay conexión
    if (isOnline) {
        syncPendingData();
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

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = db.createObjectStore(STORE_NAME, { 
                    keyPath: 'id', 
                    autoIncrement: true 
                });
                objectStore.createIndex('timestamp', 'timestamp', { unique: false });
                objectStore.createIndex('synced', 'synced', { unique: false });
            }
        };
    });
}

async function saveToIndexedDB(data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        
        const dataWithTimestamp = {
            ...data,
            timestamp: Date.now(),
            synced: false
        };

        const request = objectStore.add(dataWithTimestamp);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getPendingData() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const index = objectStore.index('synced');
        const request = index.getAll(IDBKeyRange.only(false));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function markAsSynced(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.get(id);

        request.onsuccess = () => {
            const data = request.result;
            data.synced = true;
            data.syncedAt = Date.now();
            
            const updateRequest = objectStore.put(data);
            updateRequest.onsuccess = () => resolve();
            updateRequest.onerror = () => reject(updateRequest.error);
        };

        request.onerror = () => reject(request.error);
    });
}

async function getAllData() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ============================================
// EVENT LISTENERS
// ============================================

function setupEventListeners() {
    // Botón abrir cámara
    document.getElementById('openCamera').addEventListener('click', openCamera);

    // Input de cámara
    document.getElementById('cameraInput').addEventListener('change', handleImageCapture);

    // Cerrar vista previa
    document.getElementById('closePreview').addEventListener('click', closePreview);

    // Select de proyecto
    document.getElementById('proyecto').addEventListener('change', handleProyectoChange);

    // Cancelar formulario
    document.getElementById('cancelForm').addEventListener('click', resetForm);

    // Submit formulario
    document.getElementById('dataForm').addEventListener('submit', handleFormSubmit);

    // Ver datos pendientes
    document.getElementById('viewPending').addEventListener('click', showPendingModal);

    // Cerrar modal
    document.getElementById('closePendingModal').addEventListener('click', closePendingModal);

    // Sincronizar todo
    document.getElementById('syncAll').addEventListener('click', syncPendingData);
}

// ============================================
// MANEJO DE CÁMARA Y CAPTURA
// ============================================

function openCamera() {
    document.getElementById('cameraInput').click();
}

async function handleImageCapture(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Mostrar vista previa
    const reader = new FileReader();
    reader.onload = async (e) => {
        currentImageData = e.target.result;
        
        const previewImage = document.getElementById('previewImage');
        previewImage.src = currentImageData;
        
        document.getElementById('imagePreview').style.display = 'block';
        document.querySelector('.capture-section').style.display = 'none';
        document.getElementById('ocrStatus').style.display = 'flex';

        // Procesar OCR
        await processOCR(file);
    };

    reader.readAsDataURL(file);
}

async function processOCR(imageFile) {
    try {
        const { data: { text } } = await Tesseract.recognize(
            imageFile,
            'spa',
            {
                logger: m => console.log(m)
            }
        );

        console.log('Texto extraído:', text);

        // Extraer información
        const extractedData = extractInvoiceData(text);
        
        // Llenar formulario
        fillForm(extractedData);

        // Ocultar OCR status y mostrar formulario
        document.getElementById('ocrStatus').style.display = 'none';
        document.getElementById('dataForm').style.display = 'block';

    } catch (error) {
        console.error('Error en OCR:', error);
        document.getElementById('ocrStatus').innerHTML = '<span>❌ Error al extraer datos. Complete manualmente.</span>';
        setTimeout(() => {
            document.getElementById('ocrStatus').style.display = 'none';
            document.getElementById('dataForm').style.display = 'block';
        }, 2000);
    }
}

// ============================================
// EXTRACCIÓN DE DATOS DE FACTURA
// ============================================

function extractInvoiceData(text) {
    const data = {
        fecha: '',
        docNo: '',
        valor: ''
    };

    // Extraer fecha (varios formatos)
    const fechaPatterns = [
        /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,
        /(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,
        /fecha[:\s]+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i
    ];

    for (const pattern of fechaPatterns) {
        const match = text.match(pattern);
        if (match) {
            const [_, p1, p2, p3] = match;
            // Intentar determinar formato
            let year = p3.length === 2 ? '20' + p3 : p3;
            let month = p2.length <= 2 && parseInt(p2) <= 12 ? p2.padStart(2, '0') : p1.padStart(2, '0');
            let day = p2.length <= 2 && parseInt(p2) <= 12 ? p1.padStart(2, '0') : p2.padStart(2, '0');
            
            data.fecha = `${year}-${month}-${day}`;
            break;
        }
    }

    // Extraer número de documento
    const docPatterns = [
        /(?:DTE|Documento|Doc\.?|Factura|N[uú]mero)[:\s]+([A-Z0-9\-]+)/i,
        /([A-Z0-9]{8}-[A-Z0-9]{10})/,
        /DTE[:\s]*([0-9\-]+)/i
    ];

    for (const pattern of docPatterns) {
        const match = text.match(pattern);
        if (match) {
            data.docNo = match[1].trim();
            break;
        }
    }

    // Extraer total/valor
    const valorPatterns = [
        /(?:total|monto|valor)[:\s]*Q?[:\s]*(\d+[,.]?\d*)/i,
        /Q[:\s]*(\d+[,.]?\d+)/,
        /(\d+\.\d{2})\s*$/m
    ];

    for (const pattern of valorPatterns) {
        const match = text.match(pattern);
        if (match) {
            data.valor = match[1].replace(',', '.');
            break;
        }
    }

    return data;
}

function fillForm(data) {
    if (data.fecha) {
        document.getElementById('fecha').value = data.fecha;
    } else {
        // Fecha actual como fallback
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('fecha').value = today;
    }

    if (data.docNo) {
        document.getElementById('docNo').value = data.docNo;
    }

    if (data.valor) {
        document.getElementById('valor').value = data.valor;
    }
}

// ============================================
// MANEJO DE FORMULARIO
// ============================================

function handleProyectoChange(event) {
    const otroGroup = document.getElementById('otroProyectoGroup');
    if (event.target.value === 'otro') {
        otroGroup.style.display = 'block';
        document.getElementById('otroProyecto').required = true;
    } else {
        otroGroup.style.display = 'none';
        document.getElementById('otroProyecto').required = false;
    }
}

async function handleFormSubmit(event) {
    event.preventDefault();

    const formData = {
        fecha: document.getElementById('fecha').value,
        descripcion: document.getElementById('descripcion').value,
        docNo: document.getElementById('docNo').value,
        proyecto: document.getElementById('proyecto').value === 'otro' 
            ? document.getElementById('otroProyecto').value 
            : document.getElementById('proyecto').value,
        valor: document.getElementById('valor').value,
        solicitante: document.getElementById('solicitante').value,
        foto: currentImageData
    };

    try {
        // Guardar en IndexedDB
        await saveToIndexedDB(formData);
        
        // Actualizar contador
        await updatePendingCount();

        // Mostrar notificación
        showNotification('✅ Datos guardados localmente');

        // Intentar sincronizar si hay conexión
        if (isOnline) {
            await syncPendingData();
        }

        // Resetear formulario
        resetForm();

    } catch (error) {
        console.error('Error guardando datos:', error);
        showNotification('❌ Error al guardar datos');
    }
}

function resetForm() {
    document.getElementById('dataForm').reset();
    document.getElementById('dataForm').style.display = 'none';
    document.getElementById('imagePreview').style.display = 'none';
    document.querySelector('.capture-section').style.display = 'block';
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

async function syncPendingData() {
    if (!isOnline) {
        showNotification('⚠️ Sin conexión a internet');
        return;
    }

    const pendingData = await getPendingData();
    
    if (pendingData.length === 0) {
        console.log('No hay datos pendientes');
        return;
    }

    showSyncNotification();

    for (const item of pendingData) {
        try {
            // Subir imagen a Google Drive
            const fotoUrl = await uploadToGoogleDrive(item.foto, `factura_${item.timestamp}.jpg`);
            
            // Guardar en Google Sheets
            await saveToGoogleSheets({
                fecha: item.fecha,
                descripcion: item.descripcion,
                docNo: item.docNo,
                proyecto: item.proyecto,
                valor: item.valor,
                solicitante: item.solicitante,
                foto: fotoUrl
            });

            // Marcar como sincronizado
            await markAsSynced(item.id);
            
        } catch (error) {
            console.error('Error sincronizando:', error);
        }
    }

    hideSyncNotification();
    await updatePendingCount();
    showNotification('✅ Datos sincronizados correctamente');
}

async function uploadToGoogleDrive(base64Image, filename) {
    // Esta función necesita el Apps Script desplegado
    // Por ahora retornamos la imagen en base64 como placeholder
    
    if (!APPS_SCRIPT_URL) {
        console.warn('Apps Script URL no configurada');
        return base64Image; // Fallback: guardar base64 directamente
    }

    const response = await fetch(APPS_SCRIPT_URL + '?action=uploadImage', {
        method: 'POST',
        body: JSON.stringify({
            imageData: base64Image,
            filename: filename
        })
    });

    const result = await response.json();
    return result.url;
}

async function saveToGoogleSheets(data) {
    if (!APPS_SCRIPT_URL) {
        console.warn('Apps Script URL no configurada');
        return;
    }

    const response = await fetch(APPS_SCRIPT_URL + '?action=addRow', {
        method: 'POST',
        body: JSON.stringify(data)
    });

    return await response.json();
}

// ============================================
// UI Y NOTIFICACIONES
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
    const pendingData = await getPendingData();
    const count = pendingData.length;
    
    document.getElementById('pendingCount').textContent = count;
    
    if (count > 0) {
        document.getElementById('viewPending').style.display = 'flex';
    } else {
        document.getElementById('viewPending').style.display = 'none';
    }

    // Actualizar contador total
    const allData = await getAllData();
    document.getElementById('savedCount').textContent = allData.length;
}

function showNotification(message) {
    // Crear notificación temporal
    const notification = document.createElement('div');
    notification.className = 'sync-notification show';
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 3000);
}

function showSyncNotification() {
    document.getElementById('syncNotification').classList.add('show');
}

function hideSyncNotification() {
    document.getElementById('syncNotification').classList.remove('show');
}

async function showPendingModal() {
    const pendingData = await getPendingData();
    const listContainer = document.getElementById('pendingList');
    
    listContainer.innerHTML = '';

    if (pendingData.length === 0) {
        listContainer.innerHTML = '<p style="text-align: center; color: #7f8c8d;">No hay datos pendientes</p>';
    } else {
        pendingData.forEach(item => {
            const itemEl = document.createElement('div');
            itemEl.className = 'pending-item';
            itemEl.innerHTML = `
                <div class="pending-item-header">
                    <span>${item.proyecto}</span>
                    <span>Q ${item.valor}</span>
                </div>
                <div class="pending-item-details">
                    <div><strong>Fecha:</strong> ${item.fecha}</div>
                    <div><strong>Doc:</strong> ${item.docNo || 'N/A'}</div>
                    <div><strong>Solicitante:</strong> ${item.solicitante}</div>
                </div>
            `;
            listContainer.appendChild(itemEl);
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
    syncPendingData();
}

function handleOffline() {
    isOnline = false;
    updateConnectionStatus();
}
