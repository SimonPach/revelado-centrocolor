require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const archiver = require('archiver');

const pool = require('./src/db');
const { urlSubida, urlDescarga, bajarBuffer, borrarVarios } = require('./src/r2');
const { calcularTotal, getPreciosMap, getTramos } = require('./src/precios');
const { crearPedido, regenerarPedido } = require('./src/pedidos');
const { initAuth, login, requireAuth, requireAdmin,
  listarUsuarios, crearUsuario, actualizarUsuario, borrarUsuario } = require('./src/auth');

const app = express();
app.use(express.json({ limit: '2mb' }));

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

// ============================================================
// PUBLICO
// ============================================================

// Precios + tramos (para mostrar precio en vivo en la web)
app.get('/api/precios', async (req, res) => {
  try {
    const [precios] = await pool.query(
      'SELECT medida, es_hoja, orden, precio_t1, precio_t2, precio_t3, recargo_iman FROM rev_precios WHERE activo = 1 ORDER BY orden'
    );
    const tramos = await getTramos();
    res.json({ precios, tramos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al leer precios' });
  }
});

// Calcular total (preview en vivo, sin guardar)
app.post('/api/calcular', async (req, res) => {
  try {
    const { items = [], hojas = [] } = req.body || {};
    const r = await calcularTotal(items, hojas);
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al calcular' });
  }
});

// Pedir URL pre-firmada para subir una foto directo a R2
app.post('/api/subir-url', async (req, res) => {
  try {
    const { nombre, tipo, sesion } = req.body || {};
    if (!nombre || !tipo) return res.status(400).json({ error: 'Falta nombre o tipo' });
    // key temporal por sesion de carga; el cliente la reusara al confirmar
    const safe = String(nombre).replace(/[^\w.\-]/g, '_');
    const sid = String(sesion || Date.now()).replace(/[^\w\-]/g, '');
    const key = `tmp/${sid}/${Date.now()}-${safe}`;
    const url = await urlSubida(key, tipo);
    res.json({ url, key });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo generar la URL de subida' });
  }
});

// Confirmar pedido
app.post('/api/pedidos', async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.cliente_nombre) return res.status(400).json({ error: 'Falta el nombre' });
    if ((!p.items || !p.items.length) && (!p.hojas || !p.hojas.length))
      return res.status(400).json({ error: 'El pedido esta vacio' });
    const r = await crearPedido(p);
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo crear el pedido' });
  }
});

// Estado de un pedido por codigo (consulta del cliente)
app.get('/api/pedidos/:codigo/estado', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT codigo, estado, creado FROM rev_pedidos WHERE codigo = ?',
      [req.params.codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

// ============================================================
// ADMIN
// ============================================================

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const r = await login(username, password);
  if (!r) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  res.json(r);
});

