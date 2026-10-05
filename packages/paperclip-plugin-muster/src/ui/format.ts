export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function absoluteTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function formatCount(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("en-US");
}

export function formatUsd(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function openInMusterHref(deepLink: string, origin: string, identifier: string | null): string {
  const params = new URLSearchParams({ host: origin });
  if (identifier) params.set("identifier", identifier);
  return `${deepLink}?${params.toString()}`;
}
