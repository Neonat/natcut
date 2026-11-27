# JPEG generation QC calibration

`natcut-jpeg-qc-v1` compares the decoded, sRGB-tagged JPEG with the RGB8 pixels supplied to the encoder. The reference includes the opaque white background and centered padding. Its SHA-256 digest, measured errors, limits, and worst pixel travel with the generation result.

Run the measurements from the repository root.

```sh
npx vitest run --project printer test/qc-calibration.test.ts test/generation-qc.test.ts
```

## Corpus and codec

The matrix encodes five 158 × 157 RGBA fixtures at all nine candidate qualities, for 45 comparisons. They contain a flat color, two-axis RGB gradient, diagonal saturated edges, an alpha ramp over white, and xorshift-seeded luminance detail over smooth chroma. Centering each fixture in a 174 × 185 raster also exercises partial tiles at the image edges. Measurements use Sharp 0.35.5, libvips 8.18.7, and the embedded sRGB ICC profile, with baseline JPEG and 4:2:0 chroma subsampling.

Nine further fixtures run the verified logical-bundle constructor with the published 1200 × 2100 sheet, 1216 × 2128 raster, and 1,048,576-byte limit. Varying the number of seeded-detail rows changes compressed size. Each row below is the first candidate that fits. A separate dry-run test exercises exhaustion at quality 50.

| Detail rows | Selected quality | Previous candidate bytes | Selected bytes |
| ---: | ---: | ---: | ---: |
| 500 | 95 | — | 549,568 |
| 1,050 | 92 | 1,084,671 | 961,171 |
| 1,200 | 90 | 1,089,585 | 1,035,107 |
| 1,350 | 85 | 1,158,832 | 1,035,206 |
| 1,425 | 80 | 1,087,264 | 997,933 |
| 1,500 | 75 | 1,050,186 | 965,343 |
| 1,660 | 70 | 1,061,833 | 1,001,024 |
| 1,800 | 60 | 1,079,001 | 961,695 |
| 2,100 | 50 | 1,110,041 | 1,008,743 |

## Integer limits

All means and fractions round upward. P99 uses the nearest-rank 99th percentile of each pixel's maximum absolute RGB error. The local measurement takes the largest absolute signed mean error of any channel within one 16 × 16 tile, the size of a 4:2:0 JPEG minimum coded unit. Signed errors can cancel within a tile. A localized, systematic color shift raises this measurement even when the sheet-wide measurements pass.

| Measurement | Maximum in matrix | Maximum on full sheets | Margin | Inclusive limit |
| --- | ---: | ---: | ---: | ---: |
| Per-channel MAE, thousandths of an RGB8 level | 18,313 | 14,746 | 1,000 | 19,313 |
| P99, RGB8 levels | 95 | 51 | 1 | 96 |
| Pixels with any channel error above 32, parts per million | 200,249 | 98,770 | 1,000 | 201,249 |
| Largest tile color bias, RGB8 levels | 8 | 7 | 1 | 9 |

The margins allow one code level for each magnitude and one pixel per thousand for the population fraction. Tests pin the corpus maxima as well as the limits. A change to the codec, fixture, or comparison needs a fresh measurement.

## Rejection evidence

The adversarial comparisons encode a 256 × 192 sRGB gradient at quality 90. The reported worst pixel uses coordinates in the padded print raster.

| Change | Measured result | Reason |
| --- | --- | --- |
| Exchange R and B | Max channel MAE 86,531, p99 149, high-error fraction 928,264 ppm, tile bias 147 | All four limits exceeded |
| Apply exponent 1.55 to each normalized channel | Max channel MAE 37,057, high-error fraction 947,938 ppm, tile bias 42 | Mean error, high-error fraction, tile bias |
| Paint a 3-pixel-wide red contour around a 32 × 32 region | Tile bias 51. Worst pixel at (97, 78) changed from (88, 171, 190) to (252, 45, 87) | Tile bias exceeded 9 |
| Encode at width 128 or 257 in place of 256 | Header dimensions differ from the reference | `raster_size_mismatch` |
| Supply a grayscale JPEG or 16-bit decoded samples | Channel count or sample type differs from RGB8 | `channel_mismatch` |
| Truncate decoded RGB bytes or supply an untagged JPEG | Byte count or embedded profile fails verification | `raster_length_mismatch` or `jpeg_color_profile` |

The cut mask and PLT have no path to the print constructor. The SVG display overlay takes finished JPEG and PLT artifacts. Fidelity thresholds detect the measured perturbations. The separate input paths keep blade trajectories out of printed artwork for arbitrary masks. Physical cyan, magenta, and yellow ribbon registration requires an operator observation of the printed sheet.
