-- BlueHorizon Portal — D1 schema
CREATE TABLE IF NOT EXISTS users (
  username  TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  salt      TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'pending',  -- pending | member | lead | admin
  created   TEXT NOT NULL
);
