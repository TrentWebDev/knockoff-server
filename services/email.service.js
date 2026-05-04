const nodemailer = require('nodemailer')
const { format } = require('date-fns')

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
  port: parseInt(process.env.SMTP_PORT || '587'),
  auth: {
    user: process.env.SMTP_USER || 'apikey',
    pass: process.env.SMTP_PASS || process.env.SENDGRID_API_KEY
  },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 10000
})

const baseStyle = `
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; margin: 0; padding: 0; background: #F8F9FA; }
    .wrapper { max-width: 600px; margin: 0 auto; background: white; }
    .header { background: #1A1A1A; padding: 32px 40px; }
    .header-logo { color: #FF6B00; font-size: 24px; font-weight: 800; }
    .header-sub { color: #999; font-size: 13px; margin-top: 4px; }
    .content { padding: 40px; }
    .h1 { font-size: 24px; font-weight: 700; color: #1A1A1A; margin: 0 0 8px; }
    .body { font-size: 15px; color: #374151; line-height: 1.6; }
    .card { background: #F8F9FA; border-radius: 8px; padding: 24px; margin: 24px 0; }
    .label { font-size: 11px; font-weight: 600; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.05em; }
    .value { font-size: 15px; color: #1A1A1A; margin-top: 2px; }
    .total-box { background: #FF6B00; border-radius: 8px; padding: 20px 24px; text-align: center; margin: 16px 0; }
    .total-label { color: rgba(255,255,255,0.8); font-size: 12px; font-weight: 600; }
    .total-amount { color: white; font-size: 32px; font-weight: 800; }
    .btn { display: inline-block; background: #FF6B00; color: white !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 16px; }
    .footer { background: #F8F9FA; padding: 24px 40px; font-size: 12px; color: #9CA3AF; text-align: center; }
    .divider { border: none; border-top: 1px solid #E5E7EB; margin: 24px 0; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; font-weight: 600; color: #9CA3AF; text-transform: uppercase; padding: 8px 0; border-bottom: 2px solid #E5E7EB; }
    td { padding: 10px 0; font-size: 14px; color: #374151; border-bottom: 1px solid #F3F4F6; }
    .td-right { text-align: right; }
    .total-row td { font-weight: 700; color: #1A1A1A; border-bottom: none; padding-top: 16px; }
  </style>`

