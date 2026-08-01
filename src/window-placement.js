export function getCenteredCoordinate(origin, outerSize, innerSize) {
  const numericOrigin = Number(origin);
  const numericOuterSize = Number(outerSize);
  const numericInnerSize = Number(innerSize);

  if (
    !Number.isFinite(numericOrigin) ||
    !Number.isFinite(numericOuterSize) ||
    !Number.isFinite(numericInnerSize)
  ) {
    return undefined;
  }

  return Math.round(numericOrigin + (numericOuterSize - numericInnerSize) / 2);
}
