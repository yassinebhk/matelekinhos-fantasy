# LaLiga Fantasy — panel privado de tu liga

Panel web privado para tu liga de **LaLiga Fantasy**, con el tema de la app oficial.
Incluye: clasificación con tendencias, movimiento de puestos, puntos de la jornada,
valor de plantilla, caja y eficiencia (pts/M€); gráfico de evolución; KPIs destacados;
récords de la liga; súper clausulazos; manager de la jornada; rachas; ranking de gasto;
presupuesto por manager; mejores jugadores (por valor, puntos y media); mercado actual;
subidas y bajadas de valor; plantillas de cada manager; novedades y un ticker de mercado.
Un job se ejecuta solo cada 6 horas, saca los datos de tu liga vía la API de LaLiga,
los guarda como histórico y regenera la web. Tú casi no tocas nada.

---

## ✅ LO QUE SÍ O SÍ TIENES QUE HACER TÚ (5 minutos, una vez)

Todo lo demás está automatizado. Esto no puedo hacerlo por ti:

1. **Poner tus credenciales.** Ya tienes un `config.json` creado; ábrelo y rellena tu
   **email y contraseña de LaLiga Fantasy**. Ese fichero es local y está en `.gitignore`
   (nunca se sube a ningún sitio).

   > Si entras a LaLiga Fantasy **con Google o Apple** (no con email/contraseña), el login
   > automático no aplica. En ese caso deja email/password vacíos, ejecuta el instalador
   > (paso 2) para crear el entorno, y luego **una sola vez**:
   > `./.venv/bin/python -m exporter.login` y sigue los pasos (login en el navegador →
   > pegar el `code`). Reejecuta el instalador. A partir de ahí ya es automático.

2. **Ejecutar el instalador** desde la carpeta del proyecto:
   ```bash
   bash scripts/install.sh
   ```
   Crea el entorno, instala dependencias, hace el primer volcado y deja programado
   el agente que lo repite cada 6h. Si `config.json` sigue sin rellenar, te avisa y para;
   rellénalo y vuelve a lanzarlo.

3. **Abrir el panel:**
   ```bash
   open web/index.html
   ```
   Ábrelo con doble clic siempre que quieras verlo. Se actualiza solo por detrás.

Y ya. Nada más es obligatorio.

### Mantenimiento (esporádico, no urgente)
- El *refresh token* de LaLiga caduca cada varias semanas. Cuando eso pase, el `exporter.log`
  mostrará `invalid_grant`. Si usas email/contraseña **no haces nada**: se vuelve a loguear solo.
  Si usas Google/Apple, repite el paso `exporter.login` (30 s).

---

## Cómo está montado (para cuando tengas curiosidad)

Dos capas separadas a propósito:

- **Ingest** (`exporter/`): autentica contra el tenant Azure B2C de LaLiga, llama a la API
  (`fantasy-api.llt-services.com`) y guarda **snapshots crudos** de clasificación, mercado,
  lista de jugadores y actividad en `fantasy.db` (SQLite).
  Los snapshots son inmutables: nunca se pierden aunque cambies las métricas.
- **Derive** (`exporter/metrics.py`): calcula clasificación, rachas, clausulazos, movers y
  novedades **leyendo el histórico**, y escribe `web/data/metrics.js`. Los clausulazos se
  detectan por `activityTypeId` y los *movers* (variación de valor) se calculan comparando
  snapshots propios, porque la API no da la variación diaria.
- **Web** (`web/`): estática, sin build ni servidor. Lee `window.METRICS` de ese fichero.

```
launchd (cada 6h) → exporter.run → [auth B2C] → API LaLiga
                                       │
                                       ▼
                                  SQLite (histórico inmutable)
                                       │  derive
                                       ▼
                             web/data/metrics.js → index.html
```

Rachas, evolución y comparativas dependen de acumular snapshots: las primeras horas se ven
"planas" y van cobrando forma conforme el cron acumula fotos de la liga.

## Ficheros

```
exporter/auth.py     OAuth2 B2C: login ROPC + refresh + cache de token
exporter/api.py      endpoints de la API (un solo sitio si cambian)
exporter/store.py    snapshots a SQLite
exporter/metrics.py  cálculo de métricas (aquí se ajustan nombres de campo si hiciera falta)
exporter/run.py      orquestador (lo que corre el cron)
exporter/login.py    login interactivo una vez (solo cuentas Google/Apple)
web/                 el panel (index.html + styles.css + app.js + data/)
scripts/install.sh   instalador de un comando
config.json          TUS credenciales (lo creas tú, gitignored)
```

## Si algo falla

- **Revisa `exporter.log`** en la raíz del proyecto: dice qué snapshot ha fallado y por qué.
- **Campos vacíos en la web** (p. ej. clausulazos sin nombre): la API no está documentada y
  algún campo puede llamarse distinto. Abre `fantasy.db`, mira el JSON crudo de la tabla
  `snapshots` y añade el nombre real a las listas de candidatos en `exporter/metrics.py`
  (están marcadas). Es el único punto que quizá toques.
- **404 en un endpoint**: LaLiga lo habrá movido; se corrige en `exporter/api.py`.

## Aviso

Usa APIs no públicas de LaLiga Fantasy con **tu propia cuenta y tu propia liga**, para uso
personal. No redistribuyas los datos ni lo publiques con la marca de LaLiga. Parámetros de
auth y endpoints tomados del cliente abierto de referencia
[LaLigaApp](https://github.com/Externoak/LaLigaApp) (GPL-3.0).
