// ===== Export Excel (Detalle + Resumen por Cliente DEL DÍA) =====
async function exportExcel() {
  const day = todayKey();
  const rows = await getAllToday(day);

  if (!rows.length) {
    showMsg("warn", "No hay registros para exportar.");
    return;
  }

  // Orden por fecha
  rows.sort((a,b)=>a.ts-b.ts);

  // =========================
  // HOJA 1: DETALLE
  // =========================
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
    "ID Caja": r.id_caja
  }));

  const wb = XLSX.utils.book_new();

  const wsDetalle = XLSX.utils.json_to_sheet(detalle);
  wsDetalle["!cols"] = [
    { wch: 20 }, { wch: 26 }, { wch: 22 }, { wch: 16 }, { wch: 14 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 },
    { wch: 12 }, { wch: 16 }
  ];
  XLSX.utils.book_append_sheet(wb, wsDetalle, "Detalle");

  // =========================
  // HOJA 2: RESUMEN POR CLIENTE (DEL DÍA)
  // - Pedidos = Facturas únicas
  // - Escaneadas = cantidad de cajas escaneadas
  // - Esperadas = suma de total_bultos por cada factura única
  // =========================
  const resumen = {}; // cliente -> { Facturas:Set, Escaneadas, Esperadas }

  const clienteKey = (c) => (c || "SIN CLIENTE").trim().toUpperCase();

  // 1) escaneadas + set de facturas
  for (const r of rows) {
    const ck = clienteKey(r.cliente);
    if (!resumen[ck]) {
      resumen[ck] = { Cliente: ck, Facturas: new Set(), Escaneadas: 0, Esperadas: 0 };
    }
    resumen[ck].Escaneadas += 1;
    if (r.factura) resumen[ck].Facturas.add(String(r.factura).trim().toUpperCase());
  }

  // 2) esperadas: sumar total_bultos UNA VEZ por factura (por cliente)
  const seenClienteFactura = new Set(); // `${cliente}|${factura}`
  for (const r of rows) {
    const ck = clienteKey(r.cliente);
    const fac = String(r.factura || "").trim().toUpperCase();
    if (!fac) continue;

    const key = `${ck}|${fac}`;
    if (seenClienteFactura.has(key)) continue;
    seenClienteFactura.add(key);

    resumen[ck].Esperadas += Number(r.total_bultos || 0);
  }

  // 3) a filas
  const resumenRows = Object.values(resumen)
    .map(x => ({
      "Cliente": x.Cliente,
      "Pedidos (Facturas)": x.Facturas.size,
      "Cajas Escaneadas": x.Escaneadas,
      "Cajas Esperadas": x.Esperadas
    }))
    .sort((a,b)=>a.Cliente.localeCompare(b.Cliente, "es", { sensitivity: "base" }));

  const wsResumen = XLSX.utils.json_to_sheet(resumenRows);
  wsResumen["!cols"] = [{ wch: 30 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen_por_Cliente");

  // =========================
  // EXPORT
  // =========================
  const filename = `resumen_clientes_${day}.xlsx`;
  XLSX.writeFile(wb, filename);

  showMsg("ok", `📊 Resumen del día exportado: ${filename}`);
}
