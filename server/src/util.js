// Small shared helpers.

const pad = (n) => String(n).padStart(2, "0");

/** Local time, e.g. 20261116-221530. */
export function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The hostname part of a Host header or an Origin, or "". */
export function hostnameOf(value) {
  try {
    return new URL(String(value).includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return "";
  }
}

/** Turns what the user typed into an http(s) URL, or null. */
export function normalizeAddress(input) {
  const t = String(input ?? "").trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t)
    ? t
    : /^(localhost|127\.|\[::1\])/i.test(t)
      ? `http://${t}`
      : `https://${t}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}
