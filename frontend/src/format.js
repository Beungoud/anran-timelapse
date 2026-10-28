const pad = (n) => String(n).padStart(2, "0");

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";

export const fmtDate = (date, opts = { weekday: "short", day: "numeric", month: "short" }) =>
  date ? new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString("fr-FR", opts) : "—";

export const fmtDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString("fr-FR", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export const fmtRelative = (iso) => {
  if (!iso) return "—";
  const diff = (new Date(iso) - Date.now()) / 60000;
  const abs = Math.abs(diff);
  if (abs < 1) return diff >= 0 ? "imminente" : "à l'instant";
  const unit = abs < 60 ? `${Math.round(abs)} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} j`;
  return diff >= 0 ? `dans ${unit}` : `il y a ${unit}`;
};

export const cap = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** Time until a scheduled event; anything due within a minute is "imminente". */
export const fmtUntil = (iso) => {
  if (!iso) return "—";
  const diff = (new Date(iso) - Date.now()) / 60000;
  return diff < 1 ? "imminente" : fmtRelative(iso);
};

export const fmtSize = (bytes) => {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
};

export const fmtNumber = (n) => (n ?? 0).toLocaleString("fr-FR");

export const describeSeries = (s) => {
  if (s.mode === "daily") {
    return `Chaque jour à ${s.times.join(", ")}`;
  }
  const every =
    s.intervalMin % 60 === 0
      ? s.intervalMin === 60
        ? "Toutes les heures"
        : `Toutes les ${s.intervalMin / 60} h`
      : `Toutes les ${s.intervalMin} min`;
  const fullDay = s.activeFrom === "00:00" && s.activeTo === "23:59";
  return fullDay ? every : `${every}, ${s.activeFrom}–${s.activeTo}`;
};

export const batteryLevel = (pct) => {
  if (pct == null) return "unknown";
  if (pct >= 50) return "good";
  if (pct >= 25) return "warning";
  return "critical";
};
