// Business logic of the payment service. Routes only parse HTTP and call these functions.
import crypto from 'node:crypto'
import { config } from '../config/env.js'
import { ApiError } from '../lib/api-error.js'
import { checkoutSignatureValid, razorpay, razorpayErrorMessage } from '../lib/razorpay.js'
import { log } from '../lib/log.js'
import { isoIST } from '../lib/time.js'
import { isNumeric, optionalNotes, optionalString, requiredString } from '../lib/validate.js'
import { orders, payments } from '../store/index.js'

const invalid = (message) => new ApiError(422, 'VALIDATION_ERROR', message)
const gatewayError = (message, err) => new ApiError(502, 'GATEWAY_ERROR', `${message}: ${razorpayErrorMessage(err)}`)

// Higher rank = later in the payment lifecycle. Used so an out-of-order webhook
// (e.g. "authorized" arriving after "captured") never moves a payment backwards.
const STATUS_RANK = { created: 0, failed: 1, authorized: 2, captured: 3, refunded: 4 }
const rank = (status) => STATUS_RANK[status] ?? 0

// ISO 4217 currency code; whether the account may charge it is Razorpay's decision.
function parseCurrency(value) {
  if (value === undefined || value === null || value === '') return config.currency
  const currency = String(value).trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw invalid('currency must be a 3-letter ISO code, e.g. INR.')
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency })
  } catch {
    throw invalid(`Unknown currency ${currency}.`)
  }
  return currency
}

// Decimal places of the currency's smallest unit (INR 2 = paise, JPY 0, KWD 3).
const minorUnits = (currency) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits

function parseAmount(value, currency) {
  if (!isNumeric(value)) throw invalid('amount must be a number.')
  const amount = Number(value)
  const factor = 10 ** minorUnits(currency)
  if (currency === 'INR') {
    if (amount < config.minAmount) throw invalid(`Minimum amount is ₹${config.minAmount}.`)
    if (amount > config.maxAmount) throw invalid(`Maximum amount is ₹${config.maxAmount.toLocaleString('en-IN')}.`)
  } else if (amount <= 0) {
    throw invalid('amount must be greater than 0.')
  }
  // Round to the currency's precision (a cart total can carry float noise like 2637.5200000000004).
  return Math.round(amount * factor) // ₹500 => 50000 paise
}

function parseCustomer(value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('customer must be an object.')
  const customer = {
    name: optionalString(value.name, 'customer.name', 100),
    email: optionalString(value.email, 'customer.email', 254),
    contact: optionalString(value.contact, 'customer.contact', 20),
  }
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw invalid('customer.email is not a valid email.')
  if (customer.contact && !/^\+?[0-9 -]{8,20}$/.test(customer.contact)) throw invalid('customer.contact is not a valid phone number.')
  return Object.fromEntries(Object.entries(customer).filter(([, v]) => v !== undefined))
}

