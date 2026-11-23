import { z } from 'zod';

export const GEOMETRY_LIMITS = Object.freeze({
  safetyGapMm: 1.5,
  preferredEdgeClearanceMm: 3,
  maxContours: 64,
  maxContourPoints: 50_000,
});

export const GeometryIssueCodeSchema = z.enum([
  'CUT_CONTOURS_OVERLAP',
  'CUT_GAP_TOO_SMALL',
  'CUT_EDGE_CLEARANCE',
  'EMPTY_ARTWORK',
  'OUT_OF_BOUNDS',
  'TOO_MANY_CONTOURS',
  'TOO_MANY_POINTS',
  'UNTRACEABLE',
]);

export const GeometrySeveritySchema = z.enum(['ok', 'warning', 'error']);

export const GeometryIssueSchema = z
  .object({
    code: GeometryIssueCodeSchema,
    severity: z.enum(['warning', 'error']),
    message: z.string().trim().min(1),
    cutGroupIds: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const GeometryReportSchema = z
  .object({
    valid: z.boolean(),
    severity: GeometrySeveritySchema,
    issues: z.array(GeometryIssueSchema),
    contourCount: z.number().int().nonnegative(),
    pointCount: z.number().int().nonnegative(),
    cutLengthMm: z.number().finite().nonnegative(),
    minimumContourGapMm: z.number().finite().nonnegative().nullable(),
    edgeClearanceMm: z.number().finite(),
    geometryVersion: z.string().trim().min(1),
    rasterHash: sha256Schema,
    acknowledgedByVisitor: z.boolean(),
    acknowledgedAt: z.string().datetime().nullable(),
  })
  .strict();

export type GeometryIssueCode = z.infer<typeof GeometryIssueCodeSchema>;
export type GeometrySeverity = z.infer<typeof GeometrySeveritySchema>;
export type GeometryIssue = z.infer<typeof GeometryIssueSchema>;
export type GeometryReport = z.infer<typeof GeometryReportSchema>;
