import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff, Maximize2, Pause, Play, Trash2 } from "lucide-react";
import { cap, fmtDate } from "../format.js";

const SPEEDS = [2, 5, 10];

/** `resetKey` changes when the period changes (jump to the latest frame);
 *  a plain reload (e.g. after a deletion) keeps the current position. */
export default function FrameExplorer({ frames, showDate, resetKey, onDelete }) {
  const [index, setIndex] = useState(Math.max(0, frames.length - 1));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const stripRef = useRef(null);

  const deleteCurrent = () => {
    const current = frames[Math.min(index, frames.length - 1)];
    if (!current || !onDelete) return;
    setPlaying(false);
    onDelete(current);
  };

  // Frames for a new period arrive after resetKey changes: jump to the latest
  // frame once they are there.
  const pendingReset = useRef(true);
  useEffect(() => {
    pendingReset.current = true;
    setPlaying(false);
  }, [resetKey]);

  useEffect(() => {
    if (pendingReset.current && frames.length) {
      pendingReset.current = false;
      setIndex(frames.length - 1);
    } else {
      setIndex((i) => Math.min(i, Math.max(0, frames.length - 1)));
    }
  }, [frames]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => setIndex((i) => (i + 1) % frames.length), 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, frames.length]);

  useEffect(() => {
    const onKey = (e) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setIndex((i) => Math.min(frames.length - 1, i + 1));
      if (e.key === "Delete" && onDelete) deleteCurrent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const strip = stripRef.current;
    const thumb = strip?.children[index];
    if (strip && thumb) {
      strip.scrollTo({ left: thumb.offsetLeft - strip.clientWidth / 2 + thumb.clientWidth / 2, behavior: "smooth" });
    }
  }, [index]);

  if (!frames.length) {
    return (
      <div className="empty-state">
        <ImageOff size={28} />
        <span>Aucune image sur cette période.</span>
      </div>
    );
  }

  const frame = frames[Math.min(index, frames.length - 1)];

  return (
    <div className="explorer">
      <div className="stage">
        <img src={frame.url} alt={`Image du ${frame.date} à ${frame.time}`} />
        <div className="stage-caption">
          {showDate && <span>{cap(fmtDate(frame.date, { weekday: "long", day: "numeric", month: "long" }))}</span>}
          <span className="mono">{frame.time.slice(0, 5)}</span>
        </div>
        <div className="stage-tools">
          {onDelete && (
            <button
              className="icon-btn overlay danger-hover"
              onClick={deleteCurrent}
              aria-label="Supprimer cette image"
              title="Supprimer cette image (Suppr)"
            >
              <Trash2 size={16} />
            </button>
          )}
          <a className="icon-btn overlay" href={frame.url} target="_blank" rel="noreferrer" aria-label="Ouvrir en grand" title="Ouvrir en grand">
            <Maximize2 size={16} />
          </a>
        </div>
      </div>

      <div className="scrubber">
        <button className="icon-btn" onClick={() => setIndex((i) => Math.max(0, i - 1))} aria-label="Image précédente">
          <ChevronLeft size={18} />
        </button>
        <button
          className="icon-btn primary"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? "Pause" : "Lecture"}
          disabled={frames.length < 2}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          className="icon-btn"
          onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))}
          aria-label="Image suivante"
        >
          <ChevronRight size={18} />
        </button>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={index}
          onChange={(e) => {
            setPlaying(false);
            setIndex(Number(e.target.value));
          }}
          aria-label="Position dans la série"
        />
        <span className="counter mono">
          {index + 1}/{frames.length}
        </span>
        <div className="chips compact">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? "chip active" : "chip"} onClick={() => setSpeed(s)}>
              {s} img/s
            </button>
          ))}
        </div>
      </div>

      <div className="filmstrip" ref={stripRef}>
        {frames.map((f, i) => (
          <button
            key={f.url}
            className={i === index ? "thumb active" : "thumb"}
            onClick={() => {
              setPlaying(false);
              setIndex(i);
            }}
            title={`${f.date} ${f.time}`}
          >
            <img src={f.url} alt="" loading="lazy" />
            <span>{showDate ? fmtDate(f.date, { day: "numeric", month: "short" }) : f.time.slice(0, 5)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
