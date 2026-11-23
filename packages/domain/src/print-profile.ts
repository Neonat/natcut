import { z } from 'zod';

export const PrintProfileSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.number().int().positive(),
    mediaSize: z.number().int().positive(),
    mediaType: z.number().int().positive(),
    sheetWidthPx: z.number().int().positive(),
    sheetHeightPx: z.number().int().positive(),
    rasterWidthPx: z.number().int().positive(),
    rasterHeightPx: z.number().int().positive(),
    printQuality: z.number().int().positive(),
    copies: z.number().int().positive(),
    knifePressure: z.number().int().min(1).max(100),
    cutHoles: z.boolean(),
    alphaThreshold: z.number().int().min(0).max(255),
    jpegMaxBytes: z.number().int().positive(),
  })
  .strict();

export type PrintProfile = z.infer<typeof PrintProfileSchema>;

export const DEVFEST_SG_V1 = PrintProfileSchema.parse({
  id: 'devfest-sg-v1',
  version: 1,
  mediaSize: 5013,
  mediaType: 2030,
  sheetWidthPx: 1200,
  sheetHeightPx: 2100,
  rasterWidthPx: 1216,
  rasterHeightPx: 2128,
  printQuality: 4,
  copies: 1,
  knifePressure: 42,
  cutHoles: false,
  alphaThreshold: 128,
  jpegMaxBytes: 1_048_576,
});
