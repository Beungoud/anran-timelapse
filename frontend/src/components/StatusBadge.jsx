import React from "react";
import { BatteryWarning, CirclePause, Loader2, Radio } from "lucide-react";

export function seriesStatus(s) {
  if (s.capturing) return { key: "busy", label: "Capture…", Icon: Loader2 };
  if (!s.enabled) return { key: "off", label: "Désactivée", Icon: CirclePause };
  if (s.pausedByBattery) return { key: "warn", label: `En pause · batterie < ${s.minBattery} %`, Icon: BatteryWarning };
  return { key: "on", label: "Active", Icon: Radio };
}

export default function StatusBadge({ series }) {
  const { key, label, Icon } = seriesStatus(series);
  return (
    <span className={`badge ${key}`}>
      <Icon size={13} className={key === "busy" ? "spin" : undefined} />
      {label}
    </span>
  );
}
