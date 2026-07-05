-- ============================================================
-- Centro Color - Modulo de revelado de fotos
-- Base de datos: u300904526_revelado
-- Motor: MySQL / MariaDB (Hostinger)
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ------------------------------------------------------------
-- rev_config : configuracion general (tramos + correlativo)
-- Una sola fila (id=1).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rev_config (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tramo1_hasta        INT UNSIGNED NOT NULL DEFAULT 9,    -- tramo 1: 1 .. tramo1_hasta
  tramo2_hasta        INT UNSIGNED NOT NULL DEFAULT 49,   -- tramo 2: (tramo1_hasta+1) .. tramo2_hasta ; tramo 3: resto
  ultimo_correlativo  INT UNSIGNED NOT NULL DEFAULT 0,    -- ultimo numero usado para el codigo NOMBRE - 0010
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO rev_config (id, tramo1_hasta, tramo2_hasta, ultimo_correlativo)
VALUES (1, 9, 49, 0)
ON DUPLICATE KEY UPDATE id = id;

-- ------------------------------------------------------------
-- rev_precios : precio por medida y tramo + recargo iman
-- Editable desde el panel admin.
-- Valores de ejemplo (Simon carga los reales).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rev_precios (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  medida        VARCHAR(40)  NOT NULL,            -- "Polaroid", "7x10", "10x15", ...
  es_hoja       TINYINT(1)   NOT NULL DEFAULT 0,  -- 1 = se cobra por hoja (solo 7x10)
  orden         INT UNSIGNED NOT NULL DEFAULT 0,  -- orden de aparicion en la web
  precio_t1     INT UNSIGNED NOT NULL DEFAULT 0,  -- precio tramo 1 (1-9)
  precio_t2     INT UNSIGNED NOT NULL DEFAULT 0,  -- precio tramo 2 (10-49)
  precio_t3     INT UNSIGNED NOT NULL DEFAULT 0,  -- precio tramo 3 (50+)
  recargo_iman  INT UNSIGNED NOT NULL DEFAULT 0,  -- recargo por copia con iman
  activo        TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_medida (medida)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO rev_precios (medida, es_hoja, orden, precio_t1, precio_t2, precio_t3, recargo_iman) VALUES
  ('Polaroid', 0, 1,  900,  820,  750, 300),
  ('7x10',     1, 2, 1100, 1000,  900, 400),
  ('10x15',    0, 3,  700,  640,  580, 300),
  ('13x18',    0, 4, 1300, 1200, 1100, 400),
  ('15x21',    0, 5, 1800, 1650, 1500, 500),
  ('20x25',    0, 6, 2600, 2400, 2200, 600),
  ('20x30',    0, 7, 3000, 2750, 2500, 600),
  ('25x38',    0, 8, 4200, 3900, 3600, 700)
ON DUPLICATE KEY UPDATE medida = medida;

-- ------------------------------------------------------------
-- rev_pedidos : un registro por pedido entrante
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rev_pedidos (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  codigo          VARCHAR(60)  NOT NULL,            -- "GONZALEZ - 0010"
  cliente_nombre  VARCHAR(120) NOT NULL,
  whatsapp        VARCHAR(40)  NULL,
  estado          ENUM('nuevo','en_proceso','listo','entregado') NOT NULL DEFAULT 'nuevo',
  fotos_estado    ENUM('presentes','eliminadas') NOT NULL DEFAULT 'presentes', -- limpieza manual de fotos de R2
  total           INT UNSIGNED NOT NULL DEFAULT 0,  -- total calculado al confirmar (snapshot)
  nota            TEXT NULL,                        -- nota general del cliente
  creado          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_codigo (codigo),
  KEY idx_estado (estado),
  KEY idx_creado (creado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- rev_items : fotos de medida normal (1 foto = N copias)
-- El 7x10 NO va aca, va en rev_hojas.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rev_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  pedido_id   INT UNSIGNED NOT NULL,
  archivo     VARCHAR(255) NOT NULL,            -- nombre original del archivo
  url_r2      VARCHAR(500) NOT NULL,            -- foto original en R2
  url_lista   VARCHAR(500) NULL,               -- foto YA compuesta lista para imprimir (se llena al componer)
  medida      VARCHAR(40)  NOT NULL,
  iman        TINYINT(1)   NOT NULL DEFAULT 0,
  copias      INT UNSIGNED NOT NULL DEFAULT 1,
  encuadre    ENUM('llenar','completa') NOT NULL DEFAULT 'llenar',
  borde       TINYINT(1)   NOT NULL DEFAULT 0,  -- marco blanco 4mm
  rotar       TINYINT(1)   NOT NULL DEFAULT 0,  -- override de orientacion automatica
  pos_x       DECIMAL(4,3) NOT NULL DEFAULT 0.5,-- posicion encuadre 0..1
  pos_y       DECIMAL(4,3) NOT NULL DEFAULT 0.5,
  nota        TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_pedido (pedido_id),
  CONSTRAINT fk_items_pedido FOREIGN KEY (pedido_id)
    REFERENCES rev_pedidos (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- rev_hojas : cada hoja 7x10 armada (2 fotos por hoja)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rev_hojas (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  pedido_id       INT UNSIGNED NOT NULL,
  orientacion     ENUM('apaisada','vertical') NOT NULL DEFAULT 'apaisada',
  iman            TINYINT(1)   NOT NULL DEFAULT 0,  -- iman aplica a la hoja entera
  copias          INT UNSIGNED NOT NULL DEFAULT 1,
  url_compuesta   VARCHAR(500) NULL,               -- hoja final 10x15 @300dpi en R2 (se llena al componer)
  PRIMARY KEY (id),
  KEY idx_pedido (pedido_id),
  CONSTRAINT fk_hojas_pedido FOREIGN KEY (pedido_id)
    REFERENCES rev_pedidos (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- rev_hoja_fotos : las 2 fotos que van en cada hoja 7x10
-- posicion 1 = arriba/izquierda , 2 = abajo/derecha
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rev_hoja_fotos (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  hoja_id     INT UNSIGNED NOT NULL,
  posicion    TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 1 o 2
  archivo     VARCHAR(255) NOT NULL,
  url_r2      VARCHAR(500) NOT NULL,
  encuadre    ENUM('llenar','completa') NOT NULL DEFAULT 'llenar',
  rotada      TINYINT(1)   NOT NULL DEFAULT 0,  -- foto girada 90 grados dentro de la hoja
  pos_x       DECIMAL(4,3) NOT NULL DEFAULT 0.5,
  pos_y       DECIMAL(4,3) NOT NULL DEFAULT 0.5,
  PRIMARY KEY (id),
  KEY idx_hoja (hoja_id),
  CONSTRAINT fk_hojafotos_hoja FOREIGN KEY (hoja_id)
    REFERENCES rev_hojas (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- Fin del esquema
-- ============================================================
