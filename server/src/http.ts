import type { Context } from 'hono';
import { z, type ZodType } from 'zod';

export class HttpError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  }
  return parsed.data;
}

export function idParam(c: Context, name = 'id'): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:MM');
export const money = z.number().finite();
export const nullableStr = z.string().nullable().optional();
