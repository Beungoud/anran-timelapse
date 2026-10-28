import React, { useState } from "react";
import { CalendarClock, Plus, Repeat, X } from "lucide-react";
import Modal from "./Modal.jsx";

const BLANK = {
  name: "",
  enabled: true,
  mode: "interval",
  intervalMin: 60,
  activeFrom: "00:00",
  activeTo: "23:59",
  times: ["12:00"],
  retries: 2,
  minBattery: 0,
  fps: 12,
  retentionDays: 31,
};

const INTERVAL_PRESETS = [15, 30, 60, 120, 180];

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export default function SeriesForm({ initial, onSave, onClose }) {
  const [form, setForm] = useState({ ...BLANK, ...(initial || {}) });
  const [newTime, setNewTime] = useState("08:00");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const addTime = () => {
    if (newTime && !form.times.includes(newTime)) set("times", [...form.times, newTime].sort());
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (!form.name.trim()) {
      setError("Donne un nom à la série.");
      return;
    }
    if (form.mode === "daily" && !form.times.length) {
      setError("Ajoute au moins une heure de capture.");
      return;
    }
    setSaving(true);
    try {
      await onSave(form);
    } catch (err) {
      setError(String(err.message || err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial?.id ? `Modifier « ${initial.name} »` : "Nouvelle série"}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <Field label="Nom">
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="ex. Enneigement à midi"
            autoFocus
          />
        </Field>

        <div className="field">
          <span className="field-label">Déclenchement</span>
          <div className="segmented" role="radiogroup">
            <button
              type="button"
              role="radio"
              aria-checked={form.mode === "interval"}
              className={form.mode === "interval" ? "active" : ""}
              onClick={() => set("mode", "interval")}
            >
              <Repeat size={16} /> Intervalle régulier
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={form.mode === "daily"}
              className={form.mode === "daily" ? "active" : ""}
              onClick={() => set("mode", "daily")}
            >
              <CalendarClock size={16} /> Heures fixes
            </button>
          </div>
        </div>

        {form.mode === "interval" ? (
          <>
            <Field label="Une image toutes les" hint="Une vidéo est assemblée chaque jour.">
              <div className="inline">
                <input
                  type="number"
                  min={1}
                  value={form.intervalMin}
                  onChange={(e) => set("intervalMin", Number(e.target.value))}
                  className="num"
                />
                <span className="unit">minutes</span>
                <div className="chips">
                  {INTERVAL_PRESETS.map((m) => (
                    <button
                      type="button"
                      key={m}
                      className={form.intervalMin === m ? "chip active" : "chip"}
                      onClick={() => set("intervalMin", m)}
                    >
                      {m < 60 ? `${m} min` : `${m / 60} h`}
                    </button>
                  ))}
                </div>
              </div>
            </Field>
            <Field label="Plage horaire active" hint="Ex. 07:00 → 19:00 pour ignorer la nuit.">
              <div className="inline">
                <input type="time" value={form.activeFrom} onChange={(e) => set("activeFrom", e.target.value)} />
                <span className="unit">→</span>
                <input type="time" value={form.activeTo} onChange={(e) => set("activeTo", e.target.value)} />
              </div>
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Heures de capture"
              hint="Une vidéo couvrant toute la période est assemblée chaque nuit."
            >
              <div className="chips">
                {form.times.map((t) => (
                  <span key={t} className="chip active removable">
                    {t}
                    <button
                      type="button"
                      aria-label={`Retirer ${t}`}
                      onClick={() => set("times", form.times.filter((x) => x !== t))}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <span className="inline">
                  <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} />
                  <button type="button" className="btn ghost small" onClick={addTime}>
                    <Plus size={14} /> Ajouter
                  </button>
                </span>
              </div>
            </Field>
            <Field label="Nouvelles tentatives en cas d'échec" hint="Espacées de 5 min, dans les 2 h suivant l'heure prévue.">
              <input
                type="number"
                min={0}
                max={5}
                className="num"
                value={form.retries}
                onChange={(e) => set("retries", Number(e.target.value))}
              />
            </Field>
          </>
        )}

        <Field
          label={`Pause si la batterie passe sous ${form.minBattery ? `${form.minBattery} %` : "… (désactivé)"}`}
          hint="La série reprend quand la batterie remonte au-dessus du seuil + la marge définie dans Réglages."
        >
          <div className="inline">
            <input
              type="range"
              min={0}
              max={95}
              step={5}
              value={form.minBattery}
              onChange={(e) => set("minBattery", Number(e.target.value))}
            />
            <span className="unit mono">{form.minBattery ? `${form.minBattery} %` : "off"}</span>
          </div>
        </Field>

        <div className="grid-2">
          <Field label="Vitesse de la vidéo" hint="Images par seconde.">
            <div className="inline">
              <input
                type="number"
                min={1}
                max={60}
                className="num"
                value={form.fps}
                onChange={(e) => set("fps", Number(e.target.value))}
              />
              <span className="unit">img/s</span>
            </div>
          </Field>
          <Field label="Conservation des images" hint="0 = illimitée. Les vidéos sont gardées.">
            <div className="inline">
              <input
                type="number"
                min={0}
                className="num"
                value={form.retentionDays}
                onChange={(e) => set("retentionDays", Number(e.target.value))}
              />
              <span className="unit">jours</span>
            </div>
          </Field>
        </div>

        <label className="switch-row">
          <span>
            <strong>Série active</strong>
            <small>Les captures planifiées sont déclenchées automatiquement.</small>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
        </label>
      </form>
    </Modal>
  );
}
