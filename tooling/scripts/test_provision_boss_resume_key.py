import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("provision", Path(__file__).with_name("provision-boss-resume-key.py"))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class MachineCredentialTest(unittest.TestCase):
    def setUp(self):
        self.args = ["provision", "--api-base-url", "https://harly.example.test",
                     "--project", "example-project", "--admin-key-secret", "example-admin"]
        self.key = {"id": "synthetic-key-id", "key": "synthetic-machine-secret"}

    def opener(self):
        response = Mock()
        response.read.return_value = json.dumps({"data": self.key}).encode()
        context = contextlib.nullcontext(response)
        opener = Mock()
        opener.open.return_value = context
        return opener

    def test_sends_plaintext_through_stdin_without_printing_it(self):
        output = io.StringIO()
        with patch("sys.argv", self.args), patch("sys.stdout", output), \
             patch.object(provision, "cloud", side_effect=["synthetic-admin-secret", "", ""]) as cloud, \
             patch.object(provision.subprocess, "run", return_value=SimpleNamespace(returncode=1)), \
             patch.object(provision.urllib.request, "build_opener", return_value=self.opener()):
            provision.main()
        self.assertEqual(cloud.call_args.kwargs["stdin"], self.key["key"])
        self.assertNotIn(self.key["key"], output.getvalue())
        self.assertNotIn("synthetic-admin-secret", output.getvalue())

    def test_does_not_mint_another_key_if_secret_already_has_a_version(self):
        with patch("sys.argv", self.args), \
             patch.object(provision, "cloud", side_effect=["synthetic-admin-secret", "1"]), \
             patch.object(provision.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(provision.urllib.request, "build_opener") as opener:
            with self.assertRaises(ValueError):
                provision.main()
            opener.assert_not_called()

    def test_revokes_a_key_if_secret_upload_fails(self):
        opener = self.opener()
        with patch("sys.argv", self.args), \
             patch.object(provision, "cloud", side_effect=["synthetic-admin-secret", "", RuntimeError("Synthetic failure")]), \
             patch.object(provision.subprocess, "run", return_value=SimpleNamespace(returncode=1)), \
             patch.object(provision.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(RuntimeError):
                provision.main()
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(opener.open.call_args.args[0].method, "DELETE")
        self.assertTrue(opener.open.call_args.args[0].full_url.endswith(self.key["id"]))


if __name__ == "__main__":
    unittest.main()