// Contador de pedidos nuevos (para el aviso en la pestaña del navegador).
// Liviano: solo cuenta, lo consulta el panel cada 30s.
app.get('/api/admin/pedidos-nuevos', requireAuth, async (req, res) => {
  try {
    const [r] = await pool.query("SELECT COUNT(*) AS n FROM rev_pedidos WHERE estado = 'nuevo'");
    res.json({ nuevos: r[0].n });
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

// Lista de pedidos
app.get('/api/admin/pedidos', requireAuth, async (req, res) => {
  const estado = req.query.estado;
  const params = [];
  let sql = 'SELECT id, codigo, cliente_nombre, whatsapp, estado, fotos_estado, total, creado FROM rev_pedidos';
  if (estado) { sql += ' WHERE estado = ?'; params.push(estado); }
  sql += ' ORDER BY creado DESC LIMIT 200';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

// Detalle de un pedido (con URLs de descarga firmadas)
app.get('/api/admin/pedidos/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const [ped] = await pool.query('SELECT * FROM rev_pedidos WHERE id = ?', [id]);
  if (!ped.length) return res.status(404).json({ error: 'No encontrado' });

  const [items] = await pool.query('SELECT * FROM rev_items WHERE pedido_id = ?', [id]);
  const [hojas] = await pool.query('SELECT * FROM rev_hojas WHERE pedido_id = ?', [id]);
  for (const h of hojas) {
    const [hf] = await pool.query('SELECT * FROM rev_hoja_fotos WHERE hoja_id = ? ORDER BY posicion', [h.id]);
    h.fotos = hf;
    for (const f of hf) f.url = await urlDescarga(f.url_r2);
    h.url_compuesta_firmada = h.url_compuesta ? await urlDescarga(h.url_compuesta) : null;
  }
  for (const it of items) {
    it.url = await urlDescarga(it.url_r2);
    it.url_lista_firmada = it.url_lista ? await urlDescarga(it.url_lista) : null;
  }

  res.json({ pedido: ped[0], items, hojas });
});

// Cambiar estado
app.put('/api/admin/pedidos/:id/estado', requireAuth, async (req, res) => {
  const { estado } = req.body || {};
  const validos = ['nuevo', 'en_proceso', 'listo', 'entregado'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado invalido' });
  await pool.query('UPDATE rev_pedidos SET estado = ? WHERE id = ?', [estado, req.params.id]);
  res.json({ ok: true });
});

// Descargar el pedido como ZIP, organizado como el flujo del local:
//   CODIGO/ -> MEDIDA/ -> COPIAS/ -> foto compuesta.jpg
// Las hojas 7x10 (ya armadas como una 10x15 partida) van dentro de 10x15/.
// Solo fotos compuestas (listas para imprimir), nunca las originales.
// Acepta token por header o por query (?t=) porque es un link directo de descarga.
const ORDEN_MEDIDAS = ['Polaroid', '10x15', '13x18', '15x21', '20x25', '20x30', '25x38'];
function rankMedida(m) {
  const i = ORDEN_MEDIDAS.indexOf(m);
  return i === -1 ? 99 : i;
}
function safeNombre(s) {
  return String(s || '').replace(/[^\w.\- ]/g, '_').trim() || 'foto';
}

app.get('/api/admin/pedidos/:id/zip', (req, res, next) => {
  if (!req.headers.authorization && req.query.t) {
    req.headers.authorization = 'Bearer ' + req.query.t;
  }
  next();
}, requireAuth, async (req, res) => {
  const id = req.params.id;
  const [ped] = await pool.query('SELECT codigo, fotos_estado FROM rev_pedidos WHERE id = ?', [id]);
  if (!ped.length) return res.status(404).json({ error: 'No encontrado' });
  if (ped[0].fotos_estado === 'eliminadas') {
    return res.status(400).json({ error: 'Las fotos de este pedido fueron eliminadas' });
  }

  const [items] = await pool.query(
    'SELECT archivo, url_lista, medida, copias FROM rev_items WHERE pedido_id = ?', [id]
  );
  const [hojas] = await pool.query(
    'SELECT id, copias, url_compuesta FROM rev_hojas WHERE pedido_id = ?', [id]
  );

  // Unificar todo en una lista con {medida, copias, key, nombre}.
  // Las hojas 7x10 se mapean a la medida 10x15 (ya están armadas así).
  const archivos = [];
  for (const it of items) {
    if (!it.url_lista) continue; // sin componer: no va al ZIP
    archivos.push({
      medida: it.medida, copias: it.copias || 1,
      key: it.url_lista, nombre: safeNombre(it.archivo),
    });
  }
  for (const h of hojas) {
    if (!h.url_compuesta) continue;
    archivos.push({
      medida: '10x15', copias: h.copias || 1,
      key: h.url_compuesta, nombre: `hoja7x10-${h.id}.jpg`,
    });
  }

  if (!archivos.length) {
    return res.status(400).json({ error: 'El pedido todavía no tiene fotos compuestas. Usá "Regenerar fotos".' });
  }

  // Ordenar por medida (según ORDEN_MEDIDAS) y luego por copias
  archivos.sort((a, b) => rankMedida(a.medida) - rankMedida(b.medida) || a.copias - b.copias);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${ped[0].codigo.replace(/[^\w\-]/g, '_')}.zip"`);

  const zip = archiver('zip', { zlib: { level: 5 } });
  zip.on('error', (e) => { console.error(e); try { res.status(500).end(); } catch {} });
  zip.pipe(res);

  const raiz = ped[0].codigo.replace(/[\/\\]/g, '-'); // carpeta raíz = código web
  try {
    // contador por carpeta para no pisar nombres repetidos
    const usados = {};
    for (const a of archivos) {
      const ext = (a.nombre.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
      const base = a.nombre.replace(/\.[a-z0-9]+$/i, '');
      const carpeta = `${raiz}/${a.medida}/${a.copias}`;
      const llave = carpeta + '/' + base;
      usados[llave] = (usados[llave] || 0) + 1;
      const sufijo = usados[llave] > 1 ? `-${usados[llave]}` : '';
      const buf = await bajarBuffer(a.key);
      zip.append(buf, { name: `${carpeta}/${base}${sufijo}${ext}` });
    }
    await zip.finalize();
  } catch (e) {
    console.error('Error armando ZIP', e);
    try { res.status(500).end(); } catch {}
  }
});

// Precios (ver / editar)
app.get('/api/admin/precios', requireAuth, async (req, res) => {
  const [precios] = await pool.query('SELECT * FROM rev_precios ORDER BY orden');
  const tramos = await getTramos();
  res.json({ precios, tramos });
});

app.put('/api/admin/precios', requireAuth, requireAdmin, async (req, res) => {
  const { precios = [], tramos } = req.body || {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of precios) {
      await conn.query(
        `UPDATE rev_precios SET precio_t1=?, precio_t2=?, precio_t3=?, recargo_iman=? WHERE id=?`,
        [p.precio_t1, p.precio_t2, p.precio_t3, p.recargo_iman, p.id]
      );
    }
    if (tramos) {
      await conn.query(
        'UPDATE rev_config SET tramo1_hasta=?, tramo2_hasta=? WHERE id=1',
        [tramos.tramo1_hasta, tramos.tramo2_hasta]
      );
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar' });
  } finally {
    conn.release();
  }
});

// Borrar pedido (solo admin)
app.delete('/api/admin/pedidos/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM rev_pedidos WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo borrar' });
  }
});

// Regenerar la composición de un pedido (admin y empleado).
// Vuelve a armar las fotos listas para imprimir desde lo guardado.
app.post('/api/admin/pedidos/:id/regenerar', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const [ped] = await pool.query('SELECT fotos_estado FROM rev_pedidos WHERE id = ?', [id]);
    if (!ped.length) return res.status(404).json({ error: 'No encontrado' });
    if (ped[0].fotos_estado === 'eliminadas') {
      return res.status(400).json({ error: 'Las fotos de este pedido fueron eliminadas, no se pueden regenerar' });
    }
    const r = await regenerarPedido(id);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('Error regenerando pedido', id, e);
    res.status(500).json({ error: 'No se pudo regenerar' });
  }
});

