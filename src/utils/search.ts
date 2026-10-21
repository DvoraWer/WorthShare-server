/**
 * Prisma passes `contains` to LIKE without escaping, so % and _ would act as
 * wildcards. Escape them (and the escape character) to search literally.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}
