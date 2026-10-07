import express from 'express'
import { config, razorpayConfigured } from '../config/env.js'
import { ApiError } from '../lib/api-error.js'
import { log } from '../lib/log.js'

// One terminal line per HTTP request once it finishes: method, path, status, time, caller.
export function requestLog(req, res, next) {
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
    log[level]('HTTP', {
      request: `${req.method} ${req.originalUrl}`,
      status: res.statusCode,
      ms: Math.round(ms),
      ...(req.get('X-App-Id') && { app: req.get('X-App-Id') }),
      ...(req.get('Origin') && { origin: req.get('Origin') }),
    })
  })
  next()
}

// CORS for browser-based client apps listed in ALLOWED_ORIGINS.
export function cors(req, res, next) {
  const origin = req.get('Origin') ?? ''
  if (config.allowedOrigins.includes(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Id',
      'Access-Control-Max-Age': '86400',
    })
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
}

// Every client app identifies itself with X-App-Id; data is scoped to that app.
export function requireApp(req, res, next) {
  const appId = req.get('X-App-Id')?.trim()
  if (!appId) {
    throw new ApiError(400, 'APP_ID_REQUIRED', 'X-App-Id header is required.')
  }
  if (!config.appIds.includes(appId)) {
    throw new ApiError(403, 'APP_NOT_REGISTERED', `App "${appId}" is not registered with this payment service.`)
  }
  req.appId = appId
  next()
}

export function requireRazorpay(req, res, next) {
  if (!razorpayConfigured()) {
    throw new ApiError(503, 'RAZORPAY_NOT_CONFIGURED', 'Razorpay keys are not configured. Copy backend/.env.example to backend/.env and add your Test Mode keys.')
  }
  next()
}

// Parses the body as JSON regardless of Content-Type and requires an object.
export const jsonBody = [
  express.json({ type: () => true, limit: '100kb' }),
  (req, res, next) => {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new ApiError(400, 'INVALID_JSON', 'Request body must be a JSON object.')
    }
    next()
  },
]

export function notFound(req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } })
}

// Turns every error into { success: false, error: { code, message } }.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = err.status ?? 500
  let code = err.code ?? 'SERVER_ERROR'
  let message = err.message

  if (err.type === 'entity.parse.failed') {
    [status, code, message] = [400, 'INVALID_JSON', 'Request body must be valid JSON.']
  } else if (err.type === 'entity.too.large') {
    [status, code, message] = [413, 'BODY_TOO_LARGE', 'Request body is too large.']
  } else if (!(err instanceof ApiError)) {
    console.error(err)
    ;[status, code, message] = [500, 'SERVER_ERROR', `Server error: ${err.message}`]
  }
  log[status >= 500 ? 'error' : 'warn']('ERROR', { request: `${req.method} ${req.originalUrl}`, status, code, message })
  res.status(status).json({ success: false, error: { code, message } })
}