function renderTemplate(template, data) {
  switch (template) {
    case 'verify-email':
      return {
        html: `<!DOCTYPE html><html><head>${baseStyle}</head><body><div class="wrapper">
        <div class="header"><div class="header-logo">Knock Off</div><div class="header-sub">Knock off on time, every time</div></div>
        <div class="content">
          <h1 class="h1">Welcome, ${data.firstName}! 👋</h1>
          <p class="body">Thanks for signing up to Knock Off. Verify your email to get started — your 14-day free trial begins the moment you do.</p>
          <div style="text-align:center;margin:32px 0"><a href="${data.verifyUrl}" class="btn">Verify Email →</a></div>
          <p class="body" style="font-size:13px;color:#9CA3AF">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
        </div>
        <div class="footer">© Knock Off · Made for Australian tradies · <a href="https://knockoff.com.au" style="color:#FF6B00">knockoff.com.au</a></div>
        </div></body></html>`
      }

    case 'reset-password':
      return {
        html: `<!DOCTYPE html><html><head>${baseStyle}</head><body><div class="wrapper">
        <div class="header"><div class="header-logo">Knock Off</div></div>
        <div class="content">
          <h1 class="h1">Reset your password</h1>
          <p class="body">Hey ${data.firstName}, we got a request to reset your password. Click below to choose a new one.</p>
          <div style="text-align:center;margin:32px 0"><a href="${data.resetUrl}" class="btn">Reset Password →</a></div>
          <p class="body" style="font-size:13px;color:#9CA3AF">This link expires in 1 hour. If you didn't request this, your account is safe — ignore this email.</p>
        </div>
        <div class="footer">© Knock Off</div></div></body></html>`
      }

    case 'invoice': {
      const { invoice, business, paymentLink, formattedTotal, formattedDue, dueDateFormatted } = data
      const lineItemsHtml = invoice.lineItems.map(item => `
        <tr>
          <td>${item.description}</td>
          <td class="td-right">${item.quantity % 1 === 0 ? item.quantity : item.quantity.toFixed(2)}</td>
          <td class="td-right">$${(item.unitPriceCents / 100).toFixed(2)}</td>
          <td class="td-right"><strong>$${(item.totalCents / 100).toFixed(2)}</strong></td>
        </tr>`).join('')

      return {
        html: `<!DOCTYPE html><html><head>${baseStyle}</head><body><div class="wrapper">
        <div class="header">
          <div class="header-logo">${business.name}</div>
          <div class="header-sub">${business.abn ? 'ABN: ' + business.abn + ' · ' : ''}${business.phone}</div>
        </div>
        <div class="content">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
            <div>
              <div class="label">Tax Invoice</div>
              <div style="font-size:22px;font-weight:800;color:#1A1A1A">${invoice.invoiceNumber}</div>
            </div>
            <div style="text-align:right">
              <div class="label">Due date</div>
              <div style="font-size:16px;font-weight:700;color:#FF6B00">${dueDateFormatted}</div>
            </div>
          </div>
          <div class="card">
            <div class="label">Bill to</div>
            <div class="value">${invoice.customerName}</div>
            ${invoice.customerAddress ? `<div style="color:#6B7280;font-size:14px">${invoice.customerAddress}</div>` : ''}
          </div>
          <table>
            <tr><th>Description</th><th class="td-right">Qty</th><th class="td-right">Unit</th><th class="td-right">Total</th></tr>
            ${lineItemsHtml}
            ${invoice.gstCents > 0 ? `<tr><td colspan="3" class="td-right" style="color:#6B7280;padding-top:12px">Subtotal (ex GST)</td><td class="td-right" style="color:#6B7280">$${(invoice.subtotalCents / 100).toFixed(2)}</td></tr>` : ''}
            ${invoice.gstCents > 0 ? `<tr><td colspan="3" class="td-right" style="color:#6B7280">GST (10%)</td><td class="td-right" style="color:#6B7280">$${(invoice.gstCents / 100).toFixed(2)}</td></tr>` : ''}
            ${invoice.depositCents > 0 ? `<tr><td colspan="3" class="td-right" style="color:#6B7280">Deposit paid</td><td class="td-right" style="color:#6B7280">-$${(invoice.depositCents / 100).toFixed(2)}</td></tr>` : ''}
            <tr class="total-row"><td colspan="3" class="td-right">TOTAL DUE</td><td class="td-right" style="color:#FF6B00;font-size:18px">${formattedDue}</td></tr>
          </table>
          ${paymentLink ? `<div style="text-align:center;margin:32px 0"><a href="${paymentLink}" class="btn">Pay Online Now →</a><p style="margin-top:8px;font-size:13px;color:#9CA3AF">Secure payment powered by Stripe</p></div>` : ''}
          ${business.bankBsb ? `<div class="card"><div class="label">Bank Transfer</div><div style="margin-top:8px;font-size:14px;color:#374151"><strong>Bank:</strong> ${business.bankName || 'Bank transfer'}<br><strong>BSB:</strong> ${business.bankBsb}<br><strong>Account:</strong> ${business.bankAccount}<br><strong>Reference:</strong> ${invoice.invoiceNumber}</div></div>` : ''}
          ${invoice.notes ? `<p style="font-size:14px;color:#6B7280"><strong>Notes:</strong> ${invoice.notes}</p>` : ''}
          ${business.invoiceFooter ? `<p style="font-size:14px;color:#6B7280;margin-top:12px">${business.invoiceFooter}</p>` : ''}
        </div>
        <div class="footer">
          <p>${business.name}${business.abn ? ' · ABN: ' + business.abn : ''}</p>
          <p>Questions? Contact us at ${business.phone} or ${business.email}</p>
          <p style="margin-top:8px;color:#D1D5DB">Powered by <a href="https://knockoff.com.au" style="color:#FF6B00">Knock Off</a></p>
        </div></div></body></html>`
      }
    }

    case 'invoice-reminder': {
      const { invoice, business, daysOverdue } = data
      return {
        html: `<!DOCTYPE html><html><head>${baseStyle}</head><body><div class="wrapper">
        <div class="header"><div class="header-logo">${business.name}</div></div>
        <div class="content">
          <h1 class="h1">Payment reminder</h1>
          <p class="body">Hi ${invoice.customerName.split(' ')[0]}, this is a friendly reminder that invoice ${invoice.invoiceNumber} ${daysOverdue > 0 ? `is <strong>${daysOverdue} days overdue</strong>` : 'is due today'}.</p>
          <div class="total-box">
            <div class="total-label">Amount Due</div>
            <div class="total-amount">$${(invoice.balanceDueCents / 100).toFixed(2)}</div>
          </div>
          <p class="body">Please arrange payment at your earliest convenience. If you've already paid, please disregard this message.</p>
          <p class="body">Questions? Contact us at ${business.phone}.</p>
        </div>
        <div class="footer">© ${business.name}</div></div></body></html>`
      }
    }

    case 'job-confirmation': {
      const { job, business, confirmUrl, rescheduleUrl } = data
      return {
        html: `<!DOCTYPE html><html><head>${baseStyle}</head><body><div class="wrapper">
        <div class="header"><div class="header-logo">${business.name}</div></div>
        <div class="content">
          <h1 class="h1">Job Booking Confirmed ✓</h1>
          <p class="body">Hi ${job.customerName.split(' ')[0]}, we've scheduled your job. Here are the details:</p>
          <div class="card">
            <div style="margin-bottom:16px"><div class="label">Date & Time</div><div class="value" style="color:#FF6B00;font-size:18px;font-weight:700">${format(new Date(job.scheduledAt), "EEEE, d MMMM 'at' h:mma")}</div></div>
            <div style="margin-bottom:16px"><div class="label">Address</div><div class="value">${job.address}, ${job.suburb}</div></div>
            <div><div class="label">Job</div><div class="value">${job.description || job.jobType}</div></div>
          </div>
          <div style="display:flex;gap:12px;margin:24px 0">
            <a href="${confirmUrl}" style="flex:1;text-align:center;background:#00C48C;color:white;text-decoration:none;padding:14px;border-radius:8px;font-weight:700;display:block">✓ Confirm</a>
            <a href="${rescheduleUrl}" style="flex:1;text-align:center;background:#F3F4F6;color:#374151;text-decoration:none;padding:14px;border-radius:8px;font-weight:700;display:block">↺ Reschedule</a>
          </div>
          <p class="body" style="font-size:13px;color:#9CA3AF">Questions? Call us on ${business.phone}</p>
        </div>
        <div class="footer">© ${business.name}</div></div></body></html>`
      }
    }

    case 'quote': {
      const { quote, business, viewUrl, acceptUrl, declineUrl, validUntil, isFollowUp, followUpNum } = data
      const lineItemsHtml = (quote.lineItems || []).map(item => `
        <tr>
          <td>${item.description}</td>
          <td class="td-right">${item.quantity % 1 === 0 ? item.quantity : item.quantity.toFixed(2)}</td>
          <td class="td-right">$${(item.unitPriceCents / 100).toFixed(2)}</td>
          <td class="td-right"><strong>$${(item.totalCents / 100).toFixed(2)}</strong></td>
        </tr>`).join('')
      const greeting = isFollowUp
        ? `Hi ${quote.customerName.split(' ')[0]}, just following up on the quote we sent you${followUpNum > 1 ? ` (follow-up #${followUpNum})` : ''}. Would love to get started when you're ready!`
        : `Hi ${quote.customerName.split(' ')[0]}, please find your quote from ${business.name} below.`
      return {
        html: `<!DOCTYPE html><html><head>${baseStyle}</head><body><div class="wrapper">
        <div class="header">
          <div class="header-logo">${business.name}</div>
          <div class="header-sub">${business.abn ? 'ABN: ' + business.abn + ' · ' : ''}${business.phone}</div>
        </div>
        <div class="content">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
            <div>
              <div class="label">Quote</div>
              <div style="font-size:22px;font-weight:800;color:#1A1A1A">${quote.quoteNumber}</div>
            </div>
            <div style="text-align:right">
              <div class="label">Valid until</div>
              <div style="font-size:16px;font-weight:700;color:#FF6B00">${validUntil}</div>
            </div>
          </div>
          <p class="body">${greeting}</p>
          <div class="card">
            <div class="label">Prepared for</div>
            <div class="value">${quote.customerName}</div>
            ${quote.customerAddress ? `<div style="color:#6B7280;font-size:14px">${quote.customerAddress}</div>` : ''}
          </div>
          ${quote.jobDescription ? `<div class="card"><div class="label">Scope of work</div><div style="font-size:14px;color:#374151;margin-top:4px">${quote.jobDescription}</div></div>` : ''}
          ${lineItemsHtml ? `<table>
            <tr><th>Description</th><th class="td-right">Qty</th><th class="td-right">Unit</th><th class="td-right">Total</th></tr>
            ${lineItemsHtml}
            ${quote.gstCents > 0 ? `<tr><td colspan="3" class="td-right" style="color:#6B7280;padding-top:12px">Subtotal (ex GST)</td><td class="td-right" style="color:#6B7280">$${(quote.subtotalCents / 100).toFixed(2)}</td></tr>
            <tr><td colspan="3" class="td-right" style="color:#6B7280">GST (10%)</td><td class="td-right" style="color:#6B7280">$${(quote.gstCents / 100).toFixed(2)}</td></tr>` : ''}
            <tr class="total-row"><td colspan="3" class="td-right">TOTAL</td><td class="td-right" style="color:#FF6B00;font-size:18px">$${(quote.totalCents / 100).toFixed(2)}</td></tr>
          </table>` : ''}
          ${quote.notes ? `<p style="font-size:14px;color:#6B7280"><strong>Notes:</strong> ${quote.notes}</p>` : ''}
          <div style="display:flex;gap:12px;margin:24px 0">
            <a href="${acceptUrl}" style="flex:1;text-align:center;background:#00C48C;color:white;text-decoration:none;padding:14px;border-radius:8px;font-weight:700;display:block;font-size:15px">✓ Accept Quote</a>
            <a href="${declineUrl}" style="flex:1;text-align:center;background:#F3F4F6;color:#374151;text-decoration:none;padding:14px;border-radius:8px;font-weight:700;display:block;font-size:15px">✗ Decline</a>
          </div>
          <div style="text-align:center;margin-bottom:16px"><a href="${viewUrl}" style="font-size:13px;color:#FF6B00">View full quote online →</a></div>
          ${business.invoiceFooter ? `<p style="font-size:13px;color:#6B7280;text-align:center">${business.invoiceFooter}</p>` : ''}
        </div>
        <div class="footer">
          <p>${business.name}${business.abn ? ' · ABN: ' + business.abn : ''}</p>
          <p>Questions? Contact us at ${business.phone}${business.email ? ' or ' + business.email : ''}</p>
          <p style="margin-top:8px;color:#D1D5DB">Powered by <a href="https://knockoff.com.au" style="color:#FF6B00">Knock Off</a></p>
        </div></div></body></html>`
      }
    }

    case 'daily-summary': {
      const { business, jobs, pendingRevenue, overdueCount, quotesCount, firstName } = data
      return {
        html: `<!DOCTYPE html><html><head>${baseStyle}</head><body><div class="wrapper">
        <div class="header"><div class="header-logo">Knock Off · Daily Summary</div></div>
        <div class="content">
          <h1 class="h1">Good morning, ${firstName} ☀️</h1>
          <p class="body">Here's what's on for today, ${format(new Date(), 'EEEE d MMMM')}:</p>
          ${jobs.length > 0 ? `<div class="card"><div class="label">Today's Jobs (${jobs.length})</div>${jobs.map(j => `<div style="margin-top:12px;padding:12px;background:white;border-radius:6px;border-left:3px solid #FF6B00"><strong>${format(new Date(j.scheduledAt), 'h:mma')}</strong> — ${j.customerName} · ${j.suburb}</div>`).join('')}</div>` : '<div class="card"><p style="margin:0;color:#9CA3AF">No jobs scheduled today.</p></div>'}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0">
            <div class="card" style="text-align:center"><div class="label">Pending Revenue</div><div style="font-size:24px;font-weight:800;color:#FF6B00">$${(pendingRevenue / 100).toFixed(0)}</div></div>
            <div class="card" style="text-align:center"><div class="label">Quotes Open</div><div style="font-size:24px;font-weight:800;color:#1A1A1A">${quotesCount}</div></div>
          </div>
          ${overdueCount > 0 ? `<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px;color:#DC2626"><strong>⚠️ ${overdueCount} overdue invoice${overdueCount > 1 ? 's' : ''}</strong> — log in to send reminders</div>` : ''}
          <div style="text-align:center;margin:24px 0"><a href="${process.env.CLIENT_URL}/dashboard" class="btn">Open Dashboard →</a></div>
        </div>
        <div class="footer">© Knock Off · <a href="${process.env.CLIENT_URL}/settings/notifications" style="color:#9CA3AF">Manage email preferences</a></div>
        </div></body></html>`
      }
    }

    default:
      return { html: `<p>${JSON.stringify(data)}</p>` }
  }
}

async function sendEmail({ to, subject, template, data, attachments = [] }) {
  const { html } = renderTemplate(template, data)

  const mailOptions = {
    from: `${process.env.FROM_NAME || 'Knock Off'} <${process.env.FROM_EMAIL || 'noreply@knockoff.com.au'}>`,
    to,
    subject,
    html,
    attachments
  }

  try {
    const info = await transporter.sendMail(mailOptions)
    return info
  } catch (err) {
    console.error('Email send error:', err.message)
    throw err
  }
}

module.exports = { sendEmail }
