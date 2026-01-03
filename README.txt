# Contador de Cajas (QR) - PWA Offline

## Importante: Librerías offline
Este proyecto necesita estas 2 librerías en `libs/` para funcionar OFFLINE:
- `libs/html5-qrcode.min.js`
- `libs/xlsx.full.min.js`

Si ya las tenías en tu repo anterior, copiá esos archivos a esta carpeta `libs/`.

## Archivos
- `scanner.html` (PWA / cámara / export + compartir Excel)
- `app.js` (lógica)
- `etiquetas.html` (genera QR con DI/LO/PR)
- `service-worker.js` (cache offline)
