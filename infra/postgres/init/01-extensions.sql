-- pgvector backs the retrieval side of the AI adapter. Enabling the extension
-- at database creation keeps the application migrations free of superuser DDL.
\connect optiwork_api
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
