"""Swing-Analysis backend package.

Layers (bottom → top):
  backend.core          algorithm library (vendored, zero changes)
  backend.service.pipeline  shared run-pipeline (used by both CLI and REST)
  backend.cli           CLI entry — a UI, just like REST/WebSocket
  backend.service       REST/WebSocket UI — Electron / browser / mobile client

CLI and REST are two UIs over the same pipeline. Decoupling keeps the algorithm
unchanged while letting any front-end consume it.
"""