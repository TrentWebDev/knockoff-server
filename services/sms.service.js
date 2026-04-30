const twilio = require('twilio')

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const DEFAULT_FROM = process.env.TWILIO_PHONE_NUMBER

async function sendSMS({ to, body, from }) {
  const fromNumber = from || DEFAULT_FROM
  if (!fromNumber) {
    console.warn('No Twilio phone number configured — SMS not sent')
    return null
  }

  // Normalise Australian numbers
  const normalisedTo = normaliseAustralianNumber(to)
  if (!normalisedTo) {
    console.warn('Invalid phone number:', to)
    return null
  }

  try {
    const message = await client.messages.create({
      body,
      from: fromNumber,
      to: normalisedTo
    })
    return message.sid
  } catch (err) {
    console.error('SMS send error:', err.message)
    throw err
  }
}

function normaliseAustralianNumber(phone) {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('61') && digits.length === 11) return '+' + digits
  if (digits.startsWith('0') && digits.length === 10) return '+61' + digits.slice(1)
  if (digits.length === 9) return '+61' + digits
  return '+' + digits
}

async function provisionPhoneNumber(areaCode = '02') {
  const available = await client.availablePhoneNumbers('AU').local.list({ areaCode, limit: 1 })
  if (available.length === 0) throw new Error('No phone numbers available in that area')

  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    smsUrl: `${process.env.SERVER_URL}/api/webhooks/twilio/sms`,
    voiceUrl: `${process.env.SERVER_URL}/api/webhooks/twilio/voice`
  })

  return purchased.phoneNumber
}

module.exports = { sendSMS, normaliseAustralianNumber, provisionPhoneNumber }
