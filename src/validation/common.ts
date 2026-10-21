import { z } from 'zod';

// PostgreSQL INTEGER upper bound; larger ids can never exist.
export const MAX_INT_ID = 2_147_483_647;
export const MAX_PAGE_SIZE = 50;

/** A positive integer sent as a query/route string, e.g. "3". Rejects "3.5", "-1", "abc" and repeated params. */
export function positiveIntParam(field: string, max = MAX_INT_ID) {
  return z
    .string({ error: `${field} must be a positive integer.` })
    .regex(/^[1-9]\d{0,9}$/, `${field} must be a positive integer.`)
    .transform(Number)
    .pipe(z.number().max(max, `${field} must be at most ${max}.`));
}

export const idParamSchema = z.object({ id: positiveIntParam('id') });
export type IdParam = z.infer<typeof idParamSchema>;

export const paginationQueryShape = {
  page: positiveIntParam('page').optional(),
  pageSize: positiveIntParam('pageSize', MAX_PAGE_SIZE).optional(),
};

/** A positive integer sent in a JSON body. */
export function positiveIntBody(field: string) {
  return z
    .number({ error: `${field} must be a positive integer.` })
    .int(`${field} must be a positive integer.`)
    .min(1, `${field} must be a positive integer.`)
    .max(MAX_INT_ID, `${field} is out of range.`);
}
