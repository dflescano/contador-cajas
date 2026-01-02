// ===== Config =====
const DB_NAME = "contador_cajas_db";
const DB_VER  = 1;
const STORE   = "scans";

const $ = (id) => document.getElementById(id);

// ===== IndexedDB =====
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: "id_caja" }); // ID único: factura-bulto
        st.createIndex("by_day", "day", { unique: false });
        st.createIndex("by_factura", "factura", { unique: false });
        st.createIndex("by_time", "ts", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putScan(scan) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(scan);
  });
}

async function getAllToday(day) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const st = tx.objectStore(STORE);
    const idx = st.index("by_day");
    const req = idx.getAll(day);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).clear();
  });
}

// ===== Helpers =====
function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowISO() {
  const d = new Date();
  return d.toISOString();
}

function timeHM(diso) {
  const d = new Date(diso);
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}

// Acepta QR en JSON o en texto con separadores
function parseQR(text) {
  text = (text || "").trim();

  // 1) JSON
  if (text.startsWith("{") && text.endsWith("}")) {
    const obj = JSON.parse(text);

    // Normalizar claves esperadas
    const factura = String(obj.factura ?? obj.fac ?? "").trim();
    const bulto   = String(obj.bulto ?? obj.b ?? "").trim();

    if (!factura || !bulto) throw new Error("QR inválido: falta factura o bulto");

    return {
      cliente: String(obj.cliente ?? "").trim(),
      direccion: String(obj.direccion ?? "").trim(),
      localidad: String(obj.localidad ?? "").trim(),
      provincia: String(obj.provincia ?? "").trim(),
      orden: String(obj.orden ?? "").trim(),
      factura,
      bulto: Number(bulto),
      total_bultos: Number(obj.total_bultos ?? obj.total ?? 0),
      transporte: String(obj.transporte ?? "").trim()
    };
  }

  // 2) Formato con separador (ej: cliente|direccion|localidad|provincia|orden|factura|bulto|total|transporte)
  const parts = text.split("|").map(s => s.trim());
  if (parts.length >= 7) {
    const [cliente, direccion, localidad, provincia, orden, factura, bulto, total_bultos, transporte] = parts;
    if (!factura || !bulto) throw new Error("QR inválido: falta factura o bulto");
    return {
      cliente, direccion, localidad, provincia,
      orden: orden || "",
      factura,
      bulto: Number(bulto),
      total_bultos: Number(total_bultos || 0),
      transporte: transporte || ""
    };
  }

  throw new Error("QR inválido: formato no reconocido");
}

function showMsg(type, text) {
  const el = $("msg");
  el.style.display = "block";
  el.className = type === "ok" ? "ok" : type === "warn" ? "warn" : "bad";
  el.textContent = text;
  setTimeout(() => { el.style.display = "none"; }, 3500);
}

// ===== UI / Scanner =====
let html5Qr = null;
let lastText = "";
let busy = false;

async function refreshUI() {
  const day = todayKey();
  const rows = await getAllToday(day);

  $("stTotal").textContent = rows.length;

  const facturasSet = new Set(rows.map(r => r.factura));
  $("stFacturas").textContent = facturasSet.size;

  const last = rows.slice().sort((a,b)=>b.ts-a.ts)[0];
  $("stLast").textContent = last ? `${last.factura}-${last.bulto}` : "-";

  // últimos 10
  const last10 = rows.slice().sort((a,b)=>b.ts-a.ts).slice(0,10);
  $("lastTable").innerHTML = last10.map(r => `
    <tr>
      <td>${timeHM(r.iso)}</td>
      <td>${escapeHtml(r.cliente || "")}</td>
      <td>${escapeHtml(r.factura)}</td>
      <td>${r.bulto}</td>
      <td>${escapeHtml(r.direccion || "")}</td>
    </tr>
  `).join("");

  // estado por factura: escaneados/total
  const by = {};
  for (const r of rows) {
    if (!by[r.factura]) by[r.factura] = { total: r.total_bultos || 0, set: new Set() };
    by[r.factura].set.add(r.bulto);
    // si total_bultos viene 0 en algunos, guardamos el mayor visto
    if ((r.total_bultos || 0) > (by[r.factura].total || 0)) by[r.factura].total = r.total_bultos || 0;
  }

  const lines = Object.entries(by)
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([factura, info]) => {
      const scanned = info.set.size;
      const total = info.total || "?";
      return `• Factura <b>${escapeHtml(factura)}</b>: <b>${scanned}</b> / <b>${total}</b>`;
    });

  $("byFactura").innerHTML = lines.length ? lines.join("<br>") : "-";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  })[m]);
}

