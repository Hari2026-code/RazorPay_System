// Central configuration. Everything is read from the environment (backend/.env).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DATA_DIR = path.join(ROOT_DIR, 'data')

// Load backend/.env if present (built into Node >= 20.12). Real environment variables win.
const envFile = path.join(ROOT_DIR, '.env')
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile)
}

const list = (value, fallback) =>
  (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean)

export const config = {
  port: Number(process.env.PORT) || 8000,

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  },

  // Client applications allowed to use this payment service (sent as the X-App-Id header).
  appIds: list(process.env.APP_IDS, 'web'),

  allowedOrigins: list(process.env.ALLOWED_ORIGINS, 'http://localhost:5173,http://127.0.0.1:5173'),

  // Public address of this service, used to build the hosted payment page link (payment_url).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${Number(process.env.PORT) || 8000}`).replace(/\/+$/, ''),

  // PostgreSQL (DB_CONNECTION=pgsql). Without it orders/payments are kept in data/*.json.
  db: {
    connection: (process.env.DB_CONNECTION ?? '').trim().toLowerCase(),
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_DATABASE ?? '',
    user: process.env.DB_USERNAME ?? '',
    password: process.env.DB_PASSWORD ?? '',
  },

  currency: 'INR', // default when the client app does not send one
  minAmount: 1, // INR
  maxAmount: 500000, // INR; other currencies are limited by Razorpay itself
}

export const razorpayConfigured = () =>
  config.razorpay.keyId !== '' && config.razorpay.keySecret !== '' && !config.razorpay.keyId.startsWith('YOUR_')

export const dbConfigured = () =>
  ['pgsql', 'postgres', 'postgresql'].includes(config.db.connection) && config.db.database !== ''

export const webhookConfigured = () =>
  config.razorpay.webhookSecret !== '' && !config.razorpay.webhookSecret.startsWith('YOUR_')
