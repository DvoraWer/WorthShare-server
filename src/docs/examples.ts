// Example payloads for the OpenAPI document. They mirror the real DTOs
// (src/dto) and are checked against the documented schemas by
// tests/openapi.test.ts, so they cannot silently drift from the API.

const T0 = '2026-10-01T08:30:00.000Z';
const T1 = '2026-10-05T14:12:45.120Z';
const T2 = '2026-10-11T09:15:30.250Z';
const T3 = '2026-10-11T11:02:10.480Z';

const dana = { id: 2, fullName: 'Dana Cohen' };
const noa = { id: 4, fullName: 'Noa Mizrahi' };
const admin = { id: 1, fullName: 'WorthShare Admin' };
const digitalTools = { id: 5, name: 'Digital Tools' };
const shopping = { id: 2, name: 'Shopping Finds' };

/** A list response with consistent pagination numbers. */
export function listOf<T>(items: T[], page = 1, pageSize = 10, totalItems = items.length) {
  return { items, pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } };
}

// ------------------------------------------------------------------ users and auth

export const safeUser = { id: 2, fullName: 'Dana Cohen', email: 'dana.cohen@example.com', role: 'User' };

export const authResponse = {
  // Shape of a real token; this one is not valid (example signature).
  accessToken:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyIiwiaXNzIjoid29ydGhzaGFyZS1hcGkiLCJhdWQiOiJ3b3J0aHNoYXJlLWNsaWVudCIsImlhdCI6MTc2MDE3NDEwMCwiZXhwIjoxNzYwMTc3NzAwfQ.example-signature',
  tokenType: 'Bearer',
  expiresIn: 3600,
  user: safeUser,
};

export const me = { user: safeUser };

export const adminUser = {
  id: 2,
  fullName: 'Dana Cohen',
  email: 'dana.cohen@example.com',
  role: 'User',
  isActive: true,
  createdAt: T0,
  updatedAt: T0,
};
export const promotedUser = { ...adminUser, role: 'Admin', updatedAt: T3 };
export const deactivatedUser = { ...adminUser, isActive: false, updatedAt: T3 };
export const adminUserList = listOf([
  { id: 1, fullName: 'WorthShare Admin', email: 'admin@example.com', role: 'Admin', isActive: true, createdAt: T0, updatedAt: T0 },
  adminUser,
]);

// ------------------------------------------------------------------ categories

export const publicCategoryList = listOf(
  [
    { id: 4, name: 'Cleaning & Organization', description: 'Keeping home tidy and clean.' },
    { id: 3, name: 'Cooking Tips', description: 'Kitchen tricks and recipes.' },
    { id: 5, name: 'Digital Tools', description: 'Apps, websites and software worth using.' },
  ],
  1,
  50,
);

export const adminCategory = {
  id: 7,
  name: 'Gardening',
  description: 'Plants and tools.',
  isActive: true,
  createdAt: T3,
  updatedAt: T3,
};
export const renamedCategory = { id: 3, name: 'Cooking & Baking', description: null, isActive: true, createdAt: T0, updatedAt: T3 };
export const disabledCategory = {
  id: 6,
  name: 'Seasonal Deals',
  description: 'Retired category kept for existing items.',
  isActive: false,
  createdAt: T0,
  updatedAt: T3,
};
export const adminCategoryList = listOf(
  [{ id: 3, name: 'Cooking Tips', description: 'Kitchen tricks and recipes.', isActive: true, createdAt: T0, updatedAt: T0 }, disabledCategory],
  1,
  50,
);

// ------------------------------------------------------------------ recommendations

export const publicRecommendation = {
  id: 4,
  title: 'Excalidraw for quick diagrams',
  description: 'A free whiteboard tool for hand-drawn style diagrams, right in the browser.',
  url: 'https://excalidraw.com',
  imageUrl: null,
  isSponsored: false,
  category: digitalTools,
  author: dana,
  createdAt: T1,
  updatedAt: T1,
};

