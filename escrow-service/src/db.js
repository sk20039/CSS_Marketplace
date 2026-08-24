'use strict';
// PostgreSQL persistence layer.
// Exports a pg.Pool singleton; every module that needs DB access requires this.
// DATABASE_URL must be set before this module is first required.

const { Pool, types } = require('pg');

// Parse BIGINT (OID 20) as JS Number — safe for our ID ranges (well within 2^53).
types.setTypeParser(20, Number);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = pool;
