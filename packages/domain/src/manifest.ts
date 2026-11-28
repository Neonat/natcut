import { z } from 'zod';

const finiteNumber = z.number().finite().refine((value) => !Object.is(value, -0), {
  message: 'Negative zero is not allowed',
});

export const CutGroupMemberSchema = z.enum(['sprite', 'trainer', 'branding']);

export const CutGroupSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    members: z.array(CutGroupMemberSchema).min(1).max(3),
  })
  .strict()
  .superRefine((group, context) => {
    if (new Set(group.members).size !== group.members.length) {
      context.addIssue({ code: 'custom', path: ['members'], message: 'Cut group members must be unique' });
    }
  });

export const CompositionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    spriteAssetId: z.string().trim().min(1).max(256),
    trainerAssetId: z.string().trim().min(1).max(256).nullable(),
    theme: z.enum(['default', 'hugging', 'battling', 'side-by-side']),
    sheetVariant: z.enum(['classic', 'duo', 'trio']).optional(),
    plantLabel: z.string().trim().min(1).max(32).regex(/^[A-Z0-9 ]+$/).optional(),
    brandingVariant: z.enum(['logo', 'logo-and-sprites', 'logo-and-species']),
    cutGroups: z.array(CutGroupSchema).min(1).max(64),
    cutMarginMm: finiteNumber.min(0.5).max(3),
    renderVersion: z.string().trim().min(1).max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = manifest.cutGroups.map((group) => group.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['cutGroups'], message: 'Cut group IDs must be unique' });
    }
    const members = manifest.cutGroups.flatMap((group) => group.members);
    if (new Set(members).size !== members.length) {
      context.addIssue({
        code: 'custom',
        path: ['cutGroups'],
        message: 'A visual member can belong to only one cut group',
      });
    }
    if (members.includes('trainer') !== (manifest.trainerAssetId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['trainerAssetId'],
        message: 'Trainer cut-group membership must match trainerAssetId',
      });
    }
  });

export type CutGroupMember = z.infer<typeof CutGroupMemberSchema>;
export type CutGroup = z.infer<typeof CutGroupSchema>;
export type CompositionManifest = z.infer<typeof CompositionManifestSchema>;
