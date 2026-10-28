"""OpenID Connect login (e.g. Synology SSO Server, Authelia, Authentik, Google).

Enabled when OIDC_ISSUER is set. Every route except /auth/* then requires a
session: API calls get a 401, page loads are redirected to the provider.
"""

from __future__ import annotations

import html
import logging
import os
import secrets
from pathlib import Path
from urllib.parse import quote, urlencode

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from . import store

_LOGGER = logging.getLogger(__name__)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _csv(name: str) -> set[str]:
    return {item.strip().lower() for item in _env(name).split(",") if item.strip()}


ISSUER = _env("OIDC_ISSUER").rstrip("/")
ENABLED = bool(ISSUER)
CLIENT_ID = _env("OIDC_CLIENT_ID")
CLIENT_SECRET = _env("OIDC_CLIENT_SECRET")
SCOPES = _env("OIDC_SCOPES", "openid email")
TOKEN_AUTH_METHOD = _env("OIDC_TOKEN_AUTH_METHOD", "client_secret_basic")
PUBLIC_URL = _env("PUBLIC_URL").rstrip("/")
ALLOWED_USERS = _csv("OIDC_ALLOWED_USERS")
ALLOWED_GROUPS = _csv("OIDC_ALLOWED_GROUPS")
SESSION_DAYS = int(_env("SESSION_MAX_AGE_DAYS", "30") or 30)
SECURE_COOKIE = PUBLIC_URL.startswith("https://")


def session_secret() -> str:
    """SESSION_SECRET, or a random one persisted in the data volume."""
    configured = _env("SESSION_SECRET")
    if configured:
        return configured
    path = Path(store.DATA_DIR) / ".session-secret"
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        value = secrets.token_urlsafe(48)
        path.write_text(value)
        path.chmod(0o600)
        return value


