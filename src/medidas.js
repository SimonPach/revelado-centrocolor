const sharp = require('sharp');
const { bajarBuffer, subirBuffer } = require('./r2');

// 1 mm @ 300 DPI
const MM = 11.811;

// Medidas fisicas reales del papel (datos del programa de impresion).
// [ancho_mm, largo_mm] = [Paper Width, Paper Length]
const MEDIDAS = {
  'Polaroid': { w: 152, h: 102, polaroid: true },
  '10x15':    { w: 152, h: 102 },
  '13x18':    { w: 127, h: 180 },
  '15x21':    { w: 152, h: 210 },
  '20x25':    { w: 203, h: 254 },
  '20x30':    { w: 203, h: 305 },
  '25x38':    { w: 254, h: 378 },
};

const BORDE_MM = 4; // marco blanco parejo opcional
// Bordes Polaroid (mm): pie grande abajo
const POLA = { top: 6, bottom: 25, left: 6, right: 6 };

// px del lado, redondeado
const px = mm => Math.round(mm * MM);

// Decide orientacion del lienzo segun la foto + override manual.
// Devuelve {W,H} en px del papel final.
async function lienzoParaFoto(medida, meta, rotar) {
  const m = MEDIDAS[medida];
  if (!m) throw new Error('Medida desconocida: ' + medida);
  const corto = Math.min(m.w, m.h), largo = Math.max(m.w, m.h);
  let fotoVertical = meta.height > meta.width;
  if (rotar) fotoVertical = !fotoVertical;
  // vertical -> papel parado (ancho=corto, alto=largo)
  const Wmm = fotoVertical ? corto : largo;
  const Hmm = fotoVertical ? largo : corto;
  return { W: px(Wmm), H: px(Hmm), polaroid: !!m.polaroid, fotoVertical };
}

// Coloca una foto en un recuadro (cover con posicion, o contain con blanco).
async function fotoEnRecuadro(buffer, anchoDest, altoDest, encuadre, p = 0.5, q = 0.5) {
  let img = sharp(buffer, { failOn: 'none' }).rotate(); // EXIF

  if (encuadre === 'completa') {
    return img
      .resize(anchoDest, altoDest, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .toBuffer();
  }
  // llenar: cover con recorte segun p,q
  const meta = await img.metadata();
  const esc = Math.max(anchoDest / meta.width, altoDest / meta.height);
  const eW = Math.round(meta.width * esc), eH = Math.round(meta.height * esc);
  const left = Math.round((eW - anchoDest) * Math.min(1, Math.max(0, p)));
  const top = Math.round((eH - altoDest) * Math.min(1, Math.max(0, q)));
  return img.resize(eW, eH).extract({ left, top, width: anchoDest, height: altoDest }).toBuffer();
}

// Compone una foto normal lista para imprimir.
// item = { url_r2, medida, encuadre, borde, rotar, px, py }
// Devuelve Buffer JPEG @300dpi al tamaño fisico del papel.
async function componerFoto(item) {
  const buf = await bajarBuffer(item.url_r2);
  const meta = await sharp(buf, { failOn: 'none' }).rotate().metadata();
  const L = await lienzoParaFoto(item.medida, meta, item.rotar);

  // Polaroid: area de imagen respeta los bordes especiales
  if (L.polaroid) {
    const padT = px(POLA.top), padB = px(POLA.bottom), padL = px(POLA.left), padR = px(POLA.right);
    const areaW = L.W - padL - padR;
    const areaH = L.H - padT - padB;
    const foto = await fotoEnRecuadro(buf, areaW, areaH, item.encuadre, item.px, item.py);
    return sharp({ create: { width: L.W, height: L.H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: foto, left: padL, top: padT }])
      .jpeg({ quality: 95 }).withMetadata({ density: 300 }).toBuffer();
  }

  // Medida normal, con o sin borde blanco de 4mm
  const pad = item.borde ? px(BORDE_MM) : 0;
  const areaW = L.W - pad * 2;
  const areaH = L.H - pad * 2;
  const foto = await fotoEnRecuadro(buf, areaW, areaH, item.encuadre, item.px, item.py);

  if (pad === 0) {
    return sharp(foto).jpeg({ quality: 95 }).withMetadata({ density: 300 }).toBuffer();
  }
  return sharp({ create: { width: L.W, height: L.H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: foto, left: pad, top: pad }])
    .jpeg({ quality: 95 }).withMetadata({ density: 300 }).toBuffer();
}

// Compone y sube a R2. Devuelve la key del archivo listo para imprimir.
async function componerYSubirFoto(pedidoId, itemId, item) {
  const buffer = await componerFoto(item);
  const safe = (item.medida || 'foto').replace(/[^\w]/g, '');
  const key = `pedidos/${pedidoId}/listas/${safe}-${itemId}.jpg`;
  await subirBuffer(key, buffer, 'image/jpeg');
  return key;
}

module.exports = { MEDIDAS, componerFoto, componerYSubirFoto, lienzoParaFoto, px, MM };
