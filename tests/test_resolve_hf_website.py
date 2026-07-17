import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "resolve_hf_website.py"
SPEC = importlib.util.spec_from_file_location("resolve_hf_website", SCRIPT)
assert SPEC and SPEC.loader
resolver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resolver)


class ResolveWebsiteTests(unittest.TestCase):
    def test_discovers_only_task_run_roots_and_applies_filters(self):
        paths = [
            "model-a/site-a/run-1/trials-config.json",
            "model-a/site-a/run-1/src/App.jsx",
            "model-a/site-b/run-2/trials-config.json",
            "model-b/site-a/run-3/trials-config.json",
            "README.md",
        ]
        self.assertEqual(
            resolver.discover_runs(paths, "model-a", "site-a"),
            ["model-a/site-a/run-1"],
        )

    def test_exact_run_path_requires_three_safe_segments(self):
        self.assertEqual(
            resolver.split_run_path("model/site/run"), ("model", "site", "run")
        )
        with self.assertRaises(ValueError):
            resolver.split_run_path("model/site")
        with self.assertRaises(ValueError):
            resolver.split_run_path("model/site/../run")

    def test_random_choice_is_reproducible(self):
        runs = ["m/a/1", "m/b/2", "m/c/3"]
        self.assertEqual(
            resolver.choose_run(runs, "pilot"), resolver.choose_run(runs, "pilot")
        )


if __name__ == "__main__":
    unittest.main()
