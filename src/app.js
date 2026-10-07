// Express app. Only the routes registered here are reachable, so .env and data/*.json are never served.
import express from 'express'
import { cors, errorHandler, notFound, requestLog } from './middleware/index.js'
import pay from './routes/pay.js'
import v1 from './routes/v1/index.js'

export const app = express()
app.disable('x-powered-by')

app.use(requestLog)
app.use(cors)
app.use('/api/v1', v1)
app.use('/pay', pay) // hosted payment page (payment_url)
app.use(notFound)
app.use(errorHandler)
