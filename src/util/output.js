export function sortObjectByKey(object) {
  return Object.fromEntries(
    Object.keys(object)
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((key) => [key, object[key]]),
  );
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function table(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => String(row[column.key] ?? "").length)),
  );
  const header = columns
    .map((column, index) => column.label.padEnd(widths[index]))
    .join("  ")
    .trimEnd();
  const lines = [header, widths.map((width) => "-".repeat(width)).join("  ")];
  for (const row of rows) {
    lines.push(
      columns
        .map((column, index) => String(row[column.key] ?? "").padEnd(widths[index]))
        .join("  ")
        .trimEnd(),
    );
  }
  return `${lines.join("\n")}\n`;
}
