# Publicar el panel para toda la liga

La web es **estática y sin login** (cada uno elige su equipo y ajusta su caja; se
recuerda en su dispositivo). Todo lo demás se actualiza solo desde el exportador.

Quedan **2 cosas que solo puedes hacer tú** (son tus cuentas): publicar en Cloudflare
y (opcional) mover el exportador a Oracle para 24/7. Aquí están los pasos exactos.

---

## 1) Publicar en Cloudflare Pages  (~3 min)

En una terminal, dentro de la carpeta del proyecto:

```bash
npm i -g wrangler            # instala la herramienta (una vez)
wrangler login               # abre el navegador -> autoriza tu cuenta Cloudflare (gratis, sin tarjeta)
CF_PROJECT=matelekinhos-fantasy ./deploy.sh
```

Te dará una URL tipo `https://matelekinhos-fantasy.pages.dev`. Ya está online.
Para volver a publicar tras cambios: `CF_PROJECT=matelekinhos-fantasy ./deploy.sh`.

## 2) Hacerlo privado para tu liga — Cloudflare Access  (~5 min, gratis ≤50 personas)

En el panel de Cloudflare → **Zero Trust** → **Access** → **Applications** → **Add an application**
→ *Self-hosted*:
- **Application domain:** `matelekinhos-fantasy.pages.dev`
- **Policy:** *Allow* → regla **Emails** con los correos de tus 13 colegas
  (o **Emails ending in** si compartís dominio, o *Login con Google/One-time PIN*).

Resultado: para *ver* la web, cada uno pone su email y recibe un código (o entra con
Google). Es un login trivial de Cloudflare — **no tiene nada que ver con LaLiga**.

## 3) Que se actualice sola 24/7 — Oracle Cloud Always Free (opcional)

Ahora los datos se refrescan mientras tu Mac esté encendida. Para que vaya siempre:

**a) Crea la infraestructura (en tu navegador, una vez):**
1. Alta en **Oracle Cloud** → cuenta *Always Free* (pide tarjeta solo para verificar; no cobra).
2. Crea una **VM Always Free**: *Compute → Instances → Create* → imagen **Ubuntu 22.04**,
   shape **Ampere (VM.Standard.A1.Flex)**. Descarga la clave SSH. Anota la IP pública.
3. Crea un **token de Cloudflare**: panel Cloudflare → *My Profile → API Tokens → Create Token*
   → plantilla **"Cloudflare Pages: Edit"**. Copia el token y tu **Account ID**
   (está en la barra lateral de la sección Pages).

**b) Copia el proyecto a la VM (desde tu Mac):**
```bash
cd ~/Fantasy
scp -i ~/ruta/clave.key -r laliga-fantasy-dashboard ubuntu@LA_IP:~/
```
> Incluye `config.json`, `.token.json` y `fantasy.db` (historial de valores). No subas nada a git.

**c) Monta todo en la VM (un solo script):**
```bash
ssh -i ~/ruta/clave.key ubuntu@LA_IP
cd laliga-fantasy-dashboard
nano .env         # tras la 1ª ejecución del script; pega tu token y account id
./oracle_setup.sh
```
El script instala dependencias, crea el entorno, deja el **cron cada 2 min** y el
**auto-deploy cada ~20 min**. Cuando `exporter.log` muestre `deploy Cloudflare Pages OK`, listo.

**d) Apaga el cron del Mac** (para que no haya dos publicando a la vez):
```bash
launchctl bootout gui/$(id -u)/com.laliga.fantasy.exporter
```

---

## Notas
- **Nunca subas** `config.json`, `.token.json`, `users.db`, `server/.secret` (ya están en `.gitignore`).
- La caja exacta de cada uno es privada por cuenta (la API da 403 al resto); por eso es un
  campo editable que se recuerda por dispositivo. Todo lo demás es automático.
- El backend con login por usuario (`server/`) queda **aparcado** como opción futura; no hace falta.
