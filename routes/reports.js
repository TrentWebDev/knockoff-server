const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const PDFDocument = require('pdfkit')
const { format, startOfMonth, endOfMonth, subMonths, startOfQuarter, endOfQuarter, startOfYear } = require('date-fns')

const prisma = new PrismaClient()

function financialYearStart(date = new Date()) {
  const y = date.getMonth() >= 6 ? date.getFullYear() : date.getFullYear() - 1
  return new Date(`${y}-07-01T00:00:00.000Z`)
}

function parseRange(from, to, period) {
  const now = new Date()
  if (period === 'this_month') return { from: startOfMonth(now), to: endOfMonth(now) }
  if (period === 'last_month') { const lm = subMonths(now, 1); return { from: startOfMonth(lm), to: endOfMonth(lm) } }
  if (period === 'this_quarter') return { from: startOfQuarter(now), to: endOfQuarter(now) }
  if (period === 'this_fy') return { from: financialYearStart(), to: now }
  if (period === 'last_fy') {
    const fyStart = financialYearStart()
    const lastFyStart = new Date(fyStart); lastFyStart.setFullYear(lastFyStart.getFullYear() - 1)
    const lastFyEnd = new Date(fyStart); lastFyEnd.setDate(lastFyEnd.getDate() - 1)
    return { from: lastFyStart, to: lastFyEnd }
  }
  return { from: from ? new Date(from) : financialYearStart(), to: to ? new Date(to) : now }
}

// GET /api/reports/revenue
router.get('/revenue', async (req, res) => {
  const { from, to, period } = req.query
  const { from: dateFrom, to: dateTo } = parseRange(from, to, period)
  const businessId = req.businessId

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        businessId,
        createdAt: { gte: dateFrom, lte: dateTo },
        status: { not: 'CANCELLED' }
      },
      include: { lineItems: true }
    })

    const paid = invoices.filter(i => i.status === 'PAID')
    const outstanding = invoices.filter(i => ['SENT','VIEWED'].includes(i.status))
    const overdue = invoices.filter(i => i.status === 'OVERDUE')
    const draft = invoices.filter(i => i.status === 'DRAFT')

    const sumCents = (arr, field = 'totalCents') => arr.reduce((s, i) => s + (i[field] || 0), 0)
    const sumGst = (arr) => arr.reduce((s, i) => s + (i.gstCents || 0), 0)

    // By category
    const allLineItems = invoices.flatMap(i => i.lineItems)
    const byCategory = {}
    for (const li of allLineItems) {
      const cat = li.category || 'other'
      byCategory[cat] = (byCategory[cat] || 0) + li.totalCents
    }

    // By payment method
    const byPayment = {}
    for (const inv of paid) {
      const method = inv.paymentMethod || 'bank_transfer'
      byPayment[method] = (byPayment[method] || 0) + (inv.paidAmountCents || inv.totalCents)
    }

    const totalRevenue = sumCents(paid)
    const totalGst = sumGst(paid)
    const totalExGst = totalRevenue - totalGst

    res.json({
      period: { from: dateFrom, to: dateTo },
      summary: {
        totalRevenue,
        totalExGst,
        totalGst,
        paidCount: paid.length,
        outstandingTotal: sumCents(outstanding),
        outstandingCount: outstanding.length,
        overdueTotal: sumCents(overdue),
        overdueCount: overdue.length,
        draftTotal: sumCents(draft),
        draftCount: draft.length
      },
      byCategory,
      byPayment,
      invoices: invoices.map(i => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        customerName: i.customerName,
        status: i.status,
        totalCents: i.totalCents,
        gstCents: i.gstCents,
        paidAmountCents: i.paidAmountCents,
        paidAt: i.paidAt,
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        paymentMethod: i.paymentMethod
      }))
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate revenue report' })
  }
})

