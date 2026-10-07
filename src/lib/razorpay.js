import crypto from 'node:crypto'
import Razorpay from 'razorpay'
import { config } from '../config/env.js'

let client
export function razorpay() {
  client ??= new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret })
  return client
}

// The SDK rejects with { statusCode, error: { description } } for API errors.
// On network failures it crashes internally reading err.response.status, which surfaces as a TypeError.
export function razorpayErrorMessage(err) {
  if (err?.error?.description) return err.error.description
  if (err instanceof TypeError) return 'Could not reach Razorpay (network error), please try again.'
  return err?.message || 'Unknown error'
}

function hmacMatches(payload, secret, signature) {
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('hex'))
  const given = Buffer.from(String(signature))
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

// Checkout signature: HMAC-SHA256(order_id|payment_id, KEY_SECRET).
export const checkoutSignatureValid = (orderId, paymentId, signature) =>
  hmacMatches(`${orderId}|${paymentId}`, config.razorpay.keySecret, signature)

// Webhook signature: HMAC-SHA256(raw request body, WEBHOOK_SECRET).
export const webhookSignatureValid = (rawBody, signature) =>
  hmacMatches(rawBody, config.razorpay.webhookSecret, signature)
