import { z } from 'zod';
import { clientKey, fail, handle, ok, rateLimit } from '@/lib/api';
import { requireAdmin } from '@/lib/auth';
import { isDatabaseConfigured } from '@/lib/env';
import { parseDeclaredScale } from '@/lib/analytics/units';
import { securityTypeEnum } from '@/lib/db/schema';
import {
  getInstrumentBySymbol,
  listInstruments,
  updateInstrument,
  upsertInstruments,
} from '@/lib/db/repositories/instruments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instrument administration.
 *
 * Adding or deactivating a security used to mean editing the seed CSV and
 * re-seeding, which is not something an operator can do against a deployed
 * database. This is the same set of changes, made safely and audibly.
 *
 * Two deliberate constraints:
 *   - Deactivating is offered; deleting is not. An instrument is referenced by
 *     every market row, valuation and ranking entry ever recorded for it, so
 *     removing one would either fail on a foreign key or destroy history.
 *   - A symbol cannot be edited. It is the identity every stored observation
 *     joins on, so renaming one would silently re-attribute history to a
 *     different company.
 */

const SYMBOL = /^[A-Z][A-Z0-9-]{0,19}$/;

const createSchema = z.object({
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(SYMBOL, 'A symbol is 1-20 characters: letters, digits and hyphens.'),
  name: z.string().trim().min(1).max(200),
  // Taken from the schema enum, so the two can never drift apart.
  securityType: z.enum(securityTypeEnum.enumValues).default('EQUITY'),
  sector: z.string().trim().max(80).nullable().default(null),
  isCrossListed: z.boolean().default(false),
  countryOfIncorporation: z.string().trim().length(2).default('TZ'),
  currency: z.string().trim().length(3).default('TZS'),
  sharesOutstanding: z.number().positive().nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});

const editSchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(SYMBOL),
  name: z.string().trim().min(1).max(200).optional(),
  sector: z.string().trim().max(80).nullable().optional(),
  isCrossListed: z.boolean().optional(),
  currency: z.string().trim().length(3).optional(),
  countryOfIncorporation: z.string().trim().length(2).optional(),
  active: z.boolean().optional(),
  sharesOutstanding: z.number().positive().nullable().optional(),
  /**
   * Accepts what a statement actually prints ("TZS'000") as well as a number.
   * An explicit null clears the declaration and returns the issuer to
   * inference; omitting the key leaves it untouched.
   */
  reportingScale: z.union([z.string(), z.number(), z.null()]).optional(),
  reportingScaleSource: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** GET /api/admin/instruments — the full master, active and inactive. */
export async function GET() {
  return handle(async () => {
    await requireAdmin();
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const rows = await listInstruments({ activeOnly: false });
    return ok({ instruments: rows, count: rows.length });
  });
}

/** POST /api/admin/instruments — add a security. */
export async function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const limit = await rateLimit(`admin-instruments:${clientKey(request)}`, 30, 60_000);
    if (!limit.allowed) {
      return fail(429, 'RATE_LIMITED', 'Too many changes. Try again shortly.');
    }

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'INVALID_BODY', 'The instrument could not be read.', {
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const existing = await getInstrumentBySymbol(parsed.data.symbol);
    if (existing) {
      // Creating over an existing symbol would silently rewrite the identity
      // that all of its stored history joins on.
      return fail(
        409,
        'SYMBOL_EXISTS',
        `${parsed.data.symbol} already exists. Edit it instead of adding it again.`,
      );
    }

    const result = await upsertInstruments([
      {
        symbol: parsed.data.symbol,
        name: parsed.data.name,
        securityType: parsed.data.securityType,
        sector: parsed.data.sector,
        isCrossListed: parsed.data.isCrossListed,
        countryOfIncorporation: parsed.data.countryOfIncorporation,
        currency: parsed.data.currency,
        sharesOutstanding: parsed.data.sharesOutstanding,
        notes: parsed.data.notes,
      },
    ]);

    return ok({ symbol: parsed.data.symbol, ...result });
  });
}

/** PATCH /api/admin/instruments — change one, including deactivating it. */
export async function PATCH(request: Request) {
  return handle(async () => {
    await requireAdmin();
    if (!isDatabaseConfigured()) {
      return fail(503, 'DATABASE_NOT_CONFIGURED', 'No database is configured.');
    }

    const limit = await rateLimit(`admin-instruments:${clientKey(request)}`, 30, 60_000);
    if (!limit.allowed) {
      return fail(429, 'RATE_LIMITED', 'Too many changes. Try again shortly.');
    }

    const parsed = editSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'INVALID_BODY', 'The change could not be read.', {
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const { symbol, reportingScale, ...rest } = parsed.data;

    // A scale that cannot be read is refused rather than defaulted to 1, which
    // would publish figures a thousandfold out as though they were declared.
    let scale: number | null | undefined;
    if (reportingScale !== undefined) {
      if (reportingScale === null || reportingScale === '') {
        scale = null;
      } else {
        const value = parseDeclaredScale(reportingScale);
        if (value === null) {
          return fail(
            400,
            'INVALID_REPORTING_SCALE',
            `"${reportingScale}" is not a reporting scale. Use a number, or the wording from the statements such as "TZS'000" or "millions".`,
          );
        }
        scale = value;
      }
    }

    const updated = await updateInstrument(symbol, {
      ...rest,
      ...(scale !== undefined ? { reportingScale: scale } : {}),
    });

    if (!updated) {
      return fail(404, 'NOT_FOUND', `${symbol} is not in the instrument master.`);
    }

    const row = await getInstrumentBySymbol(symbol);
    return ok({ symbol, instrument: row });
  });
}
