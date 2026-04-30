const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const { runCustomerAI, runInternalAI, parseVoiceInvoice } = require('../services/ai.service')

const prisma = new PrismaClient()

// POST /api/ai/chat — internal AI assistant (tradie-facing)
router.post('/chat', async (req, res) => {
  const { message, conversationId, messages, context } = req.body
  const businessId = req.businessId
  const business = req.user.business

  try {
    // Build or load conversation history
    let history = messages || []
    let convId = conversationId

    if (convId) {
      const conv = await prisma.conversation.findFirst({
        where: { id: convId, businessId },
        include: { messages: { orderBy: { createdAt: 'asc' } } }
      })
      if (conv) {
        history = conv.messages.map(m => ({ role: m.role, content: m.content }))
      }
    }

    if (message) history = [...history, { role: 'user', content: message }]

    const result = await runInternalAI({ business, messages: history, context })

    // Persist conversation
    if (message) {
      if (!convId) {
        const conv = await prisma.conversation.create({
          data: {
            businessId,
            channel: 'internal',
            status: 'active',
            title: message.substring(0, 60),
            messages: {
              create: [
                { role: 'user', content: message },
                { role: 'assistant', content: result }
              ]
            }
          }
        })
        convId = conv.id
      } else {
        await prisma.message.createMany({
          data: [
            { conversationId: convId, role: 'user', content: message },
            { conversationId: convId, role: 'assistant', content: result }
          ]
        })
        await prisma.conversation.update({
          where: { id: convId },
          data: { updatedAt: new Date() }
        })
      }
    }

    res.json({ reply: result, conversationId: convId })
  } catch (err) {
    console.error('AI chat error:', err)
    res.status(500).json({ error: 'AI failed to respond. Please try again.' })
  }
})

// POST /api/ai/voice-invoice — parse voice transcript to invoice
router.post('/voice-invoice', async (req, res) => {
  const { transcript } = req.body
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' })

  const business = req.user.business
  try {
    const result = await parseVoiceInvoice({ transcript, business })
    res.json(result)
  } catch (err) {
    console.error('Voice invoice error:', err)
    res.status(500).json({ error: 'Failed to parse voice invoice. Please try again.' })
  }
})

// POST /api/ai/customer — inbound customer AI (called from widget/Twilio webhook)
router.post('/customer', async (req, res) => {
  const { businessId: bizId, customerPhone, customerName, message, channel = 'web' } = req.body

  try {
    const business = await prisma.business.findUnique({ where: { id: bizId || req.businessId } })
    if (!business) return res.status(404).json({ error: 'Business not found' })

    // Find or create conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        businessId: business.id,
        customerPhone,
        status: 'active',
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } }
    })

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          businessId: business.id,
          customerPhone,
          customerName,
          channel,
          messages: {
            create: [{
              role: 'user',
              content: message
            }]
          }
        },
        include: { messages: { orderBy: { createdAt: 'asc' } } }
      })
    } else {
      await prisma.message.create({
        data: { conversationId: conversation.id, role: 'user', content: message }
      })
      conversation.messages.push({ role: 'user', content: message })
    }

    const history = conversation.messages.map(m => ({ role: m.role, content: m.content }))

    const reply = await runCustomerAI({
      business,
      messages: history,
      conversationId: conversation.id
    })

    // Save AI reply
    await prisma.message.create({
      data: { conversationId: conversation.id, role: 'assistant', content: reply }
    })

    // Emit real-time update
    if (req.io) {
      req.io.to(`business:${business.id}`).emit('new-message', {
        conversationId: conversation.id,
        customerPhone,
        customerName,
        message,
        reply
      })
    }

    res.json({ reply, conversationId: conversation.id })
  } catch (err) {
    console.error('Customer AI error:', err)
    res.status(500).json({ error: 'AI failed to respond' })
  }
})

// GET /api/ai/conversations
router.get('/conversations', async (req, res) => {
  const { page = 1, limit = 20, status, channel } = req.query
  const skip = (parseInt(page) - 1) * parseInt(limit)
  const where = { businessId: req.businessId }
  if (status) where.status = status
  if (channel) where.channel = channel

  try {
    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        customer: true
      },
      orderBy: { updatedAt: 'desc' },
      skip,
      take: parseInt(limit)
    })
    res.json({ conversations })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load conversations' })
  }
})

// GET /api/ai/conversations/:id
router.get('/conversations/:id', async (req, res) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, businessId: req.businessId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        customer: true
      }
    })
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
    res.json({ conversation })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load conversation' })
  }
})

module.exports = router