// Limpiar fotos de un pedido (admin Y empleado).
// Borra de R2 las fotos (originales + compuestas) pero CONSERVA el registro del
// pedido, marcandolo fotos_estado='eliminadas'. Irreversible en R2.
app.post('/api/admin/pedidos/:id/limpiar', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const [ped] = await pool.query('SELECT id, fotos_estado FROM rev_pedidos WHERE id = ?', [id]);
    if (!ped.length) return res.status(404).json({ error: 'No encontrado' });
    if (ped[0].fotos_estado === 'eliminadas') {
      return res.status(400).json({ error: 'Las fotos de este pedido ya fueron eliminadas' });
    }

    // Recolectar todas las keys de R2 de este pedido
    const [items] = await pool.query('SELECT url_r2, url_lista FROM rev_items WHERE pedido_id = ?', [id]);
    const [hojas] = await pool.query('SELECT id, url_compuesta FROM rev_hojas WHERE pedido_id = ?', [id]);
    const keys = [];
    for (const it of items) { keys.push(it.url_r2, it.url_lista); }
    for (const h of hojas) {
      keys.push(h.url_compuesta);
      const [hf] = await pool.query('SELECT url_r2 FROM rev_hoja_fotos WHERE hoja_id = ?', [h.id]);
      for (const f of hf) keys.push(f.url_r2);
    }

    const borradas = await borrarVarios(keys);
    await pool.query("UPDATE rev_pedidos SET fotos_estado = 'eliminadas' WHERE id = ?", [id]);

    res.json({ ok: true, borradas });
  } catch (e) {
    console.error('Error limpiando fotos del pedido', id, e);
    res.status(500).json({ error: 'No se pudieron borrar las fotos' });
  }
});

// --- Gestion de usuarios (solo admin) ---
app.get('/api/admin/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await listarUsuarios()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await crearUsuario(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    // no permitir auto-quitarse el rol admin ni desactivarse
    if (Number(req.params.id) === req.usuario.id && req.body && (req.body.rol === 'empleado' || req.body.activo === false)) {
      return res.status(400).json({ error: 'No podés quitarte tus propios permisos' });
    }
    await actualizarUsuario(req.params.id, req.body || {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (Number(req.params.id) === req.usuario.id) {
      return res.status(400).json({ error: 'No podés borrarte a vos mismo' });
    }
    await borrarUsuario(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================================================
// Frontend estatico
// ============================================================
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;

initAuth()
  .then(() => {
    const server = app.listen(PORT, () => console.log(`Revelado API en puerto ${PORT}`));
    // Pedidos grandes (50+ fotos) pueden tardar en componerse a 300 DPI.
    server.requestTimeout = 0;        // sin límite de request
    server.headersTimeout = 0;
    server.timeout = 0;
  })
  .catch((e) => {
    console.error('Error al iniciar auth:', e);
    app.listen(PORT, () => console.log(`Revelado API en puerto ${PORT} (sin admin inicial)`));
  });
