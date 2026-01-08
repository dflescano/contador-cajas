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
        const st = db.createObjectStore(STORE, { keyPath: "id_caja" }); // factura-bulto
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
  el.style.display = "block";
  el.className = type === "ok" ? "ok" : type === "warn" ? "warn" : "bad";
  el.textContent = text;
  setTimeout(() => { el.style.display = "none"; }, 3500);
}

// ===== QR Parser =====
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

  // 2) Formato clave=valor (etiquetas.html)
  // OC=...|FAC=...|B=...|T=...|CL=...|DI=...|LO=...|PR=...|TR=...
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
    const bulto   = (obj["B"] || "").trim();
    if (!factura || !bulto) throw new Error("QR inválido: falta FAC o B");

    return {
      cliente: (obj["CL"] || "").trim(),
      direccion: (obj["DI"] || "").trim(),
      localidad: (obj["LO"] || "").trim(),
      provincia: (obj["PR"] || "").trim(),
      orden: (obj["OC"] || "").trim(),
      factura,
      bulto: Number(bulto),
      total_bultos: Number((obj["T"] || "0").trim() || 0),
      transporte: (obj["TR"] || "").trim()
    };
  }

  throw new Error("QR inválido: formato no reconocido");
}

// ===== Estado por Factura =====
function buildFacturaStatus(rows) {
  const by = {};
  for (const r of rows) {
    const fac = (r.factura || "").trim();
    if (!fac) continue;
    if (!by[fac]) by[fac] = { factura: fac, total: 0, set: new Set(), cliente: r.cliente || "" };
    by[fac].set.add(Number(r.bulto));
    if ((r.total_bultos || 0) > (by[fac].total || 0)) by[fac].total = r.total_bultos || 0;
    if (!by[fac].cliente && r.cliente) by[fac].cliente = r.cliente;
  }

  const list = Object.values(by).map(x => {
    const scanned = x.set.size;
    const total = x.total || 0;
    const complete = total > 0 ? scanned >= total : false;
    return { ...x, scanned, complete };
  });

  list.sort((a,b)=>a.factura.localeCompare(b.factura, "es", { sensitivity:"base" }));
  return list;
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
      <td>${escapeHtml(r.factura || "")}</td>
      <td>${r.bulto ?? ""}</td>
      <td>${escapeHtml(r.direccion || "")}</td>
    </tr>
  `).join("");

  // estado por factura + indicador
  const status = buildFacturaStatus(rows);
  $("byFactura").innerHTML = status.length ? status.map(s => {
    const totalTxt = s.total ? s.total : "?";
    const icon = s.complete ? "✅" : "⚠️";
    const color = s.complete ? "#166534" : "#854d0e";
    const label = s.complete ? "COMPLETO" : "INCOMPLETO";
    return `• ${icon} Factura <b>${escapeHtml(s.factura)}</b> (${escapeHtml(s.cliente||"")})
      — <b>${s.scanned}</b> / <b>${escapeHtml(String(totalTxt))}</b>
      <span style="color:${color};font-weight:800;">${label}</span>`;
  }).join("<br>") : "-";
}

async function onScanSuccess(decodedText) {
  if (busy) return;
  const text = decodedText.trim();
  if (text === lastText) return;

  busy = true;
  lastText = text;

  try {
    const data = parseQR(text);

    const id_caja = `${data.factura}-${data.bulto}`.toLowerCase();
    const day = todayKey();
    const iso = nowISO();
    const ts = Date.now();

    const operador = ($("who").value || "").trim();

    const scan = { id_caja, day, iso, ts, operador, ...data };

    const rows = await getAllToday(day);
    const exists = rows.some(r => r.id_caja === id_caja);

    await putScan(scan);

    if (exists) showMsg("warn", `⚠️ Repetido: ${data.factura}-${data.bulto} (no suma)`);
    else showMsg("ok", `✅ Registrado: ${data.factura}-${data.bulto} — ${data.cliente || ""}`.trim());

    await refreshUI();
  } catch (e) {
    showMsg("bad", `❌ ${e.message || e}`);
  } finally {
    setTimeout(() => { busy = false; }, 700);
  }
}

async function startScanner() {
  if (typeof Html5Qrcode === "undefined") {
    showMsg("bad", "Falta libs/html5-qrcode.min.js");
    return;
  }
  if (!html5Qr) html5Qr = new Html5Qrcode("reader");
  const config = { fps: 10, qrbox: { width: 260, height: 260 } };

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

// ===== Excel (blob + share) =====
function buildWorkbookForDay(rows, day) {
  rows.sort((a,b)=>a.ts-b.ts);

  // Detalle
  const detalle = rows.map(r => ({
    "Fecha": new Date(r.iso).toLocaleString("es-AR"),
    "Cliente": r.cliente || "",
    "Dirección": r.direccion || "",
    "Localidad": r.localidad || "",
    "Provincia": r.provincia || "",
    "Orden": r.orden || "",
    "Factura": r.factura || "",
    "Bulto N°": r.bulto ?? "",
    "Total Bultos": r.total_bultos ?? "",
    "Transporte": r.transporte || "",
    "Operador": r.operador || "",
    "ID Caja": r.id_caja
  }));

  const wb = XLSX.utils.book_new();
  const wsDetalle = XLSX.utils.json_to_sheet(detalle);
  wsDetalle["!cols"] = [
    { wch: 20 }, { wch: 26 }, { wch: 24 }, { wch: 16 }, { wch: 14 },
    { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 },
    { wch: 12 }, { wch: 16 }
  ];
  XLSX.utils.book_append_sheet(wb, wsDetalle, "Detalle");

  // Resumen por Factura (con completo/incompleto)
  const status = buildFacturaStatus(rows).map(s => ({
    "Factura": s.factura,
    "Cliente": s.cliente || "",
    "Escaneadas": s.scanned,
    "Esperadas": s.total || "",
    "Estado": (s.total && s.scanned >= s.total) ? "COMPLETO" : "INCOMPLETO"
  }));
  const wsFac = XLSX.utils.json_to_sheet(status);
  wsFac["!cols"] = [{ wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsFac, "Resumen_por_Factura");

  // Resumen por Cliente
  const resumen = {};
  const clienteKey = (c) => (c || "SIN CLIENTE").trim().replace(/\s+/g," ").toUpperCase();

  for (const r of rows) {
    const ck = clienteKey(r.cliente);
    if (!resumen[ck]) resumen[ck] = { Cliente: ck, Facturas: new Set(), Escaneadas: 0, Esperadas: 0 };
    resumen[ck].Escaneadas += 1;
    if (r.factura) resumen[ck].Facturas.add(String(r.factura).trim().toUpperCase());
  }
  const seen = new Set(); // ck|fac
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
    .sort((a,b)=>a.Cliente.localeCompare(b.Cliente, "es", { sensitivity:"base" }));

  const wsCli = XLSX.utils.json_to_sheet(resumenRows);
  wsCli["!cols"] = [{ wch: 30 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsCli, "Resumen_por_Cliente");

  return wb;
}

async function exportExcelBlob() {
  if (typeof XLSX === "undefined") throw new Error("No se cargó XLSX");
  const day = todayKey();
  const rows = await getAllToday(day);
  if (!rows.length) throw new Error("No hay registros para exportar.");

  const wb = buildWorkbookForDay(rows, day);
  const filename = `resumen_${day}.xlsx`;

  const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return { blob, filename, rows };
}

async function exportExcel() {
  try {
    const { blob, filename } = await exportExcelBlob();

    // Descarga (fallback)
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showMsg("ok", `📥 Excel descargado: ${filename}`);
  } catch (e) {
    showMsg("bad", `❌ ${e.message || e}`);
  }
}

async function sendWhatsApp() {
  try {
    const { blob, filename, rows } = await exportExcelBlob();

    const day = todayKey();
    const status = buildFacturaStatus(rows);
    const completos = status.filter(s => s.complete).length;
    const incompletos = status.filter(s => !s.complete).length;

    const text =
      `Resumen ${day}
` +
      `Cajas: ${rows.length}
` +
      `Facturas: ${status.length}
` +
      `Completas: ${completos}
` +
      `Incompletas: ${incompletos}
` +
      `
` +
      `📎 IMPORTANTE: En el celular WhatsApp normalmente NO permite adjuntar archivos de forma automática desde una web/PWA.
` +
      `1) Descargá el Excel
