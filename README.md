# Alexia Piano Practice — Suzuki Book 2

A calm practice helper for Alexia (and Joe). Runs in the browser on this computer. No account. No paid APIs.

## How to open it

1. Open a terminal in `/workspace/alexia-piano-practice`
2. Install once: `npm install`
3. Start: `npm run dev`
4. Open the address shown (usually http://localhost:5173) in Chrome or Edge

Production build: `npm run build` then `npm run preview`

## What works

- Piece picker for all 14 Suzuki Book 2 pieces
- YouTube listening embed (audio stays on YouTube; nothing rehosted)
- Microphone recording with elapsed timer, preview, save, and playback
- Takes and practice notes persisted in IndexedDB / localStorage on this device
- Practice hone analysis via Web Audio API:
  - Solo: tempo stability + dynamic consistency across sections
  - With your own reference file: DTW-aligned section compare (onset density + RMS volume), coloured green / amber / red

## Comparison MVP limits

- Cannot fetch YouTube audio (CORS). Full vs-model match needs a reference file you own (CD/mp3).
- Solo mode only checks consistency inside one take — clearly labelled as not a YouTube match.
- Alignment is approximate if take length differs a lot from the reference.
- Proxies are onset density / energy and RMS volume — not note-level pitch scoring.

## Privacy

Recordings never leave this computer. Clearing browser site data deletes takes.
