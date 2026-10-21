import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import * as recommendations from '../services/recommendationService.js';
import { idParamSchema, type IdParam } from '../validation/common.js';
import {
  listRecommendationsQuerySchema,
  recommendationBodySchema,
  updateRecommendationBodySchema,
  type ListRecommendationsQuery,
  type RecommendationInput,
  type UpdateRecommendationInput,
} from '../validation/recommendations.js';
import { requestSponsoredBodySchema, type RequestSponsoredInput } from '../validation/sponsoredReview.js';
import * as favorites from '../services/favoriteService.js';
import { listFavoritesQuerySchema, type ListFavoritesQuery } from '../validation/favorites.js';

export const recommendationsRouter = Router();

// Public
recommendationsRouter.get('/', validateQuery(listRecommendationsQuerySchema), async (_req, res) => {
  res.json(await recommendations.listPublished(res.locals.query as ListRecommendationsQuery));
});

// Registered before '/:id' so "mine" is never parsed as an id.
recommendationsRouter.get('/mine', authenticate, validateQuery(listRecommendationsQuerySchema), async (req, res) => {
  res.json(await recommendations.listMine(req.user!, res.locals.query as ListRecommendationsQuery));
});

// Favorites: also registered before '/:id'.
recommendationsRouter.get('/favorites', authenticate, validateQuery(listFavoritesQuerySchema), async (req, res) => {
  res.json(await favorites.listFavorites(req.user!, res.locals.query as ListFavoritesQuery));
});

recommendationsRouter.get('/favorites/ids', authenticate, async (req, res) => {
  res.json(await favorites.listFavoriteIds(req.user!));
});

recommendationsRouter.get('/:id', validateParams(idParamSchema), async (_req, res) => {
  res.json(await recommendations.getPublished((res.locals.params as IdParam).id));
});

// Authenticated
recommendationsRouter.post('/', authenticate, validateBody(recommendationBodySchema), async (req, res) => {
  res.status(201).json(await recommendations.create(req.user!, req.body as RecommendationInput));
});

recommendationsRouter.put(
  '/:id',
  authenticate,
  validateParams(idParamSchema),
  validateBody(updateRecommendationBodySchema),
  async (req, res) => {
    const { id } = res.locals.params as IdParam;
    res.json(await recommendations.update(req.user!, id, req.body as UpdateRecommendationInput));
  },
);

recommendationsRouter.delete('/:id', authenticate, validateParams(idParamSchema), async (req, res) => {
  await recommendations.remove(req.user!, (res.locals.params as IdParam).id);
  res.status(204).end();
});

recommendationsRouter.post(
  '/:id/request-sponsored',
  authenticate,
  validateParams(idParamSchema),
  validateBody(requestSponsoredBodySchema),
  async (req, res) => {
    const { id } = res.locals.params as IdParam;
    res.json(await recommendations.requestSponsored(req.user!, id, req.body as RequestSponsoredInput));
  },
);

recommendationsRouter.post('/:id/favorite', authenticate, validateParams(idParamSchema), async (req, res) => {
  await favorites.addFavorite(req.user!, (res.locals.params as IdParam).id);
  res.status(204).end();
});

recommendationsRouter.delete('/:id/favorite', authenticate, validateParams(idParamSchema), async (req, res) => {
  await favorites.removeFavorite(req.user!, (res.locals.params as IdParam).id);
  res.status(204).end();
});
