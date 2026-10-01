import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = '1';
process.env.TEST_DB = 'sqlite';
process.env.DATA_FILE = '/dev/null/invalid-test-database.db';
process.env.DATABASE_URL = '';
test('un démarrage DB en échec peut être retenté, sans conserver la promesse rejetée', async () => {
  const { ready, db, closeDb } = await import('../server/db/index.ts');
  const { env } = await import('../server/lib/env.ts');
  await assert.rejects(ready());
  env.dataFile = ':memory:';
  await ready();
  assert.equal(await db().num('SELECT count(*) FROM locations'), 0);
  await closeDb();
});
