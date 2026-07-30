"""
Backend de la liga (FastAPI). Fase 1: LOGIN por usuario + datos personales.

  uvicorn server.app:app --reload --port 8099

Endpoints:
  GET  /                     página de prueba del login (local)
  GET  /api/health
  POST /api/login/start   -> {authorizeUrl}   (guarda el verifier PKCE en sesión)
  POST /api/login/finish  {url|code} -> canjea el code, crea sesión, guarda usuario
  GET  /api/me            -> {user, leagues:[{id,name,teams:[{id,name,caja}]}]}
  POST /api/logout
"""

import time
import secrets

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import JSONResponse, HTMLResponse

from exporter.api import FantasyAPI
from exporter import metrics as M
from . import auth_flow as AF
from .userstore import UserStore, make_session, read_session

app = FastAPI(title="LaLiga Fantasy Liga")
store = UserStore()

# PKCE pendientes entre /start y /finish (efímero, en memoria; 1 worker).
PENDING = {}
PENDING_TTL = 900


def _gc_pending():
    now = time.time()
    for k in [k for k, v in PENDING.items() if now - v["ts"] > PENDING_TTL]:
        PENDING.pop(k, None)


def _api_for(user_id: str) -> FantasyAPI:
    """Cliente autenticado del usuario: refresca su token y persiste el nuevo refresh."""
    refresh_token, client_id = store.get_refresh(user_id)
    if not refresh_token:
        raise HTTPException(401, "sesión sin token; vuelve a conectar")
    try:
        tok = AF.bearer_from_refresh(refresh_token, client_id)
    except Exception:
        raise HTTPException(401, "token caducado; vuelve a conectar")
    u = store.get_user(user_id) or {}
    store.save_user(user_id, u.get("email"), u.get("name"),
                    tok.get("refresh_token") or refresh_token, tok.get("client_id") or client_id)
    return FantasyAPI(tok["bearer"])


def _current_user_id(request: Request):
    uid = read_session(request.cookies.get("sid", ""))
    if not uid:
        raise HTTPException(401, "no autenticado")
    return uid


@app.get("/api/health")
def health():
    return {"ok": True, "users": len(store.all_users())}


@app.post("/api/login/start")
def login_start(response: Response):
    _gc_pending()
    verifier, challenge, state = AF.new_pkce()
    lid = secrets.token_urlsafe(24)
    PENDING[lid] = {"verifier": verifier, "state": state, "ts": time.time()}
    response.set_cookie("login_id", lid, httponly=True, samesite="lax", max_age=PENDING_TTL)
    return {"authorizeUrl": AF.authorize_url(challenge, state)}


@app.post("/api/login/finish")
async def login_finish(request: Request, response: Response):
    lid = request.cookies.get("login_id", "")
    pend = PENDING.get(lid)
    if not pend:
        raise HTTPException(400, "sesión de login expirada; pulsa Conectar otra vez")
    body = await request.json()
    code = AF.extract_code(body.get("url") or body.get("code") or "")
    if not code:
        raise HTTPException(400, "no encontré ningún 'code' en lo que pegaste")
    try:
        tok = AF.exchange_code(code, pend["verifier"])
    except Exception as e:
        raise HTTPException(400, f"no pude canjear el code (¿caducó? ~2 min): {e}")
    PENDING.pop(lid, None)
    ident = AF.identity(tok.get("id_token") or "")
    uid = ident.get("sub") or ident.get("email") or secrets.token_hex(8)
    store.save_user(uid, ident.get("email"), ident.get("name"),
                    tok.get("refresh_token"), tok.get("client_id"))
    response.delete_cookie("login_id")
    response.set_cookie("sid", make_session(uid), httponly=True, samesite="lax", max_age=60 * 86400)
    return {"ok": True, "user": {"name": ident.get("name"), "email": ident.get("email")}}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie("sid")
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    uid = _current_user_id(request)
    api = _api_for(uid)
    user = store.get_user(uid) or {}
    out = {"user": {"name": user.get("name"), "email": user.get("email")}, "leagues": []}
    for lg in M.as_list(api.leagues()):
        lid = M.pick(lg, "id")
        team = M.pick(lg, "team", default=None)  # tu equipo en esa liga (incluye caja)
        teams = []
        if isinstance(team, dict) and M.pick(team, "id"):
            teams.append({
                "id": str(M.pick(team, "id")),
                "caja": M.pick(team, "money", default=None),           # tu caja, directa
                "teamValue": M.pick(team, "teamValue", default=None),
                "points": M.pick(team, "teamPoints", default=None),
                "position": M.pick(team, "position", default=None),
                "players": M.pick(team, "playersNumber", default=None),
                "isAdmin": bool(M.pick(team, "isAdmin", default=False)),
            })
        out["leagues"].append({"id": str(lid), "name": M.pick(lg, "name", default="Liga"), "teams": teams})
    return out


# ---- página de prueba del login (solo para validar en local) ----
@app.get("/", response_class=HTMLResponse)
def test_page():
    return HTMLResponse(_TEST_HTML)


_TEST_HTML = """<!doctype html><meta charset=utf-8><title>Login LaLiga (test)</title>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;background:#0b1220;color:#e7ecf5}
button{background:#FF4B44;color:#fff;border:0;padding:10px 16px;border-radius:8px;font-size:15px;cursor:pointer}
textarea{width:100%;height:70px;margin:10px 0;background:#111a2e;color:#e7ecf5;border:1px solid #223350;border-radius:8px;padding:8px}
pre{background:#111a2e;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
.step{border:1px solid #22314f;border-radius:10px;padding:14px;margin:12px 0}</style>
<h2>Login LaLiga Fantasy — prueba</h2>
<div class=step><b>1.</b> <button onclick=start()>Conectar con LaLiga</button>
<p id=s1></p></div>
<div class=step><b>2.</b> Inicia sesión en la pestaña que se abre. Al final el navegador
intentará abrir <code>authredirect://…</code> y dará error. Copia esa URL y pégala aquí:
<textarea id=code placeholder="authredirect://com.lfp.laligafantasy/?...&code=..."></textarea>
<button onclick=finish()>Conectar</button><p id=s2></p></div>
<div class=step><b>3.</b> <button onclick=me()>Ver mis ligas y equipos</button><pre id=out>—</pre></div>
<script>
async function start(){
 const r=await fetch('/api/login/start',{method:'POST'}); const j=await r.json();
 document.getElementById('s1').innerHTML='Abriendo login… si no se abre, <a target=_blank href="'+j.authorizeUrl+'">pulsa aquí</a>.';
 window.open(j.authorizeUrl,'_blank');
}
async function finish(){
 const url=document.getElementById('code').value;
 const r=await fetch('/api/login/finish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
 const j=await r.json(); document.getElementById('s2').textContent=r.ok?('✅ Conectado: '+(j.user.name||j.user.email)):('❌ '+(j.detail||JSON.stringify(j)));
}
async function me(){
 const r=await fetch('/api/me'); const j=await r.json();
 document.getElementById('out').textContent=JSON.stringify(j,null,2);
}
</script>"""