// Where the hosted payment page sends the customer after paying. http(s) only.
function parseCallbackUrl(value) {
  const raw = optionalString(value, 'callback_url', 2000)
  if (!raw) return undefined
  let url
  try {
    url = new URL(raw)
  } catch {
    throw invalid('callback_url must be a valid URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('callback_url must be an http(s) URL.')
  return url.toString()
}

export const paymentUrl = (orderId) => `${config.publicBaseUrl}/pay/${encodeURIComponent(orderId)}`

function assertOwnedBy(record, appId, notFoundCode, label) {
  // Another app's record is reported as "not found" so apps can't probe each other's IDs.
  if (!record || record.app_id !== appId) {
    throw new ApiError(404, notFoundCode, `${label} not found.`)
  }
  return record
}

// "9.99 USD" style amount for the console, from the smallest unit.
const money = (minor, currency) => `${minor / 10 ** minorUnits(currency)} ${currency}`

// a***@example.com: enough to recognise the customer in the terminal, not a full copy.
const maskEmail = (email) => (email ? email.replace(/^(.).*(@.*)$/, '$1***$2') : undefined)

// ---------------------------------------------------------------- orders

export async function createOrder(appId, body) {
  const currency = parseCurrency(body.currency)
  const amount = parseAmount(body.amount, currency)
  const referenceId = optionalString(body.reference_id, 'reference_id', 64)
  const description = optionalString(body.description, 'description', 255)
  const customer = parseCustomer(body.customer)
  const notes = optionalNotes(body.notes)
  const callbackUrl = parseCallbackUrl(body.callback_url)
  log.info('ORDER REQUEST', {
    app: appId, amount: money(amount, currency), reference_id: referenceId, description,
    customer: customer.name, email: maskEmail(customer.email), callback_url: callbackUrl,
  })
  const receipt = `rcpt_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}` // must be <= 40 chars

  let rzpOrder
  try {
    rzpOrder = await razorpay().orders.create({
      amount,
      currency,
      receipt,
      // app_id in Razorpay's own record lets you trace every order back to its app in the dashboard.
      notes: { ...notes, app_id: appId, ...(referenceId && { reference_id: referenceId }) },
    })
  } catch (err) {
    log.error('ORDER FAILED', { app: appId, reference_id: referenceId, reason: razorpayErrorMessage(err) })
    throw gatewayError('Razorpay order creation failed', err)
  }

  const now = isoIST()
  const { record } = await orders.upsert(rzpOrder.id, () => ({
    order_id: rzpOrder.id,
    app_id: appId,
    reference_id: referenceId ?? null,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    receipt: rzpOrder.receipt,
    description: description ?? null,
    customer,
    notes,
    callback_url: callbackUrl ?? null,
    status: 'created', // created -> attempted (a payment failed) -> paid
    payment_id: null,
    created_at: now,
    updated_at: now,
  }))

  log.ok('ORDER CREATED', {
    order_id: record.order_id, amount: money(record.amount, record.currency), receipt: record.receipt,
    reference_id: record.reference_id, payment_url: paymentUrl(record.order_id),
  })
  // payment_url: the hosted page the client app opens/redirects the customer to.
  return { ...record, key_id: config.razorpay.keyId, payment_url: paymentUrl(record.order_id) } // public key only, never the secret
}

export async function getOrder(appId, orderId) {
  const order = assertOwnedBy(await orders.find(orderId), appId, 'ORDER_NOT_FOUND', 'Order')
  const orderPayments = await payments.where({ order_id: orderId })
  return { ...order, payment_url: paymentUrl(order.order_id), payments: orderPayments }
}

// ---------------------------------------------------------------- hosted payment page
// Opened by the customer's browser, which has no X-App-Id: the order id in the link
// identifies the order, and the Checkout signature proves the payment.

export async function getCheckoutOrder(orderId) {
  const order = await orders.find(orderId)
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  return order
}

export async function verifyCheckoutPayment(orderId, body) {
  const order = await getCheckoutOrder(orderId)
  log.info('PAY PAGE VERIFY', { order_id: orderId, payment_id: body.razorpay_payment_id })
  if (body.razorpay_order_id !== order.order_id) {
    throw new ApiError(400, 'ORDER_MISMATCH', 'Payment does not belong to this order.')
  }
  return verifyPayment(order.app_id, body)
}

// ---------------------------------------------------------------- payments

// Inserts/updates the local copy of a Razorpay payment and moves its order forward.
async function recordPayment(rzpPayment, order, { via, signature } = {}) {
  const payment = { ...rzpPayment }
  // Don't store card-sensitive details (normal fetch only has card_id, this is just a safeguard).
  delete payment.card
  delete payment.token

  const now = isoIST()
  const { record, previous } = await payments.upsert(payment.id, (existing) => {
    if (existing && rank(payment.status) < rank(existing.status)) return null // stale update
    return {
      payment_id: payment.id,
      order_id: order.order_id,
      app_id: order.app_id,
      reference_id: order.reference_id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      method: payment.method ?? '',
      email: payment.email ?? '',
      contact: payment.contact ?? '',
      error: payment.error_code
        ? { code: payment.error_code, description: payment.error_description, reason: payment.error_reason }
        : null,
      signature_verified: Boolean(signature) || (existing?.signature_verified ?? false),
      signature: signature ?? existing?.signature ?? null,
      synced_via: via,
      created_at: isoIST(payment.created_at ?? undefined),
      updated_at: now,
      razorpay_response: payment,
    }
  })

  const paid = ['authorized', 'captured'].includes(record.status)
  log[record.status === 'failed' ? 'warn' : 'ok']('PAYMENT SAVED', {
    payment_id: record.payment_id, order_id: record.order_id, reference_id: record.reference_id,
    status: record.status, amount: money(record.amount, record.currency), method: record.method,
    via, ...(record.error && { error: record.error.description }), ...(previous && { updated: true }),
  })
  await orders.upsert(order.order_id, (o) => {
    if (!o || o.status === 'paid') return null
    if (paid) return { ...o, status: 'paid', payment_id: record.payment_id, updated_at: now }
    if (record.status === 'failed' && o.status === 'created') return { ...o, status: 'attempted', updated_at: now }
    return null
  })

  return { record, alreadySaved: previous !== null }
}

// Called by the client app after Razorpay Checkout succeeds.
export async function verifyPayment(appId, body) {
  const paymentId = requiredString(body.razorpay_payment_id, 'razorpay_payment_id')
  const orderId = requiredString(body.razorpay_order_id, 'razorpay_order_id')
  const signature = requiredString(body.razorpay_signature, 'razorpay_signature')
  log.info('VERIFY REQUEST', { app: appId, order_id: orderId, payment_id: paymentId })

  // 1. Verify signature: proves the payment/order pair really came from Razorpay.
  if (!checkoutSignatureValid(orderId, paymentId, signature)) {
    log.warn('SIGNATURE INVALID', { order_id: orderId, payment_id: paymentId })
    throw new ApiError(400, 'SIGNATURE_INVALID', 'Signature verification failed. Payment NOT saved.')
  }

  // 2. The order must have been created through this service by the same app.
  const order = assertOwnedBy(await orders.find(orderId), appId, 'ORDER_NOT_FOUND', 'Order')

  // 3. Fetch the payment from Razorpay (server-to-server, trusted source).
  let rzpPayment
  try {
    rzpPayment = await razorpay().payments.fetch(paymentId)
  } catch (err) {
    log.error('PAYMENT FETCH FAILED', { payment_id: paymentId, reason: razorpayErrorMessage(err) })
    throw gatewayError('Signature valid, but fetching payment from Razorpay failed', err)
  }
  if (rzpPayment.order_id !== orderId) {
    throw new ApiError(400, 'ORDER_MISMATCH', 'Payment does not belong to this order.')
  }

  // 4. Save.
  const { record, alreadySaved } = await recordPayment(rzpPayment, order, { via: 'checkout', signature })
  log.ok('VERIFIED', {
    payment_id: record.payment_id, order_id: record.order_id, reference_id: record.reference_id,
    status: record.status, amount: money(record.amount, record.currency), already_saved: alreadySaved,
  })
  return {
    verified: true,
    already_saved: alreadySaved,
    payment_id: record.payment_id,
    order_id: record.order_id,
    reference_id: record.reference_id,
    status: record.status,
    amount: record.amount,
    currency: record.currency,
  }
}

export async function listPayments(appId, { status, limit, offset }) {
  const all = (await payments.where({ app_id: appId, status: status || undefined }))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) // newest first
  return { items: all.slice(offset, offset + limit), total: all.length, limit, offset }
}

export async function getPayment(appId, paymentId) {
  return assertOwnedBy(await payments.find(paymentId), appId, 'PAYMENT_NOT_FOUND', 'Payment')
}

// ---------------------------------------------------------------- webhooks

const PAYMENT_EVENTS = new Set(['payment.authorized', 'payment.captured', 'payment.failed', 'order.paid'])

// Razorpay -> this service. Records payments even if the user closed the browser before verify ran.
export async function handleWebhook(event) {
  log.info('WEBHOOK', { event: event?.event, payment_id: event?.payload?.payment?.entity?.id })
  if (!PAYMENT_EVENTS.has(event?.event)) {
    log.info('WEBHOOK SKIPPED', { event: event?.event })
    return { handled: false, reason: `Event ${event?.event} is not processed.` }
  }
  const rzpPayment = event.payload?.payment?.entity
  if (!rzpPayment?.id || !rzpPayment.order_id) {
    return { handled: false, reason: 'Event has no payment entity.' }
  }
  const order = await orders.find(rzpPayment.order_id)
  if (!order) {
    log.warn('WEBHOOK SKIPPED', { event: event.event, order_id: rzpPayment.order_id, reason: 'unknown order' })
    return { handled: false, reason: 'Order was not created through this service.' }
  }
  const { record } = await recordPayment(rzpPayment, order, { via: `webhook:${event.event}` })
  return { handled: true, payment_id: record.payment_id, status: record.status }
}
