---
name: jojocode-image-gen
description: Generate images with the JojoCode endpoint and gpt-image-2, save them as local files, and report the exact saved path. Use whenever the user asks to generate, create, draw, or design an image of something (illustration, icon, poster, photo, avatar, concept art) and does not name a different provider, and whenever JojoCode or gpt-image-2 is mentioned. Not for editing an existing image, SVG/vector assets, or diagrams better built as code.
metadata:
  short-description: Generate images via JojoCode gpt-image-2
---

# JojoCode Image Generation

Turn a text prompt into image file(s) on disk using `https://jojocode.com` and the
`gpt-image-2` model, then report where the files landed.

No API key is bundled. If no key is configured yet, ask the user for theirs
before generating (see [First run](#first-run-ask-the-user-for-the-key)).

## Run it

Run the bundled script (Node 18+; `node` is on PATH in this environment):

```bash
node "<skill-dir>/scripts/generate_image.mjs" --prompt "PROMPT" --out "PATH"
```

`<skill-dir>` is this skill's folder, e.g.
`C:/Users/elain/.codex/skills/jojocode-image-gen`.

Examples:

```bash
# Default: writes ./outputs/jojocode-<timestamp>-1.png
node scripts/generate_image.mjs --prompt "a watercolor fox reading a book"

# Explicit destination and landscape size
node scripts/generate_image.mjs --prompt "minimal app icon" --out "C:/path/outputs/icon.png" --size 1536x1024

# Long or non-ASCII prompt: write it to a UTF-8 file first, then
node scripts/generate_image.mjs --prompt-file "C:/path/prompt.txt" --out "C:/path/outputs"
```

The script prints a JSON summary (`saved`, `model`, `size`) to stdout, so read the
`saved` entry rather than guessing the filename.

## Options

| Flag | Default | Notes |
| --- | --- | --- |
| `--prompt` / `--prompt-file` | required | One of the two. Prefer `--prompt-file` for long CJK prompts to avoid shell quoting issues. |
| `--out` | `outputs` | Path with a file extension = exact file; otherwise a directory. |
| `--size` | `1024x1024` | Also accepts `1536x1024`, `1024x1536`, `auto`. |
| `--quality` | unset | Sent only when provided (`low`, `medium`, `high`). |
| `--background` | unset | Sent only when provided (`transparent`, `opaque`). |
| `--output-format` | `png` | `png`, `jpeg`, or `webp`. |
| `--model` | `gpt-image-2` | `gpt-image-2-4k` is also served by this endpoint. |
| `--n` | `1` | Multiple images get `-1`, `-2`, ... suffixes. |
| `--timeout` | `300` | Seconds per HTTP request; generation typically takes 30-60s. |
| `--extra` | unset | JSON object merged into the request body for provider-specific fields. |
| `--check-key` | - | Prints whether a key is configured (never the key itself). Exit `3` if missing. |
| `--save-key <key>` | - | Stores the key in the local config file and exits. |
| `--clear-key` | - | Forgets the stored key. |
| `--api-key <key>` | - | One-off override; lands in shell history, so prefer `--save-key`. |

## Endpoint contract

- `POST {base}/v1/images/generations` with `Authorization: Bearer <key>`.
- Response: `{"created":..., "usage":..., "data":[{"b64_json":"..."} | {"url":"..."}]}`.
  The script decodes either shape and normalizes the file extension from the
  actual bytes.
- `GET {base}/v1/models` lists available models if a model name is rejected.
- The script retries 3 times with backoff on `408`, `429`, and `5xx`, and exits
  non-zero with the provider's error body on `4xx` (e.g. `401` means the key is
  invalid or revoked).

## Credentials

This skill ships with **no API key**. Every user supplies their own on first use.

Resolution order: `--api-key`, then `JOJOCODE_API_KEY`, then the stored config
file `${CODEX_HOME:-~/.codex}/jojocode-image-gen/config.json` (override the path
with `JOJOCODE_CONFIG`). Base URL defaults to `https://jojocode.com`; override
with `JOJOCODE_BASE_URL`, `--base-url`, or a `baseUrl` field in the config file.

### First run: ask the user for the key

Start by checking cheaply:

```bash
node "<skill-dir>/scripts/generate_image.mjs" --check-key
```

If it reports `keyConfigured: false` (exit code `3`), ask the user for their
JojoCode API key in plain text before doing anything else. Then store it once:

```bash
node "<skill-dir>/scripts/generate_image.mjs" --save-key "<KEY>"
```

Rules for handling the key:

- Never print, echo, log, or repeat the key back to the user, and never write it
  into the skill folder, a prompt file, or a repository. Confirm storage by
  naming the config path only.
- Prefer `--save-key` or `JOJOCODE_API_KEY`. Avoid `--api-key` for routine use
  because it lands in shell history.
- If a run exits `3`, that means no key was found; ask again rather than
  guessing a value.
- If the user says the key was rotated or leaked, rerun `--save-key` with the new
  key, or `--clear-key` to forget it. A `401` from the API means the stored key
  is invalid or revoked.

## Reporting back

After a successful run, tell the user the absolute path of every saved image and
show it inline with `![alt](/absolute/path.png)`. Mention the model, size, and
token usage when they are relevant. When working in a projectless Codex thread,
write the file into that thread's `outputs/` folder so it shows up as a
deliverable.
