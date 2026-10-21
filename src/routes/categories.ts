import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { paginate } from '../dto/pagination.js';
import { validateQuery } from '../middleware/validate.js';
import { MAX_PAGE_SIZE, paginationQueryShape } from '../validation/common.js';

const listCategoriesQuerySchema = z.object(paginationQueryShape);
type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;

export const categoriesRouter = Router();

// Public: active categories only, alphabetical.
categoriesRouter.get('/', validateQuery(listCategoriesQuerySchema), async (_req, res) => {
  const query = res.locals.query as ListCategoriesQuery;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? MAX_PAGE_SIZE;
  const where = { isActive: true };

  const [totalItems, rows] = await prisma.$transaction([
    prisma.category.count({ where }),
    prisma.category.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, name: true, description: true },
    }),
  ]);
  res.json(paginate(rows, page, pageSize, totalItems));
});
