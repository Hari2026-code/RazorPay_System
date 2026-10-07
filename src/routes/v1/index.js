// /api/v1 — the public API of the payment service.
import express, { Router } from 'express'
import { config, razorpayConfigured, webhookConfigured } from '../../config/env.js'
import { ApiError, ok } from '../../lib/api-error.js'
import { webhookSignatureValid } from '../../lib/razorpay.js'
import { pagination } from '../../lib/validate.js'
import { jsonBody, requireApp, requireRazorpay } from '../../middleware/index.js'
import * as service from '../../services/payment-service.js'

const router = Router()

// ---- Health (no app id needed; useful for monitoring)
router.get('/health', (req, res) => {
  ok(res, {
    status: 'ok',
    razorpay_configured: razorpayConfigured(),
    webhook_configured: webhookConfigured(),
    apps: config.appIds.length,
  })
})

// ---- Razorpay webhooks (called by Razorpay, authenticated by signature, not by X-App-Id)
// Raw body is required: the signature is computed over the exact bytes Razorpay sent.
router.post('/webhooks/razorpay', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  if (!webhookConfigured()) {
    throw new ApiError(503, 'WEBHOOK_NOT_CONFIGURED', 'RAZORPAY_WEBHOOK_SECRET is not set.')
  }
  const signature = req.get('X-Razorpay-Signature')
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (!signature || !webhookSignatureValid(raw, signature)) {
    throw new ApiError(400, 'SIGNATURE_INVALID', 'Webhook signature verification failed.')
  }
  let event
  try {
    event = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Webhook body must be valid JSON.')
  }
  ok(res, await service.handleWebhook(event))
})

// ---- Everything below is called by client apps.
router.use(requireApp, requireRazorpay)

// Orders
router.post('/orders', jsonBody, async (req, res) => {
  ok(res, await service.createOrder(req.appId, req.body), 201)
})
router.get('/orders/:orderId', async (req, res) => {
  ok(res, await service.getOrder(req.appId, req.params.orderId))
})

// Payments
router.post('/payments/verify', jsonBody, async (req, res) => {
  ok(res, await service.verifyPayment(req.appId, req.body))
})
router.get('/payments', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  ok(res, await service.listPayments(req.appId, { status, ...pagination(req.query) }))
})
router.get('/payments/:paymentId', async (req, res) => {
  ok(res, await service.getPayment(req.appId, req.params.paymentId))
})

export default router
