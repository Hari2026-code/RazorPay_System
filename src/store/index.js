// The store the services use. PostgreSQL when DB_CONNECTION=pgsql (DB_* in backend/.env),
// otherwise the data/*.json files. Both expose the same methods: all, find, where, upsert.
import { config, dbConfigured } from '../config/env.js'
import { log } from '../lib/log.js'
import { JsonCollection } from './json-collection.js'
import { ORDER_COLUMNS, PAYMENT_COLUMNS, PgCollection, db, initPostgres } from './postgres-collection.js'

const json = {
  orders: new JsonCollection('orders.json', 'order_id'),
  payments: new JsonCollection('payments.json', 'payment_id'),
}

const usePostgres = dbConfigured()

export const orders = usePostgres ? new PgCollection('orders', 'order_id', ORDER_COLUMNS) : json.orders
export const payments = usePostgres ? new PgCollection('payments', 'payment_id', PAYMENT_COLUMNS) : json.payments

export const storeName = usePostgres ? `postgres (${config.db.host}/${config.db.database})` : 'json files (data/)'

// Called once before the server starts listening. Throws when the database can't be reached.
export async function initStore() {
  if (!usePostgres) {
    log.warn('STORE', { using: storeName, note: 'set DB_CONNECTION=pgsql and DB_* in .env to use PostgreSQL' })
    return
  }
  await initPostgres({ orders, payments, legacy: json })
}

export async function closeStore() {
  if (usePostgres) await db().end()
}
