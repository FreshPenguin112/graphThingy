/** Recenter a camera on a finite point while preserving its current spans. */
export function centerCameraOn(camera, point) {
  const xSpan = camera.xMax - camera.xMin;
  const ySpan = camera.yMax - camera.yMin;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError("Camera target coordinates must be finite numbers.");
  }
  if (!Number.isFinite(xSpan) || !Number.isFinite(ySpan) || xSpan <= 0 || ySpan <= 0) {
    throw new RangeError("Camera bounds must have positive finite spans.");
  }

  camera.xMin = point.x - xSpan / 2;
  camera.xMax = point.x + xSpan / 2;
  camera.yMin = point.y - ySpan / 2;
  camera.yMax = point.y + ySpan / 2;
}
