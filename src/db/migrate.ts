import fs from 'node:fs';
import path from 'node:path';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Applies every .sql file in migrations/ that has not been applied yet, in
 * filename order, and records it in schema_migrations.
 *
 * Deliberately small: the brief asks for a versioned schema in the repo, not
 * for a migration framework. Plain .sql files keep the schema readable for
 * whoever reviews this, which a framework's generated migrations would not.
 */
export async function runMigrations(database = env.db.database): Promise<void> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database,
    multipleStatements: true,
    timezone: 'Z',
  });

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (filename)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [rows] = await conn.query<RowDataPacket[]>('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.filename as string));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log(`applied ${file}`);
      count += 1;
    }

    console.log(count === 0 ? 'schema already up to date' : `${count} migration(s) applied`);
  } finally {
    await conn.end();
  }
}

// Only self-executes when run as a script, so the test setup can import and
// call runMigrations() directly.
if (require.main === module) {
  runMigrations().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