// GET /api/reports/bas
router.get('/bas', async (req, res) => {
  const { from, to, period } = req.query
  const { from: dateFrom, to: dateTo } = parseRange(from, to, period || 'this_quarter')
  const businessId = req.businessId

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        businessId,
        status: { in: ['SENT','VIEWED','PAID','OVERDUE'] },
        issueDate: { gte: dateFrom, lte: dateTo }
      },
      include: { lineItems: true }
    })

    const g1TotalSalesIncGst = invoices.reduce((s, i) => s + i.totalCents, 0)
    const gstOnSales = invoices.reduce((s, i) => s + i.gstCents, 0)

    res.json({
      period: { from: dateFrom, to: dateTo },
      g1_total_sales_inc_gst: g1TotalSalesIncGst,
      g2_export_sales: 0,
      g3_gst_free_sales: 0,
      g10_capital_purchases: 0,
      g11_non_capital_purchases: 0,
      tax_1a_gst_on_sales: gstOnSales,
      tax_1b_gst_credits: 0,
      net_gst_payable: gstOnSales,
      invoice_count: invoices.length,
      invoices: invoices.map(i => ({
        invoiceNumber: i.invoiceNumber,
        customerName: i.customerName,
        issueDate: i.issueDate,
        totalCents: i.totalCents,
        gstCents: i.gstCents,
        status: i.status
      }))
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate BAS report' })
  }
})

// GET /api/reports/aging
router.get('/aging', async (req, res) => {
  const businessId = req.businessId
  const now = new Date()

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        businessId,
        status: { in: ['SENT','VIEWED','OVERDUE'] }
      }
    })

    const current = [], days1_30 = [], days31_60 = [], days60plus = []

    for (const inv of invoices) {
      const due = new Date(inv.dueDate)
      const daysOverdue = Math.floor((now - due) / 86400000)
      if (daysOverdue <= 0) current.push({ ...inv, daysOverdue: 0 })
      else if (daysOverdue <= 30) days1_30.push({ ...inv, daysOverdue })
      else if (daysOverdue <= 60) days31_60.push({ ...inv, daysOverdue })
      else days60plus.push({ ...inv, daysOverdue })
    }

    const sum = arr => arr.reduce((s, i) => s + i.balanceDueCents, 0)

    res.json({
      current: { total: sum(current), invoices: current },
      days1_30: { total: sum(days1_30), invoices: days1_30 },
      days31_60: { total: sum(days31_60), invoices: days31_60 },
      days60plus: { total: sum(days60plus), invoices: days60plus },
      grandTotal: sum(invoices)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate aging report' })
  }
})

// GET /api/reports/customers
router.get('/customers', async (req, res) => {
  const { from, to, period } = req.query
  const { from: dateFrom, to: dateTo } = parseRange(from, to, period)
  const businessId = req.businessId

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        businessId,
        status: 'PAID',
        paidAt: { gte: dateFrom, lte: dateTo }
      }
    })

    const byCustomer = {}
    for (const inv of invoices) {
      const key = inv.customerId || inv.customerName
      if (!byCustomer[key]) {
        byCustomer[key] = {
          customerId: inv.customerId,
          customerName: inv.customerName,
          invoiceCount: 0,
          totalCents: 0,
          lastPaidAt: null
        }
      }
      byCustomer[key].invoiceCount++
      byCustomer[key].totalCents += inv.paidAmountCents || inv.totalCents
      if (!byCustomer[key].lastPaidAt || inv.paidAt > byCustomer[key].lastPaidAt) {
        byCustomer[key].lastPaidAt = inv.paidAt
      }
    }

    const ranked = Object.values(byCustomer)
      .sort((a, b) => b.totalCents - a.totalCents)
      .map((c, i) => ({ ...c, rank: i + 1, avgInvoiceCents: Math.round(c.totalCents / c.invoiceCount) }))

    const totalRevenue = ranked.reduce((s, c) => s + c.totalCents, 0)
    const top5Revenue = ranked.slice(0, 5).reduce((s, c) => s + c.totalCents, 0)

    res.json({
      period: { from: dateFrom, to: dateTo },
      customers: ranked,
      totalRevenue,
      top5Percentage: totalRevenue > 0 ? Math.round((top5Revenue / totalRevenue) * 100) : 0
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate customer report' })
  }
})

