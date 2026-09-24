export const CARD_GEOMETRY = Object.freeze({
  convite_owntime: Object.freeze({ width: 1448, height: 2347, pdfWidth: 108, pdfHeight: 175.1 }),
  convite_owner: Object.freeze({ width: 862, height: 1984, pdfWidth: 108, pdfHeight: 248.6 }),
});
export function fitPreview(frame, available, mode = 'desktop') {
  const widthScale = Math.max(0, Number(available?.width) || 0) / frame.width;
  const heightScale = Math.max(0, Number(available?.height) || 0) / frame.height;
  const scale = mode === 'desktop' ? Math.min(1, widthScale, heightScale) : Math.min(1, widthScale);
  return { scale, width: frame.width * scale, height: frame.height * scale };
}
