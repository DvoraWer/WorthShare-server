// Idempotent seed (spec.md §15). Run with `npm run db:seed`.
//
// - Creates missing rows only. Existing users, categories and recommendations
//   are never updated, reset or deleted, so running it again is safe.
// - Credentials come from environment variables; nothing secret is hardcoded.
// - Passwords and hashes are never logged.

import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPrismaClient } from '../src/db/prisma.js';
import type { PrismaClient, Prisma } from '../src/generated/prisma/client.js';
import { hashPassword, normalizeEmail, passwordSchema } from '../src/utils/password.js';

const seedEnvSchema = z.object({
  // Normalize before validating so surrounding whitespace is tolerated.
  SEED_ADMIN_EMAIL: z.string().transform(normalizeEmail).pipe(z.email()),
  SEED_ADMIN_PASSWORD: passwordSchema,
  SEED_ADMIN_FULL_NAME: z.string().trim().min(1).default('WorthShare Admin'),
  SEED_DEMO_USER_PASSWORD: passwordSchema,
});

export type SeedConfig = z.infer<typeof seedEnvSchema>;

export function parseSeedConfig(source: NodeJS.ProcessEnv = process.env): SeedConfig {
  const result = seedEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid seed configuration:\n${issues}`);
  }
  return result.data;
}

const demoUsers = [
  { key: 'dana', fullName: 'דנה כהן', email: 'dana.cohen@example.com' },
  { key: 'yossi', fullName: 'יוסי לוי', email: 'yossi.levi@example.com' },
  { key: 'noa', fullName: 'נועה מזרחי', email: 'noa.mizrahi@example.com' },
] as const;

type UserKey = 'admin' | (typeof demoUsers)[number]['key'];

const categories = [
  { name: 'לימודים', description: 'קורסים, אתרי לימוד וכלים ללמידה.', isActive: true },
  { name: 'מציאות קניות', description: 'מוצרים שימושיים וקניות חכמות.', isActive: true },
  { name: 'טיפים לבישול', description: 'טריקים למטבח ומתכונים.', isActive: true },
  { name: 'ניקיון וסדר', description: 'שמירה על בית נקי ומסודר.', isActive: true },
  { name: 'כלים דיגיטליים', description: 'אפליקציות, אתרים ותוכנות ששווה להכיר.', isActive: true },
  { name: 'מבצעים עונתיים', description: 'קטגוריה שהושבתה ונשמרת עבור המלצות קיימות.', isActive: false },
] as const;

type CategoryName = (typeof categories)[number]['name'];

/** The owner's disclosure for a declared-sponsored recommendation. */
type SeedDisclosure = Pick<
  Prisma.RecommendationUncheckedCreateInput,
  'sponsorName' | 'productName' | 'sponsorshipType' | 'disclosureDetails'
>;

type SeedRecommendation = {
  title: string;
  description: string;
  category: CategoryName;
  author: UserKey;
  url?: string;
  imageUrl?: string;
} & (
  | { kind: 'published' }
  | { kind: 'sponsored'; disclosure: SeedDisclosure }
  | { kind: 'pending'; disclosure: SeedDisclosure }
  | { kind: 'rejected'; disclosure: SeedDisclosure; rejectionReason: string }
);

const recommendations: SeedRecommendation[] = [
  {
    kind: 'published',
    title: 'קורסים בחינם באקדמיית קהאן',
    description: 'שיעורים איכותיים בחינם במתמטיקה, מדעים ועוד, כולל תרגילים.',
    category: 'לימודים',
    author: 'dana',
    url: 'https://www.khanacademy.org',
  },
  {
    kind: 'published',
    title: 'להקפיא עשבי תיבול טריים בשמן זית',
    description: 'קוצצים עשבי תיבול, ממלאים תבנית קרח, מוסיפים שמן זית ומקפיאים. קוביות טעם מוכנות לשימוש.',
    category: 'טיפים לבישול',
    author: 'yossi',
  },
  {
    kind: 'published',
    title: 'סודה לשתייה וחומץ לניקוז איטי',
    description: 'חצי כוס סודה לשתייה, כוס חומץ, מחכים 15 דקות ושוטפים במים חמים.',
    category: 'ניקיון וסדר',
    author: 'noa',
  },
  {
    kind: 'published',
    title: 'Excalidraw לשרטוט תרשימים מהיר',
    description: 'לוח שרטוט חינמי לתרשימים בסגנון כתב יד, ישירות בדפדפן.',
    category: 'כלים דיגיטליים',
    author: 'dana',
    url: 'https://excalidraw.com',
  },
  {
    kind: 'published',
    title: 'להשוות מחיר ליחידה ולא מחיר על המדף',
    description: 'בודקים בתווית המדף את המחיר ל-100 גרם או ליחידה, ומוצאים את המציאה האמיתית.',
    category: 'מציאות קניות',
    author: 'yossi',
  },
  {
    kind: 'published',
    title: 'לקנות מעילי חורף בתחילת האביב',
    description: 'במכירות סוף עונה מחירי המעילים יורדים לפעמים בחצי. נשמרת בכוונה בקטגוריה מושבתת.',
    category: 'מבצעים עונתיים',
    author: 'noa',
  },
  {
    kind: 'sponsored',
    title: 'ערכת תבניות לתכנון שבועי',
    description: 'סט מתכננים שבועיים להדפסה שעוזרים לארגן משימות וארוחות.',
    category: 'כלים דיגיטליים',
    author: 'noa',
    url: 'https://example.com/weekly-planner',
    disclosure: {
      sponsorName: 'PlanWell Studio',
      productName: 'ערכת מתכנן שבועי',
      sponsorshipType: 'FreeProduct',
      disclosureDetails: 'קיבלתי את ערכת התבניות המלאה בחינם בתמורה לביקורת כנה.',
    },
  },
  {
    kind: 'pending',
    title: 'מעמד אלומיניום מתכוונן למחשב נייד',
    description: 'מגביה את המסך לגובה העיניים ומתקפל לנסיעות.',
    category: 'מציאות קניות',
    author: 'dana',
    url: 'https://example.com/laptop-stand',
    disclosure: {
      sponsorName: 'DeskRise',
      productName: 'מעמד אלומיניום DeskRise S2',
      sponsorshipType: 'AffiliateLink',
      disclosureDetails: 'הקישור הוא קישור שותפים: אני מקבלת עמלה קטנה על כל רכישה.',
    },
  },
  {
    kind: 'rejected',
    title: 'ספריי ניקוי פלא לכל המשטחים',
    description: 'מנקה הכל מיד. 70% הנחה לזמן מוגבל!',
    category: 'ניקיון וסדר',
    author: 'yossi',
    url: 'https://example.com/miracle-spray',
    disclosure: { sponsorName: 'ShinyHome', productName: 'ספריי הפלא', sponsorshipType: 'PaidPromotion' },
    rejectionReason: 'הטענות לא מבוססות. נא לתאר תוצאות אמיתיות ולהסיר את פרסומת ההנחה.',
  },
];

export interface SeedSummary {
  users: { created: number; existing: number };
  categories: { created: number; existing: number };
  recommendations: { created: number; existing: number };
}

export async function runSeed(prisma: PrismaClient, config: SeedConfig): Promise<SeedSummary> {
  const summary: SeedSummary = {
    users: { created: 0, existing: 0 },
    categories: { created: 0, existing: 0 },
    recommendations: { created: 0, existing: 0 },
  };

  // Hash outside the transaction to keep it short.
  const [adminHash, demoHash] = await Promise.all([
    hashPassword(config.SEED_ADMIN_PASSWORD),
    hashPassword(config.SEED_DEMO_USER_PASSWORD),
  ]);

  await prisma.$transaction(async (tx) => {
    const userIds = {} as Record<UserKey, number>;

    const ensureUser = async (key: UserKey, data: Prisma.UserCreateInput) => {
      const existing = await tx.user.findUnique({ where: { email: data.email } });
      if (existing) {
        summary.users.existing++;
        if (key === 'admin' && (existing.role !== 'Admin' || !existing.isActive)) {
          console.warn(
            `Seed: user ${data.email} already exists but is not an active Admin. It was left unchanged.`,
          );
        }
        userIds[key] = existing.id;
        return;
      }
      const created = await tx.user.create({ data });
      summary.users.created++;
      userIds[key] = created.id;
    };

    await ensureUser('admin', {
      fullName: config.SEED_ADMIN_FULL_NAME,
      email: config.SEED_ADMIN_EMAIL,
      passwordHash: adminHash,
      role: 'Admin',
    });
    for (const user of demoUsers) {
      await ensureUser(user.key, {
        fullName: user.fullName,
        email: normalizeEmail(user.email),
        passwordHash: demoHash,
      });
    }

    const categoryIds = {} as Record<CategoryName, number>;
    for (const category of categories) {
      // name is citext, so this lookup is case-insensitive.
      const existing = await tx.category.findUnique({ where: { name: category.name } });
      if (existing) {
        summary.categories.existing++;
        categoryIds[category.name] = existing.id;
        continue;
      }
      const created = await tx.category.create({ data: category });
      summary.categories.created++;
      categoryIds[category.name] = created.id;
    }

    const reviewedAt = new Date();
    for (const rec of recommendations) {
      const authorId = userIds[rec.author];
      const existing = await tx.recommendation.findFirst({
        where: { title: rec.title, createdByUserId: authorId },
        select: { id: true },
      });
      if (existing) {
        summary.recommendations.existing++;
        continue;
      }

      const base = {
        title: rec.title,
        description: rec.description,
        categoryId: categoryIds[rec.category],
        createdByUserId: authorId,
        url: rec.url ?? null,
        imageUrl: rec.imageUrl ?? null,
      };

      let data: Prisma.RecommendationUncheckedCreateInput;
      switch (rec.kind) {
        case 'published':
          data = { ...base, status: 'Published', isSponsored: false, declaresSponsored: false };
          break;
        case 'sponsored':
          data = {
            ...base,
            status: 'Published',
            isSponsored: true,
            declaresSponsored: true,
            ...rec.disclosure,
            reviewedByUserId: userIds.admin,
            reviewedAt,
          };
          break;
        case 'pending':
          data = { ...base, status: 'PendingSponsoredApproval', isSponsored: false, declaresSponsored: true, ...rec.disclosure };
          break;
        case 'rejected':
          data = {
            ...base,
            status: 'Rejected',
            isSponsored: false,
            declaresSponsored: true,
            ...rec.disclosure,
            reviewedByUserId: userIds.admin,
            reviewedAt,
            rejectionReason: rec.rejectionReason,
          };
          break;
      }

      await tx.recommendation.create({ data });
      summary.recommendations.created++;
    }
  });

  return summary;
}

async function main() {
  const config = parseSeedConfig();
  const prisma = createPrismaClient();
  try {
    const summary = await runSeed(prisma, config);
    console.log('Seed complete:');
    for (const [table, counts] of Object.entries(summary)) {
      console.log(`  ${table}: ${counts.created} created, ${counts.existing} already existed`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
