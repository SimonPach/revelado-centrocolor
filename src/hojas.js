const sharp = require('sharp');
const { bajarBuffer, subirBuffer } = require('./r2');

// Medidas fisicas reales del papel 10x15 (datos del programa: W152 x L102 mm).
// A 300 DPI: 152mm=1795px (lado largo), 102mm=1205px (lado corto).
// 1 mm @300dpi = 11.811 px
const MM = 11.811;
const HOJA_LARGO = Math.round(152 * MM); // 1795
const HOJA_CORTO = Math.round(102 * MM); // 1205
const BORDE_MM = 4; // marco blanco decorativo opcional

// Procesa una foto para que llene un recuadro destino (ancho x alto en px).
// encuadre 'llenar' = cover (recorta sobrante, respeta posicion px/py) ; 'completa' = contain (margenes blancos)
// px,py = posicion del encuadre 0..1 (0.5 = centrado) cuando es 'llenar'
// rotada = girar 90 grados antes
async function fotoEnRecuadro(buffer, anchoDest, altoDest, encuadre, px = 0.5, py = 0.5, rotada = false) {
  let img = sharp(buffer, { failOn: 'none' }).rotate(); // respeta orientacion EXIF
  if (rotada) img = img.rotate(90);

  if (encuadre === 'completa') {
    // foto entera con margenes blancos
    return img
      .resize(anchoDest, altoDest, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255 },
      })
      .toBuffer();
  }

  // 'llenar': cover con recorte segun posicion px/py
  const meta = await img.metadata();
  // metadata() da las medidas del archivo SIN girar: si la foto va rotada,
  // el ancho/alto efectivos quedan intercambiados.
  let natW = meta.width, natH = meta.height;
  if (rotada) { const t = natW; natW = natH; natH = t; }
  const escala = Math.max(anchoDest / natW, altoDest / natH);
  const escW = Math.round(natW * escala);
  const escH = Math.round(natH * escala);

  // cuanto sobra para recortar en cada eje
  const sobraX = escW - anchoDest;
  const sobraY = escH - altoDest;
  const left = Math.round(sobraX * Math.min(1, Math.max(0, px)));
  const top = Math.round(sobraY * Math.min(1, Math.max(0, py)));

  return img
    .resize(escW, escH)
    .extract({ left, top, width: anchoDest, height: altoDest })
    .toBuffer();
}

// Compone una hoja 7x10.
// hoja = { orientacion: 'apaisada'|'vertical' }
// fotos = [{ url_r2, encuadre, rotada }, ...] (1 o 2)
// Devuelve un Buffer JPEG de la hoja completa 10x15 @300dpi.
async function componerHoja(hoja, fotos) {
  let lienzoW, lienzoH, recW, recH, posiciones;

  if (hoja.orientacion === 'apaisada') {
    // Hoja apaisada: lado largo horizontal. Dos mitades una arriba y otra abajo.
    lienzoW = HOJA_LARGO;
    lienzoH = HOJA_CORTO;
    recW = HOJA_LARGO;
    recH = Math.floor(HOJA_CORTO / 2);
    posiciones = [
      { left: 0, top: 0 },
      { left: 0, top: recH },
    ];
  } else {
    // Hoja vertical: lado largo vertical. Dos mitades lado a lado.
    lienzoW = HOJA_CORTO;
    lienzoH = HOJA_LARGO;
    recW = Math.floor(HOJA_CORTO / 2);
    recH = HOJA_LARGO;
    posiciones = [
      { left: 0, top: 0 },
      { left: recW, top: 0 },
    ];
  }

  const composites = [];
  for (let i = 0; i < Math.min(fotos.length, 2); i++) {
    const f = fotos[i];
    const buf = await bajarBuffer(f.url_r2);
    const procesada = await fotoEnRecuadro(
      buf, recW, recH, f.encuadre,
      f.px != null ? f.px : 0.5,
      f.py != null ? f.py : 0.5,
      f.rotada
    );
    composites.push({ input: procesada, left: posiciones[i].left, top: posiciones[i].top });
  }

  const lienzo = sharp({
    create: {
      width: lienzoW,
      height: lienzoH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  return lienzo
    .composite(composites)
    .jpeg({ quality: 95, density: 300 })
    .withMetadata({ density: 300 })
    .toBuffer();
}

// Compone y sube la hoja a R2. Devuelve la key de la hoja compuesta.
async function componerYSubir(pedidoId, hojaId, hoja, fotos) {
  const buffer = await componerHoja(hoja, fotos);
  const key = `pedidos/${pedidoId}/hojas/hoja-${hojaId}-${hoja.orientacion}.jpg`;
  await subirBuffer(key, buffer, 'image/jpeg');
  return key;
}

module.exports = { componerHoja, componerYSubir, HOJA_LARGO, HOJA_CORTO };
