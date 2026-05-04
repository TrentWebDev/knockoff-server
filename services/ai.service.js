const Anthropic = require('@anthropic-ai/sdk')
const { PrismaClient } = require('@prisma/client')
const { addDays, format, addHours } = require('date-fns')

const prisma = new PrismaClient()
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── CUSTOMER-FACING AI TOOLS ────────────────────────────────────────────────
const CUSTOMER_TOOLS = [
  {
    name: 'check_service_area',
    description: 'Check if a suburb is within the tradies service area',
    input_schema: {
      type: 'object',
      properties: { suburb: { type: 'string', description: 'Suburb name to check' } },
      required: ['suburb']
    }
  },
  {
    name: 'check_availability',
    description: 'Get available appointment slots for the next 2 weeks',
    input_schema: {
      type: 'object',
      properties: {
        preferred_date: { type: 'string', description: 'Preferred date (ISO 8601)' },
        preferred_time: { type: 'string', enum: ['morning', 'afternoon', 'any'] },
        duration_hours: { type: 'number', description: 'Estimated job duration in hours' }
      },
      required: ['duration_hours']
    }
  },
  {
    name: 'book_appointment',
    description: 'Create a confirmed appointment in the system',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        customer_phone: { type: 'string' },
        customer_email: { type: 'string' },
        address: { type: 'string' },
        suburb: { type: 'string' },
        job_type: { type: 'string', enum: ['quote_inspection', 'repair', 'installation', 'switchboard', 'safety_inspection', 'emergency', 'other'] },
        description: { type: 'string' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime for the appointment' },
        duration_minutes: { type: 'number' },
        notes: { type: 'string' }
      },
      required: ['customer_name', 'customer_phone', 'address', 'suburb', 'job_type', 'description', 'scheduled_at']
    }
  },
  {
    name: 'send_emergency_alert',
    description: 'Immediately alert the tradie about an emergency situation',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        customer_phone: { type: 'string' },
        address: { type: 'string' },
        issue: { type: 'string', description: 'Emergency description' },
        immediate_danger: { type: 'boolean' }
      },
      required: ['customer_phone', 'address', 'issue']
    }
  },
  {
    name: 'create_lead',
    description: 'Log a customer enquiry that cannot be immediately booked',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        customer_phone: { type: 'string' },
        customer_email: { type: 'string' },
        suburb: { type: 'string' },
        job_description: { type: 'string' },
        urgency: { type: 'string', enum: ['immediate', 'this_week', 'flexible'] },
        notes: { type: 'string' }
      },
      required: ['customer_phone', 'job_description']
    }
  }
]

function buildCustomerSystemPrompt(business) {
  const hours = business.workingDays?.length > 0
    ? `Mon–Fri ${business.workingHoursStart}–${business.workingHoursEnd}`
    : 'Monday to Friday'

  return `You are the virtual assistant for ${business.name}, a professional ${business.tradeType} business based in ${business.suburb}, ${business.state}, Australia.

Your job: Handle inbound customer enquiries. Book jobs. Alert the tradie. Never leave a customer without a clear next step.

TONE: Warm, professional, Australian. Use natural Australian expressions. Keep messages concise — one thought at a time, one question at a time. Address customers by first name once you know it.

BUSINESS DETAILS:
- Trade: ${business.tradeType}
- Location: ${business.suburb}, ${business.state}
- Service area: ${business.serviceSuburbs?.length > 0 ? business.serviceSuburbs.join(', ') : business.suburb + ' and surrounds (within ' + business.serviceRadius + 'km)'}
- Business hours: ${hours}
- Services: ${business.aiServices?.length > 0 ? business.aiServices.join(', ') : 'General ' + business.tradeType + ' work'}
- Emergency callouts: ${business.emergencyRate > 0 ? 'Available — after-hours rates apply' : 'Refer to emergency services'}

PROCESS:
1. Greet the customer
2. Understand what they need
3. EMERGENCY? → Collect name, address, phone quickly → send_emergency_alert immediately → tell them tradie will call within minutes
4. QUOTE/BOOKING? → Collect: full name, property address, suburb, nature of work, timeframe → check_service_area → check_availability → book_appointment
5. OUT OF AREA? → Apologize, suggest masterelectricians.com.au or hipages.com.au
6. GENERAL ENQUIRY? → Answer helpfully, collect contact details, log as lead

RULES:
- NEVER quote prices (say "prices depend on the job — [name] will give you an exact quote")
- NEVER lie about availability — always use check_availability tool first
- NEVER book without collecting: full name, phone number, address
- ONE question at a time
- If unsure about the suburb → use check_service_area tool
- Current date: ${new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`
}

