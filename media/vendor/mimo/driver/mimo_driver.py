#!/usr/bin/env python3
"""MiMo multimodal driver — file-based API relay.

Reads a request spec from a JSON file (argv[1]), reads any local media files
referenced in it, assembles the chat body, POSTs to the MiMo (Xiaomi) API, and
writes the raw response to argv[2].

Nothing large ever crosses stdout/stderr — all I/O is file based. This matters
because agent shells commonly cap captured stdout (e.g. DSH's bash seam caps
at 64KB), which would silently truncate multi-megabyte base64 payloads.

Usage:
    python3 mimo_driver.py <spec.json> <response.out>

Spec JSON shape:
{
  "model": "mimo-v2.5" | "mimo-v2.5-asr" | "mimo-v2.5-pro" | ...,
  "key": "api key",
  "url": "https://api.xiaomimimo.com/v1/chat/completions",
  "timeout": 90,
  "prompt": "user text prompt",
  "kind": "vision" | "audio" | "asr" | "video" | "chat" | "think" | "json",
  "language": "zh" | undefined,      // asr only
  "fps": 2 | undefined,              // video only (frame sampling rate)
  "media_resolution": "default" | undefined,  // video only
  "files": [ {"kind": "image"|"audio"|"video", "mime": "...", "path": "/abs/path"} ],
  "urls": ["https://..."]            // vision: image URLs; audio/asr: audio URL;
                                     // video: video URL (per official docs the
                                     // multimodal endpoints accept a bare URL in
                                     // image_url.url / input_audio.data / video_url.url)
}
"""
import json
import sys
import base64
import urllib.request
import urllib.error


def _video_item(url, spec):
    """One content item for a video: video_url plus optional fps / media_resolution
    (both are SIBLING fields of video_url in the content item, per the official
    video-understanding docs)."""
    item = {"type": "video_url", "video_url": {"url": url}}
    fps = spec.get("fps")
    if fps is not None:
        item["fps"] = int(fps)
    res = spec.get("media_resolution")
    if res:
        item["media_resolution"] = str(res)
    return item


def _fetch_b64(url, timeout=90):
    """Download a public URL and return its base64. Used only for ASR, whose
    input_audio.data rejects a bare URL (it demands base64 / a data URL with a
    mime prefix) — unlike the audio-understanding model, which accepts a public
    URL directly. A data: URL is passed through unchanged (the API accepts it
    as-is)."""
    if url.startswith("data:"):
        return url
    data = urllib.request.urlopen(url, timeout=timeout).read()
    return base64.b64encode(data).decode()


def _mime_of_url(url):
    """Best-effort mime from the URL path extension (ASR's data URL needs a
    mime prefix; unknown → audio/wav). A data: URL carries its own mime."""
    if url.startswith("data:"):
        return url.split(";", 1)[0].split(":", 1)[1]
    path = url.split("?", 1)[0].split("#", 1)[0].lower()
    for ext, mime in ((".mp3", "audio/mpeg"), (".m4a", "audio/mp4"), (".ogg", "audio/ogg"), (".flac", "audio/flac"), (".wav", "audio/wav")):
        if path.endswith(ext):
            return mime
    return "audio/wav"


def _audio_data(u, timeout):
    """One input_audio.data value for an ASR URL input: download public URLs to
    base64 (ASR rejects bare URLs), pass data: URLs through untouched."""
    if u.startswith("data:"):
        return u
    return "data:%s;base64,%s" % (_mime_of_url(u), _fetch_b64(u, timeout))


def build_body(spec):
    model = spec["model"]
    kind = spec.get("kind", "chat")
    parts = []

    for f in spec.get("files", []):
        with open(f["path"], "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        uri = "data:%s;base64,%s" % (f["mime"], b64)
        fkind = f.get("kind", "image")
        if fkind == "image":
            parts.append({"type": "image_url", "image_url": {"url": uri}})
        elif fkind == "video":
            parts.append(_video_item(uri, spec))
        else:  # audio (input_audio accepts a data URL)
            parts.append({"type": "input_audio", "input_audio": {"data": uri}})

    for u in spec.get("urls", []):
        if kind == "video":
            parts.append(_video_item(u, spec))
        elif kind == "asr":
            # ASR rejects bare URLs — download and re-encode as a data URL
            # (data: URLs pass through untouched).
            parts.append({"type": "input_audio", "input_audio": {"data": _audio_data(u, spec.get("timeout", 90))}})
        elif kind == "audio":
            # input_audio.data accepts a public URL directly (official docs).
            parts.append({"type": "input_audio", "input_audio": {"data": u}})
        else:  # vision / default
            parts.append({"type": "image_url", "image_url": {"url": u}})

    prompt = spec.get("prompt", "")
    if kind == "asr":
        if prompt:
            parts.append({"type": "text", "text": prompt})
        body = {"model": model, "messages": [{"role": "user", "content": parts}], "stream": False}
        lang = spec.get("language")
        if lang:
            body["asr_options"] = {"language": lang}
        return body
    if not prompt and kind == "chat":
        prompt = "Please respond."
    parts.append({"type": "text", "text": prompt})
    body = {
        "model": model,
        "messages": [{"role": "user", "content": parts}],
        "stream": False,
        "max_completion_tokens": 2048,
        "thinking": {"type": "disabled"},
    }
    if kind == "think":
        # Deep thinking (official deep-thinking docs): thinking enabled →
        # the response carries reasoning_content alongside content. Deeper
        # problems deserve a larger completion budget.
        body["thinking"] = {"type": "enabled"}
        body["max_completion_tokens"] = 4096
    elif kind == "json":
        # Structured output (official structured-output docs): response_format
        # json_object + an explicit instruction to return JSON only.
        body["response_format"] = {"type": "json_object"}
        body["max_completion_tokens"] = 4096
        body["messages"] = [
            {"role": "system", "content": "You must return only valid JSON matching the requested structure. No markdown fences, no commentary, no trailing text."},
            {"role": "user", "content": parts},
        ]
    return body


def main():
    spec_path, out_path = sys.argv[1], sys.argv[2]
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    body = build_body(spec)
    req = urllib.request.Request(
        spec["url"],
        data=json.dumps(body).encode(),
        headers={"api-key": spec["key"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=spec.get("timeout", 90)) as resp:
            data = resp.read()
        with open(out_path, "wb") as fh:
            fh.write(data)
        print("OK")
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write("HTTP_ERR:" + err[:800])
        print("FAIL")
    except Exception as ex:  # noqa: BLE001
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write("NET_ERR:" + str(ex)[:300])
        print("FAIL")


if __name__ == "__main__":
    main()
