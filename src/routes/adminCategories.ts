import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as categoryAdmin from '../services/categoryAdminService.js';
import {
  categoryBodySchema,
  listAdminCategoriesQuerySchema,
  statusBodySchema,
  type CategoryInput,
  type ListAdminCategoriesQuery,
  type StatusInput,
} from '../validation/admin.js';
import { idParamSchema, type IdParam } from '../validation/common.js';

export const adminCategoriesRouter = Router();

// Every route here is administrator-only. There is deliberately no DELETE:
// categories are disabled, never physically deleted (spec §10).
adminCategoriesRouter.use(authenticate, requireRole('Admin'));

adminCategoriesRouter.get('/', validateQuery(listAdminCategoriesQuerySchema), async (_req, res) => {
  res.json(await categoryAdmin.list(res.locals.query as ListAdminCategoriesQuery));
});

adminCategoriesRouter.post('/', validateBody(categoryBodySchema), async (req, res) => {
  res.status(201).json(await categoryAdmin.create(req.user!, req.body as CategoryInput));
});

adminCategoriesRouter.put('/:id', validateParams(idParamSchema), validateBody(categoryBodySchema), async (req, res) => {
  const { id } = res.locals.params as IdParam;
  res.json(await categoryAdmin.update(req.user!, id, req.body as CategoryInput));
});

adminCategoriesRouter.patch('/:id/status', validateParams(idParamSchema), validateBody(statusBodySchema), async (req, res) => {
  const { id } = res.locals.params as IdParam;
  res.json(await categoryAdmin.updateStatus(req.user!, id, req.body as StatusInput));
});