def check_config() -> None:
    if not ENABLED:
        _LOGGER.warning(
            "Authentification DÉSACTIVÉE (OIDC_ISSUER absent) : "
            "l'interface est accessible sans connexion."
        )
        return
    missing = [n for n in ("OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "PUBLIC_URL") if not _env(n)]
    if missing:
        raise RuntimeError(f"OIDC activé mais variables manquantes : {', '.join(missing)}")
    _LOGGER.info(
        "Authentification OIDC activée (issuer=%s, utilisateurs=%s, groupes=%s)",
        ISSUER, sorted(ALLOWED_USERS) or "tous", sorted(ALLOWED_GROUPS) or "tous",
    )


oauth = OAuth()
if ENABLED:
    metadata_url = (
        ISSUER
        if ISSUER.endswith("/.well-known/openid-configuration")
        else f"{ISSUER}/.well-known/openid-configuration"
    )
    oauth.register(
        "oidc",
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        server_metadata_url=metadata_url,
        client_kwargs={
            "scope": SCOPES,
            "code_challenge_method": "S256",
            "token_endpoint_auth_method": TOKEN_AUTH_METHOD,
        },
    )


def _identity(claims: dict) -> dict:
    # Synology exposes "username"; most other providers "preferred_username".
    username = (
        claims.get("preferred_username") or claims.get("username") or claims.get("email") or claims.get("sub")
    )
    groups = claims.get("groups") or []
    if isinstance(groups, str):
        groups = [g.strip() for g in groups.split(",")]
    return {
        "sub": str(claims.get("sub", "")),
        "username": str(username),
        "name": str(claims.get("name") or username),
        "email": claims.get("email"),
        "groups": [str(g) for g in groups],
    }


def _allowed(user: dict) -> bool:
    if not ALLOWED_USERS and not ALLOWED_GROUPS:
        return True
    names = {v.lower() for v in (user["username"], user["email"], user["sub"]) if v}
    if names & ALLOWED_USERS:
        return True
    return bool({g.lower() for g in user["groups"]} & ALLOWED_GROUPS)


def _page(title: str, message: str, status: int = 200, action: tuple[str, str] | None = None) -> HTMLResponse:
    button = f'<a class="btn" href="{html.escape(action[1])}">{html.escape(action[0])}</a>' if action else ""
    return HTMLResponse(
        f"""<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)}</title>
<style>
:root{{color-scheme:light dark;--bg:#f4f4f1;--card:#fcfcfb;--text:#0b0b0b;--muted:#52514e;--accent:#2a78d6;--border:#e2e1dc}}
@media (prefers-color-scheme:dark){{:root{{--bg:#121211;--card:#1a1a19;--text:#f0efec;--muted:#c3c2b7;--accent:#3987e5;--border:#2c2c29}}}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}}
main{{max-width:420px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px}}
h1{{font-size:20px;margin:0 0 8px}}p{{color:var(--muted);margin:0 0 20px}}
.btn{{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600}}
</style></head><body><main><h1>{html.escape(title)}</h1><p>{html.escape(message)}</p>{button}</main></body></html>""",
        status_code=status,
    )


router = APIRouter(prefix="/auth")


@router.get("/me")
async def me(request: Request):
    user = request.session.get("user")
    return {"enabled": ENABLED, "authenticated": bool(user) or not ENABLED, "user": user}


@router.get("/login")
async def login(request: Request, next: str = "/"):
    if not ENABLED:
        return RedirectResponse("/")
    # Only keep same-site relative targets.
    request.session["next"] = next if next.startswith("/") and not next.startswith("//") else "/"
    try:
        return await oauth.oidc.authorize_redirect(request, f"{PUBLIC_URL}/auth/callback")
    except Exception as exc:  # provider unreachable / bad metadata
        _LOGGER.error("OIDC: impossible de joindre le fournisseur: %s", exc)
        return _page(
            "Connexion impossible",
            "Le fournisseur d'identité ne répond pas. Vérifie OIDC_ISSUER et que le serveur SSO est joignable.",
            502,
            ("Réessayer", "/auth/login"),
        )


@router.get("/callback")
async def callback(request: Request):
    if not ENABLED:
        return RedirectResponse("/")
    try:
        token = await oauth.oidc.authorize_access_token(request)
        claims = dict(token.get("userinfo") or {})
        if not any(claims.get(k) for k in ("preferred_username", "username", "email")):
            claims.update(await oauth.oidc.userinfo(token=token))
    except OAuthError as exc:
        _LOGGER.warning("OIDC: échec du retour de connexion: %s", exc.error)
        return _page("Connexion refusée", f"Le fournisseur a répondu : {exc.error}.", 400, ("Réessayer", "/auth/login"))
    user = _identity(claims)
    if not _allowed(user):
        _LOGGER.warning("OIDC: accès refusé pour %s (groupes %s)", user["username"], user["groups"])
        request.session.clear()
        return _page(
            "Accès refusé",
            f"Le compte « {user['username']} » n'est pas autorisé à utiliser ANRAN Timelapse.",
            403,
            ("Changer de compte", "/auth/logout"),
        )
    next_url = request.session.pop("next", "/")
    request.session["user"] = user
    _LOGGER.info("OIDC: connexion de %s", user["username"])
    return RedirectResponse(next_url)


@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    if ENABLED:
        try:
            metadata = await oauth.oidc.load_server_metadata()
        except Exception:  # provider down: local logout is enough
            metadata = {}
        end_session = metadata.get("end_session_endpoint")
        if end_session:
            params = urlencode({"client_id": CLIENT_ID, "post_logout_redirect_uri": f"{PUBLIC_URL}/auth/logged-out"})
            return RedirectResponse(f"{end_session}?{params}")
    return RedirectResponse("/auth/logged-out")


@router.get("/logged-out")
async def logged_out():
    return _page("Déconnecté", "Tu es déconnecté d'ANRAN Timelapse.", action=("Se reconnecter", "/auth/login"))


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not ENABLED or path.startswith("/auth/") or request.session.get("user"):
            return await call_next(request)
        if path.startswith("/api/"):
            return JSONResponse({"detail": "authentification requise"}, status_code=401)
        target = path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/auth/login?next={quote(target)}")
