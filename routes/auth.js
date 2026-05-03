const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
const { body, validationResult } = require('express-validator')
const { verifyToken } = require('../middleware/auth')
const { sendEmail } = require('../services/email.service')
const crypto = require('crypto')

const prisma = new PrismaClient()

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' })
}

const CURRENT_TERMS_VERSION = '1.0'

// POST /api/auth/register
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('phone').trim().notEmpty(),
  body('termsAccepted').equals('true').withMessage('You must accept the Terms of Service')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { email, password, firstName, lastName, phone } = req.body
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress

  try {
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' })

    const passwordHash = await bcrypt.hash(password, 12)
    const verifyToken = crypto.randomBytes(32).toString('hex')

    const user = await prisma.user.create({
      data: {
        email, passwordHash, firstName, lastName, phone, emailVerifyToken: verifyToken,
        termsAcceptedAt: new Date(), termsVersion: CURRENT_TERMS_VERSION, termsIp: clientIp
      }
    })

    const serverUrl = 'https://knockoff-server-production.up.railway.app'
    sendEmail({
      to: email,
      subject: 'Welcome to Knock Off — verify your email',
      template: 'verify-email',
      data: { firstName, verifyUrl: `${serverUrl}/verify-email?token=${verifyToken}` }
    }).catch(err => console.error('Verify email failed:', err.message))

    const token = generateToken(user.id)
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
    })
  } catch (err) {
    console.error('Register error:', err)
    res.status(500).json({ error: 'Registration failed. Please try again.' })
  }
})

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() })

  const { email, password } = req.body
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { business: true }
    })
    if (!user) return res.status(401).json({ error: 'Invalid email or password' })

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' })

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

    const token = generateToken(user.id)
    res.json({
      token,
      termsUpdateRequired: user.termsVersion !== CURRENT_TERMS_VERSION,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        businessId: user.businessId,
        business: user.business,
        termsAcceptedAt: user.termsAcceptedAt,
        termsVersion: user.termsVersion,
        aiDisclaimerAcceptedAt: user.aiDisclaimerAcceptedAt
      }
    })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: 'Login failed. Please try again.' })
  }
})

// POST /api/auth/forgot-password
router.post('/forgot-password', [body('email').isEmail().normalizeEmail()], async (req, res) => {
  const { email } = req.body
  // Respond immediately — never block on email delivery
  res.json({ message: 'If that email exists, a reset link has been sent.' })

  try {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return

    const token = crypto.randomBytes(32).toString('hex')
    const expiry = new Date(Date.now() + 3600000)

    await prisma.user.update({
      where: { id: user.id },
      data: { resetPasswordToken: token, resetPasswordExpiry: expiry }
    })

    const serverUrl = 'https://knockoff-server-production.up.railway.app'
    sendEmail({
      to: email,
      subject: 'Reset your Knock Off password',
      template: 'reset-password',
      data: {
        firstName: user.firstName,
        resetUrl: `${serverUrl}/reset-password?token=${token}`
      }
    }).catch(err => console.error('Reset email failed:', err.message))
  } catch (err) {
    console.error('Forgot password error:', err.message)
  }
})

// POST /api/auth/reset-password
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 })
], async (req, res) => {
  const { token, password } = req.body
  try {
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpiry: { gt: new Date() }
      }
    })
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' })

    const passwordHash = await bcrypt.hash(password, 12)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetPasswordToken: null, resetPasswordExpiry: null }
    })

    res.json({ message: 'Password reset successfully' })
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// GET /api/auth/me
router.get('/me', verifyToken, (req, res) => {
  const { passwordHash, resetPasswordToken, emailVerifyToken, ...user } = req.user
  res.json({ user, termsUpdateRequired: user.termsVersion !== CURRENT_TERMS_VERSION })
})

// POST /api/auth/accept-terms
router.post('/accept-terms', verifyToken, async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { termsAcceptedAt: new Date(), termsVersion: CURRENT_TERMS_VERSION, termsIp: clientIp }
    })
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Failed to record acceptance' })
  }
})

// POST /api/auth/accept-ai-disclaimer
router.post('/accept-ai-disclaimer', verifyToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { aiDisclaimerAcceptedAt: new Date() }
    })
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Failed to record acceptance' })
  }
})

// POST /api/auth/verify-email
router.post('/verify-email', async (req, res) => {
  const { token } = req.body
  try {
    const user = await prisma.user.findFirst({ where: { emailVerifyToken: token } })
    if (!user) return res.status(400).json({ error: 'Invalid verification link' })
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, emailVerifyToken: null } })
    res.json({ message: 'Email verified successfully' })
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' })
  }
})

module.exports = router
