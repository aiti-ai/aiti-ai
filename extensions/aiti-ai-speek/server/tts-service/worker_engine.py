"""Client-side proxy for a separate provider worker (currently Qwen3/torch)."""
from __future__ import annotations
import base64, json, os, subprocess, threading
import numpy as np
from providers.base import NotReady, TTSEngine, TTSError


class WorkerEngine(TTSEngine):
    def __init__(self, *, provider: str, model_dir: str, voices_json: str, python: str,
                 worker_script: str, num_threads: int = 0) -> None:
        super().__init__(model_dir=model_dir, voices=[], num_threads=num_threads)
        self.id = provider
        self.model_label = provider
        self.sample_rate = 24000
        self._python = python
        self._script = worker_script
        self._voices_json = voices_json
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def _request(self, req: dict) -> dict:
        if not self._proc or self._proc.poll() is not None:
            raise NotReady("qwen worker is not running")
        assert self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(json.dumps(req) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise NotReady("qwen worker exited")
        try:
            out = json.loads(line)
        except Exception as e:
            raise TTSError(f"qwen worker protocol error: {e}")
        if not out.get("ok"):
            raise NotReady(str(out.get("error") or "qwen worker failed"))
        return out

    def load(self) -> None:
        if self.loaded:
            return
        if not os.path.isfile(self._python):
            raise NotReady(f"qwen3 venv not found: {self._python}")
        if not os.path.isfile(self._script):
            raise NotReady(f"qwen worker missing: {self._script}")
        import sys as _sys
        _sys.stderr.write(f"[worker_engine] python={self._python} script={self._script}\n")
        _sys.stderr.flush()
        self._proc = subprocess.Popen(
            [self._python, self._script, "--provider", self.id, "--model-dir", self.model_dir,
             "--voices-json", self._voices_json or "", "--num-threads", str(self.num_threads)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        ready = None
        skipped: list[str] = []
        while True:
            line = self._proc.stdout.readline() if self._proc.stdout else ""
            if not line:
                err = self._proc.stderr.read() if self._proc.stderr else ""
                raise NotReady("qwen worker failed to start: " + (err.strip()[-1000:] or "no output"))
            try:
                ready = json.loads(line)
                break
            except Exception:
                skipped.append(line.strip()[:200])
        if not ready.get("ok"):
            raise NotReady(str(ready.get("error") or "qwen worker failed"))
        self.sample_rate = int(ready.get("sampleRate") or 24000)
        self.model_label = str(ready.get("model") or self.id)
        self._voices = [v for v in (ready.get("voices") or []) if isinstance(v, dict)]
        self.loaded = True

    def voices(self):
        if not self.loaded:
            return []
        # Refresh occasionally if clone voices were added after worker start.
        try:
            out = self._request({"cmd": "voices"})
            self._voices = [v for v in (out.get("voices") or []) if isinstance(v, dict)]
        except Exception:
            pass
        return [type("V", (), {"as_dict": lambda _self, v=v: v})() for v in self._voices]

    def reload(self) -> None:
        if self.loaded:
            try:
                out = self._request({"cmd": "reload"})
                self._voices = [v for v in (out.get("voices") or []) if isinstance(v, dict)]
            except Exception:
                pass

    def synthesize(self, text: str, voice: str | None, *, language: str = "auto") -> np.ndarray:
        if not self.loaded:
            raise NotReady("qwen worker is loading")
        with self._lock:
            out = self._request({"cmd": "synthesize", "text": text, "voice": voice, "language": language})
        raw = base64.b64decode(out.get("audio") or "")
        if not raw:
            raise NotReady("qwen worker returned empty audio")
        return np.frombuffer(raw, dtype=np.float32).copy()
