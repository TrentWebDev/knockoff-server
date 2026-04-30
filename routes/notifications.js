const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

router.get('/', async (req, res) => {
  const { unread, limit = 30 } = req.query
  const where = { businessId: req.businessId }
  if (unread === 'true') where.readAt = null
  try {
    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit)
    })
    const unreadCount = await prisma.notification.count({ where: { businessId: req.businessId, readAt: null } })
    res.json({ notifications, unreadCount })
  } catch (err) { res.status(500).json({ error: 'Failed to load notifications' }) }
})

router.post('/read-all', async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { businessId: req.businessId, readAt: null },
      data: { readAt: new Date() }
    })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Failed to mark notifications read' }) }
})

router.post('/:id/read', async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, businessId: req.businessId },
      data: { readAt: new Date() }
    })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: 'Failed to mark notification read' }) }
})

module.exports = router
