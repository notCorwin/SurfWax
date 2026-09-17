export function workLabel(seconds: number): string {
  const units = [["年", 365 * 24 * 60 * 60], ["天", 24 * 60 * 60], ["小时", 60 * 60], ["分钟", 60], ["秒", 1]] as const;
  const first = units.findIndex(([, size]) => seconds >= size);
  if (first < 0) return "工作了0 秒";
  const [name, size] = units[first]!;
  const leading = `${Math.floor(seconds / size)} ${first === 3 ? "分" : name}`;
  if (first === units.length - 1) return `工作了${leading}`;
  const [nextName, nextSize] = units[first + 1]!;
  return `工作了${leading} ${Math.floor((seconds % size) / nextSize)} ${nextName}`;
}
