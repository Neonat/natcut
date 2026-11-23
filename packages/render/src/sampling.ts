export function nearestSourceCoordinate(target: number, targetSize: number, sourceSize: number): number {
  return Math.min(sourceSize - 1, Math.floor(((target + 0.5) * sourceSize) / targetSize));
}

export function compositeRgbaPixel(
  destination: Uint8ClampedArray,
  destinationOffset: number,
  source: Uint8ClampedArray,
  sourceOffset: number,
): void {
  const sourceAlpha = source[sourceOffset + 3] ?? 0;
  if (sourceAlpha === 0) return;
  const destinationAlpha = destination[destinationOffset + 3] ?? 0;
  const inverseSourceAlpha = 255 - sourceAlpha;
  const outputAlpha = Math.round(sourceAlpha + (destinationAlpha * inverseSourceAlpha) / 255);

  for (let channel = 0; channel < 3; channel++) {
    const sourcePremultiplied = (source[sourceOffset + channel] ?? 0) * sourceAlpha;
    const destinationPremultiplied =
      ((destination[destinationOffset + channel] ?? 0) * destinationAlpha * inverseSourceAlpha) / 255;
    destination[destinationOffset + channel] = outputAlpha === 0
      ? 0
      : Math.round((sourcePremultiplied + destinationPremultiplied) / outputAlpha);
  }
  destination[destinationOffset + 3] = outputAlpha;
}
