// The store the services use. MySQL when DB_CONNECTION=mysql (DB_* in backend/.env),
// otherwise the data/*.json files. Both expose the same methods: all, find, where, upsert.
import { config, dbConfigured } from '../config/env.js'
import { log } from '../lib/log.js'
import { JsonCollection } from './json-collection.js'
import { ORDER_COLUMNS, PAYMENT_COLUMNS, MySqlCollection, db, initMySql } from './mysql-collection.js'

const json = {
  orders: new JsonCollection('orders.json', 'order_id'),
  payments: new JsonCollection('payments.json', 'payment_id'),
}

const useMySql = dbConfigured()

export const orders = useMySql ? new MySqlCollection('orders', 'order_id', ORDER_COLUMNS) : json.orders
export const payments = useMySql ? new MySqlCollection('payments', 'payment_id', PAYMENT_COLUMNS) : json.payments

export const storeName = useMySql ? `mysql (${config.db.host}/${config.db.database})` : 'json files (data/)'

// Called once before the server starts listening. Throws when the database can't be reached.
export async function initStore() {
  if (!useMySql) {
    log.warn('STORE', { using: storeName, note: 'set DB_CONNECTION=mysql and DB_* in .env to use MySQL' })
    return
  }
  await initMySql({ orders, payments, legacy: json })
}

export async function closeStore() {
  if (useMySql) await db().end()
}
