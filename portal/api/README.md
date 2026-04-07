# Portal API (FastAPI + Moderation Providers)

## Run locally with uv

1. Install dependencies:

```bash
uv sync
```

2. Optional: disable Vision and use neutral fallback scores:

```bash
export GOOGLE_VISION_DISABLED=true
```

3. Run the server:

```bash
uv run uvicorn index:app --reload --host 127.0.0.1 --port 8000
```

4. Verify health endpoint:

```bash
curl http://127.0.0.1:8000/api/health
```

## Enable real Google Cloud Vision checks

After you create a service account JSON key, choose one auth method.

### Method A (recommended for local)

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

### Method B (recommended for Vercel)

Set one of these environment variables:

- `GOOGLE_APPLICATION_CREDENTIALS_JSON`: raw JSON content
- `GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64`: base64-encoded JSON

To create base64 value locally:

```bash
base64 -w 0 service-account.json
```

## Deploy on Vercel

From `portal/`:

```bash
vercel
```

Then set environment variables in Vercel Project Settings -> Environment Variables:

- `GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64` (preferred) or `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- `GOOGLE_VISION_DISABLED=false`

Redeploy after setting env vars.

## Confirm Vision is active

Call `/api/moderate` and check response `source`:

- `google-cloud-vision` means real Vision checks are active
- `fallback-neutral` means Vision auth/config failed and fallback was used
- `disabled-neutral` means `GOOGLE_VISION_DISABLED` is enabled

## Use Sightengine (direct image upload, no URL needed)

The backend sends uploaded frame bytes directly to Sightengine with multipart form-data.

Set these env vars in `api/.env` (local) or Vercel Project Settings (hosted):

- `MODERATION_PROVIDER=sightengine`
- `SIGHTENGINE_API_USER=your_user_id`
- `SIGHTENGINE_API_SECRET=your_api_secret`
- `GOOGLE_VISION_DISABLED=false`

Optional models override:

- `SIGHTENGINE_MODELS=nudity-2.1,weapon,alcohol,recreational_drug,medical,offensive-2.0,gore-2.0,tobacco,violence,self-harm,gambling`

Run locally:

```bash
uv sync
uv run uvicorn index:app --reload --host 127.0.0.1 --port 8000
```

Confirm provider:

- Call `/api/moderate` from portal
- Response `source` should be `sightengine`

