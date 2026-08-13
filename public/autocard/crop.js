export const DEFAULT_MEDIA_CROP = Object.freeze({ x: 0.5, y: 0.5, zoom: 1 });
export const MEDIA_CROP_ZOOM_MIN = 1;
export const MEDIA_CROP_ZOOM_MAX = 3;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeMediaCrop(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_MEDIA_CROP };
  const x = Number(value.x);
  const y = Number(value.y);
  const zoom = Number(value.zoom);
  if (![x, y, zoom].every(Number.isFinite)) return { ...DEFAULT_MEDIA_CROP };
  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    zoom: clamp(zoom, MEDIA_CROP_ZOOM_MIN, MEDIA_CROP_ZOOM_MAX),
  };
}

export function cropStyle(value) {
  const crop = normalizeMediaCrop(value);
  return `--crop-x:${crop.x * 100}%;--crop-y:${crop.y * 100}%;--crop-zoom:${crop.zoom}`;
}

export function dragMediaCrop(value, metrics) {
  const crop = normalizeMediaCrop(value);
  const imageRatio = metrics.imageWidth / metrics.imageHeight;
  const fittedWidth = Math.max(metrics.frameWidth, metrics.frameHeight * imageRatio) * crop.zoom;
  const fittedHeight = Math.max(metrics.frameHeight, metrics.frameWidth / imageRatio) * crop.zoom;
  const overflowX = Math.max(0, fittedWidth - metrics.frameWidth);
  const overflowY = Math.max(0, fittedHeight - metrics.frameHeight);
  return {
    ...crop,
    x: overflowX ? clamp(crop.x - metrics.dx / overflowX, 0, 1) : crop.x,
    y: overflowY ? clamp(crop.y - metrics.dy / overflowY, 0, 1) : crop.y,
  };
}