async function runCustomerAI({ business, messages, conversationId }) {
  const system = buildCustomerSystemPrompt(business)

  const toolHandlers = {
    check_service_area: async ({ suburb }) => {
      const serviceArea = business.serviceSuburbs || []
      const inArea = serviceArea.length === 0 ||
        serviceArea.some(s => s.toLowerCase().includes(suburb.toLowerCase()) || suburb.toLowerCase().includes(s.toLowerCase()))
      return { in_area: inArea, service_area: serviceArea, suburb }
    },

    check_availability: async ({ preferred_date, preferred_time, duration_hours }) => {
      const jobs = await prisma.job.findMany({
        where: {
          businessId: business.id,
          scheduledAt: { gte: new Date(), lte: addDays(new Date(), 14) },
          status: { not: 'CANCELLED' }
        },
        select: { scheduledAt: true, durationMinutes: true }
      })

      const slots = []
      let d = new Date()
      d.setHours(0, 0, 0, 0)

      while (slots.length < 4 && d < addDays(new Date(), 14)) {
        d = addDays(d, 1)
        const DOW_STRINGS = ['SUN','MON','TUE','WED','THU','FRI','SAT']
        const dow = d.getDay()
        const dowStr = DOW_STRINGS[dow]
        const workingDays = business.workingDays || ['MON','TUE','WED','THU','FRI']
        const isWorkingDay = Array.isArray(workingDays) &&
          (typeof workingDays[0] === 'string' ? workingDays.includes(dowStr) : workingDays.includes(dow))
        if (!isWorkingDay) continue

        const startHour = parseInt(business.workingHoursStart?.split(':')[0] || '7')
        const endHour = parseInt(business.workingHoursEnd?.split(':')[0] || '17')

        for (let hour = startHour; hour <= endHour - duration_hours; hour += 1) {
          const slotStart = new Date(d)
          slotStart.setHours(hour, 0, 0, 0)
          const slotEnd = addHours(slotStart, duration_hours + (business.jobBufferMinutes / 60))

          const conflict = jobs.some(job => {
            const jobStart = new Date(job.scheduledAt)
            const jobEnd = addHours(jobStart, job.durationMinutes / 60 + business.jobBufferMinutes / 60)
            return slotStart < jobEnd && slotEnd > jobStart
          })

          if (!conflict) {
            slots.push({
              datetime: slotStart.toISOString(),
              label: slotStart.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) + ` at ${hour > 12 ? hour - 12 : hour}${hour >= 12 ? 'pm' : 'am'}`
            })
            if (slots.length >= 3) break
          }
        }
      }
      return { available_slots: slots.slice(0, 3) }
    },

    book_appointment: async (input) => {
      // Find or create customer
      let customer = await prisma.customer.findFirst({
        where: { businessId: business.id, phone: input.customer_phone }
      })
      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            businessId: business.id,
            firstName: input.customer_name.split(' ')[0],
            lastName: input.customer_name.split(' ').slice(1).join(' ') || '',
            phone: input.customer_phone,
            email: input.customer_email,
            address: input.address,
            suburb: input.suburb
          }
        })
      }

      const job = await prisma.job.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          customerName: input.customer_name,
          customerPhone: input.customer_phone,
          customerEmail: input.customer_email,
          address: input.address,
          suburb: input.suburb,
          jobType: input.job_type,
          description: input.description,
          scheduledAt: new Date(input.scheduled_at),
          durationMinutes: input.duration_minutes || 60,
          notes: input.notes,
          status: 'PENDING'
        }
      })

      // Create notification for tradie
      await prisma.notification.create({
        data: {
          businessId: business.id,
          type: 'new_booking',
          priority: 'info',
          title: 'New Booking',
          body: `${input.customer_name} booked a ${input.job_type} job for ${format(new Date(input.scheduled_at), 'EEEE d MMM')}`,
          actionUrl: `/jobs/${job.id}`
        }
      })

      return {
        success: true,
        job_id: job.id,
        confirmation: `Booked for ${format(new Date(input.scheduled_at), 'EEEE, d MMMM \'at\' h:mma')}`
      }
    },

    send_emergency_alert: async (input) => {
      await prisma.notification.create({
        data: {
          businessId: business.id,
          type: 'emergency',
          priority: 'urgent',
          title: '🚨 EMERGENCY — Immediate Response Required',
          body: `${input.customer_name || 'Customer'} at ${input.address}: ${input.issue}. Phone: ${input.customer_phone}`,
          actionUrl: '/dashboard'
        }
      })

      // Create a job record
      await prisma.job.create({
        data: {
          businessId: business.id,
          customerName: input.customer_name || 'Emergency Customer',
          customerPhone: input.customer_phone,
          address: input.address,
          suburb: '',
          jobType: 'emergency',
          description: input.issue,
          priority: 'EMERGENCY',
          status: 'PENDING'
        }
      })

      return { alerted: true, message: 'Tradie has been alerted immediately' }
    },

    create_lead: async (input) => {
      let customer = await prisma.customer.findFirst({
        where: { businessId: business.id, phone: input.customer_phone }
      })
      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            businessId: business.id,
            firstName: input.customer_name?.split(' ')[0] || 'Unknown',
            lastName: input.customer_name?.split(' ').slice(1).join(' ') || '',
            phone: input.customer_phone,
            email: input.customer_email,
            suburb: input.suburb
          }
        })
      }

      await prisma.notification.create({
        data: {
          businessId: business.id,
          type: 'new_lead',
          priority: 'info',
          title: 'New Lead',
          body: `${input.customer_name || input.customer_phone}: ${input.job_description}`,
          actionUrl: '/customers'
        }
      })

      return { success: true, customer_id: customer.id }
    }
  }

  return callClaudeWithTools(system, messages, CUSTOMER_TOOLS, toolHandlers)
}

