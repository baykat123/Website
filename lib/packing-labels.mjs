import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import {RequestError} from './team.mjs';

export async function packingLabelsPdf(order,items) {
  if(items.length>500)throw new RequestError(409,'Print packing labels in smaller orders');
  const doc=new PDFDocument({size:[288,432],margin:18,autoFirstPage:false,info:{Title:`Packing labels - ${order.body.title}`,Author:'Operations desk'}}),chunks=[];
  const finished=new Promise((resolve,reject)=>{doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  // One reference label per distinct packing item. Printing never records scans.
  for(const [index,item] of items.entries()) {
    const qr=item.packingCode.length>42||/[^\x20-\x7e]/.test(item.packingCode);
    const barcode=await bwipjs.toBuffer({bcid:qr?'qrcode':'code128',text:item.packingCode,scale:3,height:16,padding:8,includetext:false});
    doc.addPage();doc.font('Helvetica-Bold').fontSize(14).text(order.body.title,18,18,{width:252,height:36,ellipsis:true});
    doc.font('Helvetica').fontSize(8).text(order.store,18,56,{width:252});
    doc.font('Helvetica-Bold').fontSize(12).text(item.packingTitle||item.title||'Order item',18,78,{width:252,height:56,ellipsis:true});
    doc.font('Helvetica').fontSize(10).text(`Required units: ${item.quantity}`,18,138,{width:252});
    doc.fontSize(8).text(item.priceEncoded?'CUSTOM JOB DESK LABEL':item.deskLabel?'DESK LABEL - no Shopify SKU supplied':`Product SKU: ${item.sku}`,18,158,{width:252,height:24,ellipsis:true});
    const attributes=(item.jobAttributes??item.customAttributes??[]).map(a=>`${a.key}: ${a.value}`).join('\n');
    if(attributes)doc.fontSize(9).text(attributes,18,192,{width:252,height:96,ellipsis:true});
    doc.image(barcode,18,300,{fit:[252,62],align:'center',valign:'center'});
    doc.font('Helvetica-Bold').fontSize(9).text(item.packingCode,18,366,{width:252,height:23,ellipsis:true,align:'center'});
    doc.font('Helvetica').fontSize(7).text(`Match the physical item and full job details before attaching.\nScan once per packed unit. Label ${index+1} of ${items.length}.`,18,396,{width:252,height:23,align:'center'});
  }
  doc.end();return finished;
}
