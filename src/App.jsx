import React, { useState, useEffect, useRef, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch } from 'firebase/firestore';
import {
  Camera, Upload, ScanLine, Phone, MessageSquare, Search, Filter, Download,
  CheckCircle2, Clock, AlertCircle, Trash2, Plus, RotateCw, ZoomIn, ZoomOut,
  FileSpreadsheet, Layers, CheckSquare, Square, Edit3, Save, X, Sparkles,
  Smartphone, MapPin, Hash, Tag, RefreshCw, Scissors, ChevronDown, ChevronUp, Info
} from 'lucide-react';

// --- CONFIGURACIÓN DE FIREBASE DESDE VARIABLES DE ENTORNO (.env / Vercel) ---
const firebaseConfig = {
apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'equipo_llamadas';

// --- CATÁLOGO DE LEYENDAS PREDEFINIDAS ---
const DEFAULT_LEGENDS = [
  { id: 'pendiente', label: 'Pendiente', color: 'bg-slate-100 text-slate-700 border-slate-300', dot: 'bg-slate-400' },
  { id: 'recupero', label: 'Recuperó / Recuperado', color: 'bg-emerald-100 text-emerald-800 border-emerald-300', dot: 'bg-emerald-500' },
  { id: 'ya_entrego', label: 'Ya entregó', color: 'bg-teal-100 text-teal-800 border-teal-300', dot: 'bg-teal-500' },
  { id: 'nc', label: 'N.C (No Contesta)', color: 'bg-amber-100 text-amber-800 border-amber-300', dot: 'bg-amber-500' },
  { id: 'apagado', label: 'Apagado / Fuera de servicio', color: 'bg-orange-100 text-orange-800 border-orange-300', dot: 'bg-orange-500' },
  { id: 'colgo', label: 'Colgó / No se escuchó', color: 'bg-rose-100 text-rose-800 border-rose-300', dot: 'bg-rose-500' },
  { id: 'equivocado', label: 'N° Equivocado / No existe', color: 'bg-red-100 text-red-800 border-red-300', dot: 'bg-red-600' },
  { id: 'se_mudo', label: 'Se mudó', color: 'bg-purple-100 text-purple-800 border-purple-300', dot: 'bg-purple-500' },
  { id: 'volver_llamar', label: 'Volver a llamar / WS', color: 'bg-blue-100 text-blue-800 border-blue-300', dot: 'bg-blue-500' },
];

// Normaliza texto manuscrito detectado a una leyenda estándar si coincide
function mapHandwrittenToLegend(note) {
  if (!note) return 'Pendiente';
  const n = note.toLowerCase().trim();
  if (n.includes('recuper')) return 'Recuperó / Recuperado';
  if (n.includes('entreg')) return 'Ya entregó';
  if (n === 'n.c' || n === 'nc' || n.includes('no contesta') || n.includes('n.c.')) return 'N.C (No Contesta)';
  if (n.includes('apagado') || n.includes('fuera')) return 'Apagado / Fuera de servicio';
  if (n.includes('colg') || n.includes('escuch')) return 'Colgó / No se escuchó';
  if (n.includes('equivoc') || n.includes('existe')) return 'N° Equivocado / No existe';
  if (n.includes('mud')) return 'Se mudó';
  if (n.includes('ws') || n.includes('escrib') || n.includes('fin de semana') || n.includes('llamar')) return 'Volver a llamar / WS';
  return note; // Devuelve la nota manuscrita tal cual como leyenda personalizada
}

// Formatea teléfono venezolano para WhatsApp (0412/0414/0424/0416/0426 -> 58...)
function formatWhatsAppLink(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.startsWith('0')) {
    return `https://wa.me/58${digits.slice(1)}`;
  }
  if (digits.startsWith('58')) {
    return `https://wa.me/${digits}`;
  }
  return `https://wa.me/58${digits}`;
}

// Procesa imagen en canvas (rotación y recorte opcional por mitades para máxima precisión OCR)
async function processImageForOCR(dataUrl, rotationDeg = 0, cropMode = 'full') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      const rad = (rotationDeg * Math.PI) / 180;
      const sin = Math.abs(Math.sin(rad));
      const cos = Math.abs(Math.cos(rad));
      const rotW = Math.floor(img.width * cos + img.height * sin);
      const rotH = Math.floor(img.width * sin + img.height * cos);

      // Canvas intermedio con la imagen rotada
      const rotCanvas = document.createElement('canvas');
      rotCanvas.width = rotW;
      rotCanvas.height = rotH;
      const rCtx = rotCanvas.getContext('2d');
      rCtx.translate(rotW / 2, rotH / 2);
      rCtx.rotate(rad);
      rCtx.drawImage(img, -img.width / 2, -img.height / 2);

      // Recorte según modo ('full', 'top', 'bottom') con ligero solapamiento del 6% para no cortar filas del medio
      let sy = 0;
      let sh = rotH;
      if (cropMode === 'top') {
        sy = 0;
        sh = Math.floor(rotH * 0.54);
      } else if (cropMode === 'bottom') {
        sy = Math.floor(rotH * 0.46);
        sh = rotH - sy;
      }

      // Escalar manteniendo alta resolución (máx 2600px de ancho para leer letras pequeñas sin perder nitidez)
      const maxDim = 2600;
      let targetW = rotW;
      let targetH = sh;
      if (targetW > maxDim) {
        const scale = maxDim / targetW;
        targetW = Math.floor(targetW * scale);
        targetH = Math.floor(targetH * scale);
      }

      canvas.width = targetW;
      canvas.height = targetH;
      ctx.drawImage(rotCanvas, 0, sy, rotW, sh, 0, 0, targetW, targetH);

      const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
      resolve(base64);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Llamada a Gemini Vision API con Structured Outputs y maxOutputTokens alto para evitar truncamiento de 60+ filas
