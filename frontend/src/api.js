export const goToLogin = () => {
  const next = `${window.location.pathname}${window.location.hash}`;
  window.location.href = `/auth/login?next=${encodeURIComponent(next)}`;
};

const unwrap = async (res) => {
  if (res.status === 401) {
    goToLogin();
    throw new Error("Session expirée, reconnexion…");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail[0]?.msg : body.detail;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
};

const json = (url, options = {}) =>
  fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(unwrap);

const qs = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v);
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
};

export const api = {
  me: () => json("/auth/me"),
  overview: () => json("/api/overview"),
  battery: (hours = 48) => json(`/api/battery?hours=${hours}`),
  refreshBattery: () => json("/api/battery/refresh", { method: "POST" }),
  capture: (series) => json("/api/capture", { method: "POST", body: { series } }),

  settings: () => json("/api/settings"),
  saveSettings: (body) => json("/api/settings", { method: "PUT", body }),

  series: (id) => json(`/api/series/${id}`),
  createSeries: (body) => json("/api/series", { method: "POST", body }),
  updateSeries: (id, body) => json(`/api/series/${id}`, { method: "PUT", body }),
  deleteSeries: (id, purge) =>
    json(`/api/series/${id}${purge ? "?purge=true" : ""}`, { method: "DELETE" }),
  days: (id) => json(`/api/series/${id}/days`),
  frames: (id, start, end) => json(`/api/series/${id}/frames${qs({ start, end })}`),
  deleteDay: (id, date) => json(`/api/series/${id}/days/${date}`, { method: "DELETE" }),
  deleteFrame: (id, date, name) => json(`/api/series/${id}/frames/${date}/${name}`, { method: "DELETE" }),
  restoreFrame: (id, date, name) =>
    json(`/api/series/${id}/frames/${date}/${name}/restore`, { method: "POST" }),
  videos: (id) => json(`/api/series/${id}/videos`),
  deleteVideo: (id, name) => json(`/api/series/${id}/videos/${name}`, { method: "DELETE" }),
  assemble: (id, start, end) =>
    json(`/api/series/${id}/assemble`, { method: "POST", body: { start, end } }),
};
