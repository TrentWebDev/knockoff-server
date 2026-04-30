const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  const passwordHash = await bcrypt.hash('password123', 12)

  // Create user + business
  const user = await prisma.user.upsert({
    where: { email: 'demo@knockoff.com.au' },
    update: {},
    create: {
      email: 'demo@knockoff.com.au',
      passwordHash,
      firstName: 'Dave',
      lastName: 'Smith',
      phone: '0412345678',
      emailVerified: true,
    }
  })

  const business = await prisma.business.upsert({
    where: { id: 'seed-business-1' },
    update: {},
    create: {
      id: 'seed-business-1',
      name: "Dave's Electrical Services",
      abn: '12345678901',
      tradeType: 'ELECTRICIAN',
      phone: '0412345678',
      email: 'demo@knockoff.com.au',
      suburb: 'Surry Hills',
      state: 'NSW',
      hourlyRate: 12000,
      emergencyRate: 20000,
      calloutFee: 9000,
      materialMarkup: 0.2,
      invoicePrefix: 'INV',
      nextInvoiceNumber: 4,
      paymentTermsDays: 7,
      bankName: 'Commonwealth Bank',
      bankBsb: '062-000',
      bankAccount: '12345678',
      workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      workingHoursStart: '07:00',
      workingHoursEnd: '17:00',
      subscriptionTier: 'GROWING',
      subscriptionStatus: 'active',
      users: { connect: { id: user.id } }
    }
  })

  // Update user with businessId
  await prisma.user.update({
    where: { id: user.id },
    data: { businessId: business.id }
  })

  // Create customers
  const customer1 = await prisma.customer.upsert({
    where: { id: 'seed-customer-1' },
    update: {},
    create: {
      id: 'seed-customer-1',
      businessId: business.id,
      firstName: 'Sarah',
      lastName: 'Johnson',
      email: 'sarah@example.com',
      phone: '0411111111',
      address: '45 Maple Street',
      suburb: 'Newtown',
      state: 'NSW',
      lastJobAt: new Date(Date.now() - 7 * 86400000)
    }
  })

  const customer2 = await prisma.customer.upsert({
    where: { id: 'seed-customer-2' },
    update: {},
    create: {
      id: 'seed-customer-2',
      businessId: business.id,
      firstName: 'Mike',
      lastName: 'Chen',
      email: 'mike@example.com',
      phone: '0422222222',
      address: '12 Ocean Drive',
      suburb: 'Bondi',
      state: 'NSW',
      isVip: true,
      totalSpend: 450000,
      lastJobAt: new Date(Date.now() - 30 * 86400000)
    }
  })

  // Create jobs
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)

  const inTwoDays = new Date()
  inTwoDays.setDate(inTwoDays.getDate() + 2)
  inTwoDays.setHours(11, 0, 0, 0)

  await prisma.job.upsert({
    where: { id: 'seed-job-1' },
    update: {},
    create: {
      id: 'seed-job-1',
      businessId: business.id,
      customerId: customer1.id,
      customerName: 'Sarah Johnson',
      customerPhone: '0411111111',
      customerEmail: 'sarah@example.com',
      address: '45 Maple Street',
      suburb: 'Newtown',
      jobType: 'ELECTRICAL',
      description: 'Switchboard upgrade — replace old fuse board with new 24-way circuit breaker board',
      scheduledAt: tomorrow,
      durationMinutes: 180,
      priority: 'NORMAL',
      status: 'CONFIRMED'
    }
  })

  await prisma.job.upsert({
    where: { id: 'seed-job-2' },
    update: {},
    create: {
      id: 'seed-job-2',
      businessId: business.id,
      customerName: 'Emergency Call',
      customerPhone: '0400000000',
      address: '77 Pacific Highway',
      suburb: 'Chatswood',
      jobType: 'ELECTRICAL',
      description: 'Power outage to entire home — investigate and restore power',
      scheduledAt: new Date(Date.now() + 2 * 3600000),
      durationMinutes: 120,
      priority: 'EMERGENCY',
      status: 'CONFIRMED'
    }
  })

  // Create paid invoice
  await prisma.invoice.upsert({
    where: { id: 'seed-invoice-1' },
    update: {},
    create: {
      id: 'seed-invoice-1',
      businessId: business.id,
      customerId: customer2.id,
      invoiceNumber: 'INV-0001',
      customerName: 'Mike Chen',
      customerEmail: 'mike@example.com',
      customerPhone: '0422222222',
      customerAddress: '12 Ocean Drive, Bondi NSW',
      subtotalCents: 133000,
      gstCents: 13300,
      totalCents: 146300,
      balanceDueCents: 0,
      dueDate: new Date(Date.now() - 14 * 86400000),
      status: 'PAID',
      paidAt: new Date(Date.now() - 7 * 86400000),
      paidAmountCents: 146300,
      lineItems: {
        create: [
          { description: 'Labour (4hrs)', quantity: 4, unitPriceCents: 12000, totalCents: 48000, category: 'labour' },
          { description: 'Complete rewire — 3 bedroom home', quantity: 1, unitPriceCents: 75000, totalCents: 75000, category: 'labour' },
          { description: 'Cable and materials', quantity: 1, unitPriceCents: 10000, totalCents: 10000, category: 'materials' }
        ]
      }
    }
  })

  // Create overdue invoice
  await prisma.invoice.upsert({
    where: { id: 'seed-invoice-2' },
    update: {},
    create: {
      id: 'seed-invoice-2',
      businessId: business.id,
      customerId: customer1.id,
      invoiceNumber: 'INV-0002',
      customerName: 'Sarah Johnson',
      customerEmail: 'sarah@example.com',
      customerPhone: '0411111111',
      customerAddress: '45 Maple Street, Newtown NSW',
      subtotalCents: 45000,
      gstCents: 4500,
      totalCents: 49500,
      balanceDueCents: 49500,
      dueDate: new Date(Date.now() - 10 * 86400000),
      sentAt: new Date(Date.now() - 17 * 86400000),
      status: 'OVERDUE',
      lineItems: {
        create: [
          { description: 'Labour (3hrs)', quantity: 3, unitPriceCents: 12000, totalCents: 36000, category: 'labour' },
          { description: 'Safety switch installation', quantity: 1, unitPriceCents: 9000, totalCents: 9000, category: 'materials' }
        ]
      }
    }
  })

  // Create draft invoice
  await prisma.invoice.upsert({
    where: { id: 'seed-invoice-3' },
    update: {},
    create: {
      id: 'seed-invoice-3',
      businessId: business.id,
      invoiceNumber: 'INV-0003',
      customerName: 'Peter Williams',
      customerEmail: 'peter@example.com',
      customerPhone: '0433333333',
      subtotalCents: 85000,
      gstCents: 8500,
      totalCents: 93500,
      balanceDueCents: 93500,
      dueDate: new Date(Date.now() + 7 * 86400000),
      status: 'DRAFT',
      lineItems: {
        create: [
          { description: 'Labour (5hrs)', quantity: 5, unitPriceCents: 12000, totalCents: 60000, category: 'labour' },
          { description: '24-way Schneider board', quantity: 1, unitPriceCents: 25000, totalCents: 25000, category: 'materials' }
        ]
      }
    }
  })

  // Create open quote
  await prisma.quote.upsert({
    where: { id: 'seed-quote-1' },
    update: {},
    create: {
      id: 'seed-quote-1',
      businessId: business.id,
      quoteNumber: 'QUO-001',
      customerName: 'Janet Lee',
      customerEmail: 'janet@example.com',
      customerPhone: '0444444444',
      customerAddress: '88 Park Road, Randwick NSW',
      jobDescription: 'Full home rewire — 4 bedroom home, circa 1975. Replace old wiring throughout.',
      validUntil: new Date(Date.now() + 21 * 86400000),
      status: 'SENT',
      sentAt: new Date(Date.now() - 3 * 86400000),
      subtotalCents: 450000,
      gstCents: 45000,
      totalCents: 495000,
      lineItems: {
        create: [
          { description: 'Labour — full rewire (est. 30hrs)', quantity: 30, unitPriceCents: 12000, totalCents: 360000, category: 'labour', sortOrder: 0 },
          { description: 'Cable and materials — 4BR home', quantity: 1, unitPriceCents: 90000, totalCents: 90000, category: 'materials', sortOrder: 1 }
        ]
      }
    }
  })

  // Create notification
  await prisma.notification.create({
    data: {
      businessId: business.id,
      type: 'invoice_overdue',
      priority: 'warning',
      title: 'Invoice INV-0002 is overdue',
      body: 'Sarah Johnson owes $495.00 — 10 days overdue. Consider sending a reminder.',
      actionUrl: '/invoices/seed-invoice-2'
    }
  })

  console.log('Seed complete!')
  console.log('Login: demo@knockoff.com.au / password123')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
