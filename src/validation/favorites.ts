import { z } from 'zod';
import { paginationQueryShape } from './common.js';

export const listFavoritesQuerySchema = z.object(paginationQueryShape);
export type ListFavoritesQuery = z.infer<typeof listFavoritesQuerySchema>;
