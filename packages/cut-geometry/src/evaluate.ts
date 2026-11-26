import {
  GEOMETRY_LIMITS,
  sha256Hex,
  type GeometryIssue,
  type GeometryReport,
  type PrintProfile,
} from '@natcut/domain';
import type { CutGroupMask } from '@natcut/render';
import type { BinaryMask, Contour } from '../../../vendor/pixcut-trace/types.ts';
import { measureGroupCollisions, minimumExpandedEdgeClearanceMm } from './collisions.ts';
import { combineMasks, traceCutContours } from './contours.ts';
import { buildDistanceField } from './distance-field.ts';
import type { DistanceField } from './distance-field.ts';
import { previewExpandedMask } from './dilate.ts';

const PRINT_DPI = 300;
export const GEOMETRY_VERSION = 'natcut-geometry-v1';

export type GeometryEvaluation = {
  contours: Contour[];
  expandedMasks: BinaryMask[];
  report: GeometryReport;
};

export function classifyTraceComplexity(contourCount: number, pointCount: number): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  if (contourCount > GEOMETRY_LIMITS.maxContours) {
    issues.push({
      code: 'TOO_MANY_CONTOURS',
      severity: 'error',
      message: `Artwork has ${contourCount} cut contours; the limit is ${GEOMETRY_LIMITS.maxContours}.`,
    });
  }
  if (pointCount > GEOMETRY_LIMITS.maxContourPoints) {
    issues.push({
      code: 'TOO_MANY_POINTS',
      severity: 'error',
      message: `Cut paths have ${pointCount} points; the limit is ${GEOMETRY_LIMITS.maxContourPoints}.`,
    });
  }
  return issues;
}

function emptyIssue(groupId: string): GeometryIssue {
  return {
    code: 'EMPTY_ARTWORK',
    severity: 'error',
    message: `Cut group ${groupId} has no visible artwork.`,
    cutGroupIds: [groupId],
  };
}

export async function evaluateCutGeometry(
  groups: CutGroupMask[],
  marginMm: number,
  profile: PrintProfile,
  precomputedFields?: DistanceField[],
): Promise<GeometryEvaluation> {
  const issues: GeometryIssue[] = [];
  if (groups.length === 0) {
    issues.push({ code: 'EMPTY_ARTWORK', severity: 'error', message: 'No cut groups were provided.' });
  }

  const dimensionsMatch = groups.every(
    (group) => group.width === profile.sheetWidthPx && group.height === profile.sheetHeightPx,
  );
  if (!dimensionsMatch) {
    issues.push({
      code: 'UNTRACEABLE',
      severity: 'error',
      message: 'Cut mask dimensions do not match the active print profile.',
    });
  }

  const reusableFields = precomputedFields?.length === groups.length && precomputedFields.every(
    (field, index) =>
      field.id === groups[index]?.id &&
      field.width === profile.sheetWidthPx &&
      field.height === profile.sheetHeightPx,
  ) ? precomputedFields : null;
  const fields = dimensionsMatch
    ? reusableFields ?? groups.map((group) => buildDistanceField(group, profile.alphaThreshold))
    : [];
  for (const field of fields) {
    if (field.foregroundCount === 0) issues.push(emptyIssue(field.id));
  }

  const expandedMasks = fields.map((field) => previewExpandedMask(field, marginMm, PRINT_DPI));
  const combined = combineMasks(expandedMasks);
  const edgeClearanceMm = minimumExpandedEdgeClearanceMm(fields, marginMm, PRINT_DPI);

  if (Number.isFinite(edgeClearanceMm) && edgeClearanceMm < 0) {
    issues.push({
      code: 'OUT_OF_BOUNDS',
      severity: 'error',
      message: 'The selected cut margin extends beyond the printable sheet.',
      cutGroupIds: fields.filter((field) => field.foregroundCount > 0).map((field) => field.id),
    });
  } else if (Number.isFinite(edgeClearanceMm) && edgeClearanceMm < GEOMETRY_LIMITS.preferredEdgeClearanceMm) {
    issues.push({
      code: 'CUT_EDGE_CLEARANCE',
      severity: 'warning',
      message: `Cut paths are closer than the preferred ${GEOMETRY_LIMITS.preferredEdgeClearanceMm} mm sheet-edge clearance.`,
    });
  }

  const collisions = measureGroupCollisions(fields, expandedMasks, marginMm, PRINT_DPI);
  for (const collision of collisions) {
    const cutGroupIds = [collision.firstId, collision.secondId];
    if (collision.overlaps) {
      issues.push({
        code: 'CUT_CONTOURS_OVERLAP',
        severity: 'warning',
        message: 'Two expanded cut regions overlap and may merge into one sticker.',
        cutGroupIds,
      });
    } else if (collision.clearanceMm < GEOMETRY_LIMITS.safetyGapMm) {
      issues.push({
        code: 'CUT_GAP_TOO_SMALL',
        severity: 'warning',
        message: `Cut paths retain less than the ${GEOMETRY_LIMITS.safetyGapMm} mm safety gap.`,
        cutGroupIds,
      });
    }
  }

  const trace = combined.data.length > 0
    ? traceCutContours(combined, PRINT_DPI)
    : { contours: [], contourCount: 0, pointCount: 0, cutLengthMm: 0 };
  issues.push(...classifyTraceComplexity(trace.contourCount, trace.pointCount));

  if (fields.some((field) => field.foregroundCount > 0) && trace.contourCount === 0) {
    issues.push({ code: 'UNTRACEABLE', severity: 'error', message: 'Visible artwork did not produce a cut contour.' });
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  const severity = hasError ? 'error' : issues.length > 0 ? 'warning' : 'ok';
  const finiteGaps = collisions.map((collision) => collision.clearanceMm).filter(Number.isFinite);
  const minimumContourGapMm = finiteGaps.length > 0 ? Math.min(...finiteGaps) : null;
  const rasterHash = await sha256Hex(combined.data);

  return {
    contours: trace.contours,
    expandedMasks,
    report: {
      valid: !hasError,
      severity,
      issues,
      contourCount: trace.contourCount,
      pointCount: trace.pointCount,
      cutLengthMm: trace.cutLengthMm,
      minimumContourGapMm,
      edgeClearanceMm: Number.isFinite(edgeClearanceMm) ? edgeClearanceMm : 0,
      geometryVersion: GEOMETRY_VERSION,
      rasterHash,
      acknowledgedByVisitor: false,
      acknowledgedAt: null,
    },
  };
}
