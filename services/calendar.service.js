const { google } = require('googleapis')
const { PrismaClient } = require('@prisma/client')
const { sendSMS } = require('./sms.service')
const { sendEmail } = require('./email.service')
const { format } = require('date-fns')

const prisma = new PrismaClient()

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

function getAuthUrl() {
  const oauth2 = getOAuthClient()
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'
  })
}

async function exchangeCodeForTokens(code) {
  const oauth2 = getOAuthClient()
  const { tokens } = await oauth2.getToken(code)
  return tokens
}

async function getCalendarClient(business) {
  const oauth2 = getOAuthClient()
  oauth2.setCredentials({
    access_token: business.googleAccessToken,
    refresh_token: business.googleRefreshToken,
    expiry_date: business.googleTokenExpiry?.getTime()
  })

  // Auto-refresh if expired
  oauth2.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await prisma.business.update({
        where: { id: business.id },
        data: {
          googleAccessToken: tokens.access_token,
          googleTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null
        }
      })
    }
  })

  return google.calendar({ version: 'v3', auth: oauth2 })
}

async function syncJobToGoogleCalendar(job, business) {
  if (!business.googleRefreshToken || !business.googleCalendarId) return null

  try {
    const calendar = await getCalendarClient(business)
    const startAt = new Date(job.scheduledAt)
    const endAt = new Date(startAt.getTime() + (job.durationMinutes || 60) * 60000)

    const event = {
      summary: `[KO] ${job.jobType} — ${job.customerName}`,
      description: `${job.description || ''}\n\nCustomer: ${job.customerName}\nPhone: ${job.customerPhone}\nAddress: ${job.address}, ${job.suburb}`,
      location: `${job.address}, ${job.suburb}`,
      start: { dateTime: startAt.toISOString(), timeZone: 'Australia/Sydney' },
      end: { dateTime: endAt.toISOString(), timeZone: 'Australia/Sydney' },
      colorId: job.priority === 'EMERGENCY' ? '11' : job.status === 'CONFIRMED' ? '2' : '5'
    }

    let result
    if (job.googleEventId) {
      result = await calendar.events.update({
        calendarId: business.googleCalendarId,
        eventId: job.googleEventId,
        resource: event
      })
    } else {
      result = await calendar.events.insert({
        calendarId: business.googleCalendarId,
        resource: event
      })
    }

    return result.data.id
  } catch (err) {
    console.error('Google Calendar sync error:', err.message)
    return null
  }
}

async function deleteGoogleCalendarEvent(job, business) {
  if (!job.googleEventId || !business.googleRefreshToken) return
  try {
    const calendar = await getCalendarClient(business)
    await calendar.events.delete({ calendarId: business.googleCalendarId, eventId: job.googleEventId })
  } catch (err) {
    console.warn('Failed to delete Google Calendar event:', err.message)
  }
}

async function sendJobConfirmationSMS(job, business) {
  if (!job.customerPhone) return

  const dateStr = format(new Date(job.scheduledAt), "EEEE d MMMM 'at' h:mma")
  const confirmUrl = `${process.env.SERVER_URL}/api/jobs/${job.id}/confirm`

  const msg = `Hi ${job.customerName.split(' ')[0]}, ${business.name} has scheduled your ${job.jobType.replace(/_/g, ' ')} for ${dateStr}. Reply YES to confirm or NO to reschedule. View details: ${confirmUrl}`

  await sendSMS({ to: job.customerPhone, body: msg, from: business.twilioPhoneNumber })

  await prisma.job.update({ where: { id: job.id }, data: { confirmationSentAt: new Date() } })
}

async function sendJobConfirmationEmail(job, business) {
  if (!job.customerEmail) return

  await sendEmail({
    to: job.customerEmail,
    subject: `Booking confirmed — ${format(new Date(job.scheduledAt), 'EEEE d MMMM')}`,
    template: 'job-confirmation',
    data: {
      job,
      business,
      confirmUrl: `${process.env.CLIENT_URL}/confirm/${job.id}?action=confirm`,
      rescheduleUrl: `${process.env.CLIENT_URL}/confirm/${job.id}?action=reschedule`
    }
  })
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  syncJobToGoogleCalendar,
  deleteGoogleCalendarEvent,
  sendJobConfirmationSMS,
  sendJobConfirmationEmail
}
