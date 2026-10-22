import shutil
import subprocess
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import Path


class AssetParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets: list[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        url = attributes.get("src" if tag == "script" else "href", "") or ""
        if tag in ("script", "link") and url.startswith("/assets/"):
            self.assets.append(url)


def test_built_wheel_serves_frontend_assets(tmp_path):
    root = Path(__file__).resolve().parents[1]
    project = tmp_path / "project"
    project.mkdir()
    shutil.copy(root / "pyproject.toml", project)
    shutil.copytree(root / "src", project / "src", ignore=shutil.ignore_patterns("__pycache__"))
    assert (project / "src/kuro/static/index.html").is_file(), "Run npm run build first"
    subprocess.run(
        [sys.executable, "-c", "from setuptools.build_meta import build_wheel; build_wheel('dist')"],
        cwd=project, check=True,
    )
    installed = tmp_path / "installed"
    with zipfile.ZipFile(next((project / "dist").glob("*.whl"))) as wheel:
        parser = AssetParser()
        parser.feed(wheel.read("kuro/static/index.html").decode())
        assert any(asset.endswith(".css") for asset in parser.assets)
        assert any(asset.endswith(".js") for asset in parser.assets)
        assert any(asset.endswith(".svg") for asset in parser.assets)
        for asset in parser.assets:
            assert wheel.read(f"kuro/static{asset}"), f"Missing packaged asset: {asset}"
        wheel.extractall(installed)
    probe = """
import sys
sys.path.insert(0, sys.argv[1])
from webtest import TestApp
from kuro.api.app import create_app
from kuro.config import Settings
from kuro.db import Repository
from kuro.ntp import NTPService
settings = Settings(database_path=sys.argv[2])
repository = Repository(settings.database_path)
app = TestApp(create_app(settings, repository, NTPService(settings, repository)))
assert app.get('/').content_type == 'text/html'
for asset in sys.argv[3:]:
    result = app.get(asset)
    assert result.body
    assert result.content_type in ('text/css', 'text/javascript', 'application/javascript', 'image/svg+xml')
repository.close()
"""
    subprocess.run(
        [sys.executable, "-c", probe, str(installed), str(tmp_path / "probe.db"), *parser.assets],
        cwd=tmp_path, check=True,
    )