// GET /api/reports/job-types
router.get('/job-types', async (req, res) => {
  const { from, to, period } = req.query
  const { from: dateFrom, to: dateTo } = parseRange(from, to, period)
  const businessId = req.businessId

  try {
    const jobs = await prisma.job.findMany({
      where: {
        businessId,
        status: 'COMPLETED',
        completedAt: { gte: dateFrom, lte: dateTo }
      },
      include: { invoice: true }
    })

    const byType = {}
    for (const job of jobs) {
      const type = job.jobType || 'Other'
      if (!byType[type]) byType[type] = { jobType: type, count: 0, revenueCents: 0 }
      byType[type].count++
      if (job.invoice?.status === 'PAID') {
        byType[type].revenueCents += job.invoice.paidAmountCents || job.invoice.totalCents
      }
    }

    const types = Object.values(byType)
      .sort((a, b) => b.revenueCents - a.revenueCents)
      .map(t => ({ ...t, avgRevenueCents: t.count > 0 ? Math.round(t.revenueCents / t.count) : 0 }))

    res.json({ period: { from: dateFrom, to: dateTo }, jobTypes: types })
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate job type report' })
  }
})

// GET /api/reports/export?format=ato_csv|xero_csv|bas_csv|full_csv
router.get('/export', async (req, res) => {
  const { from, to, period, format: fmt = 'ato_csv', status } = req.query
  const { from: dateFrom, to: dateTo } = parseRange(from, to, period)
  const businessId = req.businessId
  const business = req.user.business

  try {
    const where = {
      businessId,
      createdAt: { gte: dateFrom, lte: dateTo }
    }
    if (status) where.status = status.toUpperCase()

    const invoices = await prisma.invoice.findMany({
      where,
      include: { lineItems: true },
      orderBy: { issueDate: 'asc' }
    })

    let csv = ''
    const q = (s) => `"${String(s || '').replace(/"/g, '""')}"`
    const dollars = (cents) => (cents / 100).toFixed(2)
    const fmtDate = (d) => d ? format(new Date(d), 'dd/MM/yyyy') : ''

    if (fmt === 'ato_csv') {
      csv = 'Invoice Number,Date,Due Date,Customer Name,Customer ABN,Description,Quantity,Unit Price (ex GST),GST Amount,Total (inc GST),Status,Payment Date,Payment Method\n'
      for (const inv of invoices) {
        for (const li of inv.lineItems) {
          csv += [
            q(inv.invoiceNumber), q(fmtDate(inv.issueDate)), q(fmtDate(inv.dueDate)),
            q(inv.customerName), q(inv.customerAbn || ''),
            q(li.description), q(li.quantity), q(dollars(li.unitPriceCents)),
            q(dollars(Math.round(li.totalCents * 0.1))), q(dollars(Math.round(li.totalCents * 1.1))),
            q(inv.status), q(fmtDate(inv.paidAt)), q(inv.paymentMethod || '')
          ].join(',') + '\n'
        }
      }
    } else if (fmt === 'xero_csv') {
      csv = '*ContactName,EmailAddress,POAddressLine1,POCity,PORegion,POPostalCode,POCountry,*InvoiceNumber,Reference,*InvoiceDate,*DueDate,Description,Quantity,UnitAmount,Discount,*AccountCode,*TaxType,TrackingName1,TrackingOption1,Currency\n'
      for (const inv of invoices) {
        for (const li of inv.lineItems) {
          csv += [
            q(inv.customerName), q(inv.customerEmail || ''), q(inv.customerAddress || ''),
            '', '', '', 'AU',
            q(inv.invoiceNumber), '',
            q(fmtDate(inv.issueDate)), q(fmtDate(inv.dueDate)),
            q(li.description), q(li.quantity), q(dollars(li.unitPriceCents)),
            '0', '200', 'GST on Income', '', '', 'AUD'
          ].join(',') + '\n'
        }
      }
    } else if (fmt === 'bas_csv') {
      const gstOnSales = invoices.filter(i => ['SENT','VIEWED','PAID','OVERDUE'].includes(i.status))
        .reduce((s, i) => s + i.gstCents, 0)
      const totalSales = invoices.filter(i => ['SENT','VIEWED','PAID','OVERDUE'].includes(i.status))
        .reduce((s, i) => s + i.totalCents, 0)
      csv = 'BAS Label,Amount\n'
      csv += `G1 - Total Sales (inc GST),$${dollars(totalSales)}\n`
      csv += `G2 - Export Sales,$0.00\n`
      csv += `G3 - Other GST-free Sales,$0.00\n`
      csv += `G10 - Capital Purchases,$0.00\n`
      csv += `G11 - Non-capital Purchases,$0.00\n`
      csv += `1A - GST on Sales,$${dollars(gstOnSales)}\n`
      csv += `1B - GST Credits,$0.00\n`
      csv += `Net GST Payable,$${dollars(gstOnSales)}\n`
      csv += `\nPeriod,${fmtDate(dateFrom)} to ${fmtDate(dateTo)}\n`
      csv += `Generated,${fmtDate(new Date())}\n`
      csv += `Business,${business.name}\n`
      csv += `ABN,${business.abn || ''}\n`
    } else {
      // full_csv
      csv = 'Invoice Number,Issue Date,Due Date,Customer Name,Customer Email,Customer Phone,Customer Address,Status,Subtotal (ex GST),GST,Total (inc GST),Deposit,Balance Due,Paid Amount,Paid Date,Payment Method,Invoice Footer\n'
      for (const inv of invoices) {
        csv += [
          q(inv.invoiceNumber), q(fmtDate(inv.issueDate)), q(fmtDate(inv.dueDate)),
          q(inv.customerName), q(inv.customerEmail || ''), q(inv.customerPhone || ''),
          q(inv.customerAddress || ''), q(inv.status),
          q(dollars(inv.subtotalCents)), q(dollars(inv.gstCents)), q(dollars(inv.totalCents)),
          q(dollars(inv.depositCents)), q(dollars(inv.balanceDueCents)),
          q(dollars(inv.paidAmountCents || 0)), q(fmtDate(inv.paidAt)),
          q(inv.paymentMethod || ''), q(inv.notes || '')
        ].join(',') + '\n'
      }
    }

    const filename = `knockoff-${fmt}-${format(dateFrom, 'yyyy-MM-dd')}-${format(dateTo, 'yyyy-MM-dd')}.csv`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to export data' })
  }
})

