import React, { useEffect, useMemo, useState } from "react";
import { Camera, Clapperboard, Film, Loader2, Pencil, Power, Trash2 } from "lucide-react";
import { useApp } from "../App.jsx";
import { api } from "../api.js";
import { usePoll } from "../hooks.js";
import FrameExplorer from "../components/FrameExplorer.jsx";
import SeriesForm from "../components/SeriesForm.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import { cap, describeSeries, fmtDate, fmtDateTime, fmtNumber, fmtSize, fmtTime, fmtUntil } from "../format.js";

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const PERIODS = [
  { id: "30", label: "30 jours", start: () => daysAgo(30) },
  { id: "90", label: "3 mois", start: () => daysAgo(90) },
  { id: "365", label: "1 an", start: () => daysAgo(365) },
  { id: "all", label: "Tout", start: () => null },
];

function videoLabel(name) {
  if (name === "complet") return "Toute la période";
  if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return cap(fmtDate(name, { weekday: "long", day: "numeric", month: "long" }));
  const [a, b] = name.split("_");
  return `Du ${a === "debut" ? "début" : fmtDate(a)} au ${b === "fin" ? "dernier jour" : fmtDate(b)}`;
}

function VideoPanel({ seriesId, videos, onDeleted, preferred }) {
  const [current, setCurrent] = useState(null);
  const { toast } = useApp();

  useEffect(() => {
    if (!videos.length) setCurrent(null);
    else if (preferred && videos.some((v) => v.name === preferred)) setCurrent(preferred);
    else if (!videos.some((v) => v.name === current)) setCurrent(videos[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos, preferred]);

  const video = videos.find((v) => v.name === current);

  const remove = async () => {
    if (!video || !window.confirm(`Supprimer la vidéo « ${videoLabel(video.name)} » ?`)) return;
    try {
      await api.deleteVideo(seriesId, video.name);
      onDeleted();
    } catch (err) {
      toast({ type: "error", text: String(err.message || err) });
    }
  };

  if (!videos.length) {
    return (
      <div className="empty-state">
        <Film size={28} />
        <span>Aucune vidéo assemblée pour l'instant.</span>
      </div>
    );
  }

  return (
    <div className="video-panel">
      <video key={video?.url} controls playsInline loop src={video?.url} className="player" />
      <div className="video-meta">
        <select value={current || ""} onChange={(e) => setCurrent(e.target.value)} aria-label="Choisir une vidéo">
          {videos.map((v) => (
            <option key={v.name} value={v.name}>
              {videoLabel(v.name)}
            </option>
          ))}
        </select>
        {video && (
          <>
            <span className="muted small">
              {fmtSize(video.size)} · générée {fmtDateTime(video.updatedAt)}
            </span>
            <a className="btn ghost small" href={video.url} download={`${seriesId}-${video.name}.mp4`}>
              Télécharger
            </a>
            <button className="icon-btn danger" onClick={remove} aria-label="Supprimer la vidéo" title="Supprimer la vidéo">
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function SeriesView({ id }) {
  const { overview, captureNow, capturing, toast, reloadOverview } = useApp();
  const fromOverview = overview?.series.find((s) => s.id === id);
  const series = usePoll(() => api.series(id), 10000, [id]);
  const s = series.data || fromOverview;
  const isDaily = s?.mode === "daily";

  const days = usePoll(() => api.days(id), 0, [id]);
  const videos = usePoll(() => api.videos(id), 0, [id]);
  const [day, setDay] = useState(null);
  const [period, setPeriod] = useState("30");
  const [assembling, setAssembling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [preferredVideo, setPreferredVideo] = useState(null);

  useEffect(() => {
    if (!isDaily && days.data?.length && !days.data.some((d) => d.date === day)) setDay(days.data[0].date);
  }, [days.data, day, isDaily]);

  const range = useMemo(() => {
    if (!s) return null;
    if (!isDaily) return day ? { start: day, end: day } : null;
    return { start: PERIODS.find((p) => p.id === period).start(), end: null };
  }, [s, isDaily, day, period]);

  const frames = usePoll(
    () => (range ? api.frames(id, range.start, range.end) : Promise.resolve([])),
    0,
    [id, range?.start, range?.end],
  );

  // New capture or deletion: refresh in place, without blanking the lists
  // (the explorer keeps its position).
  const frameCount = fromOverview?.stats.frames;
  useEffect(() => {
    if (frameCount === undefined) return;
    series.reload();
    days.reload();
    frames.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameCount]);

  if (series.error && !s) return <div className="empty-state error">{series.error}</div>;
  if (!s) return <div className="skeleton" />;

  const assemble = async () => {
    setAssembling(true);
    try {
      const res = await api.assemble(id, range?.start || undefined, range?.end || undefined);
      toast({ type: "ok", text: `Vidéo assemblée : ${res.frames} images, ${fmtSize(res.size)}` });
      setPreferredVideo(res.name);
      await videos.reload();
    } catch (err) {
      toast({ type: "error", text: String(err.message || err) });
    } finally {
      setAssembling(false);
    }
  };

  const toggle = async () => {
    await api.updateSeries(id, { enabled: !s.enabled });
    await Promise.all([series.reload(), reloadOverview()]);
  };

  const save = async (form) => {
    await api.updateSeries(id, form);
    setEditing(false);
    toast({ type: "ok", text: "Série mise à jour" });
    await Promise.all([series.reload(), reloadOverview()]);
  };

  const removeDay = async () => {
    if (!day || !window.confirm(`Supprimer les images et la vidéo du ${fmtDate(day)} ?`)) return;
    await api.deleteDay(id, day);
    setDay(null);
    await Promise.all([days.reload(), videos.reload(), series.reload(), reloadOverview()]);
  };

  const frameList = frames.data ?? [];

  const refreshAfterFrameChange = () =>
    Promise.all([frames.reload(), days.reload(), series.reload(), reloadOverview()]);

  const deleteFrame = async (frame) => {
    try {
      await api.deleteFrame(id, frame.date, frame.name);
    } catch (err) {
      toast({ type: "error", text: String(err.message || err) });
      return;
    }
    await refreshAfterFrameChange();
    const hasVideo = (videos.data ?? []).length > 0;
    toast({
      type: "ok",
      text: `Image du ${fmtDate(frame.date, { day: "numeric", month: "short" })} à ${frame.time.slice(0, 5)} supprimée.${
        hasVideo ? " Ré-assemble la vidéo pour la mettre à jour." : ""
      }`,
      action: {
        label: "Annuler",
        onClick: async () => {
          try {
            await api.restoreFrame(id, frame.date, frame.name);
            await refreshAfterFrameChange();
            toast({ type: "ok", text: "Image restaurée" });
          } catch (err) {
            toast({ type: "error", text: String(err.message || err) });
          }
        },
      },
    });
  };
  const assembleLabel = isDaily
    ? period === "all"
      ? "Assembler toute la période"
      : `Assembler les ${PERIODS.find((p) => p.id === period).label}`
    : "Assembler ce jour";

  return (
    <div className="page">
      <section className="page-head">
        <div>
          <div className="title-row">
            <h1>{s.name}</h1>
            <StatusBadge series={s} />
          </div>
          <p className="muted">
            {describeSeries(s)}
            {s.minBattery ? ` · pause sous ${s.minBattery} % de batterie` : ""} · vidéo à {s.fps} img/s ·{" "}
            {s.retentionDays ? `images gardées ${s.retentionDays} j` : "images gardées sans limite"}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => captureNow([id])} disabled={capturing}>
            {capturing ? <Loader2 size={16} className="spin" /> : <Camera size={16} />} Capturer
          </button>
          <button className="btn" onClick={() => setEditing(true)}>
            <Pencil size={16} /> Modifier
          </button>
          <button className="btn ghost" onClick={toggle}>
            <Power size={16} /> {s.enabled ? "Désactiver" : "Activer"}
          </button>
        </div>
      </section>

      <section className="stats">
        <div className="card stat">
          <span className="stat-label">Images</span>
          <span className="stat-value">{fmtNumber(s.stats.frames)}</span>
          <span className="stat-sub">{s.stats.today} aujourd'hui</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Période couverte</span>
          <span className="stat-value small">
            {s.stats.firstDate ? `${fmtDate(s.stats.firstDate, { day: "numeric", month: "short" })} → ${fmtDate(s.stats.lastDate, { day: "numeric", month: "short" })}` : "—"}
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">Prochaine capture</span>
          <span className="stat-value">{s.enabled && s.nextCaptureAt ? fmtTime(s.nextCaptureAt) : "—"}</span>
          <span className="stat-sub">
            {s.capturing ? "Capture en cours" : s.enabled && s.nextCaptureAt ? fmtUntil(s.nextCaptureAt) : "Série désactivée"}
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">Vidéos</span>
          <span className="stat-value">{videos.data?.length ?? "—"}</span>
          <span className="stat-sub">Assemblage auto chaque nuit</span>
        </div>
      </section>

      <div className="split">
        <section className="card">
          <header className="card-head">
            <div>
              <h2>Images</h2>
              <p className="muted">Flèches ← → pour parcourir, ▶ pour un aperçu animé, Suppr pour retirer une image.</p>
            </div>
          </header>
          {isDaily ? (
            <div className="chips toolbar">
              {PERIODS.map((p) => (
                <button key={p.id} className={period === p.id ? "chip active" : "chip"} onClick={() => setPeriod(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="day-strip">
              {(days.data ?? []).map((d) => (
                <button key={d.date} className={day === d.date ? "day-chip active" : "day-chip"} onClick={() => setDay(d.date)}>
                  <strong>{cap(fmtDate(d.date, { weekday: "short", day: "numeric" }))}</strong>
                  <span>
                    {d.frames} img{d.video ? " · ▶" : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
          <FrameExplorer
            frames={frameList}
            showDate={isDaily}
            resetKey={`${range?.start}|${range?.end}`}
            onDelete={deleteFrame}
          />
          <div className="card-foot">
            <button className="btn" onClick={assemble} disabled={assembling || !frameList.length}>
              {assembling ? <Loader2 size={16} className="spin" /> : <Clapperboard size={16} />}
              {assembling ? "Assemblage…" : assembleLabel}
            </button>
            {!isDaily && day && (
              <button className="btn ghost danger" onClick={removeDay}>
                <Trash2 size={16} /> Supprimer ce jour
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <header className="card-head">
            <div>
              <h2>Vidéos</h2>
              <p className="muted">
                {isDaily ? "« Toute la période » est régénérée chaque nuit." : "Une vidéo par jour, générée chaque nuit."}
              </p>
            </div>
          </header>
          <VideoPanel
            seriesId={id}
            videos={videos.data ?? []}
            preferred={preferredVideo}
            onDeleted={() => videos.reload()}
          />
        </section>
      </div>

      {editing && <SeriesForm initial={s} onSave={save} onClose={() => setEditing(false)} />}
    </div>
  );
}
