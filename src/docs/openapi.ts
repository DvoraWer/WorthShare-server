// OpenAPI 3.0.3 description of the WorthShare API.
//
// Written by hand from the routes, validators (src/validation), DTOs (src/dto)
// and services. tests/openapi.test.ts keeps it honest: it validates the
// document, checks that every Express route is documented (and vice versa),
// that documented auth/role requirements match real 401/403 behaviour, and
// that real response bodies have exactly the documented fields.

import * as EX from './examples.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object, example?: unknown) => ({
  'application/json': { schema, ...(example === undefined ? {} : { example }) },
});
const paginated = (item: string) => ({
  type: 'object',
  required: ['items', 'pagination'],
  properties: { items: { type: 'array', items: ref(item) }, pagination: ref('Pagination') },
});

// ------------------------------------------------------------------ parameters

const idParam = (what: string) => ({
  name: 'id',
  in: 'path',
  required: true,
  description: `${what} id. A positive integer; anything else returns 400.`,
  schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
});
const pageParam = { $ref: '#/components/parameters/page' };
const pageSizeParam = (defaultSize: number) => ({
  name: 'pageSize',
  in: 'query',
  description: `Items per page (1–50). Default ${defaultSize}.`,
  schema: { type: 'integer', minimum: 1, maximum: 50, default: defaultSize },
});
const searchParam = (fields: string) => ({
  name: 'search',
  in: 'query',
  description: `Case-insensitive search in ${fields}. Matched literally (% and _ are not wildcards). Max 100 characters.`,
  schema: { type: 'string', maxLength: 100 },
});

// ------------------------------------------------------------------ responses

const r = (name: string) => ({ $ref: `#/components/responses/${name}` });

/**
 * Every operation can also fail with an unexpected 500. Operations that accept
 * a JSON body can also get 413 (body larger than 100 KB), raised by the JSON
 * body parser before routing, authentication and validation.
 */
function op(operation: Record<string, unknown> & { responses: Record<string, unknown> }) {
  return {
    ...operation,
    responses: {
      ...operation.responses,
      ...(operation.requestBody ? { 413: r('PayloadTooLarge') } : {}),
      500: r('InternalError'),
    },
  };
}

const bearer = [{ bearerAuth: [] }];
const ADMIN_ONLY = '**Requires an `Admin` token.** 401 without a valid token, 403 for other roles.';
const USER_AUTH = '**Requires a Bearer token** (any active user).';