` +
      `2) Se abrirá WhatsApp con el mensaje
` +
      `3) Adjuntá el archivo manualmente (📎).`;

    // 1) Intento "compartir" nativo (solo si el dispositivo lo soporta bien)
    // En muchos móviles/PWA esto falla con Permission denied / NotAllowedError.
    const file = new File([blob], filename, { type: blob.type });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: `Resumen ${day}`,
          text,
          files: [file]
        });
        showMsg("ok", "📤 Se abrió el share del sistema. Si WhatsApp no adjunta, descargá y adjuntá manualmente.");
        return;
      } catch (err) {
        // Caídas típicas: NotAllowedError / SecurityError / "Permission denied"
        console.warn("navigator.share falló:", err);
      }
    }

    // 2) Fallback robusto para móvil:
    // - Descarga el archivo
    // - Abre WhatsApp con el texto
    // - El usuario adjunta manualmente (esto NO falla)
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showMsg("ok", `📥 Excel descargado: ${filename}`);
    } catch (e) {
      // Si por alguna razón no puede descargar (iOS PWA a veces), mostramos ayuda
      showMsg("warn", "No pude descargar automáticamente. Probá 'Abrir en navegador (exportar)'.");
    }

    const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(wa, "_blank");
    showMsg("warn", "WhatsApp se abrió con el mensaje. Ahora adjuntá el Excel manualmente (📎).");
  } catch (e) {
    showMsg("bad", `❌ ${e.message || e}`);
  }
}


// ===== PDF del día (sin librerías) =====
// Genera un reporte HTML y abre impresión (Guardar como PDF funciona offline)
async function pdfDelDia() {
  try {
    const day = todayKey();
    const rows = await getAllToday(day);
    if (!rows.length) {
      showMsg("warn", "No hay registros para PDF.");
      return;
    }

    const status = buildFacturaStatus(rows);

    const html = `
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Resumen ${day}</title>
<style>
  body{font-family:Arial,system-ui;margin:18px;color:#111}
  h1{font-size:18px;margin:0 0 10px}
  .meta{font-size:12px;margin-bottom:14px;opacity:.85}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{border:1px solid #ddd;padding:6px;text-align:left}
  th{background:#f3f4f6}
  .ok{color:#166534;font-weight:700}
  .bad{color:#991b1b;font-weight:700}
</style>
</head>
<body>
  <h1>Resumen del día - ${day}</h1>
  <div class="meta">
    Cajas: <b>${rows.length}</b> — Facturas: <b>${status.length}</b>
  </div>

  <h2 style="font-size:14px;margin:16px 0 8px;">Estado por Factura</h2>
  <table>
    <thead><tr>
      <th>Factura</th><th>Cliente</th><th>Escaneadas</th><th>Esperadas</th><th>Estado</th>
    </tr></thead>
    <tbody>
      ${status.map(s=>{
        const est = (s.total && s.scanned >= s.total) ? "COMPLETO" : "INCOMPLETO";
        const cls = (est==="COMPLETO") ? "ok" : "bad";
        return `<tr>
          <td>${escapeHtml(s.factura)}</td>
          <td>${escapeHtml(s.cliente||"")}</td>
          <td>${s.scanned}</td>
          <td>${s.total || ""}</td>
          <td class="${cls}">${est}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>

  <h2 style="font-size:14px;margin:16px 0 8px;">Detalle (últimos 60)</h2>
  <table>
    <thead><tr>
      <th>Hora</th><th>Cliente</th><th>Factura</th><th>Bulto</th><th>Dirección</th><th>Localidad</th><th>Provincia</th>
    </tr></thead>
    <tbody>
      ${rows.slice().sort((a,b)=>b.ts-a.ts).slice(0,60).map(r=>`
        <tr>
          <td>${timeHM(r.iso)}</td>
          <td>${escapeHtml(r.cliente||"")}</td>
          <td>${escapeHtml(r.factura||"")}</td>
          <td>${r.bulto ?? ""}</td>
          <td>${escapeHtml(r.direccion||"")}</td>
          <td>${escapeHtml(r.localidad||"")}</td>
          <td>${escapeHtml(r.provincia||"")}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>

  <script>window.onload=()=>setTimeout(()=>window.print(), 250);</script>
</body>
</html>`;

    const w = window.open("", "_blank");
    w.document.open();
    w.document.write(html);
    w.document.close();

    showMsg("ok", "🧾 Abrió el PDF (Imprimir → Guardar como PDF)");
  } catch (e) {
    showMsg("bad", `❌ ${e.message || e}`);
  }
}

// ===== Jornada / borrar =====
async function resetDay() {
  if (!confirm("¿Nueva jornada? No borra días anteriores (se guardan por fecha). ¿Continuar?")) return;
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

const btnWhats = document.getElementById("btnWhats");
if (btnWhats) btnWhats.addEventListener("click", sendWhatsApp);

const btnPdf = document.getElementById("btnPdf");
if (btnPdf) btnPdf.addEventListener("click", pdfDelDia);

$("btnClearAll").addEventListener("click", wipeAll);
$("btnResetDay").addEventListener("click", resetDay);

// init
refreshUI();
