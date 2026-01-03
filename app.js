// Contador de Cajas (QR) — app.js
// Guarda escaneos offline en IndexedDB y exporta resumen a Excel (desde navegador).
// Nota: En PWA instalada (standalone) Android suele bloquear descargas/compartir archivos.
// Por eso, exportar/compartir se hace desde navegador (no instalada).

// ===== Config =====
const DB_NAME = "contador_cajas";
const DB_VER  = 2;              // subimos versión para resetear store viejo si existía
const STORE   = "scans";

const $ = (id) => document.getElementById(id);

// ===== Helpers =====
function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}
function nowISO() { return new Date().toISOString(); }
function timeHM(diso) {
  const d = new Date(diso);
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  })[m]);
}
function showMsg(type, text) {
  const el = $("msg");
  if (!el) return alert(text);
  el.style.display = "block";
  el.className = type === "ok" ? "ok" : type === "warn" ? "warn" : "bad";
  el.textContent = text;
  setTimeout(() => { el.style.display = "none"; }, 3800);
}

// Detectar si está instalada como PWA (standalone)
function isPWA() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
}
function openInBrowser() {
  try {
    const url = window.location.href;
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    window.location.href = window.location.href;
  }
}

// ===== IndexedDB =====
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;

      // recrea store para evitar estructuras viejas
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }

      // id_scan único: day + factura + bulto + ts  => nunca se pisa
      const st = db.createObjectStore(STORE, { keyPath: "id_scan" });

      st.createIndex("by_day", "day", { unique: false });
      st.createIndex("by_factura", "factura", { unique: false });
      st.createIndex("by_time", "ts", { unique: false });

      // para detectar duplicados "lógicos" dentro del día: factura-bulto
      st.createIndex("by_id_caja_day", "id_caja_day", { unique: false });
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