// ------------------------------------------------------------------ document

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'WorthShare API',
    version: '0.1.0',
    description: [
      'Recommendation-sharing platform API.',
      '',
      '**Authentication.** Call `POST /api/auth/login` (or register), then click **Authorize** and paste the `accessToken`. ' +
        'Tokens identify the user only; role and active status are reloaded from the database on every request, ' +
        'so deactivation and role changes take effect immediately.',
      '',
      '**Errors** always use `{ "error": { "code", "message", "details"? } }`. `details` is present for validation errors.',
      '',
      '**Lists** return `{ items, pagination: { page, pageSize, totalItems, totalPages } }`. A page past the end returns `items: []`.',
      '',
      '**Roles.** `User` (default for every registration) and `Admin`. Admin-only endpoints are under `/api/admin`.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Health' },
    { name: 'Auth', description: 'Registration, login and the current user.' },
    { name: 'Categories', description: 'Public category list (active categories only).' },
    { name: 'Recommendations', description: 'Public browsing and the owner side of the sponsored workflow. "Sponsored" is a disclosure: the author has a commercial relationship with the recommended product (paid, free product, affiliate link or own business) and declares it with the sponsor and product details.' },
    { name: 'Favorites', description: 'Recommendations the caller saved for quick access. Only published recommendations can be saved or are listed.' },
    { name: 'Admin: Sponsored review', description: `Review of sponsored requests. Admins check that the disclosure is complete (sponsor, product and relationship are specified), that the link matches what is described, and that the content is not misleading. ${ADMIN_ONLY}` },
    { name: 'Admin: Categories', description: `Category administration. ${ADMIN_ONLY}` },
    { name: 'Admin: Users', description: `User administration. ${ADMIN_ONLY}` },
  ],
  paths: {
    // ============================================================ health
    '/api/health': {
      get: op({
        tags: ['Health'],
        summary: 'Health check',
        security: [],
        responses: {
          200: { description: 'Server is up.', content: json(ref('Health'), EX.health) },
        },
      }),
    },

    // ============================================================ auth
    '/api/auth/register': {
      post: op({
        tags: ['Auth'],
        summary: 'Register a new account',
        description:
          'Always creates an active `User`. Any `role`, `isActive` or `id` in the body is ignored. Returns a token so the client is logged in immediately.',
        security: [],
        requestBody: {
          required: true,
          content: json(ref('RegisterInput'), { fullName: 'Dana Cohen', email: 'dana@example.com', password: 'a-long-password' }),
        },
        responses: {
          201: { description: 'Account created (always role User).', content: json(ref('AuthResponse'), EX.authResponse) },
          400: r('ValidationError'),
          409: { description: 'An account with this email already exists (any letter case).', content: json(ref('Error'), { error: { code: 'CONFLICT', message: 'An account with this email already exists.' } }) },
        },
      }),
    },
    '/api/auth/login': {
      post: op({
        tags: ['Auth'],
        summary: 'Log in',
        description:
          'Unknown email, wrong password and deactivated account all return the same generic 401, so responses do not reveal which accounts exist.',
        security: [],
        requestBody: { required: true, content: json(ref('LoginInput'), { email: 'dana@example.com', password: 'a-long-password' }) },
        responses: {
          200: { description: 'Logged in.', content: json(ref('AuthResponse'), EX.authResponse) },
          400: r('ValidationError'),
          401: { description: 'Invalid credentials or inactive account.', content: json(ref('Error'), { error: { code: 'UNAUTHORIZED', message: 'Invalid email or password.' } }) },
        },
      }),
    },
    '/api/auth/me': {
      get: op({
        tags: ['Auth'],
        summary: 'Current user',
        description: USER_AUTH,
        security: bearer,
        responses: {
          200: { description: 'The authenticated user.', content: json(ref('MeResponse'), EX.me) },
          401: r('Unauthorized'),
        },
      }),
    },

    // ============================================================ public categories
    '/api/categories': {
      get: op({
        tags: ['Categories'],
        summary: 'List active categories',
        description: 'Active categories only, alphabetical. Disabled categories are listed only in the admin endpoint.',
        security: [],
        parameters: [pageParam, pageSizeParam(50)],
        responses: {
          200: { description: 'Active categories.', content: json(paginated('PublicCategory'), EX.publicCategoryList) },
          400: r('ValidationError'),
        },
      }),
    },

    // ============================================================ recommendations
    '/api/recommendations': {
      get: op({
        tags: ['Recommendations'],
        summary: 'List published recommendations',
        description:
          'Only `Published` recommendations, including those whose category was later disabled. Pending, rejected and removed ones are never returned.',
        security: [],
        parameters: [
          searchParam('title and description'),
          { $ref: '#/components/parameters/categoryId' },
          { $ref: '#/components/parameters/sortBy' },
          { $ref: '#/components/parameters/sortOrder' },
          pageParam,
          pageSizeParam(10),
        ],
        responses: {
          200: { description: 'Published recommendations.', content: json(paginated('PublicRecommendation'), EX.publicRecommendationList) },
          400: r('ValidationError'),
        },
      }),
      post: op({
        tags: ['Recommendations'],
        summary: 'Create a recommendation',
        description: `${USER_AUTH} Created as a regular, public recommendation (\`Published\`, not sponsored). The author is the caller; \`status\`, \`isSponsored\`, \`declaresSponsored\`, author and reviewer fields in the body are ignored. The category must exist and be active.`,
        security: bearer,
        requestBody: {
          required: true,
          content: json(ref('RecommendationInput'), { title: 'Banana bread', description: 'Use very ripe bananas.', categoryId: 3, url: 'https://example.com/recipe' }),
        },
        responses: {
          201: { description: 'Created.', content: json(ref('OwnerRecommendation'), EX.ownerCreated) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
        },
      }),
    },
    '/api/recommendations/mine': {
      get: op({
        tags: ['Recommendations'],
        summary: "List the caller's recommendations",
        description: `${USER_AUTH} Every status, including \`PendingSponsoredApproval\`, \`Rejected\` (with \`rejectionReason\`) and \`Removed\`.`,
        security: bearer,
        parameters: [
          searchParam('title and description'),
          { $ref: '#/components/parameters/categoryId' },
          { $ref: '#/components/parameters/sortBy' },
          { $ref: '#/components/parameters/sortOrder' },
          pageParam,
          pageSizeParam(10),
        ],
        responses: {
          200: { description: "The caller's recommendations.", content: json(paginated('OwnerRecommendation'), EX.ownerList) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
        },
      }),
    },
    '/api/recommendations/favorites': {
      get: op({
        tags: ['Favorites'],
        summary: "List the caller's favorites",
        description: `${USER_AUTH} The caller's saved recommendations, most recently saved first. Only currently **published** recommendations are listed: a saved one that is later removed or sent for review disappears from this list until it is published again.`,
        security: bearer,
        parameters: [pageParam, pageSizeParam(10)],
        responses: {
          200: { description: "The caller's favorites (public view).", content: json(paginated('PublicRecommendation'), EX.favoritesList) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
        },
      }),
    },
    '/api/recommendations/favorites/ids': {
      get: op({
        tags: ['Favorites'],
        summary: "Ids of the caller's favorites",
        description: `${USER_AUTH} The ids of the caller's favorites (published only, same rule as the list), so a client can mark saved items in any list.`,
        security: bearer,
        responses: {
          200: { description: 'Favorite recommendation ids, ascending.', content: json(ref('FavoriteIds'), EX.favoriteIds) },
          401: r('Unauthorized'),
        },
      }),
    },
    '/api/recommendations/{id}': {
      get: op({
        tags: ['Recommendations'],
        summary: 'Get a published recommendation',
        description: 'Returns 404 for anything not `Published`, even to its owner (use `/mine`).',
        security: [],
        parameters: [idParam('Recommendation')],
        responses: {
          200: { description: 'The recommendation.', content: json(ref('PublicRecommendation'), EX.publicSponsoredRecommendation) },
          400: r('ValidationError'),
          404: r('NotFound'),
        },
      }),
      put: op({
        tags: ['Recommendations'],
        summary: 'Edit a recommendation (owner or admin)',
        description: [
          `${USER_AUTH} Allowed for the owner or an \`Admin\`. Replaces \`title\`, \`description\`, \`categoryId\`, \`url\` and \`imageUrl\` (omitted URLs are cleared).`,
          '',
          '- Switching to a disabled category returns 400; keeping the current (now disabled) category is allowed.',
          '- Editing an **approved sponsored** recommendation (by owner or admin) returns it to `PendingSponsoredApproval`, clears `isSponsored` and the previous review.',
          '- `publishAsRegular: true` is only allowed on a `Rejected` recommendation: it becomes `Published`, not sponsored, the sponsorship declaration is withdrawn and the review is cleared. On any other status it returns 409 `INVALID_STATE_TRANSITION`.',
          '- Other statuses keep their status (a rejected recommendation stays private).',
          "- Someone else's recommendation: 403 if public, 404 if private. Removed recommendations: 404.",
          '- Admin edits of other users\' recommendations are logged.',
        ].join('\n'),
        security: bearer,
        parameters: [idParam('Recommendation')],
        requestBody: {
          required: true,
          content: json(ref('UpdateRecommendationInput'), { title: 'Banana bread v2', description: 'Even riper bananas.', categoryId: 3, publishAsRegular: false }),
        },
        responses: {
          200: { description: 'Updated.', content: json(ref('OwnerRecommendation'), EX.ownerUpdated) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('StateConflict'),
        },
      }),
      delete: op({
        tags: ['Recommendations'],
        summary: 'Remove a recommendation (owner or admin)',
        description: `${USER_AUTH} Soft delete: the status becomes \`Removed\`; the row and its audit fields are kept. It disappears from public endpoints and stays visible to the owner in \`/mine\`. Someone else's: 403 if public, 404 if private. Already removed: 404.`,
        security: bearer,
        parameters: [idParam('Recommendation')],
        responses: {
          204: { description: 'Removed. No body.' },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('StateConflict'),
        },
      }),
    },
    '/api/recommendations/{id}/request-sponsored': {
      post: op({
        tags: ['Recommendations'],
        summary: 'Request sponsored approval or update a pending disclosure (owner only)',
        description: [
          `${USER_AUTH} Owner only (admins too, but only for their own). The body is the sponsorship disclosure: sponsor (manufacturer or brand), product and relationship are required; details are required when the relationship is \`Other\`. The disclosure is visible to the owner and admins only: the public sees just the sponsored label.`,
          '- From a regular `Published` recommendation or from `Rejected`: it becomes `PendingSponsoredApproval` (no longer public), `declaresSponsored=true`, the disclosure is stored and the previous review is cleared.',
          '- From `PendingSponsoredApproval`: replaces the disclosure of the pending request. `updatedAt` changes, so an admin review of the previous version is refused with 409.',
          '- Already approved: 409 `INVALID_STATE_TRANSITION` (editing it returns it to pending first).',
          "- Someone else's: 403 if public, 404 if private.",
        ].join('\n'),
        security: bearer,
        parameters: [idParam('Recommendation')],
        requestBody: {
          required: true,
          content: json(ref('RequestSponsoredInput'), {
            sponsorName: 'DeskRise',
            productName: 'DeskRise Aluminum Stand S2',
            sponsorshipType: 'AffiliateLink',
            disclosureDetails: 'The link is an affiliate link; I earn a small commission on purchases.',
          }),
        },
        responses: {
          200: { description: 'Request submitted.', content: json(ref('OwnerRecommendation'), EX.ownerPending) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('StateConflict'),
        },
      }),
    },

    '/api/recommendations/{id}/favorite': {
      post: op({
        tags: ['Favorites'],
        summary: 'Add to favorites',
        description: `${USER_AUTH} Saves a **published** recommendation (anyone's, including the caller's own). Saving it again changes nothing (still 204). Not published, removed or unknown: 404. No request body.`,
        security: bearer,
        parameters: [idParam('Recommendation')],
        responses: {
          204: { description: 'Saved (or already saved). No body.' },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          404: r('NotFound'),
        },
      }),
      delete: op({
        tags: ['Favorites'],
        summary: 'Remove from favorites',
        description: `${USER_AUTH} Removes the recommendation from the caller's favorites. Removing one that is not saved changes nothing (still 204), whatever the recommendation's status.`,
        security: bearer,
        parameters: [idParam('Recommendation')],
        responses: {
          204: { description: 'Removed (or was not saved). No body.' },
          400: r('ValidationError'),
          401: r('Unauthorized'),
        },
      }),
    },

    // ============================================================ admin: sponsored review
    '/api/admin/recommendations': {
      get: op({
        tags: ['Admin: Sponsored review'],
        summary: 'List all recommendations (any user, any status)',
        description: `${ADMIN_ONLY} Recommendations from every user. Without \`status\`, every status is returned (including \`Rejected\` and \`Removed\`); with \`status\`, only that status. Same search, category, sort and pagination options as the public list (default: newest first, 10 per page; ties ordered by id). Read-only: it never restores or changes a recommendation.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [
          {
            name: 'status',
            in: 'query',
            description: 'Only recommendations in this status. Omit for all statuses.',
            schema: { type: 'string', enum: ['Published', 'PendingSponsoredApproval', 'Rejected', 'Removed'] },
          },
          searchParam('title and description'),
          { $ref: '#/components/parameters/categoryId' },
          { $ref: '#/components/parameters/sortBy' },
          { $ref: '#/components/parameters/sortOrder' },
          pageParam,
          pageSizeParam(10),
        ],
        responses: {
          200: { description: 'Recommendations.', content: json(paginated('AdminRecommendation'), EX.adminRecommendationList) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
        },
      }),
    },
    '/api/admin/recommendations/pending-sponsored': {
      get: op({
        tags: ['Admin: Sponsored review'],
        summary: 'List pending sponsored requests',
        description: `${ADMIN_ONLY} All users' pending requests, oldest \`updatedAt\` first (a review queue).`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [pageParam, pageSizeParam(10)],
        responses: {
          200: { description: 'Pending requests.', content: json(paginated('AdminRecommendation'), EX.pendingList) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
        },
      }),
    },
    '/api/admin/recommendations/{id}/approve-sponsored': {
      put: op({
        tags: ['Admin: Sponsored review'],
        summary: 'Approve a sponsored request',
        description: `${ADMIN_ONLY} Only \`PendingSponsoredApproval\` recommendations, and only the exact version reviewed: send that version's \`updatedAt\` as **required** \`expectedUpdatedAt\`. Becomes \`Published\` with \`isSponsored=true\`, reviewer = the authenticated admin, \`reviewedAt\` = server time, \`rejectionReason\` cleared. **The category must be active** at approval time (409 otherwise; checked under a row lock, so a concurrent deactivation cannot slip through). Atomic: a repeated, concurrent or stale review returns 409 and changes nothing. Admins may approve their own requests. Logged.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [idParam('Recommendation')],
        requestBody: { required: true, content: json(ref('ApproveSponsoredInput'), { expectedUpdatedAt: EX.adminPending.updatedAt }) },
        responses: {
          200: { description: 'Approved.', content: json(ref('AdminRecommendation'), EX.adminApproved) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('ReviewConflict'),
        },
      }),
    },
    '/api/admin/recommendations/{id}/reject-sponsored': {
      put: op({
        tags: ['Admin: Sponsored review'],
        summary: 'Reject a sponsored request',
        description: `${ADMIN_ONLY} Only \`PendingSponsoredApproval\` recommendations, and only the exact version reviewed: send that version's \`updatedAt\` as **required** \`expectedUpdatedAt\`. Becomes \`Rejected\` (stays private), \`isSponsored=false\`, reviewer and \`reviewedAt\` recorded, optional \`rejectionReason\`. Allowed even if the category is disabled. Atomic: a repeated, concurrent or stale review returns 409 and changes nothing. Logged.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [idParam('Recommendation')],
        requestBody: {
          required: true,
          content: json(ref('RejectSponsoredInput'), { rejectionReason: 'Please disclose the brand relationship.', expectedUpdatedAt: EX.adminPending.updatedAt }),
        },
        responses: {
          200: { description: 'Rejected.', content: json(ref('AdminRecommendation'), EX.adminRejected) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('ReviewConflict'),
        },
      }),
    },

    // ============================================================ admin: categories
    '/api/admin/categories': {
      get: op({
        tags: ['Admin: Categories'],
        summary: 'List all categories',
        description: `${ADMIN_ONLY} Active and disabled categories, alphabetical.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [searchParam('the name'), pageParam, pageSizeParam(50)],
        responses: {
          200: { description: 'All categories.', content: json(paginated('AdminCategory'), EX.adminCategoryList) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
        },
      }),
      post: op({
        tags: ['Admin: Categories'],
        summary: 'Create a category',
        description: `${ADMIN_ONLY} Always created active (\`isActive\` in the body is ignored). Names are unique regardless of letter case. Logged.`,
        'x-required-role': 'Admin',
        security: bearer,
        requestBody: { required: true, content: json(ref('CategoryInput'), { name: 'Gardening', description: 'Plants and tools.' }) },
        responses: {
          201: { description: 'Created.', content: json(ref('AdminCategory'), EX.adminCategory) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          409: r('DuplicateCategory'),
        },
      }),
    },
    '/api/admin/categories/{id}': {
      put: op({
        tags: ['Admin: Categories'],
        summary: 'Edit a category',
        description: `${ADMIN_ONLY} Replaces \`name\` and \`description\` (omitted description is cleared). Status is changed only via \`PATCH /status\`. There is no delete endpoint: categories are disabled, never deleted. Logged.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [idParam('Category')],
        requestBody: { required: true, content: json(ref('CategoryInput'), { name: 'Cooking & Baking', description: null }) },
        responses: {
          200: { description: 'Updated.', content: json(ref('AdminCategory'), EX.renamedCategory) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('DuplicateCategory'),
        },
      }),
    },
    '/api/admin/categories/{id}/status': {
      patch: op({
        tags: ['Admin: Categories'],
        summary: 'Enable or disable a category',
        description: `${ADMIN_ONLY} Disabling hides the category from \`GET /api/categories\` and from new assignments (creating or moving a recommendation into it returns 400). It never deletes the category or hides recommendations already published in it. Setting the current value is a no-op. Logged.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [idParam('Category')],
        requestBody: { required: true, content: json(ref('StatusInput'), { isActive: false }) },
        responses: {
          200: { description: 'Updated.', content: json(ref('AdminCategory'), EX.disabledCategory) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
        },
      }),
    },

    // ============================================================ admin: users
    '/api/admin/users': {
      get: op({
        tags: ['Admin: Users'],
        summary: 'List users',
        description: `${ADMIN_ONLY} Oldest accounts first. Never includes password hashes.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [searchParam('full name and email'), pageParam, pageSizeParam(10)],
        responses: {
          200: { description: 'Users.', content: json(paginated('AdminUser'), EX.adminUserList) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
        },
      }),
    },
    '/api/admin/users/{id}/status': {
      patch: op({
        tags: ['Admin: Users'],
        summary: 'Activate or deactivate a user',
        description: `${ADMIN_ONLY} Deactivated users cannot log in and their existing tokens stop working immediately. Refused with 409 (database unchanged) for self-deactivation and for the last active admin. Concurrency-safe (serialized with a database lock). Other body fields (e.g. \`role\`) are ignored. Setting the current value is a no-op. Every attempt is logged.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [idParam('User')],
        requestBody: { required: true, content: json(ref('StatusInput'), { isActive: false }) },
        responses: {
          200: { description: 'Updated (or unchanged).', content: json(ref('AdminUser'), EX.deactivatedUser) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('AdminSafeguard'),
        },
      }),
    },
    '/api/admin/users/{id}/role': {
      patch: op({
        tags: ['Admin: Users'],
        summary: "Change a user's role",
        description: `${ADMIN_ONLY} Promote to \`Admin\` or demote to \`User\`; takes effect on the user's next request. Refused with 409 (database unchanged) for self-demotion and for the last active admin. Concurrency-safe (serialized with a database lock). Other body fields (e.g. \`isActive\`) are ignored. Setting the current value is a no-op. Every attempt is logged.`,
        'x-required-role': 'Admin',
        security: bearer,
        parameters: [idParam('User')],
        requestBody: { required: true, content: json(ref('RoleInput'), { role: 'Admin' }) },
        responses: {
          200: { description: 'Updated (or unchanged).', content: json(ref('AdminUser'), EX.promotedUser) },
          400: r('ValidationError'),
          401: r('Unauthorized'),
          403: r('Forbidden'),
          404: r('NotFound'),
          409: r('AdminSafeguard'),
        },
      }),
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'The `accessToken` from `POST /api/auth/login` or `POST /api/auth/register`.',
      },
    },

    parameters: {
      page: {
        name: 'page',
        in: 'query',
        description: 'Page number, starting at 1. Default 1.',
        schema: { type: 'integer', minimum: 1, default: 1 },
      },
      categoryId: {
        name: 'categoryId',
        in: 'query',
        description: 'Only recommendations in this category.',
        schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
      },
      sortBy: {
        name: 'sortBy',
        in: 'query',
        description: 'Sort field. Default `createdAt`.',
        schema: { type: 'string', enum: ['createdAt', 'title'], default: 'createdAt' },
      },
      sortOrder: {
        name: 'sortOrder',
        in: 'query',
        description: 'Sort direction. Default: `desc` (newest first) for `createdAt`, `asc` (A→Z) for `title`.',
        schema: { type: 'string', enum: ['asc', 'desc'] },
      },
    },

    responses: {
      ValidationError: {
        description:
          'Invalid input (body, query or path parameter), malformed JSON, or an inactive/missing category. `details` lists the offending fields when available.',
        content: json(ref('Error'), {
          error: { code: 'VALIDATION_ERROR', message: 'The request contains invalid data.', details: [{ path: 'title', message: 'Title is required.' }] },
        }),
      },
      Unauthorized: {
        description: 'Missing, invalid or expired token, or the account is deactivated.',
        content: json(ref('Error'), { error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } }),
      },
      Forbidden: {
        description: "Authenticated but not allowed (wrong role, or someone else's public recommendation).",
        content: json(ref('Error'), { error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' } }),
      },
      NotFound: {
        description: 'Not found, removed, or not visible to the caller.',
        content: json(ref('Error'), { error: { code: 'NOT_FOUND', message: 'Recommendation not found.' } }),
      },
      StateConflict: {
        description:
          '`INVALID_STATE_TRANSITION`: the action is not allowed in the current status. `CONFLICT`: the recommendation was changed by a concurrent request; reload and retry.',
        content: json(ref('Error'), {
          error: { code: 'INVALID_STATE_TRANSITION', message: 'Only a rejected sponsored recommendation can be published as a regular recommendation.' },
        }),
      },
      ReviewConflict: {
        description:
          '`INVALID_STATE_TRANSITION`: not pending (e.g. already reviewed, or a concurrent review won). `CONFLICT`: `expectedUpdatedAt` does not match the current version (the request changed after you loaded it), or — approval only — the recommendation\'s category is disabled. Nothing is changed in either case.',
        content: json(ref('Error'), {
          error: { code: 'INVALID_STATE_TRANSITION', message: 'Only recommendations pending sponsored approval can be approved. Current status: Published.' },
        }),
      },
      DuplicateCategory: {
        description: 'A category with this name already exists (names are unique regardless of letter case).',
        content: json(ref('Error'), { error: { code: 'CONFLICT', message: 'A category with this name already exists.' } }),
      },
      AdminSafeguard: {
        description: 'Refused by an administrative safeguard: self-demotion, self-deactivation, or the last active admin. Nothing is changed.',
        content: json(ref('Error'), { error: { code: 'CONFLICT', message: 'You cannot demote your own account.' } }),
      },
      PayloadTooLarge: {
        description:
          'The JSON request body is larger than 100 KB. Raised by the JSON body parser before routing, authentication and validation, so it can be returned even without a valid token. Uses the standard error shape; the code is `VALIDATION_ERROR` and there are no `details`.',
        content: json(ref('Error'), { error: { code: 'VALIDATION_ERROR', message: 'The request body could not be processed.' } }),
      },
      InternalError: {
        description: 'Unexpected server error. No internal details are returned.',
        content: json(ref('Error'), { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }),
      },
    },

    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INVALID_STATE_TRANSITION', 'INTERNAL_ERROR'],
              },
              message: { type: 'string' },
              details: {
                type: 'array',
                items: { type: 'object', required: ['path', 'message'], properties: { path: { type: 'string' }, message: { type: 'string' } } },
              },
            },
          },
        },
      },
      Pagination: {
        type: 'object',
        required: ['page', 'pageSize', 'totalItems', 'totalPages'],
        properties: {
          page: { type: 'integer', example: 1 },
          pageSize: { type: 'integer', example: 10 },
          totalItems: { type: 'integer', example: 0 },
          totalPages: { type: 'integer', example: 0 },
        },
      },
      Health: {
        type: 'object',
        required: ['status', 'timestamp'],
        properties: { status: { type: 'string', enum: ['ok'] }, timestamp: { type: 'string', format: 'date-time' } },
      },

      // ------------------------------------------------ auth / users
      RegisterInput: {
        type: 'object',
        required: ['fullName', 'email', 'password'],
        properties: {
          fullName: { type: 'string', minLength: 1, maxLength: 100, description: 'Trimmed.' },
          email: { type: 'string', format: 'email', maxLength: 254, description: 'Trimmed and lower-cased.' },
          password: { type: 'string', minLength: 8, description: '8 to 72 characters (at most 72 bytes in UTF-8, the bcrypt limit).' },
        },
      },
      LoginInput: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 1024 },
        },
      },
      SafeUser: {
        type: 'object',
        required: ['id', 'fullName', 'email', 'role'],
        properties: {
          id: { type: 'integer', example: 2 },
          fullName: { type: 'string', example: 'Dana Cohen' },
          email: { type: 'string', format: 'email', example: 'dana@example.com' },
          role: { type: 'string', enum: ['User', 'Admin'] },
        },
      },
      AuthResponse: {
        type: 'object',
        required: ['accessToken', 'tokenType', 'expiresIn', 'user'],
        properties: {
          accessToken: { type: 'string', description: 'JWT (HS256). Send as `Authorization: Bearer <accessToken>`.' },
          tokenType: { type: 'string', enum: ['Bearer'] },
          expiresIn: { type: 'integer', description: 'Token lifetime in seconds (from JWT_EXPIRES_IN, default 3600).', example: 3600 },
          user: ref('SafeUser'),
        },
      },
      MeResponse: { type: 'object', required: ['user'], properties: { user: ref('SafeUser') } },
      AdminUser: {
        type: 'object',
        required: ['id', 'fullName', 'email', 'role', 'isActive', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'integer' },
          fullName: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['User', 'Admin'] },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      RoleInput: {
        type: 'object',
        required: ['role'],
        properties: { role: { type: 'string', enum: ['User', 'Admin'] } },
      },
      StatusInput: {
        type: 'object',
        required: ['isActive'],
        properties: { isActive: { type: 'boolean' } },
      },

      // ------------------------------------------------ categories
      PublicCategory: {
        type: 'object',
        required: ['id', 'name', 'description'],
        properties: {
          id: { type: 'integer', example: 3 },
          name: { type: 'string', example: 'Cooking Tips' },
          description: { type: 'string', nullable: true },
        },
      },
      AdminCategory: {
        type: 'object',
        required: ['id', 'name', 'description', 'isActive', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CategoryInput: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'Trimmed. Unique regardless of letter case.' },
          description: { type: 'string', nullable: true, maxLength: 500, description: 'Optional; blank or null means none.' },
        },
      },

      // ------------------------------------------------ recommendations
      CategoryRef: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
      },
      PersonRef: {
        type: 'object',
        required: ['id', 'fullName'],
        description: 'Display information only; never an email address.',
        properties: { id: { type: 'integer' }, fullName: { type: 'string' } },
      },
      PublicRecommendation: {
        type: 'object',
        required: ['id', 'title', 'description', 'url', 'imageUrl', 'isSponsored', 'category', 'author', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'integer', example: 1 },
          title: { type: 'string', example: 'Banana bread' },
          description: { type: 'string', example: 'Use very ripe bananas.' },
          url: { type: 'string', nullable: true, format: 'uri' },
          imageUrl: { type: 'string', nullable: true, format: 'uri' },
          isSponsored: { type: 'boolean', description: 'True only for admin-approved sponsored recommendations: show the sponsored label. The disclosure behind it is never public.' },
          category: ref('CategoryRef'),
          author: ref('PersonRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      OwnerRecommendation: {
        description: 'Owner/admin view: the public fields plus workflow fields that are never shown publicly.',
        allOf: [
          ref('PublicRecommendation'),
          {
            type: 'object',
            required: ['status', 'declaresSponsored', 'disclosure', 'reviewedAt', 'rejectionReason'],
            properties: {
              status: { type: 'string', enum: ['Published', 'PendingSponsoredApproval', 'Rejected', 'Removed'] },
              declaresSponsored: {
                type: 'boolean',
                description: "The owner's sponsorship declaration (set by requesting sponsored approval, withdrawn only by publishAsRegular). While Published it always equals isSponsored.",
              },
              disclosure: {
                allOf: [ref('Disclosure')],
                nullable: true,
                description: 'The full disclosure, in every status. Owner and admin views only, never public. Set exactly when declaresSponsored; null otherwise.',
              },
              reviewedAt: { type: 'string', nullable: true, format: 'date-time' },
              rejectionReason: { type: 'string', nullable: true },
            },
          },
        ],
      },
      FavoriteIds: {
        type: 'object',
        required: ['ids'],
        properties: { ids: { type: 'array', items: { type: 'integer' }, example: [4, 7] } },
      },
      Disclosure: {
        type: 'object',
        description: "The owner's sponsorship disclosure, reviewed by admins. Never included in public responses.",
        required: ['sponsorName', 'productName', 'sponsorshipType', 'disclosureDetails'],
        properties: {
          sponsorName: { type: 'string', example: 'PlanWell Studio', description: 'The manufacturer or brand.' },
          productName: { type: 'string', example: 'Weekly Planner Pack' },
          sponsorshipType: { $ref: '#/components/schemas/SponsorshipType' },
          disclosureDetails: { type: 'string', nullable: true, description: 'Always set when sponsorshipType is Other.' },
        },
      },
      SponsorshipType: {
        type: 'string',
        enum: ['PaidPromotion', 'FreeProduct', 'AffiliateLink', 'OwnBusiness', 'Other'],
        description: "The author's relationship with the product: paid to promote it, received it for free, earns through an affiliate link, owns the business, or another relationship (explained in disclosureDetails).",
      },
      AdminRecommendation: {
        description: 'Admin review view: the owner view plus the reviewer.',
        allOf: [
          ref('OwnerRecommendation'),
          {
            type: 'object',
            required: ['reviewedBy'],
            properties: { reviewedBy: { allOf: [ref('PersonRef')], nullable: true } },
          },
        ],
      },
      RecommendationInput: {
        type: 'object',
        required: ['title', 'description', 'categoryId'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120, description: 'Trimmed.' },
          description: { type: 'string', minLength: 1, maxLength: 3000, description: 'Trimmed.' },
          categoryId: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'A JSON number. The category must exist and be active.' },
          url: { type: 'string', nullable: true, maxLength: 2048, description: 'http or https URL. Omitted, null or "" means none.' },
          imageUrl: { type: 'string', nullable: true, maxLength: 2048, description: 'http or https URL. Omitted, null or "" means none.' },
        },
      },
      UpdateRecommendationInput: {
        allOf: [
          ref('RecommendationInput'),
          {
            type: 'object',
            properties: {
              publishAsRegular: {
                type: 'boolean',
                description: 'Only for a Rejected recommendation: publish it as regular (not sponsored), withdrawing the sponsorship declaration.',
              },
            },
          },
        ],
      },
      RequestSponsoredInput: {
        type: 'object',
        required: ['sponsorName', 'productName', 'sponsorshipType'],
        description: 'The sponsorship disclosure. Status, approval and reviewer fields are always decided by the server; other fields are ignored.',
        properties: {
          sponsorName: { type: 'string', minLength: 1, maxLength: 120, description: 'The manufacturer or brand. Trimmed.' },
          productName: { type: 'string', minLength: 1, maxLength: 120, description: 'Trimmed.' },
          sponsorshipType: { $ref: '#/components/schemas/SponsorshipType' },
          disclosureDetails: { type: 'string', nullable: true, maxLength: 1000, description: 'Details about the product or the relationship. Optional, but **required when sponsorshipType is Other**. Trimmed; blank or null means none.' },
        },
      },
      ApproveSponsoredInput: {
        type: 'object',
        required: ['expectedUpdatedAt'],
        description: 'The outcome and reviewer are always decided by the server; other fields are ignored.',
        properties: {
          expectedUpdatedAt: {
            type: 'string',
            format: 'date-time',
            description: 'Required. The `updatedAt` of the version you reviewed (from the list). Compared as an instant (any UTC offset). If the recommendation changed since then, the review is refused with 409 CONFLICT.',
          },
        },
      },
      RejectSponsoredInput: {
        type: 'object',
        required: ['expectedUpdatedAt'],
        description: 'The outcome and reviewer are always decided by the server; other fields are ignored.',
        properties: {
          rejectionReason: { type: 'string', nullable: true, maxLength: 1000, description: 'Optional (spec §6). Trimmed; blank or null means none.' },
          expectedUpdatedAt: {
            type: 'string',
            format: 'date-time',
            description: 'Required. The `updatedAt` of the version you reviewed (from the list). Compared as an instant (any UTC offset). If the recommendation changed since then, the review is refused with 409 CONFLICT.',
          },
        },
      },
    },
  },
} as const;
