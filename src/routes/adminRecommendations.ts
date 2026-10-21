import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as recommendations from '../services/recommendationService.js';
import * as sponsoredReview from '../services/sponsoredReviewService.js';
import {
  adminListRecommendationsQuerySchema,
  type AdminListRecommendationsQuery,
} from '../validation/recommendations.js';
import { idParamSchema, type IdParam } from '../validation/common.js';
import {
  approveSponsoredBodySchema,
  listPendingQuerySchema,
  rejectSponsoredBodySchema,
  type ApproveSponsoredInput,
  type ListPendingQuery,
  type RejectSponsoredInput,
} from '../validation/sponsoredReview.js';

export const adminRecommendationsRouter = Router();

// Every route here is administrator-only.
adminRecommendationsRouter.use(authenticate, requireRole('Admin'));

// All users' recommendations in every status (optional ?status= filter). Read-only.
adminRecommendationsRouter.get('/', validateQuery(adminListRecommendationsQuerySchema), async (_req, res) => {
  res.json(await recommendations.listAll(res.locals.query as AdminListRecommendationsQuery));
});

adminRecommendationsRouter.get('/pending-sponsored', validateQuery(listPendingQuerySchema), async (_req, res) => {
  res.json(await sponsoredReview.listPending(res.locals.query as ListPendingQuery));
});

adminRecommendationsRouter.put(
  '/:id/approve-sponsored',
  validateParams(idParamSchema),
  validateBody(approveSponsoredBodySchema),
  async (req, res) => {
    const { id } = res.locals.params as IdParam;
    res.json(await sponsoredReview.approve(req.user!, id, req.body as ApproveSponsoredInput));
  },
);

adminRecommendationsRouter.put(
  '/:id/reject-sponsored',
  validateParams(idParamSchema),
  validateBody(rejectSponsoredBodySchema),
  async (req, res) => {
    const { id } = res.locals.params as IdParam;
    res.json(await sponsoredReview.reject(req.user!, id, req.body as RejectSponsoredInput));
  },
);
