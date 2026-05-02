const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const axios = require('axios')

const prisma = new PrismaClient()

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID
const XERO_SCOPES = 'openid profile email accounting.transactions accounting.contacts offline_access'

// GET /api/xero/connect-url
router.get('/connect-url', (req, res) => {
  if (!XERO_CLIENT_ID) return res.status(500).json({ error: 'Xero not configured' })
  const baseUrl = `${req.protocol}://${req.get('host')}`
  const redirectUri = `${baseUrl}/api/xero/callback`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: XERO_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XERO_SCOPES,
    state: req.businessId
  })
  res.json({ url: `https://login.xero.com/identity/connect/authorize?${params}` })
})

// GET /api/xero/callback (public route, mounted in index.js)
router.get('/callback', async (req, res) => {
  const { code, state: businessId, error } = req.query
  if (error) return res.redirect(`${process.env.CLIENT_URL}/settings?xero=error&tab=integrations`)

  try {
    const tokenRes = await axios.post('https://identity.xero.com/connect/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: XERO_REDIRECT_URI }),
      { auth: { username: XERO_CLIENT_ID, password: XERO_CLIENT_SECRET } }
    )
    const { access_token, refresh_token, expires_in } = tokenRes.data

    // Get tenant ID
    const connectionsRes = await axios.get('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${access_token}` }
    })
    const tenant = connectionsRes.data[0]

    await prisma.business.update({
      where: { id: businessId },
      data: {
        xeroConnectId: tenant?.tenantId,
        xeroTenantId: tenant?.tenantId,
        xeroAccessToken: access_token,
        xeroRefreshToken: refresh_token,
        xeroTokenExpiry: new Date(Date.now() + expires_in * 1000)
      }
    })

    res.redirect(`${process.env.CLIENT_URL}/settings?xero=connected&tab=integrations`)
  } catch (err) {
    console.error('Xero callback error:', err.response?.data || err.message)
    res.redirect(`${process.env.CLIENT_URL}/settings?xero=error&tab=integrations`)
  }
})

// DELETE /api/xero/disconnect
router.delete('/disconnect', async (req, res) => {
  try {
    await prisma.business.update({
      where: { id: req.businessId },
      data: { xeroConnectId: null, xeroTenantId: null, xeroAccessToken: null, xeroRefreshToken: null, xeroTokenExpiry: null }
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect Xero' })
  }
})

// POST /api/xero/sync/:invoiceId — push single invoice to Xero
router.post('/sync/:invoiceId', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.invoiceId, businessId: req.businessId },
      include: { lineItems: true }
    })
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' })

    const business = req.user.business
    if (!business.xeroAccessToken) return res.status(400).json({ error: 'Xero not connected' })

    const xeroInvoice = {
      Type: 'ACCREC',
      Reference: invoice.invoiceNumber,
      Contact: { Name: invoice.customerName, EmailAddress: invoice.customerEmail || undefined },
      Date: invoice.issueDate.toISOString().split('T')[0],
      DueDate: invoice.dueDate.toISOString().split('T')[0],
      LineAmountTypes: 'Exclusive',
      LineItems: invoice.lineItems.map(li => ({
        Description: li.description,
        Quantity: li.quantity,
        UnitAmount: li.unitPriceCents / 100,
        AccountCode: '200',
        TaxType: 'OUTPUT2'
      })),
      Status: invoice.status === 'PAID' ? 'PAID' : 'AUTHORISED'
    }

    const response = await axios.post(
      'https://api.xero.com/api.xro/2.0/Invoices',
      { Invoices: [xeroInvoice] },
      {
        headers: {
          Authorization: `Bearer ${business.xeroAccessToken}`,
          'xero-tenant-id': business.xeroTenantId,
          'Content-Type': 'application/json'
        }
      }
    )

    const xeroId = response.data.Invoices?.[0]?.InvoiceID
    if (xeroId) {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { xeroInvoiceId: xeroId, xeroSyncedAt: new Date() }
      })
    }

    res.json({ success: true, xeroInvoiceId: xeroId })
  } catch (err) {
    console.error('Xero sync error:', err.response?.data || err.message)
    res.status(500).json({ error: 'Failed to sync to Xero' })
  }
})

// GET /api/xero/status
router.get('/status', (req, res) => {
  const business = req.user.business
  res.json({
    connected: !!business?.xeroConnectId,
    tenantId: business?.xeroTenantId,
    tokenExpiry: business?.xeroTokenExpiry
  })
})

module.exports = router
