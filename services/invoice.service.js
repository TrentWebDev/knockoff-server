const PDFDocument = require('pdfkit')
const { format } = require('date-fns')

async function generateInvoicePDF(invoice, business) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' })
    const buffers = []
    doc.on('data', b => buffers.push(b))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const orange = '#FF6B00'
    const dark = '#1A1A1A'
    const grey = '#6B7280'
    const lightGrey = '#F3F4F6'
    const pageWidth = doc.page.width - 100
    const leftCol = 50
    const rightCol = 370

    // ─── HEADER ───────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 120).fill(dark)

    doc.fontSize(28).font('Helvetica-Bold').fillColor('white')
      .text('TAX INVOICE', leftCol, 40)

    doc.fontSize(11).font('Helvetica').fillColor(orange)
      .text(invoice.invoiceNumber, leftCol, 75)
      .fillColor('#CCCCCC')
      .text(`Issued: ${format(new Date(invoice.issueDate), 'dd MMMM yyyy')}`, leftCol, 90)
      .text(`Due: ${format(new Date(invoice.dueDate), 'dd MMMM yyyy')}`, leftCol + 160, 90)

    // Status badge
    const statusColor = invoice.status === 'PAID' ? '#00C48C' : invoice.status === 'OVERDUE' ? '#FF3B30' : orange
    doc.roundedRect(rightCol + 80, 50, 100, 30, 4).fill(statusColor)
    doc.fontSize(11).font('Helvetica-Bold').fillColor('white')
      .text(invoice.status, rightCol + 80, 60, { width: 100, align: 'center' })

    doc.y = 140

    // ─── FROM / TO SECTION ────────────────────────────────────────────────────
    doc.fontSize(9).font('Helvetica-Bold').fillColor(grey).text('FROM', leftCol, doc.y)
    doc.fontSize(9).font('Helvetica-Bold').fillColor(grey).text('BILL TO', rightCol, doc.y - doc.currentLineHeight())

    doc.fontSize(12).font('Helvetica-Bold').fillColor(dark)
      .text(business.name, leftCol, doc.y + 4)
    if (business.abn) {
      doc.fontSize(10).font('Helvetica').fillColor(grey)
        .text(`ABN: ${business.abn}`, leftCol)
    }
    doc.fontSize(10).font('Helvetica').fillColor(grey)
      .text(business.phone, leftCol)
      .text(business.email, leftCol)
    if (business.address) doc.text(business.address, leftCol)

    const toY = 160
    doc.fontSize(12).font('Helvetica-Bold').fillColor(dark)
      .text(invoice.customerName, rightCol, toY)
    doc.fontSize(10).font('Helvetica').fillColor(grey)
    if (invoice.customerAddress) doc.text(invoice.customerAddress, rightCol)
    if (invoice.customerPhone) doc.text(invoice.customerPhone, rightCol)
    if (invoice.customerEmail) doc.text(invoice.customerEmail, rightCol)
    if (invoice.customerAbn) doc.text(`ABN: ${invoice.customerAbn}`, rightCol)

    doc.y = Math.max(doc.y, 260)
    doc.moveDown(1)

    // ─── LINE ITEMS TABLE ─────────────────────────────────────────────────────
    const tableTop = doc.y
    const colWidths = { desc: 270, qty: 60, unit: 90, total: 80 }
    const cols = {
      desc: leftCol,
      qty: leftCol + colWidths.desc,
      unit: leftCol + colWidths.desc + colWidths.qty,
      total: leftCol + colWidths.desc + colWidths.qty + colWidths.unit
    }

    // Header row
    doc.rect(leftCol, tableTop, pageWidth, 26).fill(dark)
    doc.fontSize(9).font('Helvetica-Bold').fillColor('white')
      .text('DESCRIPTION', cols.desc + 4, tableTop + 8)
      .text('QTY', cols.qty, tableTop + 8, { width: colWidths.qty, align: 'center' })
      .text('UNIT PRICE', cols.unit, tableTop + 8, { width: colWidths.unit, align: 'right' })
      .text('TOTAL', cols.total, tableTop + 8, { width: colWidths.total, align: 'right' })

    let rowY = tableTop + 26
    let rowAlt = false

    for (const item of invoice.lineItems) {
      const rowH = 28
      if (rowAlt) doc.rect(leftCol, rowY, pageWidth, rowH).fill(lightGrey)
      rowAlt = !rowAlt

      doc.fontSize(10).font('Helvetica').fillColor(dark)
        .text(item.description, cols.desc + 4, rowY + 8, { width: colWidths.desc - 8 })

      doc.fontSize(10).fillColor(grey)
        .text(item.quantity % 1 === 0 ? item.quantity.toString() : item.quantity.toFixed(2), cols.qty, rowY + 8, { width: colWidths.qty, align: 'center' })
        .text(`$${(item.unitPriceCents / 100).toFixed(2)}`, cols.unit, rowY + 8, { width: colWidths.unit, align: 'right' })

      doc.fontSize(10).font('Helvetica-Bold').fillColor(dark)
        .text(`$${(item.totalCents / 100).toFixed(2)}`, cols.total, rowY + 8, { width: colWidths.total, align: 'right' })

      rowY += rowH
    }

    // ─── TOTALS SECTION ───────────────────────────────────────────────────────
    doc.moveTo(leftCol, rowY).lineTo(leftCol + pageWidth, rowY).strokeColor('#E5E7EB').lineWidth(1).stroke()
    rowY += 16

    const totalsLeft = cols.unit - 20
    const totalsRight = cols.total

    doc.fontSize(10).font('Helvetica').fillColor(grey)
      .text('Subtotal (ex GST)', totalsLeft, rowY, { width: colWidths.unit + 20, align: 'right' })
      .text(`$${(invoice.subtotalCents / 100).toFixed(2)}`, totalsRight, rowY, { width: colWidths.total, align: 'right' })
    rowY += 20

    doc.text('GST (10%)', totalsLeft, rowY, { width: colWidths.unit + 20, align: 'right' })
      .text(`$${(invoice.gstCents / 100).toFixed(2)}`, totalsRight, rowY, { width: colWidths.total, align: 'right' })
    rowY += 20

    if (invoice.depositCents > 0) {
      doc.text('Deposit paid', totalsLeft, rowY, { width: colWidths.unit + 20, align: 'right' })
        .text(`-$${(invoice.depositCents / 100).toFixed(2)}`, totalsRight, rowY, { width: colWidths.total, align: 'right' })
      rowY += 20
    }

    // Total due box
    doc.rect(totalsLeft - 10, rowY, colWidths.unit + colWidths.total + 30, 36).fill(orange)
    doc.fontSize(12).font('Helvetica-Bold').fillColor('white')
      .text(invoice.status === 'PAID' ? 'PAID' : 'TOTAL DUE', totalsLeft - 6, rowY + 11, { width: colWidths.unit + 20, align: 'right' })
      .text(`$${(invoice.balanceDueCents / 100).toFixed(2)}`, totalsRight, rowY + 11, { width: colWidths.total, align: 'right' })
    rowY += 52

    // ─── PAYMENT DETAILS ─────────────────────────────────────────────────────
    if (business.bankBsb && business.bankAccount && invoice.status !== 'PAID') {
      doc.moveTo(leftCol, rowY).lineTo(leftCol + pageWidth, rowY).strokeColor('#E5E7EB').stroke()
      rowY += 16
      doc.fontSize(9).font('Helvetica-Bold').fillColor(dark).text('PAYMENT DETAILS', leftCol, rowY)
      rowY += 14
      doc.fontSize(9).font('Helvetica').fillColor(grey)
        .text(`Bank: ${business.bankName || 'Bank transfer'}`, leftCol, rowY)
        .text(`BSB: ${business.bankBsb}`, leftCol + 150, rowY)
        .text(`Account: ${business.bankAccount}`, leftCol + 260, rowY)
        .text(`Reference: ${invoice.invoiceNumber}`, leftCol + 380, rowY)
      rowY += 16
    }

    // Notes
    if (invoice.notes) {
      rowY += 8
      doc.fontSize(9).font('Helvetica-Bold').fillColor(dark).text('NOTES', leftCol, rowY)
      rowY += 12
      doc.fontSize(9).font('Helvetica').fillColor(grey).text(invoice.notes, leftCol, rowY, { width: pageWidth })
    }

    // ─── FOOTER ───────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 60
    doc.rect(0, footerY - 10, doc.page.width, 70).fill(lightGrey)
    doc.fontSize(8).font('Helvetica').fillColor(grey)
      .text(`${business.name}${business.abn ? ' | ABN: ' + business.abn : ''} | ${business.phone} | ${business.email}`, leftCol, footerY, { width: pageWidth, align: 'center' })
      .text('Thank you for your business. Payment is due by the date shown above.', leftCol, footerY + 14, { width: pageWidth, align: 'center' })
      .fillColor(orange)
      .text('Powered by Knock Off', leftCol, footerY + 28, { width: pageWidth, align: 'center' })

    doc.end()
  })
}

module.exports = { generateInvoicePDF }
