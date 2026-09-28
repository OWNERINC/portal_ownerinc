export const CARD_GEOMETRY = Object.freeze({
  convite_owntime: Object.freeze({ width: 1448, height: 2347, pdfWidth: 108, pdfHeight: 175.1 }),
  convite_owner: Object.freeze({ width: 1448, height: 3361, pdfWidth: 108, pdfHeight: 250.68 }),
});
export function fitPreview(frame, available, mode = 'desktop') {
  const widthScale = Math.max(0, Number(available?.width) || 0) / frame.width;
  const heightScale = Math.max(0, Number(available?.height) || 0) / frame.height;
  const scale = mode === 'width' ? Math.min(1, widthScale) : Math.min(1, widthScale, heightScale);
  return { scale, width: frame.width * scale, height: frame.height * scale };
}
