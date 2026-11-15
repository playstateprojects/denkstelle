# Device API

How a Denkstelle telephone (a Raspberry Pi with a USB handset, or the browser simulator at `/phone`) fetches its question and submits a recording. Both clients call the same two endpoints; the backend cannot tell them apart except by how they authenticate.

## The call, step by step

1. Handset lifted → `GET /api/device/config`, play `greeting.url` (or read `greeting.text` aloud if the URL is `null`).
2. Play a beep (`beep.frequencyHz`, `beep.durationMs`), then record. Stop at `recording.maxDurationSeconds`.
3. Handset replaced → finish the WAV file and keep it on disk.
4. `POST /api/device/recordings` with the file.
5. **Keep retrying until the server answers 2xx.** Reuse the same `X-Recording-Id` on every retry. Delete the file only after a 2xx, or after a response with `"retryable": false`.

## Authentication

`Authorization: Bearer dk_<64 hex>`. Each credential belongs to one device and one project.

```bash
npm run devices -- create <project-slug> "Kitchen phone"   # prints the credential once; only its hash is stored
npm run devices -- list [project-slug]
npm run devices -- revoke <device-id>                       # stops working immediately
npm run devices -- configure <device-id> maxDurationSeconds=120
npm run devices -- greeting <project-slug> https://example.org/question.wav   # or "none"; normally upload it on the project page instead
```

The browser simulator holds no secret. It sends the admin's login session cookie plus `X-Denkstelle-Simulator: <project id>`, and the server maps that to one auto-created `simulator` device per admin and project.

The project must be `open` and its recording mode must be `audio` or `either`.

## `GET /api/device/config`

```json
{
  "project": {"id": "…", "slug": "…", "title": "…", "question": "…"},
  "greeting": {"url": "https://…/greeting.wav", "text": "<question>"},
  "beep": {"frequencyHz": 880, "durationMs": 300},
  "recording": {"maxDurationSeconds": 180, "maxBytes": 41943040, "acceptedMimeTypes": ["audio/wav"], "minDurationMs": 1000, "upload": {…}},
  "consent": {"required": "capture_analysis", "header": "X-Consent", "policyVersion": "…"},
  "device": {"id": "…", "name": "…", "kind": "handset", "config": {}}
}
```

## `POST /api/device/recordings`

Raw audio as the request body (not multipart).

| Header | |
|---|---|
| `Authorization` | `Bearer dk_…` |
| `Content-Type` | `audio/wav` (PCM, mono or stereo, 8–96 kHz). Other formats can be added in `src/lib/audio-formats.ts`. |
| `X-Recording-Id` | UUID the device generates once per recording. Makes retries idempotent. |
| `X-Content-SHA256` | Hex SHA-256 of the body. A mismatch (corrupt or cut-off upload) is rejected. |
| `X-Consent` | `capture_analysis`. The device asserts the speaker was told about and agreed to recording and analysis (for a handset: the greeting or a printed notice). Public and social permissions are always recorded as **not** granted. |

Responses (JSON):

| Status | Meaning |
|---|---|
| `201` | Verified, stored, processing job queued. |
| `200` | Already received (`"duplicate": true`). Nothing new was queued. Treat as success. |
| `4xx/5xx` | `{"error": "<code>", "message": "…", "retryable": bool}` |

`retryable: true` (network trouble, `checksum_mismatch`, `storage_unavailable`, 5xx): upload again. `retryable: false` (`invalid_audio`, `recording_too_short`, `recording_too_long`, `consent_required`, `unsupported_media_type`, `recording_id_conflict`, 401/403/409 project errors): retrying the same file will not help.

Processing is queued only after the checksum matched, the WAV parsed as complete, and the object was read back from private R2 at the expected size. The recording becomes a `sources` row (`kind = 'audio'`) carrying `device_id` and the project, and flows through the normal transcription → statements → insights pipeline.

If a POST times out and the device doesn't know whether it landed, `GET /api/device/recordings/<recording id>` answers `200` (received) or `404` (upload again). Simply re-POSTing is equally safe.

## Reference loop for a Pi

```bash
#!/bin/bash
# Sketch: assumes ALSA tools, jq, curl; GPIO/hook-switch handling left out.
BASE=https://denkstelle.example; KEY=dk_…; SPOOL=/var/spool/denkstelle; mkdir -p $SPOOL
auth=(-H "Authorization: Bearer $KEY")

call() {   # run when the handset is lifted; returns after it is replaced
  cfg=$(curl -sf "${auth[@]}" $BASE/api/device/config) || return
  curl -sf "$(jq -r .greeting.url <<<"$cfg")" | aplay -q          # greeting
  speaker-test … # beep
  id=$(uuidgen | tr A-Z a-z); f=$SPOOL/$id.wav
  arecord -q -f S16_LE -r 16000 -c 1 -d "$(jq -r .recording.maxDurationSeconds <<<"$cfg")" $f &
  wait_for_hangup; kill %1; wait
}

flush() {  # run on boot and after every call; also from a timer
  for f in $SPOOL/*.wav; do [ -e "$f" ] || continue
    id=$(basename "$f" .wav)
    code=$(curl -s -o /tmp/resp -w '%{http_code}' "${auth[@]}" -X POST $BASE/api/device/recordings \
      -H 'Content-Type: audio/wav' -H "X-Recording-Id: $id" -H 'X-Consent: capture_analysis' \
      -H "X-Content-SHA256: $(sha256sum "$f" | cut -d' ' -f1)" --data-binary @"$f")
    if [[ $code == 2* ]] || [[ $(jq -r '.retryable' /tmp/resp 2>/dev/null) == false ]]; then rm "$f"; fi
  done
}
```

## Operational notes

- Size limit 40 MB, duration limit 180 s (+3 s tolerance). The server measures duration from the WAV header, not from the device's claim.
- An interrupted request can leave an `awaiting_upload` source row with no audio and no job. A retry with the same recording ID completes it. Such rows are harmless but are never cleaned up automatically.
- Rate limiting is not implemented; put Cloudflare WAF rules in front of `/api/device/*` before exposing it broadly.
- The greeting is uploaded on the project dashboard page (stored privately in R2, served at `/api/public/greeting/<project id>`, which `greeting.url` points to; an uploaded file overrides the URL set by script). Max 5 MB; MP3, WAV, M4A or OGG.
- Apply `db/009_devices.sql` and `db/010_phone_greeting_upload.sql` with `npm run db:migrate` before using any of this.
