// BillScanner 2026 - Main Logic
// Uses Tesseract.js, Supabase, Dexie.js

// --- CONFIGURATION ---
const SUPABASE_URL = 'https://kshaerozfrjrnhymopmm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtzaGFlcm96ZnJqcm5oeW1vcG1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3MTcxNDMsImV4cCI6MjA4OTI5MzE0M30.2cc8utZdAL5U3-Az-ycdCDPTRDrs8euY-flaMJeQ654';

let sbClient = null;
if (SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_URL !== '') {
    sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// --- DATABASE SETUP (Local) ---
const db = new Dexie("InvoiceDB");
db.version(2).stores({
    invoices: '++id, vendor, invoice_number, date, total, category, status, image'
});

// --- UI ELEMENTS ---
const elements = {
    cameraBtn: document.getElementById('camera-btn'),
    cameraOverlay: document.getElementById('camera-overlay'),
    video: document.getElementById('video'),
    canvas: document.getElementById('canvas'),
    takePhotoBtn: document.getElementById('take-photo'),
    closeCameraBtn: document.getElementById('close-camera'),
    switchCameraBtn: document.getElementById('switch-camera'),
    processingOverlay: document.getElementById('processing-overlay'),
    processingStatus: document.getElementById('processing-status'),
    editModal: document.getElementById('edit-modal'),
    invoiceForm: document.getElementById('invoice-form'),
    closeModalBtn: document.getElementById('close-modal'),
    invoiceList: document.getElementById('invoice-list'),
    syncStatus: document.getElementById('sync-status'),
    totalAmount: document.getElementById('total-amount'),
    invoiceCount: document.getElementById('invoice-count'),
    exportBtn: document.getElementById('export-btn'),
    formVendor: document.getElementById('form-vendor'),
    formNumber: document.getElementById('form-number'),
    formDate: document.getElementById('form-date'),
    formTotal: document.getElementById('form-total'),
    formCategory: document.getElementById('form-category')
};

let currentStream = null;
let useFrontCamera = false;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    loadInvoices();
    setupEventListeners();
    checkOnlineStatus();
    
    window.addEventListener('online', checkOnlineStatus);
    window.addEventListener('offline', checkOnlineStatus);
});

function setupEventListeners() {
    elements.cameraBtn.addEventListener('click', openCamera);
    elements.closeCameraBtn.addEventListener('click', closeCamera);
    elements.takePhotoBtn.addEventListener('click', takePhoto);
    elements.switchCameraBtn.addEventListener('click', switchCamera);
    elements.closeModalBtn.addEventListener('click', () => elements.editModal.classList.add('hidden'));
    elements.exportBtn.addEventListener('click', exportToCSV);

    elements.invoiceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = {
            vendor: elements.formVendor.value,
            invoice_number: elements.formNumber.value,
            date: elements.formDate.value,
            total: parseFloat(elements.formTotal.value),
            category: elements.formCategory.value,
            status: 'local',
            image: elements.canvas.toDataURL('image/jpeg', 0.8)
        };
        
        await db.invoices.add(formData);
        elements.editModal.classList.add('hidden');
        loadInvoices();
        syncWithSupabase();
    });
}

// --- CAMERA LOGIC ---
async function openCamera() {
    try {
        const constraints = {
            video: { facingMode: useFrontCamera ? "user" : "environment" }
        };
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        elements.video.srcObject = currentStream;
        elements.cameraOverlay.classList.remove('hidden');
    } catch (err) {
        alert("No se pudo acceder a la cámara: " + err.message);
    }
}

function closeCamera() {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }
    elements.cameraOverlay.classList.add('hidden');
}

function switchCamera() {
    useFrontCamera = !useFrontCamera;
    closeCamera();
    openCamera();
}

async function takePhoto() {
    const context = elements.canvas.getContext('2d');
    elements.canvas.width = elements.video.videoWidth;
    elements.canvas.height = elements.video.videoHeight;
    context.drawImage(elements.video, 0, 0, elements.canvas.width, elements.canvas.height);
    
    closeCamera();
    processImageWithOCR();
}

// --- OCR LOGIC ---
async function processImageWithOCR() {
    elements.processingOverlay.classList.remove('hidden');
    elements.processingStatus.innerText = "Analizando factura...";

    try {
        const worker = await Tesseract.createWorker('spa'); 
        const { data: { text } } = await worker.recognize(elements.canvas);
        await worker.terminate();
        
        const parsedData = parseInvoiceText(text);
        
        elements.formVendor.value = parsedData.vendor || "";
        elements.formNumber.value = parsedData.invoice_number || "";
        elements.formDate.value = parsedData.date || new Date().toISOString().split('T')[0];
        elements.formTotal.value = parsedData.total || "";
        
        elements.processingOverlay.classList.add('hidden');
        elements.editModal.classList.remove('hidden');
    } catch (err) {
        console.error(err);
        elements.processingOverlay.classList.add('hidden');
        elements.editModal.classList.remove('hidden');
    }
}

