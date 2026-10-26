"""Synthèse vocale locale avec Piper (voix neuronales open source, exécutées sur ce serveur).

Plus naturelle que les voix des navigateurs, et aucun texte ne part vers un service tiers.
Les modèles de voix sont dans voices/ (voir le README pour les télécharger). Sans eux, le
site utilise la voix du navigateur.
"""
import io
import logging
import threading
import wave
from pathlib import Path

log = logging.getLogger(__name__)

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
    from piper import PiperVoice, SynthesisConfig
except ImportError:  # piper-tts non installé : voix du navigateur uniquement
    PiperVoice = SynthesisConfig = None


def available_voices():
    """Voix Piper utilisables (bibliothèque installée et modèle présent)."""
    if PiperVoice is None:
        return []
    return [key for key, model in VOICES.items() if (VOICES_DIR / f"{model}.onnx").exists()]


def _voice(key):
    if key not in _loaded:
        _loaded[key] = PiperVoice.load(str(VOICES_DIR / f"{VOICES[key]}.onnx"))
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
