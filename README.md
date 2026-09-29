# Cartoonr Backend

Backend for the Cartoonr prototype.

## Railway variables

Required:

- `OPENAI_API_KEY`

Railway supplies `PORT` automatically.

## Routes

- `GET /` — service status
- `GET /health` — configuration status
- `POST /generate` — generate one artcard option from one line plus character reference images

The frontend should call `/generate` three times per line with `option` values `1`, `2`, and `3`.

### POST body

```json
{
  "characterName": "Mamu",
  "characterReferences": ["data:image/png;base64,..."],
  "line": "Exact dialogue here",
  "option": 1
}
```

### Response

```json
{
  "ok": true,
  "option": 1,
  "imageData": "data:image/png;base64,..."
}
```

The backend uses `gpt-image-2` image editing so multiple uploaded reference images can guide the new image.
