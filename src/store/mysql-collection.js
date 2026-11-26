// MySQL "table" with the same methods as JsonCollection (all, find, where, upsert),
// so the services don't know which store they use. Connection comes from DB_* in backend/.env.
import mysql from 'mysql2/promise'
import { config } from '../config/env.js'
import { log } from '../lib/log.js'
import { isoIST } from '../lib/time.js'

const connection = () => ({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  // DATETIME columns hold UTC; Dates go in and come out as UTC.
  timezone: 'Z',
  charset: 'utf8mb4',
  connectTimeout: 10_000,
})

let pool
export function db() {
  if (!pool) {
    pool = mysql.createPool({ ...connection(), database: config.db.database, connectionLimit: 10 })
    // An idle connection dropped by the server (MySQL restart, sleep, network) is emitted on the
    // connection. Without a listener Node treats it as unhandled and the whole payment service exits.
    // The pool replaces the connection on the next query, so logging is enough.
    pool.pool.on('connection', (conn) => conn.on('error', (err) => log.error('DB CONNECTION LOST', { reason: err.message })))
  }
  return pool
}

// Column type per field. `json` = JSON, `time` = DATETIME in UTC (returned as IST ISO strings
// like the JSON store), `bool` = TINYINT(1), anything else is stored as is.
const toDb = (type, v) => {
  if (v === undefined || v === null) return null
  if (type === 'json') return JSON.stringify(v)
  if (type === 'time') return new Date(v)
  return v
}
const fromDb = (type, v) => {
  if (type === 'time' && v instanceof Date) return isoIST(Math.floor(v.getTime() / 1000))
  if (type === 'bool' && v !== null) return Boolean(v)
  if (type === 'json' && typeof v === 'string') return JSON.parse(v)
  return v
}

// Errors after which the whole read-modify-write is safe to run again.
const DUPLICATE_KEY = 1062 // another request inserted the same id between our SELECT and INSERT
const DEADLOCK = 1213 // two inserts of the same new id raced on the gap lock taken by FOR UPDATE

export class MySqlCollection {
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
    const [rows] = await db().query(`SELECT * FROM \`${this.table}\` ORDER BY created_at`)
    return rows.map((r) => this.row(r))
  }

  async find(id) {
    const [rows] = await db().query(`SELECT * FROM \`${this.table}\` WHERE \`${this.key}\` = ?`, [id])
    return this.row(rows[0])
  }

  // Records whose fields equal every value in `filter` (undefined values are ignored).
  async where(filter) {
    const entries = Object.entries(filter).filter(([, v]) => v !== undefined)
    for (const [f] of entries) if (!this.fields.includes(f)) throw new Error(`Unknown field ${f}`)
    const sql = entries.length ? `WHERE ${entries.map(([f]) => `\`${f}\` = ?`).join(' AND ')}` : ''
    const [rows] = await db().query(`SELECT * FROM \`${this.table}\` ${sql} ORDER BY created_at`, entries.map(([, v]) => v))
    return rows.map((r) => this.row(r))
  }

  // Atomically insert or update one record (row lock inside a transaction).
  // updater(existing | null) returns the record to store, or null to leave it unchanged.
  // Resolves to { record, previous }.
  async upsert(id, updater) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const conn = await db().getConnection()
      try {
        await conn.beginTransaction()
        const [found] = await conn.query(`SELECT * FROM \`${this.table}\` WHERE \`${this.key}\` = ? FOR UPDATE`, [id])
        const previous = this.row(found[0])
        const record = updater(previous)
        if (record === null) {
          await conn.commit()
          return { record: previous, previous }
        }
        const values = this.fields.map((f) => toDb(this.columns[f], record[f]))
        if (previous) {
          const others = this.fields.filter((f) => f !== this.key)
          await conn.query(
            `UPDATE \`${this.table}\` SET ${others.map((f) => `\`${f}\` = ?`).join(', ')} WHERE \`${this.key}\` = ?`,
            [...others.map((f) => values[this.fields.indexOf(f)]), values[this.fields.indexOf(this.key)]],
          )
        } else {
          await conn.query(
            `INSERT INTO \`${this.table}\` (${this.fields.map((f) => `\`${f}\``).join(', ')}) VALUES (${this.fields.map(() => '?').join(', ')})`,
            values,
          )
        }
        await conn.commit()
        return { record: this.row(record), previous }
      } catch (err) {
        await conn.rollback().catch(() => {})
        // Lost a race for a new id: run the updater again on the row the other request saved.
        if (err.errno === DUPLICATE_KEY || err.errno === DEADLOCK) continue
        throw err
      } finally {
        conn.release()
      }
    }
    throw new Error(`Could not save ${this.table} ${id}: concurrent updates, please retry.`)
  }
}

// ---------------------------------------------------------------- schema

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
    order_id      VARCHAR(64)  NOT NULL PRIMARY KEY,
    app_id        VARCHAR(64)  NOT NULL,
    reference_id  VARCHAR(64),
    amount        BIGINT       NOT NULL,
    currency      VARCHAR(8)   NOT NULL,
    receipt       VARCHAR(64),
    description   VARCHAR(255),
    customer      JSON         NOT NULL DEFAULT (JSON_OBJECT()),
    notes         JSON         NOT NULL DEFAULT (JSON_OBJECT()),
    callback_url  TEXT,
    status        VARCHAR(32)  NOT NULL,
    payment_id    VARCHAR(64),
    created_at    DATETIME     NOT NULL,
    updated_at    DATETIME     NOT NULL,
    INDEX orders_app_id_idx (app_id),
    INDEX orders_reference_id_idx (reference_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  // No foreign key: older data/payments.json has payments whose orders were never saved locally.
  `CREATE TABLE IF NOT EXISTS payments (
    payment_id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    order_id            VARCHAR(64)  NOT NULL,
    app_id              VARCHAR(64)  NOT NULL,
    reference_id        VARCHAR(64),
    amount              BIGINT       NOT NULL,
    currency            VARCHAR(8)   NOT NULL,
    status              VARCHAR(32)  NOT NULL,
    method              VARCHAR(32),
    email               VARCHAR(255),
    contact             VARCHAR(32),
    error               JSON,
    signature_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
    signature           VARCHAR(255),
    synced_via          VARCHAR(32),
    created_at          DATETIME     NOT NULL,
    updated_at          DATETIME     NOT NULL,
    razorpay_response   JSON,
    INDEX payments_order_id_idx (order_id),
    INDEX payments_app_status_idx (app_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
]

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

// Creates the database and tables if missing. On first run (empty tables) copies data/orders.json
// and data/payments.json into the database, so nothing recorded before the switch is lost.
export async function initMySql({ orders, payments, legacy }) {
  const admin = await mysql.createConnection(connection())
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4`)
  } finally {
    await admin.end()
  }
  for (const statement of SCHEMA) await db().query(statement)
  log.ok('DB CONNECTED', { host: config.db.host, database: config.db.database })

  for (const [collection, json] of [[orders, legacy.orders], [payments, legacy.payments]]) {
    const [rows] = await db().query(`SELECT COUNT(*) AS n FROM \`${collection.table}\``)
    if (rows[0].n > 0) continue
    const records = await json.all().catch(() => [])
    for (const record of records) {
      await collection.upsert(record[collection.key], () => ({ ...record, callback_url: record.callback_url ?? null }))
    }
    if (records.length) log.ok('DB IMPORTED', { table: collection.table, records: records.length, from: `data/${collection.table}.json` })
  }
}
