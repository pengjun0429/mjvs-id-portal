CREATE TABLE IF NOT EXISTS registry_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  is_ready INTEGER NOT NULL DEFAULT 0 CHECK (is_ready IN (0, 1)),
  data_version TEXT,
  activated_at TEXT
);

INSERT OR IGNORE INTO registry_control (id, is_ready) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS issued_ids (
  id_hash TEXT PRIMARY KEY NOT NULL,
  country_name TEXT NOT NULL,
  registered_name TEXT NOT NULL,
  public_name_authorized INTEGER NOT NULL DEFAULT 0 CHECK (public_name_authorized IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;
