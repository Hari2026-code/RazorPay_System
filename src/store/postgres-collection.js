// PostgreSQL "table" with the same methods as JsonCollection (all, find, where, upsert),
// so the services don't know which store they use. Connection comes from DB_* in backend/.env.
import pg from 'pg'
import { config } from '../config/env.js'
import { log } from '../lib/log.js'
import { isoIST } from '../lib/time.js'

// int8 (amounts in the smallest currency unit) as a JS number instead of a string.
pg.types.setTypeParser(20, Number)

let pool
export function db() {
  pool ??= new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    max: 10,
    connectionTimeoutMillis: 10_000,
  })
  // An idle connection dropped by the server (Postgres restart, sleep, network) is emitted here.
  // Without a listener Node treats it as unhandled and the whole payment service exits.
  // The pool replaces the connection on the next query, so logging is enough.
  pool.on('error', (err) => log.error('DB CONNECTION LOST', { reason: err.message }))
  return pool
}

// Column type per field. `json` = jsonb, `time` = timestamptz (returned as IST ISO strings
// like the JSON store), anything else is stored as is.
const toDb = (type, v) => (v === undefined ? null : type === 'json' && v !== null ? JSON.stringify(v) : v)
const fromDb = (type, v) => (type === 'time' && v instanceof Date ? isoIST(Math.floor(v.getTime() / 1000)) : v)

export class PgCollection {
  constructor(table, key, columns) {
    this.table = table
    this.key = key
    this.columns = columns // { field: 'text' | 'int' | 'bool' | 'json' | 'time' }
    this.fields = Object.keys(columns)
  }

  row(r) {
    return r ? Object.fromEntries(this.fields.map((f) => [f, fromDb(this.columns[f], r[f])])) : null
  }

  async all() {
    const { rows } = await db().query(`SELECT * FROM ${this.table} ORDER BY created_at`)
    return rows.map((r) => this.row(r))
  }

  async find(id) {
    const { rows } = await db().query(`SELECT * FROM ${this.table} WHERE ${this.key} = $1`, [id])
    return this.row(rows[0])
  }

  // Records whose fields equal every value in `filter` (undefined values are ignored).
  async where(filter) {
    const entries = Object.entries(filter).filter(([, v]) => v !== undefined)
    for (const [f] of entries) if (!this.fields.includes(f)) throw new Error(`Unknown field ${f}`)
    const sql = entries.length ? `WHERE ${entries.map(([f], i) => `${f} = $${i + 1}`).join(' AND ')}` : ''
    const { rows } = await db().query(`SELECT * FROM ${this.table} ${sql} ORDER BY created_at`, entries.map(([, v]) => v))
    return rows.map((r) => this.row(r))
  }

  // Atomically insert or update one record (row lock inside a transaction).
  // updater(existing | null) returns the record to store, or null to leave it unchanged.
  // Resolves to { record, previous }.
  async upsert(id, updater) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await db().connect()
      try {
        await client.query('BEGIN')
        const found = await client.query(`SELECT * FROM ${this.table} WHERE ${this.key} = $1 FOR UPDATE`, [id])
        const previous = this.row(found.rows[0])
        const record = updater(previous)
        if (record === null) {
          await client.query('COMMIT')
          return { record: previous, previous }
        }
        const values = this.fields.map((f) => toDb(this.columns[f], record[f]))
        if (previous) {
          const set = this.fields.filter((f) => f !== this.key).map((f) => `${f} = $${this.fields.indexOf(f) + 1}`)
          await client.query(`UPDATE ${this.table} SET ${set.join(', ')} WHERE ${this.key} = $${this.fields.indexOf(this.key) + 1}`, values)
        } else {
          const placeholders = this.fields.map((_, i) => `$${i + 1}`)
          const inserted = await client.query(
            `INSERT INTO ${this.table} (${this.fields.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${this.key}) DO NOTHING`,
            values,
          )
          if (inserted.rowCount === 0) {
            // Another request inserted the same id between our SELECT and INSERT: run the updater again on its row.
            await client.query('ROLLBACK')
            continue
          }
        }
        await client.query('COMMIT')
        return { record: this.row(record), previous }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    }
    throw new Error(`Could not save ${this.table} ${id}: concurrent updates, please retry.`)
  }
}

// ---------------------------------------------------------------- schema

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_id      text PRIMARY KEY,
  app_id        text NOT NULL,
  reference_id  text,
  amount        bigint NOT NULL,
  currency      text NOT NULL,
  receipt       text,
  description   text,
  customer      jsonb NOT NULL DEFAULT '{}',
  notes         jsonb NOT NULL DEFAULT '{}',
  callback_url  text,
  status        text NOT NULL,
  payment_id    text,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_app_id_idx ON orders (app_id);
CREATE INDEX IF NOT EXISTS orders_reference_id_idx ON orders (reference_id);

CREATE TABLE IF NOT EXISTS payments (
  payment_id          text PRIMARY KEY,
  -- No foreign key: older data/payments.json has payments whose orders were never saved locally.
  order_id            text NOT NULL,
  app_id              text NOT NULL,
  reference_id        text,
  amount              bigint NOT NULL,
  currency            text NOT NULL,
  status              text NOT NULL,
  method              text,
  email               text,
  contact             text,
  error               jsonb,
  signature_verified  boolean NOT NULL DEFAULT false,
  signature           text,
  synced_via          text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  razorpay_response   jsonb
);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_order_id_fkey;
CREATE INDEX IF NOT EXISTS payments_order_id_idx ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_app_status_idx ON payments (app_id, status);
`

export const ORDER_COLUMNS = {
  order_id: 'text', app_id: 'text', reference_id: 'text', amount: 'int', currency: 'text', receipt: 'text',
  description: 'text', customer: 'json', notes: 'json', callback_url: 'text', status: 'text', payment_id: 'text',
  created_at: 'time', updated_at: 'time',
}

export const PAYMENT_COLUMNS = {
  payment_id: 'text', order_id: 'text', app_id: 'text', reference_id: 'text', amount: 'int', currency: 'text',
  status: 'text', method: 'text', email: 'text', contact: 'text', error: 'json', signature_verified: 'bool',
  signature: 'text', synced_via: 'text', created_at: 'time', updated_at: 'time', razorpay_response: 'json',
}

// Creates the tables if missing. On first run (empty tables) copies data/orders.json and
// data/payments.json into the database, so nothing recorded before the switch is lost.
export async function initPostgres({ orders, payments, legacy }) {
  await db().query(SCHEMA)
  log.ok('DB CONNECTED', { host: config.db.host, database: config.db.database })

  for (const [collection, json] of [[orders, legacy.orders], [payments, legacy.payments]]) {
    const { rows } = await db().query(`SELECT count(*)::int AS n FROM ${collection.table}`)
    if (rows[0].n > 0) continue
    const records = await json.all().catch(() => [])
    for (const record of records) {
      await collection.upsert(record[collection.key], () => ({ ...record, callback_url: record.callback_url ?? null }))
    }
    if (records.length) log.ok('DB IMPORTED', { table: collection.table, records: records.length, from: `data/${collection.table}.json` })
  }
}