async function onScanSuccess(decodedText) {
  if (busy) return;
  const text = decodedText.trim();

  // evita doble disparo instantáneo del scanner
  if (text === lastText) return;

  busy = true;
  lastText = text;

  try {
    const data = parseQR(text);

    const id_caja = `${data.factura}-${data.bulto}`.toLowerCase(); // case-insensitive
    const day = todayKey();
    const iso = nowISO();
    const ts = Date.now();

    const operador = ($("who").value || "").trim();

    const scan = {
      id_caja,
      day,
      iso,
      ts,
      operador,
      ...data
    };

    // put() con keyPath único: si existe, reemplaza (no suma duplicado)
    // para avisar duplicado: chequeamos si ya estaba hoy
    const rows = await getAllToday(day);
    const exists = rows.some(r => r.id_caja === id_caja);

    await putScan(scan);

    if (exists) {
      showMsg("warn", `⚠️ Repetido: ${data.factura}-${data.bulto} (no suma)`);
    } else {
      showMsg("ok", `✅ Registrado: ${data.factura}-${data.bulto} — ${data.cliente || ""}`.trim());
    }

    await refreshUI();
  } catch (e) {
    showMsg("bad", `❌ ${e.message || e}`);
  } finally {
    // habilita nuevo scan después de un momento
    setTimeout(() => { busy = false; }, 700);
  }
}

async function startScanner() {
  if (!html5Qr) html5Qr = new Html5Qrcode("reader");

  const config = { fps: 10, qrbox: { width: 260, height: 260 } };

  // usa cámara trasera si está
  await html5Qr.start(
    { facingMode: "environment" },
    config,
    onScanSuccess,
    () => {}
  );
  showMsg("ok", "📷 Cámara iniciada");
}

async function stopScanner() {
  if (html5Qr && html5Qr.isScanning) {
    await html5Qr.stop();
    showMsg("ok", "🛑 Cámara detenida");
  }
}

// ===== Export Excel =====
async function exportExcel() {
  const day = todayKey();
  const rows = await getAllToday(day);

  if (!rows.length) {
    showMsg("warn", "No hay registros para exportar.");
    return;
  }

  // Orden por fecha
  rows.sort((a,b)=>a.ts-b.ts);

  // Mapeo a columnas “entendibles”
  const data = rows.map(r => ({
    "Fecha": new Date(r.iso).toLocaleString("es-AR"),
    "Cliente": r.cliente || "",
    "Dirección": r.direccion || "",
    "Localidad": r.localidad || "",
    "Provincia": r.provincia || "",
    "Orden": r.orden || "",
    "Factura": r.factura || "",
    "Bulto N°": r.bulto || "",
    "Total Bultos": r.total_bultos || "",
    "Transporte": r.transporte || "",
    "Operador": r.operador || "",
    "ID Caja": r.id_caja
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);

  // ancho de columnas (simple)
  ws["!cols"] = [
    { wch: 20 }, { wch: 22 }, { wch: 20 }, { wch: 16 }, { wch: 14 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 14 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Cajas");

  const filename = `cajas_${day}.xlsx`;
  XLSX.writeFile(wb, filename);

  showMsg("ok", `📊 Exportado: ${filename}`);
}

// ===== Jornada / borrar =====
async function resetDay() {
  // No borra todo, solo “marca” que empezás de nuevo: lo hacemos simple borrando todo hoy
  // Si querés histórico por fecha, lo ajustamos a no borrar y exportar por día.
  if (!confirm("¿Nueva jornada? Esto NO borra el histórico de otros días, pero hoy se exporta por fecha. ¿Continuar?")) return;
  showMsg("ok", "Nueva jornada lista (escaneá normalmente).");
}

async function wipeAll() {
  if (!confirm("¿Borrar TODO lo guardado en este dispositivo?")) return;
  await clearAll();
  await refreshUI();
  showMsg("ok", "🧹 Todo borrado.");
}

// ===== PWA install prompt =====
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("btnInstall").style.display = "inline-block";
});
$("btnInstall").addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $("btnInstall").style.display = "none";
});

// ===== Bind =====
$("btnStart").addEventListener("click", startScanner);
$("btnStop").addEventListener("click", stopScanner);
$("btnExport").addEventListener("click", exportExcel);
$("btnClearAll").addEventListener("click", wipeAll);
$("btnResetDay").addEventListener("click", resetDay);

// init
refreshUI();
