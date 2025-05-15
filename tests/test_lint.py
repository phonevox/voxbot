import subprocess


def test_black():
    result = subprocess.run(["black", ".", "--check"], capture_output=True, text=True)
    assert result.returncode == 0, f"Black errors:\n{result.stdout}{result.stderr}"


def test_isort():
    result = subprocess.run(["isort", ".", "--check-only"], capture_output=True, text=True)
    assert result.returncode == 0, f"Isort errors:\n{result.stdout}{result.stderr}"


def test_flake8():
    result = subprocess.run(["flake8", "."], capture_output=True, text=True)
    assert result.returncode == 0, f"Flake8 errors:\n{result.stdout}{result.stderr}"
