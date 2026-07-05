const pool = require('./db');
const { calcularTotal } = require('./precios');
const { componerYSubir } = require('./hojas');
const { componerYSubirFoto } = require('./medidas');

// Genera el codigo NOMBRE - 0010 usando el correlativo de rev_config.
async function generarCodigo(conn, nombre) {
  const [rows] = await conn.query(
    'SELECT ultimo_correlativo FROM rev_config WHERE id = 1 FOR UPDATE'
  );
  const next = (rows[0]?.ultimo_correlativo || 0) + 1;
  await conn.query('UPDATE rev_config SET ultimo_correlativo = ? WHERE id = 1', [next]);

  const base = (nombre || 'CLIENTE')
    .trim()
    .split(/\s+/)[0]
    .toUpperCase()
    .replace(/[^A-ZÑ0-9]/g, '');
  const num = String(next).padStart(4, '0');
  return `${base} - ${num}`;
}

// Crea un pedido completo.
async function crearPedido(payload) {
  const items = payload.items || [];
  const hojas = payload.hojas || [];

  const { total } = await calcularTotal(
    items.map((i) => ({ medida: i.medida, iman: i.iman, copias: i.copias })),
    hojas.map((h) => ({ iman: h.iman, copias: h.copias }))
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const codigo = await generarCodigo(conn, payload.cliente_nombre);

    const [pedRes] = await conn.query(
      `INSERT INTO rev_pedidos (codigo, cliente_nombre, whatsapp, estado, total, nota)
       VALUES (?, ?, ?, 'nuevo', ?, ?)`,
      [codigo, payload.cliente_nombre || '', payload.whatsapp || null, total, payload.nota || null]
    );
    const pedidoId = pedRes.insertId;

    // items normales
    const itemsParaComponer = [];
    for (const it of items) {
      const [r] = await conn.query(
        `INSERT INTO rev_items
         (pedido_id, archivo, url_r2, medida, iman, copias, encuadre, borde, rotar, pos_x, pos_y, nota)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pedidoId, it.archivo || '', it.url_r2, it.medida, it.iman ? 1 : 0,
         it.copias || 1, it.encuadre || 'llenar', it.borde ? 1 : 0, it.rotar ? 1 : 0,
         it.px != null ? it.px : 0.5, it.py != null ? it.py : 0.5, it.nota || null]
      );
      itemsParaComponer.push({
        itemId: r.insertId, url_r2: it.url_r2, medida: it.medida,
        encuadre: it.encuadre || 'llenar', borde: !!it.borde, rotar: !!it.rotar,
        px: it.px != null ? it.px : 0.5, py: it.py != null ? it.py : 0.5,
      });
    }

    // hojas 7x10 + sus fotos
    const hojasParaComponer = [];
    for (const h of hojas) {
      const [hRes] = await conn.query(
        `INSERT INTO rev_hojas (pedido_id, orientacion, iman, copias) VALUES (?, ?, ?, ?)`,
        [pedidoId, h.orientacion || 'apaisada', h.iman ? 1 : 0, h.copias || 1]
      );
      const hojaId = hRes.insertId;
      const fotos = (h.fotos || []).slice(0, 2);
      for (let p = 0; p < fotos.length; p++) {
        const f = fotos[p];
        await conn.query(
          `INSERT INTO rev_hoja_fotos (hoja_id, posicion, archivo, url_r2, encuadre, rotada, pos_x, pos_y)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [hojaId, p + 1, f.archivo || '', f.url_r2, f.encuadre || 'llenar', f.rotada ? 1 : 0,
           f.px != null ? f.px : 0.5, f.py != null ? f.py : 0.5]
        );
      }
      hojasParaComponer.push({
        hojaId, orientacion: h.orientacion || 'apaisada',
        fotos: fotos.map((f) => ({
          url_r2: f.url_r2, encuadre: f.encuadre || 'llenar',
          rotada: !!f.rotada,
          px: f.px != null ? f.px : 0.5, py: f.py != null ? f.py : 0.5,
        })),
      });
    }

    await conn.commit();

    // Componer DENTRO del request (antes de responder), para que el pedido
    // llegue siempre con las fotos armadas. El cliente espera, pero nunca
    // queda un pedido a medias por reciclado del proceso en Hostinger.
    await componerPedido(pedidoId, itemsParaComponer, hojasParaComponer);

    return { id: pedidoId, codigo, total };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// Compone fotos normales + hojas 7x10. Corre DENTRO del request del pedido.
async function componerPedido(pedidoId, items, hojas) {
  let ok = 0, fallo = 0;
  for (const it of items) {
    try {
      const key = await componerYSubirFoto(pedidoId, it.itemId, it);
      await pool.query('UPDATE rev_items SET url_lista = ? WHERE id = ?', [key, it.itemId]);
      ok++;
    } catch (e) {
      fallo++;
      console.error(`[componer] FALLO foto item=${it.itemId} pedido=${pedidoId}:`, e.message);
    }
  }
  for (const h of hojas) {
    try {
      const key = await componerYSubir(pedidoId, h.hojaId, { orientacion: h.orientacion }, h.fotos);
      await pool.query('UPDATE rev_hojas SET url_compuesta = ? WHERE id = ?', [key, h.hojaId]);
      ok++;
    } catch (e) {
      fallo++;
      console.error(`[componer] FALLO hoja=${h.hojaId} pedido=${pedidoId}:`, e.message);
    }
  }
  console.log(`[componer] pedido=${pedidoId} listo: ${ok} ok, ${fallo} con error`);
  return { ok, fallo };
}

// Regenera la composición de un pedido ya existente (relee de la base y
// vuelve a componer todo). Útil si un pedido viejo quedó sin componer.
async function regenerarPedido(pedidoId) {
  const [items] = await pool.query(
    'SELECT id, url_r2, medida, encuadre, borde, rotar, pos_x, pos_y FROM rev_items WHERE pedido_id = ?',
    [pedidoId]
  );
  const itemsParaComponer = items.map((it) => ({
    itemId: it.id, url_r2: it.url_r2, medida: it.medida,
    encuadre: it.encuadre, borde: !!it.borde, rotar: !!it.rotar,
    px: Number(it.pos_x), py: Number(it.pos_y),
  }));

  const [hojas] = await pool.query(
    'SELECT id, orientacion FROM rev_hojas WHERE pedido_id = ?',
    [pedidoId]
  );
  const hojasParaComponer = [];
  for (const h of hojas) {
    const [hf] = await pool.query(
      'SELECT url_r2, encuadre, rotada, pos_x, pos_y FROM rev_hoja_fotos WHERE hoja_id = ? ORDER BY posicion',
      [h.id]
    );
    hojasParaComponer.push({
      hojaId: h.id, orientacion: h.orientacion,
      fotos: hf.map((f) => ({
        url_r2: f.url_r2, encuadre: f.encuadre,
        rotada: !!f.rotada,
        px: Number(f.pos_x), py: Number(f.pos_y),
      })),
    });
  }

  return componerPedido(pedidoId, itemsParaComponer, hojasParaComponer);
}

module.exports = { crearPedido, generarCodigo, componerPedido, regenerarPedido };
