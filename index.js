require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const { createServer } = require('http')
const { Server } = require('socket.io')
const rateLimit = require('express-rate-limit')

const authRoutes = require('./routes/auth')
const businessRoutes = require('./routes/business')
const jobRoutes = require('./routes/jobs')
const invoiceRoutes = require('./routes/invoices')
const quoteRoutes = require('./routes/quotes')
const customerRoutes = require('./routes/customers')
const aiRoutes = require('./routes/ai')
const calendarRoutes = require('./routes/calendar')
const webhookRoutes = require('./routes/webhooks')
const billingRoutes = require('./routes/billing')
const notificationRoutes = require('./routes/notifications')
const dashboardRoutes = require('./routes/dashboard')
const stripeConnectRoutes = require('./routes/stripe-connect')
const reportsRoutes = require('./routes/reports')
const accountantRoutes = require('./routes/accountant')
const xeroRoutes = require('./routes/xero')

const { verifyToken } = require('./middleware/auth')
const { scheduleJobs } = require('./services/scheduler.service')

const app = express()
app.set('trust proxy', true) // Railway sits behind nginx — req.protocol returns https correctly
const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true
  }
})

// Attach io to requests
app.use((req, res, next) => {
  req.io = io
  next()
})

// Security
app.use(helmet({ contentSecurityPolicy: false }))
const allowedOrigins = [
  process.env.CLIENT_URL,
  'https://knockoff-server-production.up.railway.app'
].filter(Boolean)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(null, true) // allow all during development
  },
  credentials: true
}))

// Raw body for Stripe webhooks (must be before express.json)
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
})
app.use('/api/', limiter)

// Public routes
app.use('/api/auth', authRoutes)
app.use('/api/calendar', calendarRoutes)

// Public invoice view (token-based, no auth)
app.get('/api/invoices/view/:token', async (req, res) => {
  try {
    const invoice = await _prisma.invoice.findUnique({
      where: { publicViewToken: req.params.token },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        business: {
          select: {
            name: true, abn: true, phone: true, email: true,
            address: true, suburb: true, state: true, postcode: true,
            logoUrl: true, gstRegistered: true,
            bankName: true, bankBsb: true, bankAccount: true
          }
        }
      }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
    if (!invoice.viewedAt) {
      await _prisma.invoice.update({
        where: { id: invoice.id },
        data: { viewedAt: new Date(), status: invoice.status === 'SENT' ? 'VIEWED' : invoice.status }
      })
    }
    const { publicViewToken, stripePaymentIntentId, ...safe } = invoice
    res.json({ invoice: safe })
  } catch { res.status(500).json({ error: 'Failed to load invoice' }) }
})

// Public quote view (UUID-based, no auth)
app.get('/api/quotes/view/:id', async (req, res) => {
  try {
    const quote = await _prisma.quote.findUnique({
      where: { id: req.params.id },
      include: {
        lineItems: { orderBy: { sortOrder: 'asc' } },
        business: { select: { name: true, abn: true, phone: true, email: true, address: true, suburb: true, state: true, logoUrl: true } }
      }
    })
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    res.json({ quote })
  } catch { res.status(500).json({ error: 'Failed to load quote' }) }
})

// Xero OAuth callback (public — Xero redirects here after OAuth)
const axios = require('axios')
app.get('/api/xero/callback', async (req, res) => {
  const { code, state: businessId, error } = req.query
  // Always derive URL from request in production — avoids SERVER_URL=localhost misconfiguration
  const host = req.get('host')
  const scheme = host.includes('localhost') ? 'http' : 'https'
  const baseUrl = `${scheme}://${host}`
  if (error || !code) return res.redirect(`${baseUrl}/settings?xero=error&tab=integrations`)
  try {
    const redirectUri = `${baseUrl}/api/xero/callback`
    const tokenRes = await axios.post('https://identity.xero.com/connect/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      { auth: { username: process.env.XERO_CLIENT_ID, password: process.env.XERO_CLIENT_SECRET } }
    )
    const { access_token, refresh_token, expires_in } = tokenRes.data
    const connectionsRes = await axios.get('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${access_token}` }
    })
    const tenant = connectionsRes.data[0]
    await _prisma.business.update({
      where: { id: businessId },
      data: {
        xeroConnectId: tenant?.tenantId, xeroTenantId: tenant?.tenantId,
        xeroAccessToken: access_token, xeroRefreshToken: refresh_token,
        xeroTokenExpiry: new Date(Date.now() + expires_in * 1000)
      }
    })
    res.redirect(`${baseUrl}/settings?xero=connected&tab=integrations`)
  } catch (err) {
    console.error('Xero callback error:', err.response?.data || err.message)
    res.redirect(`${baseUrl}/settings?xero=error&tab=integrations`)
  }
})

// Public job endpoints (customer-facing, no auth)
const { PrismaClient } = require('@prisma/client')
const _prisma = new PrismaClient()

app.get('/api/jobs/:id/public', async (req, res) => {
  try {
    const job = await _prisma.job.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, customerName: true, jobType: true, address: true,
        suburb: true, scheduledAt: true, durationMinutes: true,
        status: true, confirmedByCustomer: true, customerPhone: true
      }
    })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    res.json({ job: { ...job, customerConfirmed: job.confirmedByCustomer } })
  } catch { res.status(500).json({ error: 'Failed to load job' }) }
})

app.post('/api/jobs/:id/confirm', async (req, res) => {
  const { action } = req.body
  try {
    const job = await _prisma.job.findUnique({ where: { id: req.params.id } })
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (action === 'confirm') {
      await _prisma.job.update({ where: { id: job.id }, data: { status: 'CONFIRMED', confirmedByCustomer: true } })
      await _prisma.notification.create({
        data: {
          businessId: job.businessId, type: 'job_confirmed', priority: 'info',
          title: 'Job Confirmed',
          body: `${job.customerName} confirmed their job`,
          actionUrl: `/jobs/${job.id}`
        }
      }).catch(() => {})
    } else {
      await _prisma.job.update({ where: { id: job.id }, data: { status: 'CANCELLED' } })
    }
    res.json({ success: true })
  } catch { res.status(500).json({ error: 'Failed to update job' }) }
})

// Protected routes
app.use('/api/dashboard', verifyToken, dashboardRoutes)
app.use('/api/business', verifyToken, businessRoutes)
app.use('/api/jobs', verifyToken, jobRoutes)
app.use('/api/invoices', verifyToken, invoiceRoutes)
app.use('/api/quotes', verifyToken, quoteRoutes)
app.use('/api/customers', verifyToken, customerRoutes)
app.use('/api/ai', verifyToken, aiRoutes)
app.use('/api/billing', verifyToken, billingRoutes)
app.use('/api/stripe', verifyToken, stripeConnectRoutes)
app.use('/api/reports', verifyToken, reportsRoutes)
app.use('/api/accountant', verifyToken, accountantRoutes)
app.use('/api/xero', verifyToken, xeroRoutes)
app.use('/api/notifications', verifyToken, notificationRoutes)

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

// Serve React frontend (static files + SPA fallback)
const path = require('path')
app.use(express.static(path.join(__dirname, 'public')))
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// Socket.io for real-time
io.on('connection', (socket) => {
  socket.on('join-business', (businessId) => {
    socket.join(`business:${businessId}`)
  })
  socket.on('disconnect', () => {})
})

// Start background jobs
scheduleJobs()

const PORT = process.env.PORT || 4000
httpServer.listen(PORT, () => {
  console.log(`Knock Off server running on port ${PORT}`)
})

module.exports = { app, io }
