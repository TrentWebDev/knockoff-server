const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

router.get('/', async (req, res) => {
  const { search, page = 1, limit = 20 } = req.query
  const where = { businessId: req.businessId }
  if (search) {
    const parts = search.trim().split(/\s+/)
    const nameConditions = parts.length >= 2
      ? [
          // "John Smith" → firstName contains "John" AND lastName contains "Smith"
          { AND: [
            { firstName: { contains: parts[0], mode: 'insensitive' } },
            { lastName: { contains: parts.slice(1).join(' '), mode: 'insensitive' } }
          ]},
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } }
        ]
      : [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } }
        ]
    where.OR = [
      ...nameConditions,
      { phone: { contains: search } },
      { email: { contains: search, mode: 'insensitive' } }
    ]
  }
  try {
    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: [{ lastJobAt: 'desc' }, { createdAt: 'desc' }],
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
        include: { _count: { select: { jobs: true, invoices: true } } }
      }),
      prisma.customer.count({ where })
    ])
    const mapped = customers.map(c => ({
      ...c,
      name: `${c.firstName} ${c.lastName}`.trim(),
      tags: c.isVip ? ['VIP'] : []
    }))
    res.json({ customers: mapped, total })
  } catch (err) { res.status(500).json({ error: 'Failed to load customers' }) }
})

router.get('/:id', async (req, res) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: {
        jobs: { orderBy: { scheduledAt: 'desc' }, take: 10 },
        invoices: { orderBy: { createdAt: 'desc' }, take: 10, include: { lineItems: true } },
        quotes: { orderBy: { createdAt: 'desc' }, take: 5 }
      }
    })
    if (!customer) return res.status(404).json({ error: 'Customer not found' })
    const enriched = { ...customer, name: `${customer.firstName} ${customer.lastName}`.trim(), tags: customer.isVip ? ['VIP'] : [] }
    res.json({ customer: enriched })
  } catch (err) { res.status(500).json({ error: 'Failed to load customer' }) }
})

router.put('/:id', async (req, res) => {
  try {
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!customer) return res.status(404).json({ error: 'Customer not found' })
    const updated = await prisma.customer.update({ where: { id: customer.id }, data: req.body })
    res.json({ customer: updated })
  } catch (err) { res.status(500).json({ error: 'Failed to update customer' }) }
})

router.post('/', async (req, res) => {
  try {
    const { firstName, lastName, phone, email, address, suburb, state, postcode, notes } = req.body
    const customer = await prisma.customer.create({
      data: { businessId: req.businessId, firstName, lastName, phone, email, address, suburb, state, postcode, notes }
    })
    res.status(201).json({ customer })
  } catch (err) { res.status(500).json({ error: 'Failed to create customer' }) }
})

router.delete('/:id', async (req, res) => {
  try {
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, businessId: req.businessId } })
    if (!customer) return res.status(404).json({ error: 'Customer not found' })
    await prisma.customer.delete({ where: { id: customer.id } })
    res.json({ success: true })
  } catch (err) {
    if (err.code === 'P2003') return res.status(409).json({ error: 'Cannot delete — customer has jobs or invoices. Archive them first.' })
    res.status(500).json({ error: 'Failed to delete customer' })
  }
})

module.exports = router
