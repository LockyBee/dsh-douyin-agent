export const AUTO_MEMORY_BYTES = 4096;
export const bytes = value => Buffer.byteLength(value, 'utf8');

export function availableMemoryBytes(occupiedBytes, maximum = AUTO_MEMORY_BYTES) {
  return Math.max(0, Math.min(maximum, 24 * 1024 - occupiedBytes));
}

export function fitMemoryRows(rows, maximum, prefix = '', suffix = '') {
  const selected = [];
  let remaining = maximum - bytes(prefix) - bytes(suffix) - 2;
  for (const row of rows) {
    const size = bytes(JSON.stringify(row)) + (selected.length ? 1 : 0);
    if (size > remaining) continue;
    selected.push(row);
    remaining -= size;
  }
  return selected;
}