function parseInvoiceText(text) {
    const data = { vendor: "", invoice_number: "", date: "", total: "" };
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    if (lines.length > 0) data.vendor = lines[0];

    // INVOICE NUMBER
    const numberRegex = /(?:factura|f\.e\.|no\.|n[ú|u]mero|serie|autorizaci[ó|o]n|documento)[:\s]*([0-9a-z-]+(?:\s*[0-9a-z-]+)*)/i;
    const numberMatch = text.match(numberRegex);
    if (numberMatch) {
        data.invoice_number = numberMatch[1].trim();
    } else {
        const feIndex = lines.findIndex(l => /factura\s+electr[ó|o]nica/i.test(l));
        if (feIndex !== -1 && lines[feIndex + 1]) {
            data.invoice_number = lines[feIndex + 1].trim();
        }
    }

    // DATE
    const dateRegex = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})|(\d{4}-\d{1,2}-\d{1,2})/;
    const dateMatch = text.match(dateRegex);
    if (dateMatch) {
        let dateStr = dateMatch[0];
        if (dateStr.includes('/')) {
            const parts = dateStr.split('/');
            if (parts[2].length === 2) parts[2] = "20" + parts[2];
            data.date = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        } else {
            data.date = dateStr;
        }
    }

    // TOTAL
    const totalRegex = /(?:total|pago|suma|importe|neto|monto|pagar|q\.*)[:\s]*([0-9,]+\.[0-9]{2})/gi;
    let match;
    let lastMatch = null;
    while ((match = totalRegex.exec(text)) !== null) {
        lastMatch = match[1];
    }
    if (lastMatch) data.total = lastMatch.replace(',', '');

    return data;
}

// --- SYNC & STORAGE ---
async function loadInvoices() {
    const invoices = await db.invoices.toArray();
    elements.invoiceList.innerHTML = '';
    let total = 0;
    
    if (invoices.length === 0) {
        elements.invoiceList.innerHTML = `
            <div class="empty-state">
                <i data-lucide="file-text"></i>
                <p>No hay facturas registradas</p>
            </div>
        `;
    } else {
        invoices.reverse().forEach(inv => {
            total += inv.total;
            const card = document.createElement('div');
            card.className = 'invoice-card slider-up';
            card.innerHTML = `
                <div class="invoice-info">
                    <h4>${inv.vendor}</h4>
                    <p style="font-size: 0.7rem; font-family: monospace; color: var(--primary-color)">${inv.invoice_number || 'S/N'}</p>
                    <p>${inv.date} • ${inv.category}</p>
                </div>
                <div class="invoice-amount">
                    Q${inv.total.toFixed(2)}
                    ${inv.status === 'synced' ? '<i data-lucide="check-circle-2" style="width:12px;color:var(--success-color)"></i>' : ''}
                </div>
            `;
            elements.invoiceList.appendChild(card);
        });
    }
    lucide.createIcons();
    elements.totalAmount.innerText = `Q${total.toFixed(2)}`;
    elements.invoiceCount.innerText = invoices.length;
}

function checkOnlineStatus() {
    if (navigator.onLine) {
        elements.syncStatus.className = 'status-pill online';
        elements.syncStatus.innerHTML = '<i data-lucide="wifi"></i><span>En línea</span>';
        syncWithSupabase();
    } else {
        elements.syncStatus.className = 'status-pill offline';
        elements.syncStatus.innerHTML = '<i data-lucide="wifi-off"></i><span>Sin conexión</span>';
    }
    lucide.createIcons();
}

async function syncWithSupabase() {
    if (!navigator.onLine || !sbClient) return;
    const unsynced = await db.invoices.where('status').equals('local').toArray();
    for (const inv of unsynced) {
        try {
            const { error } = await sbClient
                .from('invoices')
                .insert([{
                    vendor: inv.vendor,
                    invoice_number: inv.invoice_number,
                    date: inv.date,
                    total: inv.total,
                    category: inv.category,
                    image_url: inv.image
                }]);
            if (!error) await db.invoices.update(inv.id, { status: 'synced' });
        } catch (err) {
            console.error("Sync error:", err);
        }
    }
    loadInvoices();
}

async function exportToCSV() {
    const invoices = await db.invoices.toArray();
    if (invoices.length === 0) return alert("Nada que exportar");
    const headers = ["ID", "Establecimiento", "No. Factura", "Fecha", "Total", "Categoria", "Estado"];
    const rows = invoices.map(inv => [inv.id, `"${inv.vendor}"`, `"${inv.invoice_number}"`, inv.date, inv.total, inv.category, inv.status]);
    const csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n" + rows.map(r => r.join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `facturas_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- SERVICE WORKER REGISTRATION ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then(reg => console.log('SW Registered')).catch(err => console.log('SW Error', err));
    });
}
