// Centralized payment service: entry point.
import { app } from './src/app.js'
import { config, razorpayConfigured, webhookConfigured } from './src/config/env.js'
import { initStore, storeName } from './src/store/index.js'

try {
  await initStore()
} catch (err) {
  console.error(`Could not connect to the database (${storeName}): ${err.message}`)
  process.exit(1)
}

app.listen(config.port, (err) => {
  // Express 5 hands listen errors (e.g. EADDRINUSE: port taken by another instance) to this callback.
  if (err) {
    console.error(`Could not start on port ${config.port}: ${err.message}`)
    process.exit(1)
  }
  console.log(`Payment service running on http://localhost:${config.port}/api/v1`)
  console.log(`Registered apps: ${config.appIds.join(', ')}`)
  console.log(`Storage: ${storeName}`)
  if (!razorpayConfigured()) console.warn('Warning: Razorpay keys are not configured in backend/.env')
  if (!webhookConfigured()) console.warn('Note: RAZORPAY_WEBHOOK_SECRET not set, /api/v1/webhooks/razorpay is disabled')
})
