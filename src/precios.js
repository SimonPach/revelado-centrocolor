const pool = require('./db');

// Devuelve { tramo1_hasta, tramo2_hasta }
async function getTramos() {
  const [rows] = await pool.query(
    'SELECT tramo1_hasta, tramo2_hasta FROM rev_config WHERE id = 1'
  );
  return rows[0] || { tramo1_hasta: 9, tramo2_hasta: 49 };
}

// Mapa medida -> fila de precios
async function getPreciosMap() {
  const [rows] = await pool.query('SELECT * FROM rev_precios WHERE activo = 1');
  const map = {};
  for (const r of rows) map[r.medida] = r;
  return map;
}

// Elige el precio unitario segun la cantidad total de esa medida
function precioUnitario(fila, cantidad, tramos) {
  if (cantidad <= tramos.tramo1_hasta) return fila.precio_t1;
  if (cantidad <= tramos.tramo2_hasta) return fila.precio_t2;
  return fila.precio_t3;
}

// Calcula el total del pedido a partir de items normales + hojas 7x10.
// items: [{ medida, iman, copias }]
// hojas: [{ iman, copias }]  (cada hoja es una unidad de 7x10)
// Devuelve { total, detalle }
async function calcularTotal(items = [], hojas = []) {
  const tramos = await getTramos();
  const precios = await getPreciosMap();

  // 1) Acumular cantidades por medida para decidir el tramo
  const cantPorMedida = {};
  for (const it of items) {
    cantPorMedida[it.medida] = (cantPorMedida[it.medida] || 0) + Number(it.copias || 0);
  }
  // Las hojas 7x10 cuentan como cantidad de la medida "7x10"
  const cantHojas = hojas.reduce((a, h) => a + Number(h.copias || 0), 0);
  if (cantHojas > 0) cantPorMedida['7x10'] = (cantPorMedida['7x10'] || 0) + cantHojas;

  let total = 0;
  const detalle = [];

  // 2) Items normales
  for (const it of items) {
    const fila = precios[it.medida];
    if (!fila) continue;
    const unit = precioUnitario(fila, cantPorMedida[it.medida], tramos);
    const copias = Number(it.copias || 0);
    const sub = unit * copias;
    const subIman = it.iman ? fila.recargo_iman * copias : 0;
    total += sub + subIman;
    detalle.push({ medida: it.medida, copias, unit, iman: !!it.iman, subtotal: sub + subIman });
  }

  // 3) Hojas 7x10 (se cobran por hoja)
  const fila710 = precios['7x10'];
  if (fila710) {
    const unit = precioUnitario(fila710, cantPorMedida['7x10'] || cantHojas, tramos);
    for (const h of hojas) {
      const copias = Number(h.copias || 0);
      const sub = unit * copias;
      const subIman = h.iman ? fila710.recargo_iman * copias : 0;
      total += sub + subIman;
      detalle.push({ medida: '7x10 (hoja)', copias, unit, iman: !!h.iman, subtotal: sub + subIman });
    }
  }

  return { total, detalle };
}

module.exports = { getTramos, getPreciosMap, precioUnitario, calcularTotal };