async function getAllForDay(day) {
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

// ===== QR Parsing =====
// Acepta QR en JSON o en texto con separadores (etiquetas.html)
// Formato: OC=...|FAC=...|B=...|T=...|CL=...|DI=...|LO=...|PR=...|TR=...
function parseQR(text) {
  text = (text || "").trim();

  // 1) JSON
  if (text.startsWith("{") && text.endsWith("}")) {
    const obj = JSON.parse(text);

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

  // 2) Formato clave=valor
  if (text.includes("=") && text.includes("|")) {
    const obj = {};
    text.split("|").forEach(part => {
      const i = part.indexOf("=");
      if (i === -1) return;
      const k = part.slice(0, i).trim().toUpperCase();
      const v = part.slice(i + 1).trim();
      obj[k] = v;
    });

    const factura = (obj["FAC"] || "").trim();
    const bulto   = (obj["B"]   || "").trim();
    if (!factura || !bulto) throw new Error("QR inválido: falta FAC o B");

    return {
      cliente:   (obj["CL"] || "").trim(),
      direccion: (obj["DI"] || "").trim(),
      localidad: (obj["LO"] || "").trim(),
      provincia: (obj["PR"] || "").trim(),
      orden:     (obj["OC"] || "").trim(),
      factura,
      bulto: Number(bulto),
      total_bultos: Number((obj["T"] || "0").trim() || 0),
      transporte: (obj["TR"] || "").trim()
    };
  }

  throw new Error("QR inválido: formato no reconocido");
}

// ===== UI / Scanner =====
let html5Qr = null;
let lastText = "";
let busy = false;

async function refreshUI() {
  const day = todayKey();
  const rows = await getAllForDay(day);

  $("stTotal").textContent = rows.length;

  const facturasSet = new Set(rows.map(r => r.factura));
  $("stFacturas").textContent = facturasSet.size;

  const last = rows.slice().sort((a,b)=>b.ts-a.ts)[0];
  $("stLast").textContent = last ? `${last.factura}-${last.bulto}` : "-";

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

  // estado por factura
  const by = {};
  for (const r of rows) {
    if (!by[r.factura]) by[r.factura] = { total: r.total_bultos || 0, set: new Set() };
    by[r.factura].set.add(r.bulto);
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

async function onScanSuccess(decodedText) {
  if (busy) return;
  const text = decodedText.trim();
  if (text === lastText) return;

  busy = true;
  lastText = text;

  try {
    const data = parseQR(text);

    const day = todayKey();
    const iso = nowISO();
    const ts  = Date.now();

    // ✅ clave lógica del día (para detectar duplicados)
    const id_caja_day = `${day}-${data.factura}-${data.bulto}`.toLowerCase();

    // ✅ clave única real (nunca pisa)
    const id_scan = `${id_caja_day}-${ts}`;

    const operador = ($("who").value || "").trim();

    const scan = {
      id_scan,
      id_caja_day,
      day,
      iso,
      ts,
      operador,
      ...data
    };

    const rows = await getAllForDay(day);
    const exists = rows.some(r => r.id_caja_day === id_caja_day);

    await putScan(scan);

    if (exists) {
      showMsg("warn", `⚠️ Repetido hoy: ${data.factura}-${data.bulto} (queda registrado igual)`);
    } else {
      showMsg("ok", `✅ Registrado: ${data.factura}-${data.bulto} — ${data.cliente || ""}`.trim());
    }

    await refreshUI();
  } catch (e) {
    showMsg("bad", `❌ ${e.message || e}`);
  } finally {
    setTimeout(() => { busy = false; }, 650);
  }
}

async function startScanner() {
  if (typeof Html5Qrcode === "undefined") {
    showMsg("bad", "Falta libs/html5-qrcode.min.js. Copialo a la carpeta libs/");
    return;
  }
  if (!html5Qr) html5Qr = new Html5Qrcode("reader");

  const config = { fps: 10, qrbox: { width: 260, height: 260 } };

  try {
    await html5Qr.start(
      { facingMode: "environment" },
      config,
      onScanSuccess,
      () => {}
    );
    showMsg("ok", "📷 Cámara iniciada");
  } catch (e) {
    showMsg("bad", `❌ No pude iniciar cámara: ${e.message || e}`);
  }
}

async function stopScanner() {
  if (html5Qr && html5Qr.isScanning) {
    await html5Qr.stop();
    showMsg("ok", "🛑 Cámara detenida");
  }
}

// ===== Export Excel =====
function buildWorkbookForDay(rows, day) {
  rows.sort((a,b)=>a.ts-b.ts);

  const detalle = rows.map(r => ({
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
    "ID Caja (día)": r.id_caja_day || "",
    "ID Scan": r.id_scan || ""
  }));

  const wb = XLSX.utils.book_new();
  const wsDetalle = XLSX.utils.json_to_sheet(detalle);
  wsDetalle["!cols"] = [
    { wch: 20 }, { wch: 26 }, { wch: 26 }, { wch: 18 }, { wch: 14 },
    { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 },
    { wch: 12 }, { wch: 20 }, { wch: 18 }
  ];
  XLSX.utils.book_append_sheet(wb, wsDetalle, "Detalle");

  const resumen = {};
  const clienteKey = (c) => (c || "SIN CLIENTE").trim().replace(/\s+/g," ").toUpperCase();

  for (const r of rows) {
    const ck = clienteKey(r.cliente);
    if (!resumen[ck]) resumen[ck] = { Cliente: ck, Facturas: new Set(), Escaneadas: 0, Esperadas: 0 };
    resumen[ck].Escaneadas += 1;
    if (r.factura) resumen[ck].Facturas.add(String(r.factura).trim().toUpperCase());
  }

  const seen = new Set(); // cliente|fac
  for (const r of rows) {
    const ck = clienteKey(r.cliente);
    const fac = String(r.factura || "").trim().toUpperCase();
    if (!fac) continue;
    const k = `${ck}|${fac}`;
    if (seen.has(k)) continue;
    seen.add(k);
    resumen[ck].Esperadas += Number(r.total_bultos || 0);
  }

  const resumenRows = Object.values(resumen)
    .map(x => ({
      "Cliente": x.Cliente,
      "Pedidos (Facturas)": x.Facturas.size,
      "Cajas Escaneadas": x.Escaneadas,
      "Cajas Esperadas": x.Esperadas
    }))
    .sort((a,b)=>a.Cliente.localeCompare(b.Cliente, "es", { sensitivity: "base" }));

  const wsResumen = XLSX.utils.json_to_sheet(resumenRows);
  wsResumen["!cols"] = [{ wch: 34 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen_por_Cliente");

  return wb;
}

async function exportExcel() {
  if (isPWA()) {
    showMsg("warn", "📌 En la app instalada Android suele bloquear exportar. Tocá 'Abrir en navegador (exportar)'.");
    const btn = $("btnOpenBrowser");
    if (btn) btn.style.display = "inline-block";
    return;
  }

  if (typeof XLSX === "undefined") {
    showMsg("bad", "Falta libs/xlsx.full.min.js. Copialo a la carpeta libs/");
    return;
  }

  const day = todayKey();
  const rows = await getAllForDay(day);

  if (!rows.length) {
    showMsg("warn", "No hay registros para exportar.");
    return;
  }

  const wb = buildWorkbookForDay(rows, day);
  const filename = `resumen_clientes_${day}.xlsx`;

  try {
    const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showMsg("ok", `📊 Exportado: ${filename}`);
  } catch (e) {
    showMsg("bad", `❌ No se pudo exportar: ${e.message || e}`);
  }
}

async function shareExcel() {
  if (isPWA()) {
    showMsg("warn", "📌 Compartir archivos suele fallar en la app instalada. Abrilo en navegador para exportar y compartir.");
    const btn = $("btnOpenBrowser");
    if (btn) btn.style.display = "inline-block";
    return;
  }
  if (typeof XLSX === "undefined") {
    showMsg("bad", "Falta libs/xlsx.full.min.js. Copialo a la carpeta libs/");
    return;
  }

  const day = todayKey();
  const rows = await getAllForDay(day);

  if (!rows.length) {
    showMsg("warn", "No hay registros para compartir.");
    return;
  }

  const wb = buildWorkbookForDay(rows, day);
  const filename = `resumen_clientes_${day}.xlsx`;

  try {
    const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const file = new File([blob], filename, { type: blob.type });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: "Resumen del día",
        text: "Excel con detalle + resumen por cliente",
        files: [file]
      });
      showMsg("ok", "📤 Compartido.");
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showMsg("ok", "📥 Descargado (tu dispositivo no soporta compartir directo).");
    }
  } catch (e) {
    showMsg("bad", `❌ No se pudo compartir: ${e.message || e}`);
  }
}

// ===== Jornada / borrar =====
async function resetDay() {
  if (!confirm("¿Nueva jornada? (Hoy se agrupa por fecha. Esto NO borra otros días). ¿Continuar?")) return;
  showMsg("ok", "Nueva jornada lista (escaneá normalmente).");
  await refreshUI();
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
  const btn = $("btnInstall");
  if (btn) btn.style.display = "inline-block";
});

// ===== Bind (cuando el DOM está listo) =====
document.addEventListener("DOMContentLoaded", () => {
  $("btnInstall")?.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("btnInstall").style.display = "none";
  });

  $("btnStart")?.addEventListener("click", startScanner);
  $("btnStop")?.addEventListener("click", stopScanner);
  $("btnExport")?.addEventListener("click", exportExcel);
  $("btnShare")?.addEventListener("click", shareExcel);
  $("btnClearAll")?.addEventListener("click", wipeAll);
  $("btnResetDay")?.addEventListener("click", resetDay);
  $("btnOpenBrowser")?.addEventListener("click", openInBrowser);

  // UI según modo
  if (isPWA()) {
    if ($("btnOpenBrowser")) $("btnOpenBrowser").style.display = "inline-block";
    if ($("btnShare")) $("btnShare").style.display = "none";
  } else {
    if ($("btnOpenBrowser")) $("btnOpenBrowser").style.display = "none";
    if ($("btnShare")) $("btnShare").style.display = "inline-block";
  }

  refreshUI();
});
