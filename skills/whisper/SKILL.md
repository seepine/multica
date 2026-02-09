---
name: Audio Transcription
description: Transcribe audio files using OpenAI Whisper CLI
version: 1.0.0
metadata:
  emoji: "🎙️"
  always: true
  requires:
    anyBins:
      - whisper
      - whisper-cli
  install:
    - id: brew-whisper
      kind: brew
      formula: openai-whisper
      bins: [whisper]
      label: "Install OpenAI Whisper via Homebrew"
      os: [darwin]
    - id: pip-whisper
      kind: uv
      package: openai-whisper
      bins: [whisper]
      label: "Install OpenAI Whisper via pip/uv"
  tags:
    - audio
    - transcription
    - media
userInvocable: false
disableModelInvocation: false
---

## Audio Transcription

When you receive a message indicating an audio or voice message file (e.g., `[audio message received]` with a `File:` path), you should transcribe it.

### How to Transcribe

Run the following command using the `exec` tool:

```
whisper "<file_path>" --model turbo --output_format txt --output_dir /tmp
```

Then read the resulting `.txt` file (same name as input, in `/tmp/`) to get the transcript.

### Response Format

After transcription, respond naturally based on the transcribed content. If the user said something in the voice message, respond to it as if they had typed it.

If transcription fails, let the user know and suggest they check their Whisper installation.

### Supported Formats

Whisper supports: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, oga, flac