async function extractRecordsWithGemini(base64Image, scanMode = 'full', customApiKey = '') {
  const apiKey = customApiKey.trim() || (typeof __gemini_api_key !== 'undefined' ? __gemini_api_key : "");
  if (!apiKey) {
    throw new Error("Falta la clave API de Gemini. Haz clic en 'Configurar API Key' arriba e ingresa tu clave gratuita de Google AI Studio.");
  }

  const modeInstruction =
    scanMode === 'top'
      ? "Estás analizando la MITAD SUPERIOR de una planilla. Extrae TODAS las filas visibles desde la fila 1 hasta el final de este recorte."
      : scanMode === 'bottom'
      ? "Estás analizando la MITAD INFERIOR de una planilla. Extrae TODAS las filas visibles desde el inicio de este recorte hasta la última fila del fondo de la hoja."
      : "Estás analizando una planilla COMPLETA que contiene entre 50 y 85 filas muy juntas de arriba hacia abajo. Es CRÍTICO que NO te detengas en la fila 20 ni resumas: debes leer y extraer ABSOLUTAMENTE TODAS Y CADA UNA de las filas desde la primera hasta la última fila inferior.";

  const prompt = `Eres un sistema OCR de ultra-precisión especializado en digitalizar planillas físicas de reportes de clientes y recuperación de equipos de telecomunicaciones.
${modeInstruction}

INSTRUCCIONES ESTRICTAS:
1. Lee la hoja fila por fila de arriba hacia abajo. No omitas ninguna fila, incluso si está al final o tiene letra pequeña.
2. Captura el encabezado o título escrito a mano en la parte superior si existe (por ejemplo: "Equipo Improductivo").
3. Para cada fila, extrae:
   - filaNumero: número secuencial (1, 2, 3...)
   - ciudad: ej. MARACAY
   - oficina: ej. C.O. EL LIMON
   - fecha: fecha impresa en la fila (ej. 06/03/2025)
   - contrato: código de contrato/cuenta (ej. 0300268280)
   - serial: serial/MAC del equipo (ej. 80F7A6A4660F o C4A5592D788)
   - cliente: nombre completo del cliente
   - telefono1: primer número telefónico (ej. 0424-3368697)
   - telefono2: segundo número telefónico si existe (ej. 0424-3229696)
   - datoExtra: columna intermedia (ej. MAY10, GRIS, BLANCO, etc.)
   - direccion: unión de las columnas de calle/vereda/número y urbanización (ej. "CA. 09 #24 URB. CAÑA DE AZUCAR STR I")
   - tipoEquipo: texto de la columna derecha (ej. "EQUIPO ONI ONT FIBRAS Recupero", "CAJA DIGITA", "ROUTER", "Pendiente")
   - notaManuscrita: MUY IMPORTANTE. Lee cuidadosamente cualquier anotación escrita a mano con bolígrafo sobre o al lado de esa fila (ej. "N.C", "Se mudó", "Ya entregó", "N° Equivocado", "Apagado", "Colgó", "No se escuchó", "Recuperó", "Le escribí al ws", "Fin de semana", "No existe", "Cagua", "No está en la casa", "Recupero sábado", etc.). Si no tiene nota manuscrita, deja "".

Devuelve el resultado estrictamente en el esquema JSON solicitado.`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 32768,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          tituloHoja: { type: "STRING" },
          totalFilasDetectadas: { type: "INTEGER" },
          registros: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                filaNumero: { type: "INTEGER" },
                ciudad: { type: "STRING" },
                oficina: { type: "STRING" },
                fecha: { type: "STRING" },
                contrato: { type: "STRING" },
                serial: { type: "STRING" },
                cliente: { type: "STRING" },
                telefono1: { type: "STRING" },
                telefono2: { type: "STRING" },
                datoExtra: { type: "STRING" },
                direccion: { type: "STRING" },
                tipoEquipo: { type: "STRING" },
                notaManuscrita: { type: "STRING" }
              },
              required: ["cliente", "telefono1", "contrato", "serial", "direccion", "notaManuscrita"]
            }
          }
        },
        required: ["registros"]
      }
    }
  };

  // Consultar dinámicamente los modelos disponibles para esta clave API + lista de prioridad
  let candidateModels = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-3-flash-preview'
  ];

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (listRes.ok) {
      const listData = await listRes.json();
      const supported = (listData.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((name) => name.includes('gemini') && !name.includes('embedding') && !name.includes('imagen'));

      if (supported.length > 0) {
        // Priorizar modelos flash o pro recientes disponibles en la cuenta
        const prioritized = [
          ...supported.filter((n) => n.includes('2.5-flash') && !n.includes('lite')),
          ...supported.filter((n) => n.includes('3') && n.includes('flash')),
          ...supported.filter((n) => n.includes('2.0-flash') && !n.includes('lite')),
          ...supported.filter((n) => n.includes('flash')),
          ...supported
        ];
        candidateModels = Array.from(new Set(prioritized));
      }
    }
  } catch {
    // Si falla ListModels, continúa con candidateModels por defecto
  }

  let lastError = null;

  for (const modelName of candidateModels) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const detailMsg = errorBody?.error?.message || `HTTP error ${response.status}`;

          if (response.status === 404) {
            lastError = new Error(`Modelo ${modelName} no disponible (404): ${detailMsg}`);
            break; // Probar siguiente modelo candidato inmediatamente
          }
          if (response.status === 401 || response.status === 403 || response.status === 400) {
            throw new Error(`Clave API inválida o sin permisos (${response.status}): ${detailMsg}`);
          }
          throw new Error(`Error del servidor (${response.status}): ${detailMsg}`);
        }

        const result = await response.json();
        const rawText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
          throw new Error("Respuesta vacía del modelo OCR");
        }

        return JSON.parse(rawText);
      } catch (err) {
        lastError = err;
        // Si es error de autenticación o 404, no reintentar el mismo modelo
        if (err.message.includes('Clave API inválida') || err.message.includes('(404)')) {
          break;
        }
        attempt++;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
  }

  throw lastError || new Error("No se pudo conectar con ningún modelo de Gemini Vision.");
}

// --- CARGA Y LECTURA DE ARCHIVOS EXCEL (.xlsx / .xls / .csv) ---
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('No se pudo cargar el lector de Excel'));
    document.head.appendChild(s);
  });
}

