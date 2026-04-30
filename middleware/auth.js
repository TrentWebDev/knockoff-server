const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const token = authHeader.split(' ')[1]
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { business: true }
    })
    if (!user) return res.status(401).json({ error: 'User not found' })
    req.user = user
    req.businessId = user.businessId
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function requireBusiness(req, res, next) {
  if (!req.user.businessId) {
    return res.status(403).json({ error: 'Business profile required' })
  }
  next()
}

module.exports = { verifyToken, requireBusiness }
