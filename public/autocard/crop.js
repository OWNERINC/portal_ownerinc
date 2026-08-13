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

export function cropLayout(value, metrics) {
  const crop = normalizeMediaCrop(value);
  const { frameWidth, frameHeight, imageWidth, imageHeight } = metrics || {};
  if (![frameWidth, frameHeight, imageWidth, imageHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.max(frameWidth / imageWidth, frameHeight / imageHeight) * crop.zoom;
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const overflowX = Math.max(0, renderedWidth - frameWidth);
  const overflowY = Math.max(0, renderedHeight - frameHeight);
  return {
    renderedWidth,
    renderedHeight,
    overflowX,
    overflowY,
    translateX: -overflowX * crop.x,
    translateY: -overflowY * crop.y,
  };
}

export function cropRenderStyle(value, metrics) {
  const crop = normalizeMediaCrop(value);
  const layout = cropLayout(crop, metrics);
  if (!layout) return null;
  return `${cropStyle(crop)};width:${layout.renderedWidth}px;height:${layout.renderedHeight}px;max-width:none;max-height:none;transform:translate(${layout.translateX}px,${layout.translateY}px);transform-origin:top left`;
}

export function dragMediaCrop(value, metrics) {
  const crop = normalizeMediaCrop(value);
  const layout = cropLayout(crop, metrics);
  if (!layout) return crop;
  return {
    ...crop,
    x: layout.overflowX ? clamp(crop.x - metrics.dx / layout.overflowX, 0, 1) : crop.x,
    y: layout.overflowY ? clamp(crop.y - metrics.dy / layout.overflowY, 0, 1) : crop.y,
  };
}