// ─── INTERNAL AI (tradie-facing assistant) ───────────────────────────────────
const INTERNAL_TOOLS = [
  {
    name: 'get_business_snapshot',
    description: 'Get key business stats: revenue, outstanding invoices, overdue amounts, upcoming jobs, open quotes',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_invoices',
    description: 'List invoices filtered by status or search query',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['DRAFT', 'SENT', 'VIEWED', 'PAID', 'OVERDUE', 'CANCELLED'] },
        search: { type: 'string', description: 'Search by customer name' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_jobs',
    description: 'List jobs, optionally filtered by status or date range',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] },
        upcoming: { type: 'boolean', description: 'If true, only return upcoming scheduled jobs' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_customers',
    description: 'Search or list customers',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by name, phone, or email' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_quotes',
    description: 'List quotes filtered by status',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'DECLINED', 'EXPIRED'] },
        limit: { type: 'number' }
      }
    }
  }
]

async function runInternalAI({ business, messages, context }) {
  const system = `You are Knock Off AI, the built-in business assistant for ${business.name}.
You help the tradie manage their business: answer questions about invoices, jobs, customers, revenue. Give practical advice.

Business: ${business.name} | ${business.tradeType} | ${business.suburb}, ${business.state}
Hourly rate: $${(business.hourlyRate / 100).toFixed(2)}/hr
Today: ${new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}

IMPORTANT: Use your tools to look up real data before answering questions about invoices, jobs, revenue, customers, or quotes. Never guess or make up numbers.
Be conversational and practical. Give direct, useful answers. Don't be verbose. Use Australian currency.`

  const handlers = {
    get_business_snapshot: async () => {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const [invoices, overdueInvoices, upcomingJobs, openQuotes, paidThisMonth] = await Promise.all([
        prisma.invoice.findMany({ where: { businessId: business.id, status: { in: ['SENT', 'VIEWED'] } }, select: { balanceDueCents: true, customerName: true, invoiceNumber: true, dueDate: true } }),
        prisma.invoice.findMany({ where: { businessId: business.id, status: 'OVERDUE' }, select: { balanceDueCents: true, customerName: true, invoiceNumber: true } }),
        prisma.job.findMany({ where: { businessId: business.id, scheduledAt: { gte: now }, status: { not: 'CANCELLED' } }, orderBy: { scheduledAt: 'asc' }, take: 5, select: { customerName: true, scheduledAt: true, jobType: true, status: true } }),
        prisma.quote.findMany({ where: { businessId: business.id, status: { in: ['SENT', 'VIEWED'] } }, select: { totalCents: true, customerName: true, quoteNumber: true } }),
        prisma.invoice.aggregate({ where: { businessId: business.id, status: 'PAID', paidAt: { gte: monthStart } }, _sum: { paidAmountCents: true, totalCents: true } })
      ])
      const monthRevenue = paidThisMonth._sum.paidAmountCents || paidThisMonth._sum.totalCents || 0
      return {
        monthRevenue: `$${(monthRevenue / 100).toFixed(2)}`,
        outstandingCount: invoices.length,
        outstandingTotal: `$${invoices.reduce((s, i) => s + (i.balanceDueCents || 0), 0) / 100}`,
        overdueCount: overdueInvoices.length,
        overdueTotal: `$${overdueInvoices.reduce((s, i) => s + (i.balanceDueCents || 0), 0) / 100}`,
        overdueInvoices: overdueInvoices.map(i => `${i.customerName} — ${i.invoiceNumber}`),
        upcomingJobs: upcomingJobs.map(j => `${j.customerName} — ${j.jobType} — ${new Date(j.scheduledAt).toLocaleString('en-AU')}`),
        openQuotes: openQuotes.length,
        quotePipeline: `$${openQuotes.reduce((s, q) => s + (q.totalCents || 0), 0) / 100}`
      }
    },
    get_invoices: async ({ status, search, limit = 10 }) => {
      const where = { businessId: business.id }
      if (status) where.status = status
      if (search) where.customerName = { contains: search, mode: 'insensitive' }
      const invoices = await prisma.invoice.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, select: { invoiceNumber: true, customerName: true, status: true, totalCents: true, balanceDueCents: true, dueDate: true, paidAt: true } })
      return invoices.map(i => ({ ...i, total: `$${(i.totalCents / 100).toFixed(2)}`, balance: `$${((i.balanceDueCents || 0) / 100).toFixed(2)}`, dueDate: i.dueDate ? new Date(i.dueDate).toLocaleDateString('en-AU') : null }))
    },
    get_jobs: async ({ status, upcoming, limit = 10 }) => {
      const where = { businessId: business.id }
      if (status) where.status = status
      if (upcoming) where.scheduledAt = { gte: new Date() }
      const jobs = await prisma.job.findMany({ where, orderBy: upcoming ? { scheduledAt: 'asc' } : { createdAt: 'desc' }, take: limit, select: { customerName: true, jobType: true, status: true, scheduledAt: true, address: true, suburb: true } })
      return jobs.map(j => ({ ...j, scheduled: j.scheduledAt ? new Date(j.scheduledAt).toLocaleString('en-AU') : 'unscheduled' }))
    },
    get_customers: async ({ search, limit = 10 }) => {
      const where = { businessId: business.id }
      if (search) where.OR = [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }, { email: { contains: search, mode: 'insensitive' } }]
      const customers = await prisma.customer.findMany({ where, orderBy: { lastJobAt: 'desc' }, take: limit, select: { firstName: true, lastName: true, phone: true, email: true, suburb: true, lastJobAt: true, _count: { select: { jobs: true, invoices: true } } } })
      return customers.map(c => ({ name: `${c.firstName} ${c.lastName}`.trim(), phone: c.phone, email: c.email, suburb: c.suburb, jobs: c._count.jobs, invoices: c._count.invoices, lastJob: c.lastJobAt ? new Date(c.lastJobAt).toLocaleDateString('en-AU') : null }))
    },
    get_quotes: async ({ status, limit = 10 }) => {
      const where = { businessId: business.id }
      if (status) where.status = status
      const quotes = await prisma.quote.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, select: { quoteNumber: true, customerName: true, status: true, totalCents: true, validUntil: true, createdAt: true } })
      return quotes.map(q => ({ ...q, total: `$${(q.totalCents / 100).toFixed(2)}`, validUntil: new Date(q.validUntil).toLocaleDateString('en-AU') }))
    }
  }

  return callClaudeWithTools(system, messages, INTERNAL_TOOLS, handlers, 4)
}