function parseExcelRows(sheet, XLSX) {
  // raw: false convierte los números de fecha de Excel (ej. 45659) a texto real (01/02/2025)
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const rowMeta = sheet['!rows'] || [];

  const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

  // Buscar fila de encabezados
  let hIdx = rawRows.findIndex((r) =>
    Array.isArray(r) && ['cliente', 'nombre', 'suscriptor', 'titular', 'contrato', 'serial', 'telefono'].some((k) => r.map(norm).join(' ').includes(k))
  );
  if (hIdx < 0) hIdx = 0;

  const headers = (rawRows[hIdx] || []).map(norm);
  const col = (keys) => headers.findIndex((h) => keys.some((k) => h.includes(k)));

  const iCiudad = col(['ciudad', 'localidad']),
        iOficina = col(['oficina', 'co', 'agencia']),
        iFecha = col(['fecha']),
        // Ignora columnas como "Nombre del contrato" para no poner el nombre en el número de contrato
        iContrato = headers.findIndex((h) =>
          ['contrato', 'cuenta', 'abonado', 'codigo'].some((k) => h.includes(k)) &&
          !['nombre', 'cliente', 'suscriptor', 'titular'].some((ex) => h.includes(ex))
        ),
        iSerial = col(['serial', 'mac', 'serie']),
        iCliente = col(['cliente', 'nombre', 'suscriptor', 'titular', 'razon', 'usuario', 'abonado', 'beneficiario', 'persona', 'NOMB_ABONADO']),
        iEquipo = col(['equipo', 'modelo', 'tipo', 'servicio']),
        iNota = col(['nota', 'obs', 'estatus', 'status', 'leyenda', 'resultado', 'gestion']);

  const tels = headers.map((h, i) => (h.includes('tel') || h.includes('cel') || h.includes('movil') || h.includes('tlf') ? i : -1)).filter((i) => i >= 0);
  const dirs = headers
    .map((h, i) =>
      ['dir', 'calle', 'urb', 'sector', 'vereda', 'av', 'casa', 'nro', 'numero', 'num', 'parcela', 'lote', 'apto', 'piso', 'edificio', 'edif', 'manzana', 'mz']
        .some((k) => h === k || h.includes(k)) && !h.includes('tel') && !h.includes('contrato') && !h.includes('fila')
        ? i
        : -1
    )
    .filter((i) => i >= 0);

  return rawRows.slice(hIdx + 1).reduce((acc, row, idx) => {
    const realRowIndex = hIdx + 1 + idx;
    if (rowMeta[realRowIndex]?.hidden) return acc;

    if (!Array.isArray(row) || row.filter((c) => String(c ?? '').trim() !== '').length < 2) return acc;
    const val = (i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');

    let cliente = val(iCliente);
    // Respaldo: si no detectó el encabezado del nombre, busca la celda con nombre y apellido (letras y espacios, sin números de serial/equipo)
    if (!cliente) {
      const nameCell = row.find((c, idx) => {
        if (idx === iCiudad || idx === iOficina || idx === iEquipo || idx === iNota || dirs.includes(idx)) return false;
        const s = String(c ?? '').trim();
        return /^[A-Za-zÁÉÍÓÚÑáéíóúñ\s.,]{6,}$/.test(s) && s.includes(' ');
      });
      if (nameCell) cliente = String(nameCell).trim();
    }

    let contrato = val(iContrato);
    // Respaldo: si no detectó el código de contrato, busca en la fila la celda que empieza por 0300 o 7-12 dígitos
    if (!contrato || !/\d{6,}/.test(contrato)) {
      const codeCell = row.find((c) => /^0?\d{7,12}$/.test(String(c ?? '').trim()));
      if (codeCell) contrato = String(codeCell).trim();
    }

    const serial = val(iSerial);
    const tel1 = val(tels[0] ?? -1);
    const tel2 = val(tels[1] ?? -1);

    if (!cliente && !contrato && !serial && !tel1) return acc;

    const nota = val(iNota);
    acc.push({
      ciudad: val(iCiudad),
      oficina: val(iOficina),
      fecha: val(iFecha),
      contrato,
      serial,
      cliente: cliente || 'Sin nombre',
      telefono1: tel1 === '-' ? '' : tel1,
      telefono2: tel2 === '-' ? '' : tel2,
      datoExtra: '',
      direccion: dirs.map(val).filter(Boolean).join(' - '),
      tipoEquipo: val(iEquipo),
      notaManuscrita: nota,
      leyenda: mapHandwrittenToLegend(nota),
      observacion: ''
    });
    return acc;
  }, []);
}

export default function App() {
  // --- ESTADOS DE AUTENTICACIÓN Y DATOS ---
  const [user, setUser] = useState(null);
  const [records, setRecords] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loadingData, setLoadingData] = useState(true);

  // --- ESTADOS DEL ESCÁNER OCR ---
  const [activeTab, setActiveTab] = useState('records'); // 'scanner' | 'records'
  const [imagePreview, setImagePreview] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [batchName, setBatchName] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgressText, setScanProgressText] = useState('');
  const [scanError, setScanError] = useState('');
  const [lastScanSummary, setLastScanSummary] = useState(null);
  const [geminiApiKey, setGeminiApiKey] = useState(() => {
    try {
      return localStorage.getItem('gemini_api_key') || '';
    } catch {
      return '';
    }
  });
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  // --- ESTADOS DE FILTROS, SELECCIÓN Y LEYENDAS ---
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLegendFilter, setSelectedLegendFilter] = useState('ALL');
  const [selectedBatchFilter, setSelectedBatchFilter] = useState('ALL');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [customLegends, setCustomLegends] = useState(DEFAULT_LEGENDS);
  const [newLegendInput, setNewLegendInput] = useState('');
  const [showLegendManager, setShowLegendManager] = useState(false);

  // --- ESTADOS DE EDICIÓN Y MODALES ---
  const [editingRecord, setEditingRecord] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null); // { title, message, onConfirm }
  const [toastMsg, setToastMsg] = useState(null);

  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
 const excelInputRef = useRef(null);

  const handleExcelUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !user) return;
    setIsScanning(true);
    setScanProgressText(`Leyendo Excel "${file.name}"...`);
    try {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const items = wb.SheetNames.flatMap((name) => parseExcelRows(wb.Sheets[name], XLSX));
      if (!items.length) throw new Error('No se encontraron registros válidos en el Excel.');

      const now = Date.now(), batchId = `excel_${now}`, finalName = `Excel: ${file.name.replace(/\.[^/.]+$/, '')}`;
      await setDoc(doc(db, appId, 'shared', 'scan_batches', batchId), { name: finalName, count: items.length, createdAt: now });

      for (let i = 0; i < items.length; i += 400) {
        const batch = writeBatch(db);
        items.slice(i, i + 400).forEach((item, idx) => {
          batch.set(doc(collection(db, appId, 'shared', 'call_records')), { ...item, batchId, batchName: finalName, filaNumero: i + idx + 1, createdAt: now });
        });
        await batch.commit();
      }
      setSelectedBatchFilter(batchId);
      setActiveTab('records');
      showToast(`¡Excel cargado! ${items.length} registros guardados.`);
    } catch (err) {
      showToast(err.message || 'Error al leer el Excel', 'error');
    } finally {
      setIsScanning(false);
      setScanProgressText('');
    }
  };

  const showToast = (text, type = 'success') => {
    setToastMsg({ text, type });
    setTimeout(() => setToastMsg(null), 4000);
  };

  // --- INICIALIZACIÓN DE FIREBASE AUTH ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (e) {
        console.error("Error de autenticación:", e);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsubscribe();
  }, []);

  // --- SUSCRIPCIÓN EN TIEMPO REAL A FIRESTORE ---
  useEffect(() => {
    if (!user) return;

    const recordsCol = collection(db, appId, 'shared', 'call_records');
    const unsubRecords = onSnapshot(
      recordsCol,
      (snapshot) => {
        const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        // Ordenar en memoria por fecha de creación (más recientes primero) y número de fila
        list.sort((a, b) => {
          if (b.createdAt !== a.createdAt) return (b.createdAt || 0) - (a.createdAt || 0);
          return (a.filaNumero || 0) - (b.filaNumero || 0);
        });
        setRecords(list);
        setLoadingData(false);
      },
      (error) => {
        console.error("Error leyendo registros:", error);
        setLoadingData(false);
      }
    );

    const batchesCol = collection(db, appId, 'shared', 'scan_batches');
    const unsubBatches = onSnapshot(
      batchesCol,
      (snapshot) => {
        const bList = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        bList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setBatches(bList);
      },
      (error) => {
        console.error("Error leyendo hojas/lotes:", error);
      }
    );

    return () => {
      unsubRecords();
      unsubBatches();
    };
  }, [user]);

  // --- MANEJO DE CARGA DE IMAGEN ---
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImagePreview(ev.target.result);
      setRotation(0);
      setZoom(1);
      setScanError('');
      setLastScanSummary(null);
      const today = new Date().toLocaleDateString('es-VE');
      setBatchName(`Hoja Escaneada - ${today}`);
    };
    reader.readAsDataURL(file);
  };

  // --- EJECUCIÓN DE ESCANEO OCR EXHAUSTIVO ---
  const handleRunOCR = async (mode = 'full') => {
    if (!imagePreview || !user) return;
    setIsScanning(true);
    setScanError('');
    setLastScanSummary(null);

    try {
      let extractedItems = [];
      let detectedTitle = '';

      if (mode === 'split') {
        // Escaneo en dos pasadas (Mitad Superior + Mitad Inferior) para hojas ultra densas de 70+ filas
        setScanProgressText('Paso 1/2: Escaneando mitad superior de la hoja (filas 1 a ~38)...');
        const topBase64 = await processImageForOCR(imagePreview, rotation, 'top');
        const topRes = await extractRecordsWithGemini(topBase64, 'top', geminiApiKey);
        detectedTitle = topRes.tituloHoja || '';
        const topList = topRes.registros || [];

        setScanProgressText(`Paso 2/2: ${topList.length} filas leídas arriba. Escaneando mitad inferior...`);
        const bottomBase64 = await processImageForOCR(imagePreview, rotation, 'bottom');
        const bottomRes = await extractRecordsWithGemini(bottomBase64, 'bottom', geminiApiKey);
        if (!detectedTitle && bottomRes.tituloHoja) detectedTitle = bottomRes.tituloHoja;
        const bottomList = bottomRes.registros || [];

        // Deduplicar filas en la zona de solapamiento por contrato + serial + cliente
        const seenKeys = new Set();
        const combined = [...topList, ...bottomList];
        for (const item of combined) {
          const key = `${(item.contrato || '').trim()}_${(item.serial || '').trim()}_${(item.cliente || '').trim().toLowerCase()}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            extractedItems.push(item);
          }
        }
      } else {
        setScanProgressText('Analizando hoja completa en alta resolución (extrayendo todas las 60+ filas)...');
        const fullBase64 = await processImageForOCR(imagePreview, rotation, 'full');
        const res = await extractRecordsWithGemini(fullBase64, 'full', geminiApiKey);
        detectedTitle = res.tituloHoja || '';
        extractedItems = res.registros || [];
      }

      if (extractedItems.length === 0) {
        throw new Error("No se detectaron filas legibles. Intenta rotar la imagen o usar 'Escaneo Doble (Por Mitades)'.");
      }

      setScanProgressText(`Guardando ${extractedItems.length} registros en la base de datos...`);

      const now = Date.now();
      const batchId = `batch_${now}`;
      const finalBatchName = batchName.trim() || detectedTitle || `Hoja ${new Date().toLocaleDateString('es-VE')}`;

      // Guardar lote en Firestore
      await setDoc(doc(db, appId, 'shared', 'scan_batches', batchId), {
        name: finalBatchName,
        detectedTitle,
        count: extractedItems.length,
        createdAt: now
      });

      // Guardar todos los registros usando WriteBatch (en bloques de 400 por límite de Firestore)
      const chunkSize = 400;
      for (let i = 0; i < extractedItems.length; i += chunkSize) {
        const chunk = extractedItems.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach((item, idx) => {
          const rowNum = i + idx + 1;
          const docRef = doc(collection(db, appId, 'shared', 'call_records'));
          const autoLegend = mapHandwrittenToLegend(item.notaManuscrita);
          batch.set(docRef, {
            batchId,
            batchName: finalBatchName,
            filaNumero: rowNum,
            ciudad: item.ciudad || '',
            oficina: item.oficina || '',
            fecha: item.fecha || '',
            contrato: item.contrato || '',
            serial: item.serial || '',
            cliente: item.cliente || 'Sin nombre',
            telefono1: item.telefono1 || '',
            telefono2: item.telefono2 || '',
            datoExtra: item.datoExtra || '',
            direccion: item.direccion || '',
            tipoEquipo: item.tipoEquipo || '',
            notaManuscrita: item.notaManuscrita || '',
            leyenda: autoLegend,
            observacion: '',
            createdAt: now
          });
        });
        await batch.commit();
      }

      setLastScanSummary({
        count: extractedItems.length,
        batchName: finalBatchName,
        detectedTitle
      });
      setSelectedBatchFilter(batchId);
      showToast(`¡Éxito! Se extrajeron y guardaron ${extractedItems.length} registros completos.`);
      setActiveTab('records');
    } catch (err) {
      console.error("Error en escaneo OCR:", err);
      setScanError(err.message || "Ocurrió un error al procesar la imagen. Intenta nuevamente.");
    } finally {
      setIsScanning(false);
      setScanProgressText('');
    }
  };

  // --- ACTUALIZAR LEYENDA U OBSERVACIÓN DE UN REGISTRO ---
  const handleUpdateRecord = async (recordId, updates) => {
    if (!user) return;
    try {
      const ref = doc(db, appId, 'shared', 'call_records', recordId);
      await updateDoc(ref, updates);
    } catch (err) {
      console.error("Error actualizando registro:", err);
      showToast("Error al guardar cambio", "error");
    }
  };

  // --- ASIGNACIÓN MASIVA DE LEYENDA ---
  const handleBulkLegendAssign = async (legendLabel) => {
    if (!user || selectedIds.size === 0) return;
    try {
      const idsArray = Array.from(selectedIds);
      const batch = writeBatch(db);
      idsArray.forEach((id) => {
        const ref = doc(db, appId, 'shared', 'call_records', id);
        batch.update(ref, { leyenda: legendLabel });
      });
      await batch.commit();
      showToast(`Leyenda "${legendLabel}" aplicada a ${idsArray.length} registros.`);
      setSelectedIds(new Set());
    } catch (err) {
      console.error("Error en actualización masiva:", err);
      showToast("Error al actualizar registros seleccionados", "error");
    }
  };

  // --- ELIMINAR REGISTROS O LOTES ---
  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    setConfirmModal({
      title: `Eliminar ${selectedIds.size} registros`,
      message: "¿Estás seguro de que deseas eliminar permanentemente los registros seleccionados?",
      onConfirm: async () => {
        try {
          const idsArray = Array.from(selectedIds);
          for (let i = 0; i < idsArray.length; i += 400) {
            const batch = writeBatch(db);
            idsArray.slice(i, i + 400).forEach((id) => {
              batch.delete(doc(db, appId, 'shared', 'call_records', id));
            });
            await batch.commit();
          }
          setSelectedIds(new Set());
          showToast(`${idsArray.length} registros eliminados.`);
        } catch {
          showToast("Error al eliminar", "error");
        }
        setConfirmModal(null);
      }
    });
  };

  const handleDeleteBatch = (batchId, name) => {
    setConfirmModal({
      title: `Eliminar hoja completa`,
      message: `Se eliminarán la hoja "${name}" y todos los registros asociados a ella. ¿Continuar?`,
      onConfirm: async () => {
        try {
          const idsArray = Array.from(selectedIds);
          for (let i = 0; i < idsArray.length; i += 400) {
            const batch = writeBatch(db);
            idsArray.slice(i, i + 400).forEach((id) => {
              batch.delete(doc(db, appId, 'shared', 'call_records', id));
            });
            await batch.commit();
          }
          setSelectedIds(new Set());
          showToast(`${idsArray.length} registros eliminados.`);
        } catch {
          showToast("Error al eliminar", "error");
        }
        setConfirmModal(null);
      }
    });
  };

  // --- AGREGAR REGISTRO MANUAL ---
  const handleCreateManualRecord = async (newRec) => {
    if (!user) return;
    try {
      const now = Date.now();
      const docRef = doc(collection(db, appId, 'shared', 'call_records'));
      await setDoc(docRef, {
        ...newRec,
        batchId: 'manual',
        batchName: 'Registro Manual',
        filaNumero: 1,
        createdAt: now
      });
      setEditingRecord(null);
      showToast("Registro agregado correctamente.");
    } catch (err) {
      showToast("Error al crear registro", "error");
    }
  };

  // --- AGREGAR NUEVA LEYENDA PERSONALIZADA ---
  const handleAddCustomLegend = (e) => {
    e.preventDefault();
    const val = newLegendInput.trim();
    if (!val) return;
    if (customLegends.some((l) => l.label.toLowerCase() === val.toLowerCase())) {
      showToast("Esa leyenda ya existe", "error");
      return;
    }
    const newItem = {
      id: `custom_${Date.now()}`,
      label: val,
      color: 'bg-indigo-100 text-indigo-800 border-indigo-300',
      dot: 'bg-indigo-500'
    };
    setCustomLegends([...customLegends, newItem]);
    setNewLegendInput('');
    showToast(`Leyenda "${val}" agregada.`);
  };

  // --- FILTRADO DE REGISTROS ---
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (selectedBatchFilter !== 'ALL' && r.batchId !== selectedBatchFilter) return false;
      if (selectedLegendFilter !== 'ALL' && r.leyenda !== selectedLegendFilter) return false;
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const match =
          (r.cliente || '').toLowerCase().includes(q) ||
          (r.telefono1 || '').toLowerCase().includes(q) ||
          (r.telefono2 || '').toLowerCase().includes(q) ||
          (r.contrato || '').toLowerCase().includes(q) ||
          (r.serial || '').toLowerCase().includes(q) ||
          (r.direccion || '').toLowerCase().includes(q) ||
          (r.leyenda || '').toLowerCase().includes(q) ||
          (r.notaManuscrita || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [records, selectedBatchFilter, selectedLegendFilter, searchTerm]);

  // --- ESTADÍSTICAS ---
  const stats = useMemo(() => {
    const base = selectedBatchFilter === 'ALL' ? records : records.filter((r) => r.batchId === selectedBatchFilter);
    const total = base.length;
    const pendientes = base.filter((r) => r.leyenda === 'Pendiente').length;
    const recuperados = base.filter(
      (r) => r.leyenda === 'Recuperó / Recuperado' || r.leyenda === 'Ya entregó'
    ).length;
    const noContesta = base.filter(
      (r) => r.leyenda === 'N.C (No Contesta)' || r.leyenda === 'Apagado / Fuera de servicio'
    ).length;
    const gestionados = total - pendientes;
    return { total, pendientes, recuperados, noContesta, gestionados };
  }, [records, selectedBatchFilter]);

  // --- EXPORTAR A CSV / EXCEL ---
  const handleExportCSV = () => {
    if (filteredRecords.length === 0) {
      showToast("No hay registros para exportar", "error");
      return;
    }
    const headers = [
      'N° Fila',
      'Hoja / Lote',
      'Fecha',
      'Ciudad',
      'Oficina',
      'Contrato',
      'Serial / MAC',
      'Cliente',
      'Teléfono 1',
      'Teléfono 2',
      'Dirección',
      'Tipo Equipo',
      'Nota Manuscrita Hoja',
      'Leyenda Asignada',
      'Observación Operador'
    ];

    const escapeCSV = (val) => `"${String(val || '').replace(/"/g, '""')}"`;

    const rows = filteredRecords.map((r, i) =>
      [
        r.filaNumero || i + 1,
        r.batchName,
        r.fecha,
        r.ciudad,
        r.oficina,
        r.contrato,
        r.serial,
        r.cliente,
        r.telefono1,
        r.telefono2,
        r.direccion,
        r.tipoEquipo,
        r.notaManuscrita,
        r.leyenda,
        r.observacion
      ]
        .map(escapeCSV)
        .join(';')
    );

    const csvContent = '\uFEFF' + [headers.join(';'), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Reporte_Llamadas_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`Exportados ${filteredRecords.length} registros a Excel/CSV.`);
  };

  // --- SELECCIÓN DE FILAS ---
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredRecords.length && filteredRecords.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredRecords.map((r) => r.id)));
    }
  };

  const toggleSelectRow = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  // Obtener estilo de color para cualquier leyenda
  const getLegendStyle = (label) => {
    const found = customLegends.find((l) => l.label.toLowerCase() === (label || '').toLowerCase());
    if (found) return found;
    return {
      color: 'bg-sky-100 text-sky-800 border-sky-300',
      dot: 'bg-sky-500'
    };
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-16">
      {/* NOTIFICACIÓN TOAST */}
      {toastMsg && (
        <div
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium transition-all ${
            toastMsg.type === 'error'
              ? 'bg-red-600 text-white border-red-700'
              : 'bg-slate-900 text-white border-slate-700'
          }`}
        >
          {toastMsg.type === 'error' ? <AlertCircle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
          <span>{toastMsg.text}</span>
        </div>
      )}

      {/* BARRA SUPERIOR */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-sm">
              <ScanLine className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-tight">
                Gestor de Llamadas y Escáner OCR
              </h1>
              <p className="text-xs text-slate-500 hidden sm:block">
                Digitalización masiva de planillas (60+ filas) y control de gestión
              </p>
            </div>
          </div>

          {/* NAVEGACIÓN PRINCIPAL */}
          <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setActiveTab('scanner')}
              className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeTab === 'scanner'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Camera className="w-4 h-4" />
              <span>Escanear Hoja</span>
            </button>
            <button
              onClick={() => setActiveTab('records')}
              className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeTab === 'records'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-4 h-4" />
              <span>Registros</span>
              <span
                className={`px-2 py-0.5 text-xs rounded-full ${
                  activeTab === 'records' ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-700'
                }`}
              >
                {records.length}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        {/* ===================================================================== */}
        {/* PESTAÑA 1: ESCÁNER OCR DE ALTA DENSIDAD                               */}
        {/* ===================================================================== */}
        {activeTab === 'scanner' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* PANEL IZQUIERDO: CARGA Y CONTROLES DE EXTRACCIÓN */}
            <div className="lg:col-span-5 space-y-5">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-blue-600" />
                    1. Cargar Foto de la Planilla
                  </h2>
                  <button
                    onClick={() => setShowApiKeyInput(!showApiKeyInput)}
                    className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${
                      geminiApiKey
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-300 animate-pulse'
                    }`}
                  >
                    {geminiApiKey ? 'API Key Lista ✓' : 'Configurar API Key'}
                  </button>
                </div>

                {(showApiKeyInput || !geminiApiKey) && (
                  <div className="mb-4 p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <label className="block text-xs font-bold text-slate-700">
                      Clave API de Google Gemini (Gratuita en aistudio.google.com)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={geminiApiKey}
                        onChange={(e) => {
                          setGeminiApiKey(e.target.value);
                          localStorage.setItem('gemini_api_key', e.target.value);
                        }}
                        placeholder="Pega tu clave AIzaSy..."
                        className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 text-xs outline-none focus:border-blue-500 bg-white"
                      />
                      {geminiApiKey && (
                        <button
                          onClick={() => {
                            setShowApiKeyInput(false);
                            showToast('Clave API guardada en el navegador');
                          }}
                          className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold"
                        >
                          Listo
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <p className="text-xs text-slate-500 mb-4">
                  Toma una foto nítida con buena luz donde se vean todas las columnas y notas escritas a bolígrafo.
                </p>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <button
                    onClick={() => cameraInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed border-blue-300 bg-blue-50/50 hover:bg-blue-50 text-blue-700 font-semibold text-sm transition-all"
                  >
                    <Camera className="w-6 h-6" />
                    <span>Tomar Foto</span>
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-sm transition-all"
                  >
                    <Upload className="w-6 h-6" />
                    <span>Subir Imagen</span>
                  </button>
                </div>

                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {imagePreview && (
                  <div className="space-y-4 pt-3 border-t border-slate-100">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Nombre de esta Hoja / Lote
                      </label>
                      <input
                        type="text"
                        value={batchName}
                        onChange={(e) => setBatchName(e.target.value)}
                        placeholder="Ej: Equipo Improductivo - Hoja 1"
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      />
                    </div>

                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 space-y-1">
                      <p className="font-bold flex items-center gap-1.5">
                        <Info className="w-4 h-4 text-amber-600 shrink-0" />
                        Motor Anti-Truncamiento (60+ filas)
                      </p>
                      <p>
                        Configurado para leer todas las filas sin detenerse en la 20. Si la hoja tiene letra muy pequeña, usa el botón <strong>"Escaneo Doble por Mitades"</strong>.
                      </p>
                    </div>

                    <div className="space-y-2.5">
                      <button
                        disabled={isScanning}
                        onClick={() => handleRunOCR('full')}
                        className="w-full py-3.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-all"
                      >
                        {isScanning ? (
                          <>
                            <RefreshCw className="w-5 h-5 animate-spin" />
                            <span>Procesando Planilla...</span>
                          </>
                        ) : (
                          <>
                            <ScanLine className="w-5 h-5" />
                            <span>Extraer Todos los Registros (60+ filas)</span>
                          </>
                        )}
                      </button>

                      <button
                        disabled={isScanning}
                        onClick={() => handleRunOCR('split')}
                        className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-900 disabled:bg-slate-400 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all"
                      >
                        <Scissors className="w-4 h-4 text-emerald-400" />
                        <span>Escaneo Doble (Mitad Superior + Inferior - Máxima Precisión)</span>
                      </button>
                    </div>

                    {isScanning && (
                      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3.5 text-center space-y-2">
                        <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
                          <div className="bg-blue-600 h-2 rounded-full animate-pulse w-3/4"></div>
                        </div>
                        <p className="text-xs font-semibold text-blue-800">{scanProgressText}</p>
                      </div>
                    )}

                    {scanError && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-700 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{scanError}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* HOJAS ESCANEADAS RECIENTEMENTE */}
              {batches.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-900 mb-3">Hojas Guardadas en la Nube</h3>
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {batches.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs"
                      >
                        <div>
                          <p className="font-bold text-slate-800">{b.name}</p>
                          <p className="text-slate-500">{b.count} filas extraídas</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => {
                              setSelectedBatchFilter(b.id);
                              setActiveTab('records');
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 font-semibold hover:bg-blue-200"
                          >
                            Ver
                          </button>
                          <button
                            onClick={() => handleDeleteBatch(b.id, b.name)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
                            title="Eliminar hoja"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* PANEL DERECHO: VISTA PREVIA INTERACTIVA DE LA HOJA */}
            <div className="lg:col-span-7">
              <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm h-full flex flex-col">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-100">
                  <span className="text-sm font-bold text-slate-800">Vista Previa de la Hoja</span>
                  {imagePreview && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setRotation((r) => (r - 90 + 360) % 360)}
                        className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium flex items-center gap-1"
                        title="Rotar izquierda"
                      >
                        <RotateCw className="w-4 h-4 -scale-x-100" />
                      </button>
                      <button
                        onClick={() => setRotation((r) => (r + 90) % 360)}
                        className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium flex items-center gap-1"
                        title="Rotar derecha"
                      >
                        <RotateCw className="w-4 h-4" />
                        <span>Rotar</span>
                      </button>
                      <button
                        onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                        className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700"
                        title="Alejar"
                      >
                        <ZoomOut className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setZoom((z) => Math.min(2.5, z + 0.25))}
                        className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700"
                        title="Acercar"
                      >
                        <ZoomIn className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {!imagePreview ? (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 min-h-[380px] border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center p-8 text-center cursor-pointer hover:bg-slate-50 transition-colors"
                  >
                    <div className="w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4">
                      <FileSpreadsheet className="w-8 h-8" />
                    </div>
                    <h3 className="text-base font-bold text-slate-800 mb-1">
                      Sube o fotografía tu planilla de llamadas
                    </h3>
                    <p className="text-xs text-slate-500 max-w-md">
                      El sistema leerá automáticamente todas las filas (60, 70 o más), teléfonos, seriales de equipos, direcciones y las anotaciones hechas a bolígrafo.
                    </p>
                  </div>
                ) : (
                  <div className="flex-1 min-h-[420px] max-h-[650px] overflow-auto bg-slate-900 rounded-xl flex items-center justify-center p-4">
                    <img
                      src={imagePreview}
                      alt="Planilla escaneada"
                      style={{
                        transform: `rotate(${rotation}deg) scale(${zoom})`,
                        transition: 'transform 0.2s ease'
                      }}
                      className="max-w-full max-h-full object-contain rounded shadow-lg"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* PESTAÑA 2: TABLA DE GESTIÓN DE LLAMADAS Y LEYENDAS                    */}
        {/* ===================================================================== */}
        {activeTab === 'records' && (
          <div className="space-y-5">
            {/* TARJETAS DE ESTADÍSTICAS */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                <p className="text-xs font-semibold text-slate-500">Total Registros</p>
                <p className="text-2xl font-extrabold text-slate-900 mt-1">{stats.total}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">{stats.gestionados} gestionados</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                <p className="text-xs font-semibold text-slate-500">Pendientes por Llamar</p>
                <p className="text-2xl font-extrabold text-amber-600 mt-1">{stats.pendientes}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Sin leyenda final</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                <p className="text-xs font-semibold text-slate-500">Recuperados / Entregados</p>
                <p className="text-2xl font-extrabold text-emerald-600 mt-1">{stats.recuperados}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Equipos recuperados</p>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                <p className="text-xs font-semibold text-slate-500">N.C / Apagados</p>
                <p className="text-2xl font-extrabold text-orange-600 mt-1">{stats.noContesta}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Requieren reintento</p>
              </div>
            </div>

            {/* BARRA DE HERRAMIENTAS, FILTROS Y ACCIONES */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row gap-3 justify-between">
                {/* BUSCADOR */}
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Buscar por cliente, teléfono, contrato, serial, dirección o leyenda..."
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>

                {/* SELECTOR DE HOJA / LOTE */}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={selectedBatchFilter}
                    onChange={(e) => setSelectedBatchFilter(e.target.value)}
                    className="px-3 py-2.5 rounded-xl border border-slate-300 text-sm bg-white font-medium text-slate-700 focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="ALL">Todas las Hojas ({records.length})</option>
                    {batches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.count})
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={() => setShowLegendManager(!showLegendManager)}
                    className="px-3 py-2.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-semibold flex items-center gap-1.5"
                  >
                    <Tag className="w-4 h-4 text-blue-600" />
                    <span className="hidden sm:inline">Leyendas</span>
                  </button>

                  <button
                    onClick={() =>
                      setEditingRecord({
                        isNew: true,
                        cliente: '',
                        telefono1: '',
                        telefono2: '',
                        contrato: '',
                        serial: '',
                        direccion: '',
                        tipoEquipo: 'EQUIPO ONI ONT',
                        notaManuscrita: '',
                        leyenda: 'Pendiente',
                        observacion: ''
                      })
                    }
                    className="px-3 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-sm font-semibold flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Nuevo</span>
                  </button>

                  <input ref={excelInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} className="hidden" />
<button onClick={() => excelInputRef.current?.click()} className="px-3 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-semibold flex items-center gap-1.5">
  <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
  <span>Importar Excel</span>
</button>

                  <button
                    onClick={handleExportCSV}
                    className="px-3.5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1.5 shadow-sm"
                  >
                    <Download className="w-4 h-4" />
                    <span>Excel / CSV</span>
                  </button>
                </div>
              </div>

              {/* GESTOR DE LEYENDAS PERSONALIZADAS (DESPLEGABLE) */}
              {showLegendManager && (
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                      Catálogo de Leyendas Disponibles
                    </span>
                    <button onClick={() => setShowLegendManager(false)} className="text-slate-400 hover:text-slate-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {customLegends.map((l) => (
                      <span
                        key={l.id}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold ${l.color}`}
                      >
                        <span className={`w-2 h-2 rounded-full ${l.dot}`}></span>
                        {l.label}
                      </span>
                    ))}
                  </div>
                  <form onSubmit={handleAddCustomLegend} className="flex gap-2 max-w-md">
                    <input
                      type="text"
                      value={newLegendInput}
                      onChange={(e) => setNewLegendInput(e.target.value)}
                      placeholder="Nueva leyenda (ej: Promesa de entrega lunes)..."
                      className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 text-xs outline-none focus:border-blue-500"
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
                    >
                      Agregar
                    </button>
                  </form>
                </div>
              )}

              {/* FILTROS RÁPIDOS POR LEYENDA (CHIPS) */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                <button
                  onClick={() => setSelectedLegendFilter('ALL')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 transition-all ${
                    selectedLegendFilter === 'ALL'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Todos ({records.filter((r) => selectedBatchFilter === 'ALL' || r.batchId === selectedBatchFilter).length})
                </button>
                {customLegends.map((leg) => {
                  const count = records.filter(
                    (r) =>
                      (selectedBatchFilter === 'ALL' || r.batchId === selectedBatchFilter) &&
                      r.leyenda === leg.label
                  ).length;
                  return (
                    <button
                      key={leg.id}
                      onClick={() => setSelectedLegendFilter(leg.label)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 border transition-all flex items-center gap-1.5 ${
                        selectedLegendFilter === leg.label
                          ? 'ring-2 ring-blue-500 ' + leg.color
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full ${leg.dot}`}></span>
                      <span>{leg.label}</span>
                      <span className="opacity-75">({count})</span>
                    </button>
                  );
                })}
              </div>

              {/* BARRA DE ACCIÓN MASIVA CUANDO HAY FILAS SELECCIONADAS */}
              {selectedIds.size > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-blue-50 border border-blue-200">
                  <div className="flex items-center gap-2 text-xs font-bold text-blue-900">
                    <CheckSquare className="w-4 h-4 text-blue-600" />
                    <span>{selectedIds.size} registros seleccionados</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      onChange={(e) => {
                        if (e.target.value) {
                          handleBulkLegendAssign(e.target.value);
                          e.target.value = '';
                        }
                      }}
                      defaultValue=""
                      className="px-3 py-1.5 rounded-lg border border-blue-300 bg-white text-xs font-semibold text-slate-800 outline-none"
                    >
                      <option value="" disabled>
                        Asignar leyenda masiva...
                      </option>
                      {customLegends.map((l) => (
                        <option key={l.id} value={l.label}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleDeleteSelected}
                      className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Eliminar</span>
                    </button>
                    <button
                      onClick={() => setSelectedIds(new Set())}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-blue-100"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* LISTADO / TABLA DE REGISTROS */}
            {loadingData ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
                <RefreshCw className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-3" />
                <p className="text-sm font-medium text-slate-600">Cargando registros guardados...</p>
              </div>
            ) : filteredRecords.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
                  <ScanLine className="w-7 h-7" />
                </div>
                <h3 className="text-base font-bold text-slate-800">No hay registros para mostrar</h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  {records.length === 0
                    ? 'Aún no has escaneado ninguna hoja. Ve a la pestaña "Escanear Hoja" para digitalizar tu primera planilla.'
                    : 'Ningún registro coincide con los filtros o búsqueda actual.'}
                </p>
                {records.length === 0 && (
                  <button
                    onClick={() => setActiveTab('scanner')}
                    className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 inline-flex items-center gap-2"
                  >
                    <Camera className="w-4 h-4" />
                    <span>Ir al Escáner OCR</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                        <th className="py-3 px-3 w-10 text-center">
                          <button onClick={toggleSelectAll} className="text-slate-500 hover:text-blue-600">
                            {selectedIds.size === filteredRecords.length && filteredRecords.length > 0 ? (
                              <CheckSquare className="w-4 h-4 text-blue-600" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>
                        </th>
                        <th className="py-3 px-3 w-12">N°</th>
                        <th className="py-3 px-3 min-w-[180px]">Cliente / Contrato</th>
                        <th className="py-3 px-3 min-w-[175px]">Teléfonos (Llamar / WS)</th>
                        <th className="py-3 px-3 min-w-[150px]">Serial / Equipo</th>
                        <th className="py-3 px-3 min-w-[200px]">Dirección</th>
                        <th className="py-3 px-3 min-w-[210px]">Leyenda / Resultado</th>
                        <th className="py-3 px-3 min-w-[180px]">Observación Adicional</th>
                        <th className="py-3 px-3 w-16 text-right">Editar</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredRecords.map((rec, index) => {
                        const isSelected = selectedIds.has(rec.id);
                        const legStyle = getLegendStyle(rec.leyenda);
                        const ws1 = formatWhatsAppLink(rec.telefono1);
                        const ws2 = formatWhatsAppLink(rec.telefono2);

                        return (
                          <tr
                            key={rec.id}
                            className={`transition-colors ${
                              isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50/80'
                            }`}
                          >
                            {/* CHECKBOX */}
                            <td className="py-3 px-3 text-center align-top">
                              <button
                                onClick={() => toggleSelectRow(rec.id)}
                                className="text-slate-400 hover:text-blue-600 mt-0.5"
                              >
                                {isSelected ? (
                                  <CheckSquare className="w-4 h-4 text-blue-600" />
                                ) : (
                                  <Square className="w-4 h-4" />
                                )}
                              </button>
                            </td>

                            {/* NÚMERO DE FILA */}
                            <td className="py-3 px-3 align-top font-bold text-slate-400">
                              #{rec.filaNumero || index + 1}
                            </td>

                            {/* CLIENTE Y CONTRATO */}
                            <td className="py-3 px-3 align-top">
                              <p className="font-bold text-slate-900 text-sm leading-snug">{rec.cliente}</p>
                              <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-slate-500">
                                {rec.contrato && (
                                  <span className="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-slate-700">
                                    Cto: {rec.contrato}
                                  </span>
                                )}
                                {rec.fecha && <span>• {rec.fecha}</span>}
                              </div>
                            </td>

                            {/* TELÉFONOS CON ACCIÓN DIRECTA */}
                            <td className="py-3 px-3 align-top space-y-1.5">
                              {rec.telefono1 ? (
                                <div className="flex items-center gap-1.5">
                                  <a
                                    href={`tel:${rec.telefono1.replace(/\D/g, '')}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold transition-colors"
                                    title="Llamar ahora"
                                  >
                                    <Phone className="w-3 h-3" />
                                    <span>{rec.telefono1}</span>
                                  </a>
                                  {ws1 && (
                                    <a
                                      href={ws1}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors"
                                      title="Escribir por WhatsApp"
                                    >
                                      <MessageSquare className="w-3.5 h-3.5" />
                                    </a>
                                  )}
                                </div>
                              ) : (
                                <span className="text-slate-400 italic">Sin teléfono</span>
                              )}

                              {rec.telefono2 && (
                                <div className="flex items-center gap-1.5">
                                  <a
                                    href={`tel:${rec.telefono2.replace(/\D/g, '')}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors"
                                  >
                                    <Phone className="w-3 h-3" />
                                    <span>{rec.telefono2}</span>
                                  </a>
                                  {ws2 && (
                                    <a
                                      href={ws2}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors"
                                      title="WhatsApp Teléfono 2"
                                    >
                                      <MessageSquare className="w-3.5 h-3.5" />
                                    </a>
                                  )}
                                </div>
                              )}
                            </td>

                            {/* SERIAL Y EQUIPO */}
                            <td className="py-3 px-3 align-top">
                              <p className="font-mono font-semibold text-slate-800 bg-slate-100 px-2 py-0.5 rounded inline-block">
                                {rec.serial || 'N/A'}
                              </p>
                              <p className="text-[11px] text-slate-500 mt-1">{rec.tipoEquipo}</p>
                            </td>

                            {/* DIRECCIÓN */}
                            <td className="py-3 px-3 align-top">
                              <p className="text-slate-700 leading-snug">{rec.direccion || 'Sin dirección'}</p>
                              {rec.ciudad && (
                                <span className="text-[10px] text-slate-400 uppercase font-semibold">
                                  {rec.ciudad} {rec.oficina ? `- ${rec.oficina}` : ''}
                                </span>
                              )}
                            </td>

                            {/* SELECTOR DE LEYENDA + NOTA MANUSCRITA DETECTADA */}
                            <td className="py-3 px-3 align-top space-y-1.5">
                              <select
                                value={rec.leyenda || 'Pendiente'}
                                onChange={(e) => handleUpdateRecord(rec.id, { leyenda: e.target.value })}
                                className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-bold outline-none cursor-pointer transition-all ${legStyle.color}`}
                              >
                                {/* Si la leyenda actual no está en el catálogo estándar, mostrarla como opción */}
                                {!customLegends.some((l) => l.label === rec.leyenda) && rec.leyenda && (
                                  <option value={rec.leyenda}>{rec.leyenda}</option>
                                )}
                                {customLegends.map((l) => (
                                  <option key={l.id} value={l.label} className="bg-white text-slate-900">
                                    {l.label}
                                  </option>
                                ))}
                              </select>

                              {rec.notaManuscrita && (
                                <div className="flex items-center gap-1 text-[11px] text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
                                  <Edit3 className="w-3 h-3 shrink-0" />
                                  <span className="truncate" title={`Escrito en hoja: ${rec.notaManuscrita}`}>
                                    Hoja: <strong>{rec.notaManuscrita}</strong>
                                  </span>
                                </div>
                              )}
                            </td>

                            {/* OBSERVACIÓN ADICIONAL DEL OPERADOR */}
                            <td className="py-3 px-3 align-top">
                              <input
                                type="text"
                                defaultValue={rec.observacion || ''}
                                onBlur={(e) => {
                                  if (e.target.value !== (rec.observacion || '')) {
                                    handleUpdateRecord(rec.id, { observacion: e.target.value });
                                  }
                                }}
                                placeholder="Añadir nota de llamada..."
                                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-xs outline-none bg-white"
                              />
                            </td>

                            {/* ACCIONES DE FILA */}
                            <td className="py-3 px-3 align-top text-right">
                              <button
                                onClick={() => setEditingRecord(rec)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                                title="Editar todos los campos"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ===================================================================== */}
      {/* MODAL DE EDICIÓN COMPLETA / CREACIÓN DE REGISTRO                      */}
      {/* ===================================================================== */}
      {editingRecord && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-lg w-full p-6 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                {editingRecord.isNew ? 'Agregar Nuevo Registro' : `Editar Registro #${editingRecord.filaNumero || ''}`}
              </h3>
              <button onClick={() => setEditingRecord(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="sm:col-span-2">
                <label className="block font-semibold text-slate-700 mb-1">Nombre del Cliente</label>
                <input
                  type="text"
                  value={editingRecord.cliente || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, cliente: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Teléfono Principal</label>
                <input
                  type="text"
                  value={editingRecord.telefono1 || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, telefono1: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Teléfono Secundario</label>
                <input
                  type="text"
                  value={editingRecord.telefono2 || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, telefono2: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Contrato / Cuenta</label>
                <input
                  type="text"
                  value={editingRecord.contrato || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, contrato: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Serial / MAC del Equipo</label>
                <input
                  type="text"
                  value={editingRecord.serial || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, serial: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500 font-mono"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block font-semibold text-slate-700 mb-1">Dirección Completa</label>
                <input
                  type="text"
                  value={editingRecord.direccion || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, direccion: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Leyenda / Estado</label>
                <select
                  value={editingRecord.leyenda || 'Pendiente'}
                  onChange={(e) => setEditingRecord({ ...editingRecord, leyenda: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500 bg-white font-semibold"
                >
                  {customLegends.map((l) => (
                    <option key={l.id} value={l.label}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Nota Manuscrita (Hoja)</label>
                <input
                  type="text"
                  value={editingRecord.notaManuscrita || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, notaManuscrita: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block font-semibold text-slate-700 mb-1">Observación Adicional</label>
                <textarea
                  rows={2}
                  value={editingRecord.observacion || ''}
                  onChange={(e) => setEditingRecord({ ...editingRecord, observacion: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                onClick={() => setEditingRecord(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  if (editingRecord.isNew) {
                    const { isNew, ...data } = editingRecord;
                    handleCreateManualRecord(data);
                  } else {
                    const { id, ...data } = editingRecord;
                    handleUpdateRecord(id, data);
                    setEditingRecord(null);
                    showToast("Registro actualizado.");
                  }
                }}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5"
              >
                <Save className="w-4 h-4" />
                <span>Guardar Cambios</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL DE CONFIRMACIÓN PERSONALIZADO                                   */}
      {/* ===================================================================== */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-sm w-full p-5 shadow-xl space-y-4">
            <h3 className="text-base font-bold text-slate-900">{confirmModal.title}</h3>
            <p className="text-xs text-slate-600 leading-relaxed">{confirmModal.message}</p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                Cancelar
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
