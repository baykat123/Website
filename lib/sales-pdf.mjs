import PDFDocument from 'pdfkit';

export async function salesPdf(record) {
  const b=record.body, doc=new PDFDocument({size:'LETTER',margin:48,bufferPages:true,info:{Title:`${record.type} #${record.id} - ${b.title}`,Author:'Operations desk'}});
  const chunks=[];
  const completed=new Promise((resolve,reject)=>{doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const money=value=>`${b.currency} ${(value/100).toFixed(2)}`;
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#193e31').text('Operations desk');
  doc.fontSize(16).text(`${record.type==='quote'?'QUOTE / ESTIMATE':record.type==='invoice'?'INVOICE':'ORDER'} #${record.id}`);
  doc.moveDown(.5).font('Helvetica').fontSize(10).fillColor('#333333');
  doc.text(`Status: ${b.status.replaceAll('_',' ')} | Revision ${record.version}`);
  doc.text(`Updated: ${record.updated_at.slice(0,10)}`);
  doc.moveDown().font('Helvetica-Bold').fontSize(13).text(b.title);
  doc.font('Helvetica').fontSize(10).text(`Customer / recipient: ${b.contact || 'Not specified'}`);
  if(b.due)doc.text(`Due date: ${b.due}`);
  doc.moveDown().font('Helvetica-Bold').text('Line items');
  for(const [index,item] of b.items.entries()) {
    // Natural text flow wraps descriptions and paginates long quotes without fixed row heights.
    doc.moveDown(.5).font('Helvetica-Bold').text(`${index+1}. ${item.description}`);
    doc.font('Helvetica').text(`Quantity ${item.quantity}  |  Unit ${money(item.unitPriceCents)}  |  Line ${money(item.quantity*item.unitPriceCents)}`);
  }
  doc.moveDown().font('Helvetica').text(`Shipping: ${money(b.shippingCents)}`);
  doc.text(`Tax (manually entered): ${money(b.taxCents)}`);
  doc.font('Helvetica-Bold').fontSize(14).text(`Total: ${money(b.totalCents)}`);
  if(b.notes){doc.moveDown().font('Helvetica-Bold').fontSize(10).text('Notes');doc.font('Helvetica').text(b.notes);}
  doc.moveDown().fontSize(9).fillColor('#637068').text('Internal sales document. Downloading does not issue, email, charge, or fulfill this record. Tax is entered manually.');
  const range=doc.bufferedPageRange();
  for(let index=0;index<range.count;index++) {
    doc.switchToPage(index);doc.font('Helvetica').fontSize(8).fillColor('#637068').text(`Operations desk | ${record.type} #${record.id} | Page ${index+1} of ${range.count}`,48,740,{lineBreak:false});
  }
  doc.end();return completed;
}
