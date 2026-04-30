const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function log({ businessId, entityType, entityId, action, description, userId, userEmail, metadata }) {
  try {
    await prisma.auditLog.create({
      data: { businessId, entityType, entityId, action, description, userId, userEmail, metadata }
    })
  } catch (e) {
    console.warn('Audit log failed:', e.message)
  }
}

module.exports = { log }
