import React, { useState } from "react";
import { Camera, CheckCircle2, Clock, ImageOff, Images, Loader2, RefreshCw, SkipForward, XCircle } from "lucide-react";
import { useApp } from "../App.jsx";
import { api } from "../api.js";
import { usePoll } from "../hooks.js";
import { BatteryChart, BatteryMeter } from "../components/Battery.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import { cap, describeSeries, fmtDate, fmtDateTime, fmtNumber, fmtRelative, fmtTime, fmtUntil } from "../format.js";

const RANGES = [
  { hours: 24, label: "24 h" },
  { hours: 48, label: "48 h" },
  { hours: 168, label: "7 j" },
];

function Stat({ label, value, sub, children }) {
  return (
    <div className="card stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {children}
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

function SeriesCard({ s }) {
  const { captureNow, capturing } = useApp();
  return (
    <article className="card series-card">
      <a className="series-thumb" href={`#/series/${s.id}`}>
        {s.stats.lastFrame ? (
          <img src={s.stats.lastFrame.url} alt={`Dernière image de ${s.name}`} loading="lazy" />
        ) : (
          <div className="thumb-empty">
            <ImageOff size={24} />
          </div>
        )}
        {s.stats.lastFrame && (
          <span className="thumb-caption">
            {fmtDate(s.stats.lastFrame.date, { day: "numeric", month: "short" })} · {s.stats.lastFrame.time.slice(0, 5)}
          </span>
        )}
      </a>
      <div className="series-body">
        <div className="series-title">
          <a href={`#/series/${s.id}`}>
            <h3>{s.name}</h3>
          </a>
          <StatusBadge series={s} />
        </div>
        <p className="muted">{describeSeries(s)}</p>
        <dl className="facts">
          <div>
            <dt>Prochaine</dt>
            <dd>
              {s.capturing
                ? "En cours"
                : s.enabled && s.nextCaptureAt
                  ? `${fmtTime(s.nextCaptureAt)} (${fmtUntil(s.nextCaptureAt)})`
                  : "—"}
            </dd>
          </div>
          <div>
            <dt>Images</dt>
            <dd>
              {fmtNumber(s.stats.frames)} · {s.stats.today} aujourd'hui
            </dd>
          </div>
          <div>
            <dt>Seuil batterie</dt>
            <dd>{s.minBattery ? `${s.minBattery} %` : "aucun"}</dd>
          </div>
        </dl>
        <div className="actions">
          <a className="btn" href={`#/series/${s.id}`}>
            <Images size={16} /> Ouvrir
          </a>
          <button className="btn ghost" onClick={() => captureNow([s.id])} disabled={capturing}>
            <Camera size={16} /> Capturer
          </button>
        </div>
      </div>
    </article>
  );
}

function CaptureLog({ entries, seriesById }) {
  if (!entries.length) return <div className="empty-state">Aucune capture pour l'instant.</div>;
  return (
    <div className="table-wrap">
      <table className="log">
        <thead>
          <tr>
            <th>Quand</th>
            <th>Séries</th>
            <th>Résultat</th>
            <th className="num">Durée</th>
            <th>Détail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((c, i) => {
            const state = c.ok ? "ok" : c.skipped ? "skip" : "fail";
            const Icon = c.ok ? CheckCircle2 : c.skipped ? SkipForward : XCircle;
            return (
              <tr key={`${c.ts}-${i}`}>
                <td className="nowrap">{fmtDateTime(c.ts)}</td>
                <td>{(c.series || []).map((id) => seriesById[id]?.name || id).join(", ") || <span className="muted">Ancienne version</span>}</td>
                <td>
                  <span className={`result ${state}`}>
                    <Icon size={15} />
                    {c.ok ? "OK" : c.skipped ? "Ignorée" : "Échec"}
                  </span>
                </td>
                <td className="num mono">{c.ms ? `${(c.ms / 1000).toFixed(0)} s` : "—"}</td>
                <td className="detail" title={c.error || ""}>
                  {c.frame ? (
                    <a href={c.frame} target="_blank" rel="noreferrer">
                      Voir l'image
                    </a>
                  ) : (
                    (c.error || "").split("\n").pop()
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const { overview, captureNow, capturing, toast, reloadOverview } = useApp();
  const [hours, setHours] = useState(48);
  const battery = usePoll(() => api.battery(hours), 60000, [hours]);
  const [refreshing, setRefreshing] = useState(false);

  if (!overview) return <div className="skeleton" />;

  const series = overview.series;
  const seriesById = Object.fromEntries(series.map((s) => [s.id, s]));
  const latest = series
    .map((s) => s.stats.lastFrame && { ...s.stats.lastFrame, series: s })
    .filter(Boolean)
    .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))[0];
  const upcoming = series
    .filter((s) => s.enabled && s.nextCaptureAt)
    .sort((a, b) => a.nextCaptureAt.localeCompare(b.nextCaptureAt))[0];
  const totalFrames = series.reduce((n, s) => n + s.stats.frames, 0);
  const { attempts, ok, skipped } = overview.last24h;
  const thresholds = series
    .filter((s) => s.minBattery > 0 && s.enabled)
    .map((s) => ({ id: s.id, name: s.name, value: s.minBattery }));

  const refreshBattery = async () => {
    setRefreshing(true);
    try {
      await api.refreshBattery();
      await Promise.all([battery.reload(), reloadOverview()]);
    } catch (err) {
      toast({ type: "error", text: String(err.message || err) });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="page">
      <section className="hero card">
        <div className="hero-media">
          {latest ? (
            <img src={latest.url} alt="Dernière image capturée" />
          ) : (
            <div className="thumb-empty">
              <ImageOff size={32} />
              <span>Pas encore d'image</span>
            </div>
          )}
        </div>
        <div className="hero-side">
          <span className="eyebrow">Dernière image</span>
          <h1>{latest ? cap(fmtDate(latest.date, { weekday: "long", day: "numeric", month: "long" })) : "—"}</h1>
          <p className="muted">
            {latest ? (
              <>
                à <span className="mono">{latest.time.slice(0, 5)}</span> · série{" "}
                <a href={`#/series/${latest.series.id}`}>{latest.series.name}</a>
              </>
            ) : (
              "Lance une première capture pour vérifier la caméra."
            )}
          </p>
          <button className="btn primary large" onClick={() => captureNow()} disabled={capturing}>
            {capturing ? <Loader2 size={18} className="spin" /> : <Camera size={18} />}
            {capturing ? "Capture en cours…" : "Capturer maintenant"}
          </button>
          <span className="hint">Enregistre l'image dans toutes les séries actives. Compter ~45 s (réveil de la caméra).</span>
        </div>
      </section>

      <section className="stats">
        <Stat
          label="Batterie"
          value={overview.battery ? `${overview.battery.percent} %` : "—"}
          sub={overview.battery ? `Relevée ${fmtRelative(overview.battery.ts)}` : "Pas encore relevée"}
        >
          <BatteryMeter battery={overview.battery} />
        </Stat>
        <Stat
          label="Captures sur 24 h"
          value={attempts ? `${ok}/${attempts}` : "—"}
          sub={`${attempts ? Math.round((ok / attempts) * 100) : 0} % de réussite${skipped ? ` · ${skipped} ignorée(s) (batterie)` : ""}`}
        />
        <Stat
          label="Prochaine capture"
          value={upcoming ? fmtTime(upcoming.nextCaptureAt) : "—"}
          sub={upcoming ? `${upcoming.name} · ${upcoming.capturing ? "en cours" : fmtUntil(upcoming.nextCaptureAt)}` : "Aucune série active"}
        />
        <Stat label="Images stockées" value={fmtNumber(totalFrames)} sub={`${series.length} série(s)`} />
      </section>

      <section className="card">
        <header className="card-head">
          <div>
            <h2>Niveau de batterie</h2>
            <p className="muted">Relevé dans le cloud toutes les 15 min et après chaque capture, sans réveiller la caméra.</p>
          </div>
          <div className="head-actions">
            <div className="chips compact">
              {RANGES.map((r) => (
                <button key={r.hours} className={hours === r.hours ? "chip active" : "chip"} onClick={() => setHours(r.hours)}>
                  {r.label}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={refreshBattery} disabled={refreshing} aria-label="Relever maintenant" title="Relever maintenant">
              <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
            </button>
          </div>
        </header>
        <BatteryChart history={battery.data?.history ?? []} thresholds={thresholds} hours={hours} />
      </section>

      <section>
        <div className="section-head">
          <h2>Séries</h2>
          <a className="btn ghost small" href="#/settings">
            Gérer les séries
          </a>
        </div>
        <div className="series-grid">
          {series.map((s) => (
            <SeriesCard key={s.id} s={s} />
          ))}
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <div>
            <h2>Journal des captures</h2>
            <p className="muted">
              <Clock size={13} /> 25 dernières tentatives
            </p>
          </div>
        </header>
        <CaptureLog entries={overview.recentCaptures} seriesById={seriesById} />
      </section>
    </div>
  );
}
