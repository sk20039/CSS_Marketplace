// PostgreSQL connection pool for the listing service.
// Schema is managed by node-pg-migrate (migrations/ directory).
// Run `npm run migrate` once before starting the service.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

module.exports = pool;
