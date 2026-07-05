const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const SECRET = process.env.JWT_SECRET || 'cambiar-este-secreto';
const EXPIRES = process.env.JWT_EXPIRES || '8h';

// Crea la tabla de usuarios y el admin inicial. Migra el campo rol si falta.
async function initAuth() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rev_usuarios (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(60) NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      rol ENUM('admin','empleado') NOT NULL DEFAULT 'empleado',
      activo TINYINT(1) NOT NULL DEFAULT 1,
      creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Migracion: si la tabla ya existia sin la columna rol, agregarla
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rev_usuarios' AND COLUMN_NAME = 'rol'"
  );
  if (cols.length === 0) {
    await pool.query("ALTER TABLE rev_usuarios ADD COLUMN rol ENUM('admin','empleado') NOT NULL DEFAULT 'empleado' AFTER password_hash");
  }

  // Migracion: columna fotos_estado en rev_pedidos (para la limpieza manual de fotos)
  const [fe] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rev_pedidos' AND COLUMN_NAME = 'fotos_estado'"
  );
  if (fe.length === 0) {
    await pool.query("ALTER TABLE rev_pedidos ADD COLUMN fotos_estado ENUM('presentes','eliminadas') NOT NULL DEFAULT 'presentes' AFTER estado");
  }

  // Migracion: columna rotada en rev_hoja_fotos (rotar la foto dentro de la hoja 7x10)
  const [rot] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rev_hoja_fotos' AND COLUMN_NAME = 'rotada'"
  );
  if (rot.length === 0) {
    await pool.query("ALTER TABLE rev_hoja_fotos ADD COLUMN rotada TINYINT(1) NOT NULL DEFAULT 0 AFTER encuadre");
  }

  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) return;

  const [rows] = await pool.query('SELECT id FROM rev_usuarios WHERE username = ?', [user]);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(pass, 10);
    await pool.query(
      "INSERT INTO rev_usuarios (username, nombre, password_hash, rol) VALUES (?, ?, ?, 'admin')",
      [user, process.env.ADMIN_NOMBRE || user, hash]
    );
    console.log(`Admin inicial creado: ${user}`);
  } else {
    // Asegurar que el admin definido por env siempre tenga rol admin
    await pool.query("UPDATE rev_usuarios SET rol = 'admin' WHERE username = ?", [user]);
  }
}

async function login(username, password) {
  const [rows] = await pool.query(
    'SELECT * FROM rev_usuarios WHERE username = ? AND activo = 1',
    [username]
  );
  if (rows.length === 0) return null;
  const u = rows[0];
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return null;
  const token = jwt.sign(
    { id: u.id, username: u.username, nombre: u.nombre, rol: u.rol },
    SECRET,
    { expiresIn: EXPIRES }
  );
  return { token, usuario: { id: u.id, username: u.username, nombre: u.nombre, rol: u.rol } };
}

// Middleware: exige token valido
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.usuario = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Sesion invalida' });
  }
}

// Middleware: exige rol admin (para precios, gestion de usuarios, borrar)
function requireAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Necesitas permisos de administrador' });
  }
  next();
}

// --- Gestion de usuarios (solo admin) ---
async function listarUsuarios() {
  const [rows] = await pool.query(
    'SELECT id, username, nombre, rol, activo, creado FROM rev_usuarios ORDER BY creado'
  );
  return rows;
}

async function crearUsuario({ username, nombre, password, rol }) {
  username = (username || '').trim().toLowerCase();
  if (!username || !password) throw new Error('Faltan datos');
  const r = (rol === 'admin') ? 'admin' : 'empleado';
  const [exist] = await pool.query('SELECT id FROM rev_usuarios WHERE username = ?', [username]);
  if (exist.length) throw new Error('Ese usuario ya existe');
  const hash = await bcrypt.hash(password, 10);
  const [res] = await pool.query(
    'INSERT INTO rev_usuarios (username, nombre, password_hash, rol) VALUES (?, ?, ?, ?)',
    [username, nombre || username, hash, r]
  );
  return { id: res.insertId, username, nombre: nombre || username, rol: r };
}

async function actualizarUsuario(id, { nombre, password, rol, activo }) {
  const sets = [], vals = [];
  if (nombre != null) { sets.push('nombre = ?'); vals.push(nombre); }
  if (rol != null) { sets.push('rol = ?'); vals.push(rol === 'admin' ? 'admin' : 'empleado'); }
  if (activo != null) { sets.push('activo = ?'); vals.push(activo ? 1 : 0); }
  if (password) { sets.push('password_hash = ?'); vals.push(await bcrypt.hash(password, 10)); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE rev_usuarios SET ${sets.join(', ')} WHERE id = ?`, vals);
}

async function borrarUsuario(id) {
  await pool.query('DELETE FROM rev_usuarios WHERE id = ?', [id]);
}

module.exports = {
  initAuth, login, requireAuth, requireAdmin,
  listarUsuarios, crearUsuario, actualizarUsuario, borrarUsuario,
};
