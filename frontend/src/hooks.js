import { useCallback, useEffect, useRef, useState } from "react";

/** Fetch `loader` now and every `intervalMs`; `reload` refreshes on demand. */
export function usePoll(loader, intervalMs, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    try {
      const result = await loaderRef.current();
      setData(result);
      setError(null);
      return result;
    } catch (err) {
      setError(String(err.message || err));
      return null;
    }
  }, []);

  useEffect(() => {
    setData(null);
    reload();
    if (!intervalMs) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) reload();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, intervalMs, ...deps]);

  return { data, error, reload };
}

export function useHashRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const navigate = (path) => {
  window.location.hash = `#/${path}`;
};

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("theme") || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* storage unavailable: theme simply isn't remembered */
    }
  }, [theme]);
  return [theme, setTheme];
}
