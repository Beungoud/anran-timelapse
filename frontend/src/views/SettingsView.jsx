import React, { useEffect, useState } from "react";
import { CalendarClock, Pencil, Plus, Repeat, Save, Trash2 } from "lucide-react";
import { useApp } from "../App.jsx";
import { api } from "../api.js";
import SeriesForm from "../components/SeriesForm.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import { describeSeries } from "../format.js";

function Row({ label, hint, children }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function GlobalSettings() {
  const { toast } = useApp();
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api.settings().then(setForm).catch((err) => toast({ type: "error", text: String(err.message || err) }));
  }, [toast]);

  if (!form) return <div className="skeleton small" />;

  const set = (key, value) => {
    setForm({ ...form, [key]: value });
    setDirty(true);
  };
  const num = (key) => (e) => set(key, Number(e.target.value));
  const assemblyTime = `${String(form.assemblyHour).padStart(2, "0")}:${String(form.assemblyMinute).padStart(2, "0")}`;

  const save = async () => {
    try {
      setForm(await api.saveSettings(form));
      setDirty(false);
      toast({ type: "ok", text: "Réglages enregistrés" });
    } catch (err) {
      toast({ type: "error", text: String(err.message || err) });
    }
  };

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Caméra et planification</h2>
          <p className="muted">Communs à toutes les séries.</p>
        </div>
        <button className="btn primary" onClick={save} disabled={!dirty}>
          <Save size={16} /> Enregistrer
        </button>
      </header>
      <div className="settings-list">
        <Row label="Qualité vidéo" hint="SD est plus rapide et plus fiable ; QHD donne des images 2304×1296.">
          <select value={form.quality} onChange={(e) => set("quality", e.target.value)}>
            <option value="SD">SD · 640×360 (H.264)</option>
            <option value="QHD">QHD · 2304×1296 (HEVC)</option>
            <option value="AUTO">Automatique</option>
          </select>
        </Row>
        <Row label="Durée du flux par capture" hint="Minimum 25 s : l'enregistreur analyse le flux ~20 s avant d'écrire.">
          <div className="inline">
            <input type="number" className="num" min={25} max={120} value={form.grabDurationSec} onChange={num("grabDurationSec")} />
            <span className="unit">s</span>
          </div>
        </Row>
        <Row label="Assemblage automatique" hint="Heure de génération des vidéos de la journée.">
          <input
            type="time"
            value={assemblyTime}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              setForm({ ...form, assemblyHour: h, assemblyMinute: m });
              setDirty(true);
            }}
          />
        </Row>
        <Row label="Relevé de la batterie" hint="Requête cloud, ne réveille pas la caméra.">
          <div className="inline">
            <span className="unit">toutes les</span>
            <input type="number" className="num" min={5} max={240} value={form.batteryPollMin} onChange={num("batteryPollMin")} />
            <span className="unit">min</span>
          </div>
        </Row>
        <Row label="Marge de reprise" hint="Une série en pause reprend au seuil + cette marge (évite les va-et-vient).">
          <div className="inline">
            <span className="unit">+</span>
            <input type="number" className="num" min={0} max={20} value={form.batteryHysteresis} onChange={num("batteryHysteresis")} />
            <span className="unit">%</span>
          </div>
        </Row>
      </div>
    </section>
  );
}

function SeriesManager() {
  const { overview, reloadOverview, toast } = useApp();
  const [editing, setEditing] = useState(null);
  const series = overview?.series ?? [];

  const save = async (form) => {
    if (editing?.id) await api.updateSeries(editing.id, form);
    else await api.createSeries(form);
    setEditing(null);
    toast({ type: "ok", text: editing?.id ? "Série mise à jour" : "Série créée" });
    await reloadOverview();
  };

  const remove = async (s) => {
    if (!window.confirm(`Supprimer la série « ${s.name} » ?`)) return;
    const purge = s.stats.frames
      ? window.confirm(`Supprimer aussi ses ${s.stats.frames} images et ses vidéos ? (Annuler = les garder sur le disque)`)
      : true;
    try {
      await api.deleteSeries(s.id, purge);
      toast({ type: "ok", text: "Série supprimée" });
      await reloadOverview();
    } catch (err) {
      toast({ type: "error", text: String(err.message || err) });
    }
  };

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Séries de timelapse</h2>
          <p className="muted">Si deux séries tombent en même temps, un seul réveil de la caméra sert aux deux.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({})}>
          <Plus size={16} /> Nouvelle série
        </button>
      </header>
      <ul className="series-list">
        {series.map((s) => {
          const Icon = s.mode === "daily" ? CalendarClock : Repeat;
          return (
            <li key={s.id}>
              <span className="series-icon">
                <Icon size={18} />
              </span>
              <div className="grow">
                <div className="title-row">
                  <a href={`#/series/${s.id}`}>
                    <strong>{s.name}</strong>
                  </a>
                  <StatusBadge series={s} />
                </div>
                <small className="muted">
                  {describeSeries(s)} · {s.minBattery ? `pause < ${s.minBattery} %` : "pas de seuil batterie"} · {s.fps} img/s ·{" "}
                  {s.retentionDays ? `${s.retentionDays} j` : "conservation illimitée"}
                </small>
              </div>
              <button className="icon-btn" onClick={() => setEditing(s)} aria-label={`Modifier ${s.name}`} title="Modifier">
                <Pencil size={16} />
              </button>
              <button className="icon-btn danger" onClick={() => remove(s)} aria-label={`Supprimer ${s.name}`} title="Supprimer">
                <Trash2 size={16} />
              </button>
            </li>
          );
        })}
        {!series.length && <li className="muted">Aucune série. Crée-en une pour démarrer les captures.</li>}
      </ul>
      {editing && <SeriesForm initial={editing.id ? editing : null} onSave={save} onClose={() => setEditing(null)} />}
    </section>
  );
}

export default function SettingsView() {
  return (
    <div className="page narrow">
      <section className="page-head">
        <div>
          <h1>Réglages</h1>
          <p className="muted">Séries de captures, caméra et batterie.</p>
        </div>
      </section>
      <SeriesManager />
      <GlobalSettings />
    </div>
  );
}
