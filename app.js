// Simplified app.js with full QR parsing
function parseQR(text){
  const obj = {};
  text.split("|").forEach(p=>{
    const i=p.indexOf("=");
    if(i>-1) obj[p.slice(0,i)] = p.slice(i+1);
  });
  return {
    cliente: obj.CL || "",
    direccion: obj.DI || "",
    localidad: obj.LO || "",
    provincia: obj.PR || "",
    orden: obj.OC || "",
    factura: obj.FAC || "",
    bulto: Number(obj.B||0),
    total_bultos: Number(obj.T||0),
    transporte: obj.TR || ""
  };
}
