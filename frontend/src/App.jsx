import React, { createContext, useContext, useEffect, useState } from "react";
import { Aperture, LayoutDashboard, LogOut, Moon, Settings, Sun, SunMoon } from "lucide-react";
import { api } from "./api.js";
import { navigate, useHashRoute, usePoll, useTheme } from "./hooks.js";
import { BatteryPill } from "./components/Battery.jsx";
import { Toasts, useToasts } from "./components/Toasts.jsx";
import Dashboard from "./views/Dashboard.jsx";
import SeriesView from "./views/SeriesView.jsx";
import SettingsView from "./views/SettingsView.jsx";

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const THEMES = { system: SunMoon, light: Sun, dark: Moon };
const NEXT_THEME = { system: "light", light: "dark", dark: "system" };
const THEME_LABEL = { system: "Thème : système", light: "Thème : clair", dark: "Thème : sombre" };

export default function App() {
  const route = useHashRoute();
  const [theme, setTheme] = useTheme();
  const toasts = useToasts();
  const [capturing, setCapturing] = useState(false);
  const overview = usePoll(api.overview, capturing ? 2000 : 5000, [capturing]);
  const [me, setMe] = useState(null);
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);
  const data = overview.data;

  const captureNow = async (seriesIds) => {
    setCapturing(true);
    toasts.push({ type: "info", text: "Réveil de la caméra et capture en cours…" });
    try {
      const res = await api.capture(seriesIds);
      if (res.ok) toasts.push({ type: "ok", text: `Capture réussie (${(res.ms / 1000).toFixed(0)} s)` });
      else toasts.push({ type: "error", text: `Échec de la capture : ${res.error?.slice(-140)}` });
    } catch (err) {
      toasts.push({ type: "error", text: String(err.message || err) });
    } finally {
      setCapturing(false);
      overview.reload();
    }
  };

  const ctx = {
    overview: data,
    reloadOverview: overview.reload,
    captureNow,
    capturing: capturing || Boolean(data?.capturing),
    toast: toasts.push,
  };

  const [page, param] = route;
  const ThemeIcon = THEMES[theme];
  const seriesList = data?.series ?? [];

  let view;
  if (page === "series" && param) view = <SeriesView key={param} id={param} />;
  else if (page === "settings") view = <SettingsView />;
  else view = <Dashboard />;

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <a className="brand" href="#/">
            <span className="brand-mark">
              <Aperture size={18} />
            </span>
            <span>ANRAN Timelapse</span>
          </a>
          <nav className="nav" aria-label="Navigation principale">
            <a className={!page ? "nav-item active" : "nav-item"} href="#/">
              <LayoutDashboard size={16} /> Tableau de bord
            </a>
            {seriesList.map((s) => (
              <a
                key={s.id}
                className={page === "series" && param === s.id ? "nav-item active" : "nav-item"}
                href={`#/series/${s.id}`}
              >
                <span className={`dot ${s.enabled ? (s.pausedByBattery ? "warn" : "on") : "off"}`} />
                {s.name}
              </a>
            ))}
            <a className={page === "settings" ? "nav-item active" : "nav-item"} href="#/settings">
              <Settings size={16} /> Réglages
            </a>
          </nav>
          <div className="topbar-end">
            <BatteryPill battery={data?.battery} onClick={() => navigate("")} />
            {me?.enabled && me.user && (
              <div className="user-chip" title={me.user.email || me.user.username}>
                <span className="avatar" aria-hidden="true">
                  {me.user.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="user-name">{me.user.username}</span>
                <a className="icon-btn small" href="/auth/logout" aria-label="Se déconnecter" title="Se déconnecter">
                  <LogOut size={15} />
                </a>
              </div>
            )}
            <button
              className="icon-btn"
              onClick={() => setTheme(NEXT_THEME[theme])}
              title={THEME_LABEL[theme]}
              aria-label={THEME_LABEL[theme]}
            >
              <ThemeIcon size={18} />
            </button>
          </div>
        </header>
        <main className="content">
          {overview.error && !data ? (
            <div className="empty-state error">Serveur injoignable : {overview.error}</div>
          ) : (
            view
          )}
        </main>
      </div>
      <Toasts items={toasts.items} dismiss={toasts.dismiss} />
    </AppContext.Provider>
  );
}
