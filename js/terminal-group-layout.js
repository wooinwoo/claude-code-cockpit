const GROUP_LAYOUTS = new Set([
  'cols', 'rows', 'grid',
  'main-left', 'main-right', 'main-top', 'main-bottom',
]);

export function normalizeTerminalGroupLayout(layout, count) {
  const migrated = layout === 'h' ? 'cols' : layout === 'v' ? 'rows' : layout;
  if (count === 2) return migrated === 'rows' ? 'rows' : 'cols';
  if (count === 3) return GROUP_LAYOUTS.has(migrated) && migrated !== 'grid' ? migrated : 'main-left';
  if (count >= 4) return ['cols', 'rows', 'grid', 'main-left', 'main-right'].includes(migrated) ? migrated : 'grid';
  return 'cols';
}

export function terminalGroupLayoutOptions(count) {
  if (count === 2) return [['cols', 'Side by side'], ['rows', 'Stacked']];
  if (count === 3) return [
    ['cols', '3 columns'], ['rows', '3 rows'],
    ['main-left', 'Main left'], ['main-right', 'Main right'],
    ['main-top', 'Main top'], ['main-bottom', 'Main bottom'],
  ];
  return [
    ['grid', '2 × 2 grid'], ['cols', `${count} columns`], ['rows', `${count} rows`],
    ['main-left', 'Main left'], ['main-right', 'Main right'],
  ];
}

export function terminalGroupLayoutLabel(group) {
  return terminalGroupLayoutOptions(group?.termIds.length || 0)
    .find(([value]) => value === group?.layout)?.[1] || 'Group layout';
}

export function terminalGroupRects(count, layout, width, height, gap = 16) {
  if (count <= 1) return [{ x: 0, y: 0, w: width, h: height }];
  if (layout === 'cols') {
    const w = (width - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, index) => ({ x: index * (w + gap), y: 0, w, h: height }));
  }
  if (layout === 'rows') {
    const h = (height - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, index) => ({ x: 0, y: index * (h + gap), w: width, h }));
  }
  if (layout === 'grid') {
    const columns = 2;
    const rows = Math.ceil(count / columns);
    const w = (width - gap) / columns;
    const h = (height - gap * (rows - 1)) / rows;
    return Array.from({ length: count }, (_, index) => ({
      x: (index % columns) * (w + gap),
      y: Math.floor(index / columns) * (h + gap),
      w: count === 3 && index === 2 ? width : w,
      h,
    }));
  }
  const secondaryCount = count - 1;
  const horizontalMain = layout === 'main-left' || layout === 'main-right';
  if (horizontalMain) {
    const mainWidth = (width - gap) * 0.64;
    const sideWidth = width - gap - mainWidth;
    const sideHeight = (height - gap * (secondaryCount - 1)) / secondaryCount;
    const mainX = layout === 'main-right' ? sideWidth + gap : 0;
    const sideX = layout === 'main-right' ? 0 : mainWidth + gap;
    return [
      { x: mainX, y: 0, w: mainWidth, h: height },
      ...Array.from({ length: secondaryCount }, (_, index) => ({ x: sideX, y: index * (sideHeight + gap), w: sideWidth, h: sideHeight })),
    ];
  }
  const mainHeight = (height - gap) * 0.64;
  const sideHeight = height - gap - mainHeight;
  const sideWidth = (width - gap * (secondaryCount - 1)) / secondaryCount;
  const mainY = layout === 'main-bottom' ? sideHeight + gap : 0;
  const sideY = layout === 'main-bottom' ? 0 : mainHeight + gap;
  return [
    { x: 0, y: mainY, w: width, h: mainHeight },
    ...Array.from({ length: secondaryCount }, (_, index) => ({ x: index * (sideWidth + gap), y: sideY, w: sideWidth, h: sideHeight })),
  ];
}
