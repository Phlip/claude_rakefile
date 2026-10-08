# payload/tests/test_shoes_gui.py - Harbor verifier test suite
import subprocess
import time
from PIL import Image

def run_app():
    """Spins up the Shoes application inside a headless Xvfb display."""
    proc = subprocess.Popen(
        ["xvfb-run", "--auto-servernum", "ruby", "/workspace/payload/app.rb"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    time.sleep(2)  # Wait for window render loop
    return proc

def test_shoes_layout_render():
    proc = run_app()
    try:
        # Capture the virtual framebuffer
        subprocess.run(["import", "-window", "root", "/tmp/rendered.png"], check=True)

        # Verify rendered image properties
        img = Image.open("/tmp/rendered.png")
        assert img.size == (300, 200)
    finally:
        proc.terminate()
