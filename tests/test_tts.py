"""Fils de calcul de la synthèse vocale : alignés sur la limite CPU du conteneur, pas sur la machine."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tts  # noqa: E402


def cpu_max(tmp_path, content):
    f = tmp_path / "cpu.max"
    f.write_text(content)
    return f


def test_limite_du_conteneur(tmp_path, monkeypatch):
    monkeypatch.delenv("TTS_THREADS", raising=False)
    assert tts.onnx_threads(cpu_max(tmp_path, "200000 100000\n")) == 2


def test_limite_fractionnaire_arrondie_au_dessus(tmp_path, monkeypatch):
    monkeypatch.delenv("TTS_THREADS", raising=False)
    assert tts.onnx_threads(cpu_max(tmp_path, "150000 100000\n")) == 2
    assert tts.onnx_threads(cpu_max(tmp_path, "30000 100000\n")) == 1


def test_variable_d_environnement_prioritaire(tmp_path, monkeypatch):
    monkeypatch.setenv("TTS_THREADS", "3")
    assert tts.onnx_threads(cpu_max(tmp_path, "200000 100000\n")) == 3


def test_sans_limite_cpus_disponibles(tmp_path, monkeypatch):
    monkeypatch.delenv("TTS_THREADS", raising=False)
    assert tts.onnx_threads(cpu_max(tmp_path, "max 100000\n")) >= 1
    assert tts.onnx_threads(tmp_path / "absent") >= 1
