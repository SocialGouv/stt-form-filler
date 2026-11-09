"""Sonde Kubernetes : répond sans mot de passe, le reste du site reste protégé."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ACCES_IDENTIFIANT", "testeur")
    monkeypatch.setenv("ACCES_MOT_DE_PASSE", "secret-de-test")
    return app.app.test_client()


def test_healthz_sans_mot_de_passe(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.get_data(as_text=True) == "ok"


def test_reste_du_site_protege(client):
    assert client.get("/").status_code == 401
    assert client.get("/api/status").status_code == 401


def test_site_accessible_avec_mot_de_passe(client):
    resp = client.get("/", headers={"Authorization": "Basic dGVzdGV1cjpzZWNyZXQtZGUtdGVzdA=="})
    assert resp.status_code == 200
