/**
 * Turn whatever a producer sends into text Claude can read. Spreadsheets and
 * docs become text; PDFs and images are passed to Claude as native blocks.
 */
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import type Anthropic from '@anthropic-ai/sdk';

const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

export function textFromFile(filename: string, mimeType: string, buf: Buffer): string | null {
  const e = ext(filename);
  if (['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'numbers'].includes(e) || /spreadsheet|excel|csv/.test(mimeType)) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    return wb.SheetNames.map(name => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, dateNF: 'yyyy-mm-dd' });
      return `### Sheet: ${name}\n${csv}`;
    }).join('\n\n');
  }
  if (e === 'docx' || mimeType.includes('wordprocessingml')) {
    const files = unzipSync(new Uint8Array(buf));
    const xml = strFromU8(files['word/document.xml'] ?? new Uint8Array());
    return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }
  if (e === 'eml' || mimeType === 'message/rfc822') {
    const s = buf.toString('utf8');
    const [head, ...rest] = s.split(/\r?\n\r?\n/);
    const h = (n: string) => head.match(new RegExp(`^${n}:\\s*(.+)$`, 'im'))?.[1] ?? '';
    return `From: ${h('From')}\nTo: ${h('To')}\nDate: ${h('Date')}\nSubject: ${h('Subject')}\n\n${rest.join('\n\n').replace(/<[^>]+>/g, '')}`;
  }
  if (['txt', 'md', 'json', 'ics'].includes(e) || mimeType.startsWith('text/')) return buf.toString('utf8');
  return null;
}

/** Native content blocks for files Claude reads directly (PDF, images). */
export function attachmentBlocks(filename: string, mimeType: string, buf: Buffer): Anthropic.Beta.BetaContentBlockParam[] {
  const e = ext(filename);
  if (e === 'pdf' || mimeType === 'application/pdf') {
    return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: filename }];
  }
  const img: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  if (img[e]) return [{ type: 'image', source: { type: 'base64', media_type: img[e], data: buf.toString('base64') } }];
  return [];
}

export function sourceTypeFor(filename: string, mimeType: string): 'text' | 'email' | 'spreadsheet' | 'pdf' | 'image' {
  const e = ext(filename);
  if (['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods'].includes(e)) return 'spreadsheet';
  if (e === 'pdf') return 'pdf';
  if (e === 'eml' || mimeType === 'message/rfc822') return 'email';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return 'image';
  return 'text';
}
