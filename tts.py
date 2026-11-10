"""Synthèse vocale locale avec Piper (voix neuronales open source, exécutées sur ce serveur).

Plus naturelle que les voix des navigateurs, et aucun texte ne part vers un service tiers.
Les modèles de voix sont dans voices/ (voir le README pour les télécharger). Sans eux, le
site utilise la voix du navigateur.
"""
import io
import json
import logging
import math
import os
import threading
import wave
from pathlib import Path

log = logging.getLogger(__name__)
CPU_MAX = Path("/sys/fs/cgroup/cpu.max")

VOICES_DIR = Path(__file__).parent / "voices"
# Identifiant exposé au navigateur → modèle Piper.
VOICES = {
    "femme": "fr_FR-siwis-medium",
    "homme": "fr_FR-tom-medium",
}
DEFAULT_VOICE = "femme"
MAX_CHARS = 1500

_loaded = {}
_lock = threading.Lock()

try:
    import onnxruntime
    from piper import PiperVoice, SynthesisConfig
    from piper.config import PiperConfig
except ImportError:  # piper-tts non installé : voix du navigateur uniquement
    PiperVoice = SynthesisConfig = None


def onnx_threads(cpu_max=CPU_MAX):
    """Nombre de fils de calcul pour la synthèse : TTS_THREADS, sinon la limite CPU du conteneur.

    Sans réglage, onnxruntime lance un fil par cœur de la machine (16 sur le cluster) alors que le
    conteneur n'a droit qu'à 2 CPU : il est alors bridé en permanence et une phrase prend ~2,7 s au
    lieu de ~0,3 s (mesuré dans le pod)."""
    try:
        return max(1, int(os.environ["TTS_THREADS"]))
    except (KeyError, ValueError):
        pass
    try:  # cgroup v2 : « quota période », ou « max période » sans limite
        quota, period = cpu_max.read_text().split()
        if quota != "max":
            return max(1, math.ceil(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    return max(1, len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1))


def available_voices():
    """Voix Piper utilisables (bibliothèque installée et modèle présent)."""
    if PiperVoice is None:
        return []
    return [key for key, model in VOICES.items() if (VOICES_DIR / f"{model}.onnx").exists()]


def _voice(key):
    if key not in _loaded:
        model = VOICES_DIR / f"{VOICES[key]}.onnx"
        # Comme PiperVoice.load, mais avec un nombre de fils adapté au conteneur.
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = onnx_threads()
        options.inter_op_num_threads = 1
        config = json.loads(Path(f"{model}.json").read_text(encoding="utf-8"))
        _loaded[key] = PiperVoice(
            config=PiperConfig.from_dict(config),
            session=onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"]),
        )
    return _loaded[key]


def synthesize(text, voice=DEFAULT_VOICE, rate=1.0):
    """Texte → WAV (octets). `rate` : 1 = vitesse normale, 0.65 = lente, 1.15 = rapide."""
    if voice not in available_voices():
        voice = DEFAULT_VOICE
    rate = min(max(float(rate), 0.4), 1.6)
    config = SynthesisConfig(length_scale=1 / rate)
    buf = io.BytesIO()
    # Une synthèse à la fois : le modèle n'est pas prévu pour des appels simultanés.
    with _lock:
        with wave.open(buf, "wb") as wav:
            _voice(voice).synthesize_wav(text[:MAX_CHARS], wav, syn_config=config)
    return buf.getvalue()
