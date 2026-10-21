import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as userAdmin from '../services/userAdminService.js';
import {
  listUsersQuerySchema,
  roleBodySchema,
  statusBodySchema,
  type ListUsersQuery,
  type RoleInput,
  type StatusInput,
} from '../validation/admin.js';
import { idParamSchema, type IdParam } from '../validation/common.js';

export const adminUsersRouter = Router();

// Every route here is administrator-only.
adminUsersRouter.use(authenticate, requireRole('Admin'));

adminUsersRouter.get('/', validateQuery(listUsersQuerySchema), async (_req, res) => {
  res.json(await userAdmin.list(res.locals.query as ListUsersQuery));
});

adminUsersRouter.patch('/:id/status', validateParams(idParamSchema), validateBody(statusBodySchema), async (req, res) => {
  const { id } = res.locals.params as IdParam;
  res.json(await userAdmin.changeStatus(req.user!, id, req.body as StatusInput));
});

adminUsersRouter.patch('/:id/role', validateParams(idParamSchema), validateBody(roleBodySchema), async (req, res) => {
  const { id } = res.locals.params as IdParam;
  res.json(await userAdmin.changeRole(req.user!, id, req.body as RoleInput));
});