// ─── VOICE INVOICE PARSER ────────────────────────────────────────────────────
async function parseVoiceInvoice({ transcript, business }) {
  const today = new Date().toISOString().split('T')[0]
  const system = `You are an invoice parser for ${business.name}, an Australian ${business.tradeType} business.
Parse voice transcripts into structured invoice data.

Business defaults:
- Hourly rate: $${(business.hourlyRate / 100).toFixed(2)}/hr
- Call-out fee: $${(business.calloutFee / 100).toFixed(2)}
- Material markup: ${Math.round(business.materialMarkup * 100)}%
- GST registered: ${business.gstRegistered ? 'Yes (add 10% GST)' : 'No'}
- Today: ${today}

Extract ALL of: customer name, address, job date, labor (hours and rate), materials (each with description and price), any call-out fees.
Prices in the transcript are EXCLUDING GST unless stated otherwise.
If hourly rate not specified, use the business default.
Respond ONLY with valid JSON matching the schema exactly.`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system,
    messages: [{
      role: 'user',
      content: `Parse this transcript into invoice data:\n\n"${transcript}"\n\nRespond with JSON only:\n{\n  "customer_name": string,\n  "customer_email": string | null,\n  "customer_phone": string | null,\n  "customer_address": string,\n  "job_date": "YYYY-MM-DD",\n  "job_description": string,\n  "line_items": [\n    {\n      "description": string,\n      "quantity": number,\n      "unit_price_cents": integer,\n      "category": "labor"|"materials"|"callout"|"other"\n    }\n  ],\n  "notes": string | null,\n  "needs_clarification": string | null\n}`
    }]
  })

  const text = response.content.find(b => b.type === 'text')?.text || '{}'
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('AI could not parse the transcript')

  const parsed = JSON.parse(jsonMatch[0])

  // Apply material markup
  const lineItems = parsed.line_items.map(item => {
    if (item.category === 'materials' && business.materialMarkup > 0) {
      return { ...item, unit_price_cents: Math.round(item.unit_price_cents * (1 + business.materialMarkup)) }
    }
    return item
  })

  const subtotalCents = lineItems.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_price_cents), 0)
  const gstCents = business.gstRegistered ? Math.round(subtotalCents * 0.1) : 0
  const totalCents = subtotalCents + gstCents

  return {
    ...parsed,
    line_items: lineItems,
    subtotal_cents: subtotalCents,
    gst_cents: gstCents,
    total_cents: totalCents,
    needs_clarification: parsed.needs_clarification || null
  }
}

// ─── CORE CLAUDE TOOL LOOP ───────────────────────────────────────────────────
async function callClaudeWithTools(system, messages, tools, handlers, maxDepth = 5) {
  if (maxDepth === 0) return 'I ran into an issue processing that. Please try again.'

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system,
    tools,
    messages
  })

  if (response.stop_reason === 'tool_use') {
    const toolResults = []
    for (const block of response.content) {
      if (block.type === 'tool_use' && handlers[block.name]) {
        try {
          const result = await handlers[block.name](block.input)
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) })
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: err.message }), is_error: true })
        }
      }
    }
    const newMessages = [...messages, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }]
    return callClaudeWithTools(system, newMessages, tools, handlers, maxDepth - 1)
  }

  return response.content.find(b => b.type === 'text')?.text || ''
}

module.exports = { runCustomerAI, runInternalAI, parseVoiceInvoice }