// GET /api/reports/audit/:entityId
router.get('/audit/:entityId', async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { entityId: req.params.entityId, businessId: req.businessId },
      orderBy: { createdAt: 'asc' }
    })
    res.json({ logs })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit log' })
  }
})

// GET /api/reports/cash-flow
router.get('/cash-flow', async (req, res) => {
  const businessId = req.businessId
  const now = new Date()
  const thirtyDaysOut = new Date(now); thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30)

  try {
    const [outstanding, bookedJobs] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          businessId,
          status: { in: ['SENT','VIEWED','OVERDUE'] },
          dueDate: { lte: thirtyDaysOut }
        }
      }),
      prisma.job.findMany({
        where: {
          businessId,
          status: { in: ['CONFIRMED','PENDING'] },
          scheduledAt: { gte: now, lte: thirtyDaysOut }
        },
        include: { customer: true }
      })
    ])

    const invoiceEvents = outstanding.map(inv => {
      const daysOverdue = Math.floor((now - new Date(inv.dueDate)) / 86400000)
      let probability = 0.9
      if (daysOverdue > 30) probability = 0.5
      else if (daysOverdue > 0) probability = 0.7
      return {
        type: 'invoice',
        date: inv.dueDate,
        label: `${inv.invoiceNumber} — ${inv.customerName}`,
        amountCents: inv.balanceDueCents,
        expectedCents: Math.round(inv.balanceDueCents * probability),
        probability,
        status: inv.status,
        id: inv.id
      }
    })

    const jobEvents = bookedJobs.map(job => ({
      type: 'job',
      date: job.scheduledAt,
      label: `${job.jobType} — ${job.customerName}`,
      amountCents: null,
      id: job.id
    }))

    const events = [...invoiceEvents, ...jobEvents].sort((a, b) => new Date(a.date) - new Date(b.date))
    const projectedTotal = invoiceEvents.reduce((s, e) => s + e.expectedCents, 0)

    res.json({ events, projectedTotal, period: { from: now, to: thirtyDaysOut } })
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate cash flow' })
  }
})

module.exports = router
