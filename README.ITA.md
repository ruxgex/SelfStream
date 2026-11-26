# SelfStream 🤌

Addon leggero e self-hosted per Stremio con **2 sorgenti configurabili**, proxy HLS integrato e supporto multi-lingua (40 lingue).

> **Tutte le sorgenti sono disabilitate di default.** Attiva solo quelle che ti servono dalla pagina di configurazione.

---

## Funzionalità

| Funzione | Descrizione |
|---|---|
| **2 Sorgenti** | **VixSrc** (film e serie), **AnimeUnity** (anime tramite Kitsu) |
| **Configurazione per sorgente** | Abilita/disabilita ogni sorgente indipendentemente dalla landing page |
| **40 Lingue** | Scegli la lingua audio preferita |
| **Proxy HLS** | Tutti gli stream passano attraverso l'addon — bypassa restrizioni geo/IP |
| **Synthetic FHD** | Il proxy riscrive i manifest per servire solo la qualità migliore disponibile (1080p) |
| **Selezione Audio** | Lingua preferita → fallback inglese → primo disponibile |
| **Titoli Localizzati** | I titoli degli stream mostrano il titolo TMDB localizzato nella tua lingua |
| **ID Agnostico** | Funziona con ID TMDB (`786892`), IMDB (`tt30144839`) e Kitsu (`kitsu:12:1`) |

### Label degli Stream
- **VixSrc**: `VixSrc 🤌` — `🎬 Titolo Localizzato`
- **AnimeUnity**: `AU 🤌` — `VIX 1080 🤌`

---

## Deploy