export const publicSponsoredRecommendation = {
  id: 7,
  title: 'Weekly planning template pack',
  description: 'A set of printable weekly planners that make it easy to organize tasks and meals.',
  url: 'https://example.com/weekly-planner',
  imageUrl: 'https://example.com/images/weekly-planner.png',
  isSponsored: true,
  category: digitalTools,
  author: noa,
  createdAt: T0,
  updatedAt: T1,
};

export const publicRecommendationList = listOf([publicRecommendation, publicSponsoredRecommendation], 1, 10, 7);

/** The caller's favorites: the public view, most recently saved first. */
export const favoritesList = listOf([publicSponsoredRecommendation, publicRecommendation]);

export const favoriteIds = { ids: [publicRecommendation.id, publicSponsoredRecommendation.id] };

/** Owner view of a newly created (regular, public) recommendation. */
export const ownerCreated = {
  ...publicRecommendation,
  id: 10,
  title: 'Banana bread',
  description: 'Use very ripe bananas.',
  url: 'https://example.com/recipe',
  category: { id: 3, name: 'Cooking Tips' },
  createdAt: T3,
  updatedAt: T3,
  status: 'Published',
  declaresSponsored: false,
  disclosure: null,
  reviewedAt: null,
  rejectionReason: null,
};

export const ownerUpdated = {
  ...ownerCreated,
  title: 'Banana bread v2',
  description: 'Even riper bananas.',
  url: null,
  updatedAt: '2026-10-11T11:20:00.000Z',
};

/** Owner view right after requesting sponsored approval. */
export const ownerPending = {
  ...publicRecommendation,
  id: 8,
  title: 'Adjustable aluminum laptop stand',
  description: 'Raises the screen to eye level and folds flat for travel.',
  url: 'https://example.com/laptop-stand',
  category: shopping,
  createdAt: T1,
  updatedAt: T2,
  status: 'PendingSponsoredApproval',
  declaresSponsored: true,
  disclosure: {
    sponsorName: 'DeskRise',
    productName: 'DeskRise Aluminum Stand S2',
    sponsorshipType: 'AffiliateLink',
    disclosureDetails: 'The link is an affiliate link; I earn a small commission on purchases.',
  },
  reviewedAt: null,
  rejectionReason: null,
};

export const ownerRejected = {
  ...ownerPending,
  id: 9,
  title: 'Miracle all-surface cleaning spray',
  description: 'Cleans most surfaces in one pass.',
  url: 'https://example.com/miracle-spray',
  category: { id: 4, name: 'Cleaning & Organization' },
  status: 'Rejected',
  disclosure: { sponsorName: 'ShinyHome', productName: 'Miracle Spray', sponsorshipType: 'PaidPromotion', disclosureDetails: null },
  reviewedAt: T2,
  rejectionReason: 'Claims are not substantiated. Please describe actual results.',
};

export const ownerList = listOf([{ ...ownerCreated }, ownerPending, ownerRejected]);

/** Admin views: the owner view plus the reviewer. */
export const adminPending = { ...ownerPending, reviewedBy: null };

export const adminApproved = {
  ...ownerPending,
  status: 'Published',
  isSponsored: true,
  reviewedAt: T3,
  updatedAt: T3,
  reviewedBy: admin,
};

export const adminRejected = {
  ...ownerPending,
  status: 'Rejected',
  isSponsored: false,
  reviewedAt: T3,
  updatedAt: T3,
  rejectionReason: 'The link leads to a different product than the one described.',
  reviewedBy: admin,
};

export const adminRemoved = {
  ...publicRecommendation,
  id: 11,
  title: 'Old coupon site',
  description: 'No longer maintained.',
  url: 'https://example.com/coupons',
  status: 'Removed',
  declaresSponsored: false,
  disclosure: null,
  reviewedAt: null,
  rejectionReason: null,
  updatedAt: T3,
  reviewedBy: null,
};

export const pendingList = listOf([adminPending]);
export const adminRecommendationList = listOf([adminRemoved, { ...ownerRejected, reviewedBy: admin }, adminPending], 1, 10, 9);

export const health = { status: 'ok', timestamp: T3 };
