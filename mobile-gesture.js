export function normalizeTouchGesture({
  mode,
  startX,
  startY,
  currentX,
  currentY,
  startDistance,
  currentDistance,
  centerX,
  centerY,
  viewWidth,
  viewHeight,
  camera,
}) {
  if (mode === "pan") {
    const dx = (currentX - startX) / Math.max(1, viewWidth);
    const dy = (startY - currentY) / Math.max(1, viewHeight);
    const xRange = camera.xMax - camera.xMin;
    const yRange = camera.yMax - camera.yMin;
    return {
      dx: dx * xRange,
      dy: dy * yRange,
      xDelta: dx * xRange,
      yDelta: dy * yRange,
    };
  }

  const zoomFactor = currentDistance / Math.max(startDistance, 1e-9);
  return {
    zoomFactor,
    centerX,
    centerY,
  };
}