> Per la stack Docker locale qui sotto usa direttamente il `Dockerfile` incluso.
> Aggiorna `Dockerfile.hf` solo se fai deploy su Hugging Face tramite il tuo fork.
>
> [📺 Video Guida](https://www.youtube.com/watch?v=nnhwo0C5x3I)

### Docker locale

```bash
docker compose up -d --build
```

Manifest locale:

```text
http://127.0.0.1:7000/manifest.json
```

Per esporlo in HTTPS (richiesto da Stremio per gli addon non locali) usa Tailscale:

```bash
tailscale serve --bg 7000      # privato, solo tailnet
tailscale funnel --bg 7000     # pubblico
```

Cambia la porta dell'host con `SELFSTREAM_LOCAL_PORT` in `.env`.

#### Buffering e cache

Il proxy è pensato per un server di casa la cui connessione internet è il collo di bottiglia: scarica in anticipo rispetto alla riproduzione con download paralleli, ritenta i segmenti falliti (riprendendo i download parziali), invia i segmenti al player mentre arrivano e, verso la fine di un episodio, pre-scarica l'inizio del successivo. Si configura in `.env`:

| Variabile | Default | Significato |
|---|---|---|
| `SEGMENT_PREFETCH_AHEAD_SECONDS` | `240` | Quanto scaricare in anticipo rispetto alla riproduzione. Un valore molto alto scarica l'intero episodio. |
| `SEGMENT_PREFETCH_CONCURRENCY` | `4` | Download paralleli in prefetch. |
| `SEGMENT_CACHE_MAX_MB` | `2048` | RAM usata per i segmenti in cache. |
| `SEGMENT_FETCH_RETRIES` | `3` | Tentativi per segmento/playlist in caso di errori o timeout. |
| `SEGMENT_NEXT_EPISODE_SECONDS` | `60` | Quanto pre-scaricare dell'episodio successivo. |
| `STREAM_CACHE_TTL_MS` | `1200000` | Durata della cache delle liste stream (riaprire un titolo è istantaneo). |

Vedi `.env.example` per l'elenco completo.

#### Opzionale: instrada il traffico tramite Surfshark WireGuard (Gluetun)

1. Nella [dashboard Surfshark](https://my.surfshark.com/vpn/manual-setup/main/wireguard) vai su **Configurazione manuale → Router → WireGuard**, scegli **Non ho una coppia di chiavi**, dagli un nome e generala. Copia la **chiave privata** (viene mostrata una sola volta).
2. Aggiungila a `.env`:

   ```bash
   SURFSHARK_WIREGUARD_PRIVATE_KEY=la_tua_chiave_privata
   SURFSHARK_SERVER_COUNTRIES=Italy   # opzionale, scegli il più vicino per latenza minima
   SURFSHARK_SERVER_CITIES=Milan      # opzionale
   SURFSHARK_WIREGUARD_MTU=1280       # opzionale, il default va bene per il 4G
   ```

3. Avvia la stack con l'override VPN:

   ```bash
   docker compose -f compose.yaml -f compose.vpn.yaml up -d --build
   ```

Tutto il traffico in uscita di SelfStream passa dal tunnel. Se la VPN cade, il kill switch di Gluetun blocca il traffico invece di esporre il tuo IP. Il manifest resta `http://127.0.0.1:7000/manifest.json`.

### Consigliato: VPS / Raspberry Pi (Massima compatibilità)

Un server persistente è l'opzione più affidabile — mantiene la cache proxy in memoria e evita i blocchi IP dei provider cloud.

```bash
git clone https://github.com/TUO_USER/SelfStream.git
cd SelfStream
npm install
npm run build
PORT=7020 node dist/addon.js
```

L'addon sarà disponibile su `http://tuo-ip:7020/manifest.json`.

### Koyeb (Cloud consigliato — stabile, senza sleep, AnimeUnity potrebbe non funzionare)

[📺 Video Guida](https://www.youtube.com/watch?v=IXEi81ONdNo)

1. Crea un account su [Koyeb.com](https://www.koyeb.com/).
2. Clicca **"Create Service"** → seleziona **GitHub**.
3. Collega il tuo repository forkato.
4. Configurazione:
   - **Builder**: `Docker`
   - **Dockerfile Path**: `Dockerfile.hf`
   - **Port**: `7000`
5. Clicca **Deploy**.

### Hugging Face Spaces (Gratuito, AnimeUnity potrebbe non funzionare))

[📺 Video Guida](https://www.youtube.com/watch?v=Ti2BNDjm0ns)

1. Crea un nuovo **Space** su [Hugging Face](https://huggingface.co/spaces).
2. Scegli **Docker** come SDK, template **Blank**.
3. Carica il Dockerfile (prima fai il fork e rinomina `Dockerfile.hf` con il tuo username GitHub).
4. Copia il link embed.
5. Lo Space gira sulla porta `7860`.

> **Nota**: AnimeUnity/VixCloud potrebbe non funzionare su HuggingFace a causa del blocco IP dei provider cloud.

### Vercel (Serverless — veloce, con limitazioni, AnimeUnity potrebbe non funzionare)

[📺 Video Guida](https://www.youtube.com/watch?v=TP3_sbt94Ag)

Il progetto include `vercel.json` e `api/index.ts` per il deploy serverless.

1. Vai su [Vercel.com](https://vercel.com/) e importa il tuo repo GitHub.
2. Vercel rileva automaticamente la configurazione.
3. Clicca **Deploy**.
4. Accessibile su `https://tua-app.vercel.app/manifest.json`.

> **Limitazioni**: Il piano gratuito di Vercel ha un timeout di 10s per funzione. Lo scraping multi-step (AnimeUnity) potrebbe superarlo. La cache proxy in memoria si resetta tra le invocazioni (c'è un fallback, ma il VPS è più affidabile).

---

## Sviluppo Locale

```bash
npm install
npm run build
npm start
# Oppure con ts-node:
npm run dev
```

L'addon gira su `http://localhost:7000` di default.

---

## Note Tecniche

- **Architettura proxy**: Gli URL degli stream puntano a `/proxy/hls/manifest.m3u8` che riscrive tutti gli URI di segmenti/audio/sottotitoli per passare anch'essi dal proxy, garantendo la riproduzione da qualsiasi rete.
- **AnimeMapping**: Gli ID Kitsu vengono convertiti in percorsi AnimeUnity tramite l'API AnimeMapping, poi risolti attraverso VixCloud.
- **Fallback cache headers**: Sulle piattaforme serverless dove la cache in memoria è vuota, il proxy inferisce gli headers corretti dal pattern dell'URL (VixSrc, VixCloud, o generico).
