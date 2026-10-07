// /pay — the hosted payment page. A client app creates an order (POST /api/v1/orders),
// gets back payment_url, and sends the customer there. This page opens Razorpay Checkout,
// verifies the payment with this service, then shows a receipt or returns to callback_url.
import { Router } from 'express'
import { config, razorpayConfigured } from '../config/env.js'
import { ApiError, ok } from '../lib/api-error.js'
import { log } from '../lib/log.js'
import { jsonBody, requireRazorpay } from '../middleware/index.js'
import * as service from '../services/payment-service.js'

const router = Router()

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// JSON that is safe to place inside <script>.
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '')

// Amount in the currency's smallest unit (paise, cents, ...) -> "₹1,500.50".
function formatAmount(minor, currency) {
  const format = new Intl.NumberFormat('en-IN', { style: 'currency', currency })
  return format.format(minor / 10 ** format.resolvedOptions().maximumFractionDigits)
}

const STYLE = `
  :root { --bg:#f4f5f7; --card:#fff; --text:#111827; --muted:#6b7280; --line:#e5e7eb; --brand:#2563eb; --brand-ink:#fff; --ok:#047857; --ok-bg:#ecfdf5; --bad:#b91c1c; --bad-bg:#fef2f2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f17; --card:#131a26; --text:#f3f4f6; --muted:#9ca3af; --line:#253042; --brand:#3b82f6; --ok:#34d399; --ok-bg:#062a1f; --bad:#f87171; --bad-bg:#2a0d0d; } }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .card { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px 24px; }
  .label { font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0; }
  .amount { font-size:34px; font-weight:700; margin:4px 0 18px; font-variant-numeric:tabular-nums; }
  dl { margin:0 0 22px; border-top:1px solid var(--line); }
  dl div { display:flex; justify-content:space-between; gap:16px; padding:10px 0; border-bottom:1px solid var(--line); }
  dt { color:var(--muted); } dd { margin:0; text-align:right; word-break:break-all; }
  button { width:100%; padding:13px; border:0; border-radius:10px; background:var(--brand); color:var(--brand-ink); font:inherit; font-weight:600; cursor:pointer; }
  button[disabled] { opacity:.6; cursor:default; }
  .msg { display:none; margin:0 0 16px; padding:10px 12px; border-radius:8px; }
  .msg.ok { display:block; background:var(--ok-bg); color:var(--ok); }
  .msg.bad { display:block; background:var(--bad-bg); color:var(--bad); }
  .foot { margin:16px 0 0; text-align:center; font-size:12px; color:var(--muted); }
`

function page({ title, body, script = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
${script}
</body>
</html>`
}

function errorPage(res, status, message) {
  res.status(status).type('html').send(page({
    title: 'Payment',
    body: `<main class="card"><p class="label">Payment</p><p class="msg bad">${escapeHtml(message)}</p></main>`,
  }))
}

router.get('/:orderId', async (req, res) => {
  if (!razorpayConfigured()) return errorPage(res, 503, 'Payments are not available right now. Please try again later.')
  let order
  try {
    order = await service.getCheckoutOrder(req.params.orderId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return errorPage(res, 404, 'This payment link is not valid.')
    throw err
  }

  const paid = order.status === 'paid'
  log.info('PAY PAGE OPENED', { order_id: order.order_id, reference_id: order.reference_id, status: order.status })
  const rows = [
    ['Reference', order.reference_id],
    ['For', order.description],
    ['Order', order.order_id],
  ].filter(([, v]) => v)

  const checkout = {
    key: config.razorpay.keyId,
    order_id: order.order_id,
    amount: order.amount,
    currency: order.currency,
    name: 'Payment',
    description: order.description ?? order.reference_id ?? '',
    prefill: order.customer ?? {},
    notes: { reference_id: order.reference_id ?? '' },
  }

  res.type('html').send(page({
    title: paid ? 'Payment received' : `Pay ${formatAmount(order.amount, order.currency)}`,
    body: `<main class="card">
  <p class="label">${paid ? 'Paid' : 'Amount to pay'}</p>
  <p class="amount">${escapeHtml(formatAmount(order.amount, order.currency))}</p>
  <dl>${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
  <p id="msg" class="msg${paid ? ' ok' : ''}">${paid ? 'This order has already been paid. Thank you.' : ''}</p>
  ${paid ? '' : '<button id="pay" type="button">Pay now</button>'}
  <p class="foot">Secured by Razorpay</p>
</main>`,
    script: paid ? '' : `<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
(() => {
  const checkout = ${scriptJson(checkout)};
  const callbackUrl = ${scriptJson(order.callback_url ?? null)};
  // Relative, so it stays same-origin whatever host the customer opened the link on.
  const verifyUrl = ${scriptJson(`${encodeURIComponent(order.order_id)}/verify`)};
  const btn = document.getElementById('pay');
  const msg = document.getElementById('msg');
  const show = (text, tone) => { msg.textContent = text; msg.className = 'msg ' + tone; };

  function done(result) {
    btn.remove();
    show('Payment successful. Payment ID: ' + result.payment_id, 'ok');
    if (callbackUrl) {
      const url = new URL(callbackUrl);
      url.searchParams.set('status', 'paid');
      url.searchParams.set('order_id', result.order_id);
      url.searchParams.set('payment_id', result.payment_id);
      if (result.reference_id) url.searchParams.set('reference_id', result.reference_id);
      setTimeout(() => location.assign(url.toString()), 1500);
    }
  }

  async function verify(response) {
    show('Confirming your payment…', 'ok');
    try {
      const res = await fetch(verifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) });
      const body = await res.json();
      if (!body.success) throw new Error(body.error?.message || 'Verification failed.');
      done(body.data);
    } catch (err) {
      btn.disabled = false;
      show('We could not confirm the payment: ' + err.message + ' If money was deducted, it will be confirmed automatically — please do not pay again.', 'bad');
    }
  }

  function open() {
    if (typeof Razorpay === 'undefined') return show('Could not load Razorpay Checkout. Check your connection and reload the page.', 'bad');
    btn.disabled = true;
    const rzp = new Razorpay({
      ...checkout,
      handler: verify,
      modal: { ondismiss: () => { btn.disabled = false; show('Payment was cancelled. You can try again.', 'bad'); } },
    });
    rzp.on('payment.failed', (r) => show('Payment failed: ' + (r.error?.description || 'unknown error') + ' You can try again.', 'bad'));
    rzp.open();
  }

  btn.addEventListener('click', open);
  open();
})();
</script>`,
  }))
})

// Called by the page above after Razorpay Checkout succeeds.
router.post('/:orderId/verify', requireRazorpay, jsonBody, async (req, res) => {
  ok(res, await service.verifyCheckoutPayment(req.params.orderId, req.body))
})

export default router
